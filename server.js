const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const { Client } = require("pg");
const path = require("path");
const crypto = require("crypto");

const { pool, withTenant } = require("./db");
const { ingestEvent } = require("./ingestion");
const { startGapMonitor /*, startBundleSplitReconciler */ } = require("./worker");
const tenantResolver = require("./middleware/tenantResolver");
const { extractSubdomain } = require("./middleware/tenantResolver");

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/scanner.html", (_req, res) => res.sendFile(path.join(__dirname, "scanner.html")));
app.use("/assets", express.static(path.join(__dirname, "assets")));

app.get("/v1/whoami", tenantResolver, (req, res) => {
  res.json({ tenantId: req.tenantId, subdomain: req.tenantSubdomain });
});

// =====================================================================
// API KEY (global untuk semua tenant -- known limitation, lihat
// CHECKPOINT bagian 13: idealnya per-tenant, belum digarap di pass ini)
// =====================================================================
function requireApiKey(req, res, next) {
  const expected = process.env.API_KEY;
  if (!expected) {
    console.error("API_KEY belum di-set di environment.");
    return res.status(503).json({ error: "server belum dikonfigurasi (API_KEY kosong)" });
  }
  const provided = req.header("x-api-key");
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// =====================================================================
// EVENTS -- tenant_id WAJIB dari subdomain (req.tenantId), bukan dari
// body. Klien tetap boleh kirim tenant_id di body (misal buat testing),
// tapi selalu ditimpa oleh hasil tenantResolver -- mencegah klien kirim
// tenant_id milik tenant lain lewat body request.
// =====================================================================
app.post("/v1/events", tenantResolver, requireApiKey, async (req, res) => {
  try {
    const body = { ...req.body, tenant_id: req.tenantId };
    const result = await ingestEvent(body);
    res.status(result.httpStatus).json(result.body);
  } catch (err) {
    console.error("ingestion error:", err);
    res.status(500).json({ error: "internal error" });
  }
});

// =====================================================================
// ORDERS -- production_jobs + orders (bukan order_state/gap_status lama)
// =====================================================================
app.get("/v1/orders", tenantResolver, requireApiKey, async (req, res) => {
  const client = await pool.connect();
  try {
    const rows = await withTenant(client, req.tenantId, (c) =>
      c.query(
        `SELECT o.id AS order_id, o.customer_name, o.status,
                pj.id AS production_job_id, pj.current_stage, pj.gap_status,
                pj.updated_at
         FROM orders o
         LEFT JOIN production_jobs pj ON pj.id = o.production_job_id
         ORDER BY o.updated_at DESC`
      )
    );
    res.json(rows.rows);
  } catch (err) {
    console.error("orders list error:", err);
    res.status(500).json({ error: "internal error" });
  } finally {
    client.release();
  }
});

// =====================================================================
// STAFF PIN LOGIN
// Catatan: schema v2 TIDAK punya kolom "staff_id" text terpisah --
// identifier staff adalah "id" (uuid). Klien pilih staff dari
// /v1/staff/list (yang balikin id + full_name), baru kirim id itu ke
// /v1/staff/login bareng PIN.
// =====================================================================
const rateLimitMap = new Map();
function checkRateLimit(key, limit, windowMs) {
  if (rateLimitMap.size > 10000) rateLimitMap.clear();
  const now = Date.now();
  const entry = rateLimitMap.get(key) || { count: 0, ts: now };
  if (now - entry.ts > windowMs) {
    entry.count = 0;
    entry.ts = now;
  }
  entry.count += 1;
  rateLimitMap.set(key, entry);
  return entry.count <= limit;
}

const sessionMap = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 jam

function createSession(tenantId, staff) {
  if (sessionMap.size > 10000) sessionMap.clear();
  const token = crypto.randomBytes(32).toString("hex");
  sessionMap.set(token, {
    tenantId,
    staffId: staff.id,
    role: staff.role,
    assignedStage: staff.assigned_stage,
    fullName: staff.full_name,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

function requireStaffSession(req, res, next) {
  const token = req.header("x-staff-token");
  if (!token) {
    return res.status(401).json({ error: "sesi tidak ditemukan, silakan login ulang" });
  }
  const session = sessionMap.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessionMap.delete(token);
    return res.status(401).json({ error: "sesi kadaluarsa, silakan login ulang" });
  }
  // Cegah token dipakai lintas-tenant (misal token bocor / salah kirim)
  if (session.tenantId !== req.tenantId) {
    return res.status(403).json({ error: "sesi ini bukan untuk tenant ini" });
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  req.staffSession = session;
  next();
}

app.get("/v1/staff/list", tenantResolver, requireApiKey, async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await withTenant(client, req.tenantId, (c) =>
      c.query(`SELECT id, full_name FROM staff WHERE is_active = true ORDER BY full_name`)
    );
    res.json(result.rows);
  } catch (err) {
    console.error("staff list error:", err);
    res.status(500).json({ error: "internal error" });
  } finally {
    client.release();
  }
});

app.post("/v1/staff/login", tenantResolver, requireApiKey, async (req, res) => {
  const { staff_id, pin } = req.body || {};
  const ip = req.ip;

  if (!staff_id || !pin) {
    return res.status(400).json({ error: "staff_id dan pin wajib diisi" });
  }

  // rate limit di-scope per tenant juga, biar tenant A nggak bisa ngerjain rate limit tenant B
  const staffKey = `staff:${req.tenantId}:${staff_id}`;
  if (!checkRateLimit(staffKey, 5, 30_000)) {
    return res.status(429).json({ error: "Terlalu banyak percobaan PIN, coba lagi sebentar lagi" });
  }
  const ipKey = `ip:${ip}`;
  if (!checkRateLimit(ipKey, 20, 30_000)) {
    return res.status(429).json({ error: "Terlalu banyak request, coba lagi sebentar lagi" });
  }

  const client = await pool.connect();
  try {
    const result = await withTenant(client, req.tenantId, (c) =>
      c.query(
        `SELECT id, full_name, role, assigned_stage FROM staff
         WHERE id = $1 AND is_active = true AND pin_hash = crypt($2, pin_hash)`,
        [staff_id, pin]
      )
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: "PIN salah atau staff tidak aktif" });
    }
    const staff = result.rows[0];
    const token = createSession(req.tenantId, staff);
    res.json({ ok: true, staff, token });
  } catch (err) {
    console.error("staff login error:", err);
    res.status(500).json({ error: "internal error" });
  } finally {
    client.release();
  }
});

app.post("/v1/staff/revoke", tenantResolver, requireApiKey, requireStaffSession, async (req, res) => {
  if (req.staffSession.role !== "admin") {
    return res.status(403).json({ error: "hanya admin yang bisa revoke sesi staff" });
  }
  const { target_staff_id } = req.body || {};
  if (!target_staff_id) {
    return res.status(400).json({ error: "target_staff_id wajib diisi" });
  }
  let revokedCount = 0;
  for (const [token, session] of sessionMap.entries()) {
    if (session.tenantId === req.tenantId && session.staffId === target_staff_id) {
      sessionMap.delete(token);
      revokedCount += 1;
    }
  }
  console.log(`REVOKE: admin ${req.staffSession.staffId} (tenant ${req.tenantId}) revoke ${revokedCount} sesi milik staff ${target_staff_id}`);
  res.json({ ok: true, revoked_sessions: revokedCount });
});

app.post("/v1/staff/offboard", tenantResolver, requireApiKey, requireStaffSession, async (req, res) => {
  if (req.staffSession.role !== "admin") {
    return res.status(403).json({ error: "hanya admin yang bisa offboard staff" });
  }
  const { target_staff_id } = req.body || {};
  if (!target_staff_id) {
    return res.status(400).json({ error: "target_staff_id wajib diisi" });
  }
  const client = await pool.connect();
  try {
    const result = await withTenant(client, req.tenantId, (c) =>
      c.query(
        `UPDATE staff SET is_active = false WHERE id = $1 RETURNING id, full_name`,
        [target_staff_id]
      )
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "staff tidak ditemukan" });
    }
    let revokedCount = 0;
    for (const [token, session] of sessionMap.entries()) {
      if (session.tenantId === req.tenantId && session.staffId === target_staff_id) {
        sessionMap.delete(token);
        revokedCount += 1;
      }
    }
    console.log(`OFFBOARD: admin ${req.staffSession.staffId} offboard staff ${result.rows[0].full_name} (${target_staff_id}), is_active=false + revoke ${revokedCount} sesi`);
    res.json({ ok: true, staff: result.rows[0], revoked_sessions: revokedCount });
  } catch (err) {
    console.error("offboard error:", err);
    res.status(500).json({ error: "internal error" });
  } finally {
    client.release();
  }
});

// =====================================================================
// JOB LOCKS (production_job_id, bukan entity_id/order_id)
// =====================================================================
app.post("/v1/lock/acquire", tenantResolver, requireApiKey, requireStaffSession, async (req, res) => {
  const { production_job_id, override_admin_pin } = req.body || {};
  const staffId = req.staffSession.staffId;
  if (!production_job_id) {
    return res.status(400).json({ error: "production_job_id wajib diisi" });
  }

  const client = await pool.connect();
  try {
    const result = await withTenant(client, req.tenantId, async (c) => {
      const staffCheck = await c.query(
        `SELECT role, assigned_stage FROM staff WHERE id = $1 AND is_active = true`,
        [staffId]
      );
      if (staffCheck.rows.length === 0) {
        return { httpStatus: 403, body: { error: "staff tidak ditemukan atau tidak aktif" } };
      }
      const { role, assigned_stage } = staffCheck.rows[0];

      const jobCheck = await c.query(
        `SELECT current_stage FROM production_jobs WHERE id = $1`,
        [production_job_id]
      );
      if (jobCheck.rows.length === 0) {
        return { httpStatus: 404, body: { error: "production job tidak ditemukan" } };
      }

      if (role !== "admin") {
        if (jobCheck.rows[0].current_stage !== assigned_stage) {
          return {
            httpStatus: 403,
            body: {
              error: "job ini bukan bagian kerjamu",
              your_stage: assigned_stage,
              job_stage: jobCheck.rows[0].current_stage,
            },
          };
        }

        const otherLock = await c.query(
          `SELECT production_job_id FROM job_locks
           WHERE locked_by_staff_id = $1 AND production_job_id != $2 AND released_at IS NULL`,
          [staffId, production_job_id]
        );
        if (otherLock.rows.length > 0) {
          if (!override_admin_pin) {
            return {
              httpStatus: 409,
              body: {
                error: "kamu masih pegang job lain, selesaikan atau lepas dulu",
                active_job: otherLock.rows[0].production_job_id,
              },
            };
          }
          const adminCheck = await c.query(
            `SELECT id, full_name FROM staff WHERE role = 'admin' AND is_active = true AND pin_hash = crypt($1, pin_hash)`,
            [override_admin_pin]
          );
          if (adminCheck.rows.length === 0) {
            return { httpStatus: 403, body: { error: "PIN admin salah" } };
          }
          console.log(`OVERRIDE: staff ${staffId} acquire job baru ${production_job_id} sambil masih pegang ${otherLock.rows[0].production_job_id}, disetujui admin ${adminCheck.rows[0].full_name}`);
        }
      }

      // Cegah double-active-lock: cek eksplisit, jangan andalkan unique
      // constraint (released_at NULL dianggap "distinct" oleh Postgres
      // secara default, jadi unique constraint TIDAK cukup buat ini).
      const activeLock = await c.query(
        `SELECT jl.locked_by_staff_id, s.full_name, jl.locked_at
         FROM job_locks jl JOIN staff s ON s.id = jl.locked_by_staff_id
         WHERE jl.production_job_id = $1 AND jl.released_at IS NULL`,
        [production_job_id]
      );
      if (activeLock.rows.length > 0) {
        return {
          httpStatus: 409,
          body: {
            error: "job sedang dikerjakan orang lain",
            locked_by: activeLock.rows[0].full_name,
            locked_at: activeLock.rows[0].locked_at,
          },
        };
      }

      const inserted = await c.query(
        `INSERT INTO job_locks (tenant_id, production_job_id, locked_by_staff_id)
         VALUES ($1, $2, $3) RETURNING *`,
        [req.tenantId, production_job_id, staffId]
      );

      await c.query(
        `INSERT INTO work_log (tenant_id, production_job_id, staff_id, stage, action)
         VALUES ($1, $2, $3, $4, 'started')`,
        [req.tenantId, production_job_id, staffId, jobCheck.rows[0].current_stage]
      );

      return { httpStatus: 200, body: { ok: true, lock: inserted.rows[0] } };
    });

    res.status(result.httpStatus).json(result.body);
  } catch (err) {
    console.error("lock acquire error:", err);
    res.status(500).json({ error: "internal error" });
  } finally {
    client.release();
  }
});

app.post("/v1/lock/release", tenantResolver, requireApiKey, requireStaffSession, async (req, res) => {
  const { production_job_id } = req.body || {};
  const staffId = req.staffSession.staffId;
  if (!production_job_id) {
    return res.status(400).json({ error: "production_job_id wajib diisi" });
  }

  const client = await pool.connect();
  try {
    const result = await withTenant(client, req.tenantId, async (c) => {
      const released = await c.query(
        `UPDATE job_locks SET released_at = now()
         WHERE production_job_id = $1 AND locked_by_staff_id = $2 AND released_at IS NULL
         RETURNING *`,
        [production_job_id, staffId]
      );
      if (released.rows.length === 0) {
        return { httpStatus: 409, body: { error: "lock tidak ditemukan atau bukan milik staff ini" } };
      }

      const jobRow = await c.query(`SELECT current_stage FROM production_jobs WHERE id = $1`, [production_job_id]);

      await c.query(
        `INSERT INTO work_log (tenant_id, production_job_id, staff_id, stage, action)
         VALUES ($1, $2, $3, $4, 'completed')`,
        [req.tenantId, production_job_id, staffId, jobRow.rows[0]?.current_stage || null]
      );

      return { httpStatus: 200, body: { ok: true, released: released.rows[0] } };
    });

    res.status(result.httpStatus).json(result.body);
  } catch (err) {
    console.error("lock release error:", err);
    res.status(500).json({ error: "internal error" });
  } finally {
    client.release();
  }
});

app.post("/v1/lock/force-unlock", tenantResolver, requireApiKey, requireStaffSession, async (req, res) => {
  if (req.staffSession.role !== "admin") {
    return res.status(403).json({ error: "hanya admin yang bisa force-unlock" });
  }
  const { production_job_id } = req.body || {};
  const adminStaffId = req.staffSession.staffId;
  if (!production_job_id) {
    return res.status(400).json({ error: "production_job_id wajib diisi" });
  }

  const client = await pool.connect();
  try {
    const result = await withTenant(client, req.tenantId, async (c) => {
      const released = await c.query(
        `UPDATE job_locks SET released_at = now(), admin_override = true
         WHERE production_job_id = $1 AND released_at IS NULL
         RETURNING *`,
        [production_job_id]
      );
      if (released.rows.length === 0) {
        return { httpStatus: 404, body: { error: "tidak ada lock aktif untuk job ini" } };
      }

      await c.query(
        `INSERT INTO work_log (tenant_id, production_job_id, staff_id, stage, action)
         VALUES ($1, $2, $3, 'unknown', 'force_unlock')`,
        [req.tenantId, production_job_id, adminStaffId]
      );

      console.log(`FORCE-UNLOCK: job ${production_job_id} dipaksa unlock oleh admin ${adminStaffId}, sebelumnya dikunci oleh ${released.rows[0].locked_by_staff_id}`);
      return { httpStatus: 200, body: { ok: true, unlocked: released.rows[0] } };
    });

    res.status(result.httpStatus).json(result.body);
  } catch (err) {
    console.error("force-unlock error:", err);
    res.status(500).json({ error: "internal error" });
  } finally {
    client.release();
  }
});

// =====================================================================
// STAGE QUANTITY SUBMISSIONS -- QC 2-pihak (bagian 57)
// Staff submit qty hasil kerja di stage-nya. Boleh berkali-kali per
// job+stage (menutup kasus lupa setor / nemu belakangan). Tidak
// otomatis majuin stage -- itu terjadi saat QC confirm (endpoint lain).
// =====================================================================
app.post("/v1/stage-submissions", tenantResolver, requireApiKey, requireStaffSession, async (req, res) => {
  const { production_job_id, stage_key, qty_submitted } = req.body || {};
  const staffId = req.staffSession.staffId;

  if (!production_job_id || !stage_key || qty_submitted === undefined) {
    return res.status(400).json({ error: "production_job_id, stage_key, dan qty_submitted wajib diisi" });
  }
  const qty = Number(qty_submitted);
  if (!Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({ error: "qty_submitted harus angka lebih besar dari 0" });
  }

  const client = await pool.connect();
  try {
    const result = await withTenant(client, req.tenantId, async (c) => {
      const staffCheck = await c.query(
        `SELECT id, assigned_stage FROM staff WHERE id = $1 AND is_active = true`,
        [staffId]
      );
      if (staffCheck.rows.length === 0) {
        return { httpStatus: 403, body: { error: "staff tidak ditemukan atau tidak aktif" } };
      }
      if (staffCheck.rows[0].assigned_stage !== stage_key) {
        return {
          httpStatus: 403,
          body: { error: "staff ini tidak ditugaskan untuk stage tersebut", assigned_stage: staffCheck.rows[0].assigned_stage },
        };
      }

      const jobCheck = await c.query(
        `SELECT current_stage, pipeline_snapshot FROM production_jobs WHERE id = $1`,
        [production_job_id]
      );
      if (jobCheck.rows.length === 0) {
        return { httpStatus: 404, body: { error: "production job tidak ditemukan" } };
      }
      const stageKeys = (jobCheck.rows[0].pipeline_snapshot || []).map((s) => s.stage_key);
      if (!stageKeys.includes(stage_key)) {
        return { httpStatus: 400, body: { error: "stage_key tidak dikenal di pipeline job ini", allowed: stageKeys } };
      }
      if (jobCheck.rows[0].current_stage !== stage_key) {
        return {
          httpStatus: 403,
          body: { error: "stage_key tidak cocok dengan stage job saat ini", job_stage: jobCheck.rows[0].current_stage, sent_stage: stage_key },
        };
      }

      const insertRes = await c.query(
        `INSERT INTO stage_quantity_submissions
           (tenant_id, production_job_id, stage_key, qty_submitted, submitted_by_staff_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, status, submitted_at`,
        [req.tenantId, production_job_id, stage_key, qty, staffId]
      );
      return { httpStatus: 201, body: insertRes.rows[0] };
    });
    res.status(result.httpStatus).json(result.body);
  } catch (err) {
    console.error("stage-submissions POST error:", err);
    res.status(500).json({ error: "internal error" });
  } finally {
    client.release();
  }
});

// =====================================================================
// STAGE QUANTITY SUBMISSIONS -- QC confirm (bagian 57 lanjutan)
// QC confirm per submission satu-satu (bukan digabung). Kalau qty beda
// (discrepancy), status jadi DISCREPANCY tapi stage TETAP maju pakai
// qty_confirmed -- produksi tidak boleh macet menunggu resolusi kasus.
// =====================================================================
app.post("/v1/stage-submissions/:id/confirm", tenantResolver, requireApiKey, requireStaffSession, async (req, res) => {
  const { id } = req.params;
  const { qty_confirmed } = req.body || {};
  const staffId = req.staffSession.staffId;

  if (qty_confirmed === undefined) {
    return res.status(400).json({ error: "qty_confirmed wajib diisi" });
  }
  const qtyConf = Number(qty_confirmed);
  if (!Number.isFinite(qtyConf) || qtyConf < 0) {
    return res.status(400).json({ error: "qty_confirmed harus angka >= 0" });
  }

  const client = await pool.connect();
  let orderId, eventPayload;
  try {
    const result = await withTenant(client, req.tenantId, async (c) => {
      const staffCheck = await c.query(
        `SELECT id, assigned_stage FROM staff WHERE id = $1 AND is_active = true`,
        [staffId]
      );
      if (staffCheck.rows.length === 0) {
        return { httpStatus: 403, body: { error: "staff tidak ditemukan atau tidak aktif" } };
      }
      if (staffCheck.rows[0].assigned_stage !== "qc") {
        return { httpStatus: 403, body: { error: "hanya staff QC yang boleh confirm submission" } };
      }

      const subRes = await c.query(
        `SELECT id, production_job_id, stage_key, qty_submitted, status
         FROM stage_quantity_submissions WHERE id = $1`,
        [id]
      );
      if (subRes.rows.length === 0) {
        return { httpStatus: 404, body: { error: "submission tidak ditemukan" } };
      }
      const sub = subRes.rows[0];
      if (sub.status !== "PENDING_QC") {
        return { httpStatus: 409, body: { error: `submission sudah berstatus ${sub.status}, tidak bisa confirm ulang` } };
      }

      const newStatus = Number(sub.qty_submitted) === qtyConf ? "CONFIRMED" : "DISCREPANCY";

      await c.query(
        `UPDATE stage_quantity_submissions
         SET qty_confirmed = $1, confirmed_by_staff_id = $2, confirmed_at = now(), status = $3
         WHERE id = $4`,
        [qtyConf, staffId, newStatus, id]
      );

      const jobRes = await c.query(`SELECT order_id FROM production_jobs WHERE id = $1`, [sub.production_job_id]);
      if (jobRes.rows.length === 0) {
        return { httpStatus: 404, body: { error: "production_job tidak ditemukan" } };
      }

      return {
        httpStatus: 200,
        body: { id, status: newStatus, qty_submitted: sub.qty_submitted, qty_confirmed: qtyConf },
        _orderId: jobRes.rows[0].order_id,
        _stageKey: sub.stage_key,
        _newStatus: newStatus,
      };
    });

    if (result.httpStatus !== 200) {
      return res.status(result.httpStatus).json(result.body);
    }

    orderId = result._orderId;

    const eventResult = await ingestEvent({
      tenant_id: req.tenantId,
      order_id: orderId,
      event_type: "STAGE_COMPLETED",
      payload: { qty_confirmed: qtyConf, submission_id: id, discrepancy: result._newStatus === "DISCREPANCY" },
      source: "qc_confirm",
    });

    if (eventResult.httpStatus >= 400) {
      console.error("stage-submissions confirm: stage gagal maju setelah QC confirm", eventResult.body);
      return res.status(200).json({ ...result.body, stage_advance_warning: eventResult.body });
    }

    res.status(200).json(result.body);
  } catch (err) {
    console.error("stage-submissions confirm error:", err);
    res.status(500).json({ error: "internal error" });
  } finally {
    client.release();
  }
});

// =====================================================================
// PRODUCTION STAGE PHOTOS
// Stage divalidasi terhadap pipeline_snapshot job itu sendiri (bukan
// hardcode array), karena pipeline sekarang configurable per tenant.
// =====================================================================
app.post("/v1/photos", tenantResolver, requireApiKey, requireStaffSession, async (req, res) => {
  const { production_job_id, stage, photo_base64 } = req.body || {};
  const staffId = req.staffSession.staffId;

  if (!production_job_id || !stage || !photo_base64) {
    return res.status(400).json({ error: "production_job_id, stage, dan photo_base64 wajib diisi" });
  }

  let buffer;
  try {
    const base64Data = photo_base64.includes(",") ? photo_base64.split(",")[1] : photo_base64;
    buffer = Buffer.from(base64Data, "base64");
  } catch (err) {
    return res.status(400).json({ error: "photo_base64 tidak valid" });
  }
  if (!buffer || buffer.length === 0) {
    return res.status(400).json({ error: "photo_base64 kosong atau tidak valid" });
  }
  const MAX_BYTES = 5 * 1024 * 1024;
  if (buffer.length > MAX_BYTES) {
    return res.status(400).json({ error: "ukuran foto melebihi 5MB" });
  }

  const client = await pool.connect();
  try {
    const checkResult = await withTenant(client, req.tenantId, async (c) => {
      const staffCheck = await c.query(`SELECT id FROM staff WHERE id = $1 AND is_active = true`, [staffId]);
      if (staffCheck.rows.length === 0) {
        return { httpStatus: 403, body: { error: "staff tidak ditemukan atau tidak aktif" } };
      }

      const jobCheck = await c.query(
        `SELECT current_stage, pipeline_snapshot FROM production_jobs WHERE id = $1`,
        [production_job_id]
      );
      if (jobCheck.rows.length === 0) {
        return { httpStatus: 404, body: { error: "production job tidak ditemukan" } };
      }

      const stageKeys = (jobCheck.rows[0].pipeline_snapshot || []).map((s) => s.stage_key);
      if (!stageKeys.includes(stage)) {
        return { httpStatus: 400, body: { error: "stage tidak dikenal di pipeline job ini", allowed: stageKeys } };
      }
      if (jobCheck.rows[0].current_stage !== stage) {
        return {
          httpStatus: 403,
          body: { error: "stage foto tidak cocok dengan stage job saat ini", job_stage: jobCheck.rows[0].current_stage, sent_stage: stage },
        };
      }
      return { httpStatus: 200 };
    });

    if (checkResult.httpStatus !== 200) {
      return res.status(checkResult.httpStatus).json(checkResult.body);
    }

    const storagePath = `${production_job_id}/${stage}-${Date.now()}.jpg`;
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
      console.error("SUPABASE_URL atau SUPABASE_SECRET_KEY belum di-set di environment.");
      return res.status(503).json({ error: "server belum dikonfigurasi (Supabase Storage)" });
    }

    const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/stage-photos/${storagePath}`, {
      method: "POST",
      headers: { apikey: SUPABASE_SECRET_KEY, "Content-Type": "image/jpeg" },
      body: buffer,
    });
    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      console.error("upload foto ke Supabase Storage gagal:", uploadRes.status, errText);
      return res.status(502).json({ error: "gagal upload foto ke storage" });
    }

    const insertResult = await withTenant(client, req.tenantId, (c) =>
      c.query(
        `INSERT INTO production_stage_photos (tenant_id, production_job_id, stage, storage_path, uploaded_by_staff_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [req.tenantId, production_job_id, stage, storagePath, staffId]
      )
    );

    res.json({ ok: true, photo: insertResult.rows[0] });
  } catch (err) {
    console.error("photos error:", err);
    res.status(500).json({ error: "internal error" });
  } finally {
    client.release();
  }
});

// =====================================================================
// REALTIME RELAY
// TODO: nama channel "order_state_changed" belum diverifikasi ulang --
// perlu dicek apakah trigger NOTIFY ini masih ada / masih terpasang ke
// production_jobs di schema v2, atau perlu di-rename. Belum disentuh di
// pass ini karena butuh cek definisi trigger langsung di database.
// =====================================================================
const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/v1/realtime",
  verifyClient: async (info, callback) => {
    try {
      const subdomain = extractSubdomain(info.req.headers.host);
      if (!subdomain) {
        callback(false, 403, "Invalid tenant");
        return;
      }
      const { rows } = await pool.query("SELECT * FROM resolve_tenant_id($1)", [subdomain]);
      if (rows.length === 0 || !rows[0].is_active) {
        callback(false, 403, "Invalid tenant");
        return;
      }
      info.req.tenantId = rows[0].id;
      callback(true);
    } catch (err) {
      console.error("WS tenant validation error:", err.message);
      callback(false, 500, "Internal error");
    }
  },
});

wss.on("connection", (ws, req) => {
  ws.tenantId = req.tenantId;
});

async function setupRealtimeRelay() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL kosong -- realtime relay tidak dijalankan.");
    return;
  }

  let currentClient = null;
  let reconnecting = false;

  const connect = async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    currentClient = client;

    client.on("error", (err) => console.error("listenClient error (pre-ready):", err.message));
    await client.connect();
    await client.query("LISTEN order_state_changed");

    const scheduleReconnect = (reason) => {
      if (reconnecting) return;
      reconnecting = true;
      console.error(`listenClient ${reason}, reconnecting in 5s...`);
      if (currentClient) {
        currentClient.removeAllListeners();
        currentClient.on("error", () => {});
        currentClient.end().catch(() => {});
        currentClient = null;
      }
      setTimeout(() => {
        reconnecting = false;
        connect().catch((err) => {
          console.error("Reconnect gagal:", err.message);
          scheduleReconnect("retry_failed");
        });
      }, 5000);
    };

    client.on("error", (err) => {
      console.error("listenClient error:", err.message);
      scheduleReconnect("error");
    });
    client.on("end", () => scheduleReconnect("disconnected"));
    client.on("notification", (msg) => {
      let payloadTenantId;
      try {
        payloadTenantId = JSON.parse(msg.payload).tenant_id;
      } catch (err) {
        console.error("Gagal parse payload NOTIFY:", err.message);
        return;
      }
      wss.clients.forEach((ws) => {
        if (ws.readyState === ws.OPEN && ws.tenantId === payloadTenantId) {
          ws.send(msg.payload);
        }
      });
    });

    console.log("Realtime relay listening on order_state_changed");
  };

  while (true) {
    try {
      await connect();
      break;
    } catch (err) {
      console.error("Realtime relay initial connect gagal:", err.message);
      await new Promise((res) => setTimeout(res, 5000));
    }
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`Fashion platform gateway running on port ${PORT}`);
  await setupRealtimeRelay();
  startGapMonitor();
  // startBundleSplitReconciler() sengaja belum dipanggil -- masih desain
  // lama (CHECKPOINT bagian 31), akan crash/salah baca tabel kalau
  // dijalankan sekarang. Aktifkan lagi setelah desain child bundle fix.
});
