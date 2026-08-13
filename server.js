const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const { Client } = require("pg");
const path = require("path");
const crypto = require("crypto");

const { pool, withTenant, withTenantAndStaff } = require("./db");
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

// Owner = pemilik tenant, wewenang penuh (setara admin + lebih).
// Semua pengecekan otorisasi "admin-only" WAJIB pakai helper ini,
// bukan bandingin string role langsung -- supaya owner otomatis
// ke-cover di semua titik, tidak perlu tambal manual satu-satu.
const PRIVILEGED_ROLES = ["admin", "owner"];
function isPrivileged(role) {
  return PRIVILEGED_ROLES.includes(role);
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
  if (!isPrivileged(req.staffSession.role)) {
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
  if (!isPrivileged(req.staffSession.role)) {
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

      if (!isPrivileged(role)) {
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
            `SELECT id, full_name FROM staff WHERE role IN ('admin','owner') AND is_active = true AND pin_hash = crypt($1, pin_hash)`,
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
  if (!isPrivileged(req.staffSession.role)) {
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
// STAGE QUANTITY SUBMISSIONS -- confirm dinamis (bagian 57 VERSI FINAL + 61)
// Confirmer TIDAK hardcode "qc" -- ditentukan dinamis dari stage_order
// tenant_pipeline_stages: staff di stage_order berikutnya yang berhak
// confirm. Kalau stage yang disubmit adalah stage kerja TERAKHIR sebelum
// stage terminal (mis. finishing sebelum shipped), confirmer MEMUTAR
// BALIK ke stage yang is_gudang_stage = true (bukan lanjut ke terminal,
// karena stage terminal seperti shipped tidak punya staff/submission).
// Kalau qty beda (discrepancy), status jadi DISCREPANCY tapi stage TETAP
// maju pakai qty_confirmed -- produksi tidak boleh macet menunggu
// resolusi kasus. Ruang diskusi otomatis (Lapis 2) BELUM diimplementasi
// di sini -- menyusul sebagai fitur terpisah (lihat CHECKPOINT bagian 57).
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
    const result = await withTenantAndStaff(client, req.tenantId, staffId, async (c) => {
      const staffCheck = await c.query(
        `SELECT id, assigned_stage FROM staff WHERE id = $1 AND is_active = true`,
        [staffId]
      );
      if (staffCheck.rows.length === 0) {
        return { httpStatus: 403, body: { error: "staff tidak ditemukan atau tidak aktif" } };
      }

      const subRes = await c.query(
        `SELECT id, production_job_id, stage_key, qty_submitted, status, submitted_by_staff_id
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

      const pipelineRes = await c.query(
        `SELECT stage_key, stage_order, is_gudang_stage
         FROM tenant_pipeline_stages WHERE tenant_id = $1 ORDER BY stage_order ASC`,
        [req.tenantId]
      );
      const pipeline = pipelineRes.rows;
      if (pipeline.length === 0) {
        return { httpStatus: 500, body: { error: "tenant_pipeline_stages kosong untuk tenant ini" } };
      }

      const currentRow = pipeline.find((s) => s.stage_key === sub.stage_key);
      if (!currentRow) {
        return { httpStatus: 500, body: { error: `stage_key submission tidak ditemukan di tenant_pipeline_stages: ${sub.stage_key}` } };
      }

      const maxOrder = pipeline[pipeline.length - 1].stage_order;
      const nextOrder = currentRow.stage_order + 1;

      let confirmerRow;
      if (nextOrder >= maxOrder) {
        confirmerRow = pipeline.find((s) => s.is_gudang_stage === true);
        if (!confirmerRow) {
          return { httpStatus: 500, body: { error: "tidak ada stage dengan is_gudang_stage=true di tenant_pipeline_stages, tidak bisa tentukan confirmer wrap-around" } };
        }
      } else {
        confirmerRow = pipeline.find((s) => s.stage_order === nextOrder);
        if (!confirmerRow) {
          return { httpStatus: 500, body: { error: `tidak ada stage dengan stage_order=${nextOrder} di tenant_pipeline_stages` } };
        }
      }

      if (staffCheck.rows[0].assigned_stage !== confirmerRow.stage_key) {
        return {
          httpStatus: 403,
          body: {
            error: "staff ini tidak berhak confirm submission stage tersebut",
            required_stage: confirmerRow.stage_key,
            your_stage: staffCheck.rows[0].assigned_stage,
          },
        };
      }

      const newStatus = Number(sub.qty_submitted) === qtyConf ? "CONFIRMED" : "DISCREPANCY";

      await c.query(
        `UPDATE stage_quantity_submissions
         SET qty_confirmed = $1, confirmed_by_staff_id = $2, confirmed_at = now(), status = $3
         WHERE id = $4`,
        [qtyConf, staffId, newStatus, id]
      );

      // Kalau discrepancy, otomatis bikin kasus + assign mediator paling ringan
      // bebannya (jumlah kasus aktifnya), auto-catat "mediator bergabung" di
      // linimasa. Mediator WAJIB otomatis dari awal kasus (Bagian 74/78), bukan
      // opsional. Kalau tidak ada mediator aktif, eskalasi ke admin (kolom
      // escalated_to_admin sudah ada dari desain awal tabel).
      let discrepancyCaseId = null;
      let joinedCaseMessage = null;
      let mediatorStaffIdForBroadcast = null;
      let caseRowForBroadcast = null;

      if (newStatus === "DISCREPANCY") {
        const mediatorLoadRes = await c.query(
          `SELECT tm.id, tm.staff_id,
                  COUNT(dc.id) FILTER (WHERE dc.status != 'RESOLVED') AS active_count
           FROM tenant_mediators tm
           LEFT JOIN discrepancy_cases dc ON dc.mediator_id = tm.id
           WHERE tm.tenant_id = $1 AND tm.is_active = true
           GROUP BY tm.id, tm.staff_id
           ORDER BY active_count ASC`,
          [req.tenantId]
        );

        if (mediatorLoadRes.rows.length === 0) {
          await c.query(
            `UPDATE stage_quantity_submissions SET escalated_to_admin = true, escalated_at = now() WHERE id = $1`,
            [id]
          );
          console.error(`WARNING: submission ${id} DISCREPANCY tapi tidak ada mediator aktif -- escalated_to_admin`);
        } else {
          const minLoad = mediatorLoadRes.rows[0].active_count;
          const leastLoaded = mediatorLoadRes.rows.filter((r) => r.active_count === minLoad);
          const chosen = leastLoaded[Math.floor(Math.random() * leastLoaded.length)];

          const caseInsertRes = await c.query(
            `INSERT INTO discrepancy_cases
               (tenant_id, stage_quantity_submission_id, production_job_id, submitter_staff_id, receiver_staff_id, mediator_id, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'OPEN')
             RETURNING id, submitter_staff_id, receiver_staff_id, mediator_id, status`,
            [req.tenantId, id, sub.production_job_id, sub.submitted_by_staff_id, staffId, chosen.id]
          );
          const caseRow = caseInsertRes.rows[0];
          discrepancyCaseId = caseRow.id;
          caseRowForBroadcast = caseRow;
          mediatorStaffIdForBroadcast = chosen.staff_id;

          const msgRes = await c.query(
            `INSERT INTO discrepancy_thread_messages
               (tenant_id, discrepancy_case_id, sender_staff_id, message_type, action_subtype, content)
             VALUES ($1, $2, $3, 'mediator_action', 'joined_case', $4)
             RETURNING *`,
            [req.tenantId, discrepancyCaseId, chosen.staff_id, "Mediator otomatis bergabung ke kasus ini."]
          );
          joinedCaseMessage = msgRes.rows[0];
        }
      }

      const jobRes = await c.query(`SELECT order_id FROM production_jobs WHERE id = $1`, [sub.production_job_id]);
      if (jobRes.rows.length === 0) {
        return { httpStatus: 404, body: { error: "production_job tidak ditemukan" } };
      }

      return {
        httpStatus: 200,
        body: {
          id, status: newStatus, qty_submitted: sub.qty_submitted, qty_confirmed: qtyConf,
          discrepancy_case_id: discrepancyCaseId,
        },
        _orderId: jobRes.rows[0].order_id,
        _stageKey: sub.stage_key,
        _newStatus: newStatus,
        _caseRowForBroadcast: caseRowForBroadcast,
        _mediatorStaffIdForBroadcast: mediatorStaffIdForBroadcast,
        _joinedCaseMessage: joinedCaseMessage,
      };
    });

    if (result.httpStatus !== 200) {
      return res.status(result.httpStatus).json(result.body);
    }

    orderId = result._orderId;

    if (result._caseRowForBroadcast && result._joinedCaseMessage) {
      broadcastToDiscrepancyCase(
        req.tenantId, result._caseRowForBroadcast, result._mediatorStaffIdForBroadcast,
        {
          type: "discrepancy_message",
          discrepancy_case_id: result._caseRowForBroadcast.id,
          message: result._joinedCaseMessage,
          photo: null,
        }
      );
    }

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

// POST /v1/discrepancy-cases/:id/messages
// Kirim pesan (text/photo/call_log) ke ruang diskusi kasus discrepancy
app.post("/v1/discrepancy-cases/:id/messages", tenantResolver, requireApiKey, requireStaffSession, async (req, res) => {
  const { id: caseId } = req.params;
  const { message_type, content, call_to_staff_id, storage_path } = req.body || {};
  const { staffId } = req.staffSession;

  const validTypes = ["text", "photo", "call_log"];
  if (!validTypes.includes(message_type)) {
    return res.status(400).json({
      error: 'Jenis pesan gak valid. Pakai "text", "photo", atau "call_log" ya.'
    });
  }
  if (message_type === "text" && !content) {
    return res.status(400).json({ error: "Pesan teksnya kosong nih. Isi dulu baru kirim ya." });
  }
  if (message_type === "photo" && !storage_path) {
    return res.status(400).json({
      error: 'Fotonya mana? Upload dulu lewat /v1/photos, baru kirim storage_path-nya ke sini.'
    });
  }

  const client = await pool.connect();
  try {
    const result = await withTenantAndStaff(client, req.tenantId, staffId, async (c) => {
      const caseResult = await c.query(
        `SELECT id, submitter_staff_id, receiver_staff_id, mediator_id, status
         FROM discrepancy_cases WHERE id = $1`,
        [caseId]
      );
      if (caseResult.rows.length === 0) {
        throw { statusCode: 404, message: "Kasusnya gak ketemu, atau lo emang gak terlibat di kasus ini." };
      }
      const caseRow = caseResult.rows[0];
      if (caseRow.status === "RESOLVED") {
        throw { statusCode: 409, message: "Kasus ini udah kelar (RESOLVED), gak bisa nambah pesan lagi." };
      }

      // Ambil staff_id mediator di dalam transaksi tenant-scoped ini (bukan query
      // terpisah tanpa app.tenant_id -- itu penyebab error UUID kosong sebelumnya).
      let mediatorStaffId = null;
      if (caseRow.mediator_id) {
        const mediatorCheck = await c.query(
          `SELECT staff_id FROM tenant_mediators WHERE id = $1`,
          [caseRow.mediator_id]
        );
        if (mediatorCheck.rows.length > 0) mediatorStaffId = mediatorCheck.rows[0].staff_id;
      }

      if (message_type === "call_log") {
        const isMediator = mediatorStaffId === staffId;
        if (!isMediator) {
          throw {
            statusCode: 403,
            message: "Catatan telpon cuma boleh ditulis penengah, biar netral -- gak bisa dari pihak yang lagi bersengketa."
          };
        }
        if (!call_to_staff_id) {
          throw { statusCode: 400, message: "Catatan telpon butuh tau ini telpon ke siapa (call_to_staff_id)." };
        }
      }

      const msgResult = await c.query(
        `INSERT INTO discrepancy_thread_messages
           (tenant_id, discrepancy_case_id, sender_staff_id, message_type, content, call_to_staff_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [req.tenantId, caseId, staffId, message_type, content || null, call_to_staff_id || null]
      );
      const message = msgResult.rows[0];

      let photo = null;
      if (message_type === "photo") {
        const photoResult = await c.query(
          `INSERT INTO discrepancy_thread_photos
             (tenant_id, message_id, storage_path, uploaded_by_staff_id)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [req.tenantId, message.id, storage_path, staffId]
        );
        photo = photoResult.rows[0];
      }

      return { message, photo, caseRow, mediatorStaffId };
    });

    // Broadcast real-time ke staff yang berhak (submitter/receiver/mediator/owner)
    // yang lagi connect WebSocket -- di luar transaksi DB, gak boleh gagalkan response HTTP
    broadcastToDiscrepancyCase(req.tenantId, result.caseRow, result.mediatorStaffId, {
      type: "discrepancy_message",
      discrepancy_case_id: caseId,
      message: result.message,
      photo: result.photo,
    });

    res.status(201).json({ message: result.message, photo: result.photo });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error("Error POST /v1/discrepancy-cases/:id/messages:", err);
    res.status(500).json({ error: "Waduh, gagal kekirim. Coba cek koneksi lo dan ulangi ya." });
  } finally {
    client.release();
  }
});

// POST /v1/discrepancy-cases/:id/summon-owner
// Panggil owner ke kasus discrepancy yang lagi jalan -- dari pihak yang terlibat
app.post("/v1/discrepancy-cases/:id/summon-owner", tenantResolver, requireApiKey, requireStaffSession, async (req, res) => {
  const { id: caseId } = req.params;
  const { staffId } = req.staffSession;

  const client = await pool.connect();
  try {
    const result = await withTenantAndStaff(client, req.tenantId, staffId, async (c) => {
      const caseResult = await c.query(
        `SELECT dc.id, dc.submitter_staff_id, dc.receiver_staff_id, dc.mediator_id, dc.status,
                tm.staff_id AS mediator_staff_id, s.full_name AS caller_name
         FROM discrepancy_cases dc
         LEFT JOIN tenant_mediators tm ON tm.id = dc.mediator_id
         JOIN staff s ON s.id = $2
         WHERE dc.id = $1`,
        [caseId, staffId]
      );
      if (caseResult.rows.length === 0) {
        throw { statusCode: 404, message: "Kasusnya gak ketemu, atau lo emang gak terlibat di kasus ini." };
      }
      const caseRow = caseResult.rows[0];

      if (caseRow.status === "RESOLVED") {
        throw { statusCode: 409, message: "Kasus ini udah kelar (RESOLVED), gak perlu panggil owner lagi." };
      }

      const isMediator = caseRow.mediator_staff_id === staffId;
      if (!isMediator) {
        throw { statusCode: 403, message: "Cuma mediator (staff kepercayaan) yang bisa manggil owner, biar tetap netral -- bukan dari pihak yang lagi bersengketa." };
      }

      const msgResult = await c.query(
        `INSERT INTO discrepancy_thread_messages
           (tenant_id, discrepancy_case_id, sender_staff_id, message_type, action_subtype, content)
         VALUES ($1, $2, $3, 'mediator_action', 'summoned_owner', $4)
         RETURNING *`,
        [req.tenantId, caseId, staffId, `${caseRow.caller_name} minta bantuan owner buat kasus ini.`]
      );
      const message = msgResult.rows[0];

      const ownersResult = await c.query(
        `SELECT id FROM staff WHERE tenant_id = $1 AND role = 'owner' AND is_active = true`,
        [req.tenantId]
      );

      for (const owner of ownersResult.rows) {
        await c.query(
          `INSERT INTO notifications
             (tenant_id, recipient_staff_id, trigger_type, source_table, source_id, title, body, related_staff_id)
           VALUES ($1, $2, 'discrepancy_summoned_owner', 'discrepancy_cases', $3, $4, $5, $6)`,
          [
            req.tenantId,
            owner.id,
            caseId,
            "Ada yang butuh bantuan kamu",
            `${caseRow.caller_name} manggil kamu buat bantu selesaikan kasus diskusi yang lagi jalan. Yuk dicek sebelum kelamaan nyangkut.`,
            staffId
          ]
        );
      }

      return { message, caseRow, mediatorStaffId: caseRow.mediator_staff_id, ownersNotified: ownersResult.rows.length };
    });

    broadcastToDiscrepancyCase(req.tenantId, result.caseRow, result.mediatorStaffId, {
      type: "discrepancy_message",
      discrepancy_case_id: caseId,
      message: result.message,
      photo: null,
    });

    res.status(201).json({ message: result.message, ownersNotified: result.ownersNotified });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error("Error POST /v1/discrepancy-cases/:id/summon-owner:", err);
    res.status(500).json({ error: "Waduh, gagal manggil owner. Coba cek koneksi lo dan ulangi ya." });
  } finally {
    client.release();
  }
});

// GET /v1/notifications
// Ambil notifikasi milik staff yang lagi login (RLS otomatis batasi punya sendiri)
app.get("/v1/notifications", tenantResolver, requireApiKey, requireStaffSession, async (req, res) => {
  const { staffId } = req.staffSession;
  const client = await pool.connect();
  try {
    const result = await withTenantAndStaff(client, req.tenantId, staffId, (c) =>
      c.query(
        `SELECT n.id, n.trigger_type, n.source_table, n.source_id, n.title, n.body,
                n.read_at, n.created_at,
                s.full_name AS related_staff_name, s.phone_number AS related_staff_phone
         FROM notifications n
         LEFT JOIN staff s ON s.id = n.related_staff_id
         WHERE n.recipient_staff_id = $1
         ORDER BY n.created_at DESC
         LIMIT 50`,
        [staffId]
      )
    );
    const unreadCount = result.rows.filter((n) => !n.read_at).length;
    res.json({ notifications: result.rows, unread_count: unreadCount });
  } catch (err) {
    console.error("notifications list error:", err);
    res.status(500).json({ error: "internal error" });
  } finally {
    client.release();
  }
});

// PATCH /v1/notifications/:id/read
// Tandai 1 notifikasi sudah dibaca
app.patch("/v1/notifications/:id/read", tenantResolver, requireApiKey, requireStaffSession, async (req, res) => {
  const { id: notifId } = req.params;
  const { staffId } = req.staffSession;
  const client = await pool.connect();
  try {
    const result = await withTenantAndStaff(client, req.tenantId, staffId, (c) =>
      c.query(
        `UPDATE notifications SET read_at = now()
         WHERE id = $1 AND read_at IS NULL
         RETURNING id, read_at`,
        [notifId]
      )
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Notifikasi gak ketemu, bukan milik lo, atau udah pernah ditandai dibaca." });
    }
    res.json({ ok: true, notification: result.rows[0] });
  } catch (err) {
    console.error("notification mark-read error:", err);
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

      // Ambil token staff dari query param (?token=...), sama seperti x-staff-token di REST.
      // Dibutuhkan supaya WS tau ini staff siapa, buat filter broadcast per-kasus discrepancy.
      const url = new URL(info.req.url, "http://internal");
      const token = url.searchParams.get("token");
      if (!token) {
        callback(false, 401, "Token staff wajib disertakan (?token=...)");
        return;
      }
      const session = sessionMap.get(token);
      if (!session || session.expiresAt < Date.now()) {
        callback(false, 401, "Sesi kadaluarsa, login ulang");
        return;
      }
      if (session.tenantId !== rows[0].id) {
        callback(false, 403, "Sesi ini bukan untuk tenant ini");
        return;
      }
      info.req.staffId = session.staffId;
      info.req.role = session.role;
      callback(true);
    } catch (err) {
      console.error("WS tenant validation error:", err.message);
      callback(false, 500, "Internal error");
    }
  },
});

wss.on("connection", (ws, req) => {
  ws.tenantId = req.tenantId;
  ws.staffId = req.staffId;
  ws.role = req.role;
  ws.typingCaseId = null; // kasus mana yang lagi diketik staff ini, kalau ada

  ws.on("message", async (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return; // abaikan pesan yang bukan JSON valid
    }
    if (data.type === "typing_start" || data.type === "typing_stop") {
      await handleTypingSignal(ws, data.type, data.discrepancy_case_id);
    }
  });

  ws.on("close", () => {
    // Jaring pengaman: kalau staff lagi "mengetik" terus koneksinya putus
    // (nutup app dsb), otomatis kirim typing_stop biar gak nyangkut selamanya.
    if (ws.typingCaseId) {
      const caseId = ws.typingCaseId;
      getCaseAuthContext(ws.tenantId, ws.staffId, caseId)
        .then((ctx) => {
          if (ctx) {
            broadcastToDiscrepancyCase(
              ws.tenantId, ctx.caseRow, ctx.mediatorStaffId,
              { type: "typing_stop", discrepancy_case_id: caseId, staff_id: ws.staffId },
              ws.staffId
            );
          }
        })
        .catch((err) => console.error("typing cleanup error:", err.message));
    }
  });
});

// Ambil data kasus + mediator staff_id, DI DALAM transaksi tenant+staff-scoped
// (pola aman dari bug RLS Bagian 80). Dipakai buat validasi sinyal typing.
async function getCaseAuthContext(tenantId, staffId, caseId) {
  const client = await pool.connect();
  try {
    return await withTenantAndStaff(client, tenantId, staffId, async (c) => {
      const caseResult = await c.query(
        `SELECT id, submitter_staff_id, receiver_staff_id, mediator_id, status
         FROM discrepancy_cases WHERE id = $1`,
        [caseId]
      );
      if (caseResult.rows.length === 0) return null;
      const caseRow = caseResult.rows[0];
      let mediatorStaffId = null;
      if (caseRow.mediator_id) {
        const medResult = await c.query(
          `SELECT staff_id FROM tenant_mediators WHERE id = $1`,
          [caseRow.mediator_id]
        );
        if (medResult.rows.length > 0) mediatorStaffId = medResult.rows[0].staff_id;
      }
      return { caseRow, mediatorStaffId };
    });
  } finally {
    client.release();
  }
}

// Proses sinyal typing_start/typing_stop dari client, validasi otorisasi,
// terus terusin ke staff lain yang berhak (kecuali si pengirim sendiri).
async function handleTypingSignal(ws, type, discrepancyCaseId) {
  if (!discrepancyCaseId) return;
  try {
    const ctx = await getCaseAuthContext(ws.tenantId, ws.staffId, discrepancyCaseId);
    if (!ctx) return; // gak berhak atau kasus gak ketemu -- diamkan saja, jangan bocorkan info

    ws.typingCaseId = type === "typing_start" ? discrepancyCaseId : null;

    broadcastToDiscrepancyCase(
      ws.tenantId, ctx.caseRow, ctx.mediatorStaffId,
      { type, discrepancy_case_id: discrepancyCaseId, staff_id: ws.staffId },
      ws.staffId
    );
  } catch (err) {
    console.error("handleTypingSignal error:", err.message);
  }
}

// Broadcast pesan thread discrepancy cuma ke staff yang berhak: submitter,
// receiver, mediator kasus itu, atau siapa saja dengan role owner (Bagian 71/76).
// excludeStaffId opsional: kecualikan 1 staff (dipakai typing indicator biar
// pengirim gak lihat "dirinya sendiri lagi mengetik").
function broadcastToDiscrepancyCase(tenantId, caseRow, mediatorStaffId, payload, excludeStaffId) {
  try {
    const allowedStaffIds = new Set(
      [caseRow.submitter_staff_id, caseRow.receiver_staff_id, mediatorStaffId].filter(Boolean)
    );
    const payloadStr = JSON.stringify(payload);
    wss.clients.forEach((ws) => {
      if (ws.readyState !== ws.OPEN || ws.tenantId !== tenantId) return;
      if (excludeStaffId && ws.staffId === excludeStaffId) return;
      const isParty = allowedStaffIds.has(ws.staffId);
      const isOwner = ws.role === "owner";
      if (isParty || isOwner) {
        ws.send(payloadStr);
      }
    });
  } catch (err) {
    console.error("broadcastToDiscrepancyCase error:", err.message);
  }
}

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
