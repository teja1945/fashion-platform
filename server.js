const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const { Client } = require("pg");
const path = require("path");
const crypto = require("crypto");

const { pool, withTenant, withTenantAndStaff } = require("./db");
const { ingestEvent, resolveStageTransition } = require("./ingestion");
const { assignVersionAndStoreInTx } = require("./versioning");
const { startGapMonitor /*, startBundleSplitReconciler */ } = require("./worker");
const tenantResolver = require("./middleware/tenantResolver");
const { extractSubdomain } = require("./middleware/tenantResolver");

const rateLimit = require("express-rate-limit");

const app = express();
app.set("trust proxy", "loopback"); // nginx reverse proxy di localhost yang sama (Bagian 99-100) -- perlu ini biar express-rate-limit (Bagian 111) baca IP client asli, bukan IP nginx
app.use(express.json({ limit: "10mb" }));

// Rate limiter API level umum (checklist keamanan bagian 6, CodeQL alert
// js/missing-rate-limiting -- 23 lokasi, satu akar masalah yang sama:
// tidak ada batas global sebelumnya). Endpoint login PIN sudah punya
// proteksi brute-force terpisah (rateLimitMap, lebih ketat) -- ini lapis
// tambahan yang berlaku ke SEMUA /v1/*, termasuk endpoint yang sebelumnya
// tidak dilindungi apapun.
const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 menit
  max: 300, // 300 request/menit per IP -- longgar untuk staff pabrik yang
            // submit berkali-kali cepat (piece-rate), tapi tetap membatasi
            // spam/bot ekstrem
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "terlalu banyak permintaan, coba lagi sebentar lagi" },
});
app.use("/v1", apiRateLimiter);

app.get("/scanner.html", (_req, res) => res.sendFile(path.join(__dirname, "scanner.html")));
app.use("/assets", express.static(path.join(__dirname, "assets")));

app.get("/v1/whoami", tenantResolver, (req, res) => {
  res.json({ tenantId: req.tenantId, subdomain: req.tenantSubdomain });
});

// =====================================================================
// API KEY per-tenant (P1-2, Bagian 113-114 CHECKPOINT.md) --
// verifikasi via verify_tenant_api_key(), tidak ada lagi API_KEY global.
// =====================================================================
async function requireApiKey(req, res, next) {
  if (!req.tenantId) {
    return res.status(500).json({ error: "Konfigurasi route salah: tenant belum teridentifikasi sebelum cek API key." });
  }

  const providedKey = req.header("x-api-key");
  if (!providedKey) {
    return res.status(401).json({ error: "API key wajib disertakan." });
  }

  try {
    const isValid = await withTenant(pool, req.tenantId, async (c) => {
      const r = await c.query(
        "SELECT verify_tenant_api_key($1, $2) AS valid",
        [req.tenantId, providedKey]
      );
      return r.rows[0]?.valid === true;
    });

    if (!isValid) {
      return res.status(401).json({ error: "API key tidak valid." });
    }
    next();
  } catch (err) {
    console.error("requireApiKey error:", err);
    res.status(500).json({ error: "Gagal verifikasi API key." });
  }
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

app.post("/v1/mediators", tenantResolver, requireApiKey, requireStaffSession, async (req, res) => {
  if (!isPrivileged(req.staffSession.role)) {
    return res.status(403).json({ error: "hanya owner yang bisa menunjuk mediator" });
  }
  const { staff_id, line_scope, has_full_mandate } = req.body || {};
  if (!staff_id) {
    return res.status(400).json({ error: "staff_id wajib diisi" });
  }

  const client = await pool.connect();
  try {
    const result = await withTenant(client, req.tenantId, (c) =>
      c.query(
        `INSERT INTO tenant_mediators
           (tenant_id, staff_id, line_scope, has_full_mandate, is_active, assigned_by)
         VALUES ($1, $2, $3, $4, true, $5)
         ON CONFLICT (tenant_id, staff_id)
         DO UPDATE SET is_active = true, line_scope = $3, has_full_mandate = $4,
                        assigned_by = $5, updated_at = now()
         RETURNING *`,
        [req.tenantId, staff_id, line_scope || null, !!has_full_mandate, req.staffSession.staffId]
      )
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("mediator assign error:", err);
    res.status(500).json({ error: "internal error" });
  } finally {
    client.release();
  }
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

      const orphanPhotos = await c.query(
        `SELECT id FROM production_stage_photos
         WHERE production_job_id = $1 AND stage = $2 AND submission_id IS NULL
         FOR UPDATE`,
        [production_job_id, stage_key]
      );
      if (orphanPhotos.rows.length === 0) {
        return { httpStatus: 400, body: { error: "wajib upload foto bukti terlebih dahulu sebelum submit (POST /v1/photos)" } };
      }

      const insertRes = await c.query(
        `INSERT INTO stage_quantity_submissions
           (tenant_id, production_job_id, stage_key, qty_submitted, submitted_by_staff_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, status, submitted_at`,
        [req.tenantId, production_job_id, stage_key, qty, staffId]
      );
      const newSubmission = insertRes.rows[0];

      await c.query(
        `UPDATE production_stage_photos
         SET submission_id = $1
         WHERE production_job_id = $2 AND stage = $3 AND submission_id IS NULL`,
        [newSubmission.id, production_job_id, stage_key]
      );

      return { httpStatus: 201, body: newSubmission };
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
         FROM stage_quantity_submissions WHERE id = $1
         FOR UPDATE`,
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

      const jobRes = await c.query(
        `SELECT order_id, current_stage, pipeline_snapshot FROM production_jobs WHERE id = $1 FOR UPDATE`,
        [sub.production_job_id]
      );
      if (jobRes.rows.length === 0) {
        return { httpStatus: 404, body: { error: "production_job tidak ditemukan" } };
      }

      // Maju-kan stage produksi DI DALAM transaksi yang sama (atomic dengan
      // update submission/discrepancy di atas) -- kalau bagian ini gagal,
      // SEMUANYA rollback bersama, tidak ada "submission CONFIRMED tapi
      // stage tidak maju" (perbaikan P0-3, audit ChatGPT bagian 105).
      const resolution = resolveStageTransition(
        jobRes.rows[0].pipeline_snapshot,
        jobRes.rows[0].current_stage,
        "STAGE_COMPLETED",
        {}
      );
      if (resolution.error) {
        return { httpStatus: 400, body: { error: `submission tercatat, tapi stage gagal maju: ${resolution.error}` } };
      }

      const eventResult = await assignVersionAndStoreInTx(c, {
        tenantId: req.tenantId,
        productionJobId: sub.production_job_id,
        eventType: "order.stage_changed",
        eventVersion: 1,
        payload: { qty_confirmed: qtyConf, submission_id: id, discrepancy: newStatus === "DISCREPANCY", to_stage: resolution.stage },
      });

      return {
        httpStatus: 200,
        body: {
          id, status: newStatus, qty_submitted: sub.qty_submitted, qty_confirmed: qtyConf,
          discrepancy_case_id: discrepancyCaseId,
          stage_event: { sequence_version: eventResult.sequenceVersion, applied: eventResult.applied, to_stage: resolution.stage },
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

    // Stage sudah dimajukan atomic DI DALAM transaksi di atas (bersama
    // update submission/discrepancy) -- tidak ada lagi panggilan ingestEvent
    // terpisah di sini, dan tidak ada lagi kemungkinan "submission CONFIRMED
    // tapi stage gagal maju diam-diam" (P0-3, audit ChatGPT bagian 105).
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
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_REGEX.test(production_job_id)) {
    return res.status(400).json({ error: "production_job_id harus berupa UUID yang valid" });
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
  if (buffer.length < 3 || buffer[0] !== 0xFF || buffer[1] !== 0xD8 || buffer[2] !== 0xFF) {
    return res.status(400).json({ error: "file bukan JPEG yang valid (magic byte tidak cocok)" });
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

    let insertResult;
    try {
      insertResult = await withTenant(client, req.tenantId, (c) =>
        c.query(
          `INSERT INTO production_stage_photos (tenant_id, production_job_id, stage, storage_path, uploaded_by_staff_id)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [req.tenantId, production_job_id, stage, storagePath, staffId]
        )
      );
    } catch (insertErr) {
      console.error("photos: INSERT gagal setelah upload sukses, mencoba rollback storage:", insertErr.message);
      try {
        const rollbackRes = await fetch(`${SUPABASE_URL}/storage/v1/object/stage-photos/${storagePath}`, {
          method: "DELETE",
          headers: { apikey: SUPABASE_SECRET_KEY },
        });
        if (!rollbackRes.ok) {
          console.error(`photos: rollback storage GAGAL untuk ${storagePath}, file orphan tertinggal. Status: ${rollbackRes.status}`);
        } else {
          console.warn(`photos: rollback storage sukses untuk ${storagePath} setelah INSERT gagal.`);
        }
      } catch (rollbackErr) {
        console.error(`photos: rollback storage GAGAL (exception) untuk ${storagePath}, file orphan tertinggal:`, rollbackErr.message);
      }
      throw insertErr;
    }

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


// POST /v1/discrepancy-cases/:id/resolution
// Mediator nulis (atau revisi) kesimpulan penyelesaian kasus discrepancy
app.post("/v1/discrepancy-cases/:id/resolution", tenantResolver, requireApiKey, requireStaffSession, async (req, res) => {
  const { id: caseId } = req.params;
  const { resolution_notes } = req.body || {};
  const { staffId } = req.staffSession;

  if (!resolution_notes || !resolution_notes.trim()) {
    return res.status(400).json({ error: "Kesimpulannya kosong nih. Tulis dulu baru kirim ya." });
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
        throw { statusCode: 409, message: "Kasus ini udah kelar (RESOLVED), gak bisa diubah lagi." };
      }

      let mediatorStaffId = null;
      if (caseRow.mediator_id) {
        const mediatorCheck = await c.query(
          `SELECT staff_id FROM tenant_mediators WHERE id = $1`,
          [caseRow.mediator_id]
        );
        if (mediatorCheck.rows.length > 0) mediatorStaffId = mediatorCheck.rows[0].staff_id;
      }

      const isMediator = mediatorStaffId === staffId;
      if (!isMediator) {
        throw {
          statusCode: 403,
          message: "Kesimpulan cuma boleh ditulis penengah, biar netral -- gak bisa dari pihak yang lagi bersengketa."
        };
      }

      const priorResult = await c.query(
        `SELECT id FROM discrepancy_thread_messages
         WHERE discrepancy_case_id = $1 AND action_subtype IN ('resolution_written', 'resolution_revised')
         ORDER BY created_at DESC LIMIT 1`,
        [caseId]
      );
      const isRevision = priorResult.rows.length > 0;
      const priorMessageId = isRevision ? priorResult.rows[0].id : null;

      const msgResult = await c.query(
        `INSERT INTO discrepancy_thread_messages
           (tenant_id, discrepancy_case_id, sender_staff_id, message_type, action_subtype, content, corrects_message_id)
         VALUES ($1, $2, $3, 'mediator_action', $4, $5, $6)
         RETURNING *`,
        [
          req.tenantId,
          caseId,
          staffId,
          isRevision ? "resolution_revised" : "resolution_written",
          resolution_notes.trim(),
          priorMessageId
        ]
      );
      const message = msgResult.rows[0];

      const updateResult = await c.query(
        `UPDATE discrepancy_cases
         SET resolution_notes = $1,
             submitter_confirmed_at = NULL,
             receiver_confirmed_at = NULL,
             status = CASE WHEN status = 'OPEN' THEN 'IN_DISCUSSION' ELSE status END
         WHERE id = $2
         RETURNING submitter_staff_id, receiver_staff_id, status`,
        [resolution_notes.trim(), caseId]
      );
      const updatedCase = updateResult.rows[0];

      const notifyTitle = isRevision
        ? "Kesimpulan direvisi, tolong konfirmasi ulang"
        : "Ada kesimpulan dari penengah, tolong konfirmasi";
      const notifyBody = isRevision
        ? "Penengah baru aja ngerevisi kesimpulan kasus diskusi kamu. Konfirmasi ulang persetujuan kamu ya."
        : "Penengah udah kasih kesimpulan buat kasus diskusi kamu. Cek dan konfirmasi persetujuan kamu ya.";

      const recipients = [updatedCase.submitter_staff_id, updatedCase.receiver_staff_id];
      for (const recipientId of recipients) {
        await c.query(
          `INSERT INTO notifications
             (tenant_id, recipient_staff_id, trigger_type, source_table, source_id, title, body, related_staff_id)
           VALUES ($1, $2, 'discrepancy_resolution_written', 'discrepancy_cases', $3, $4, $5, $6)`,
          [req.tenantId, recipientId, caseId, notifyTitle, notifyBody, staffId]
        );
      }

      return { message, caseRow: { ...caseRow, ...updatedCase }, mediatorStaffId, isRevision };
    });

    broadcastToDiscrepancyCase(req.tenantId, result.caseRow, result.mediatorStaffId, {
      type: "discrepancy_message",
      discrepancy_case_id: caseId,
      message: result.message,
      photo: null,
    });

    res.status(201).json({ message: result.message, isRevision: result.isRevision });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error("Error POST /v1/discrepancy-cases/:id/resolution:", err);
    res.status(500).json({ error: "Waduh, gagal kesimpen. Coba cek koneksi lo dan ulangi ya." });
  } finally {
    client.release();
  }
});


// POST /v1/discrepancy-cases/:id/confirm
// Submitter atau receiver menyetujui resolution_notes yang ditulis mediator.
// Kalau keduanya sudah confirm, kasus otomatis jadi RESOLVED (kesepakatan bersama, bukan mandat mediator).
app.post("/v1/discrepancy-cases/:id/confirm", tenantResolver, requireApiKey, requireStaffSession, async (req, res) => {
  const { id: caseId } = req.params;
  const { staffId } = req.staffSession;

  const client = await pool.connect();
  try {
    const result = await withTenantAndStaff(client, req.tenantId, staffId, async (c) => {
      const caseResult = await c.query(
        `SELECT id, submitter_staff_id, receiver_staff_id, mediator_id, status, resolution_notes,
                submitter_confirmed_at, receiver_confirmed_at
         FROM discrepancy_cases WHERE id = $1`,
        [caseId]
      );
      if (caseResult.rows.length === 0) {
        throw { statusCode: 404, message: "Kasusnya gak ketemu, atau lo emang gak terlibat di kasus ini." };
      }
      const caseRow = caseResult.rows[0];
      if (caseRow.status === "RESOLVED") {
        throw { statusCode: 409, message: "Kasus ini udah kelar (RESOLVED), gak perlu konfirmasi lagi." };
      }
      if (!caseRow.resolution_notes || !caseRow.resolution_notes.trim()) {
        throw { statusCode: 409, message: "Belum ada kesimpulan dari penengah. Tunggu penengah nulis kesimpulan dulu ya." };
      }

      const isSubmitter = caseRow.submitter_staff_id === staffId;
      const isReceiver = caseRow.receiver_staff_id === staffId;
      if (!isSubmitter && !isReceiver) {
        throw {
          statusCode: 403,
          message: "Konfirmasi cuma boleh dari pihak yang bersengketa (yang ngirim atau yang nerima barang)."
        };
      }

      const confirmColumn = isSubmitter ? "submitter_confirmed_at" : "receiver_confirmed_at";
      const alreadyConfirmed = isSubmitter ? caseRow.submitter_confirmed_at : caseRow.receiver_confirmed_at;
      if (alreadyConfirmed) {
        throw { statusCode: 409, message: "Lo udah konfirmasi kesimpulan ini sebelumnya." };
      }

      let mediatorStaffId = null;
      if (caseRow.mediator_id) {
        const mediatorCheck = await c.query(
          `SELECT staff_id FROM tenant_mediators WHERE id = $1`,
          [caseRow.mediator_id]
        );
        if (mediatorCheck.rows.length > 0) mediatorStaffId = mediatorCheck.rows[0].staff_id;
      }

      const roleLabel = isSubmitter ? "Submitter" : "Receiver";
      const msgResult = await c.query(
        `INSERT INTO discrepancy_thread_messages
           (tenant_id, discrepancy_case_id, sender_staff_id, message_type, action_subtype, content)
         VALUES ($1, $2, $3, 'party_action', 'confirmed_resolution', $4)
         RETURNING *`,
        [req.tenantId, caseId, staffId, `${roleLabel} menyetujui kesimpulan penyelesaian.`]
      );
      const message = msgResult.rows[0];

      const otherAlreadyConfirmed = isSubmitter ? caseRow.receiver_confirmed_at : caseRow.submitter_confirmed_at;
      const bothConfirmed = !!otherAlreadyConfirmed;

      const updateResult = await c.query(
        `UPDATE discrepancy_cases
         SET ${confirmColumn} = NOW(),
             status = CASE WHEN $2 THEN 'RESOLVED' ELSE status END,
             resolved_at = CASE WHEN $2 THEN NOW() ELSE resolved_at END,
             resolved_by_staff_id = CASE WHEN $2 THEN $3 ELSE resolved_by_staff_id END,
             resolved_with_mandate = CASE WHEN $2 THEN false ELSE resolved_with_mandate END
         WHERE id = $1
         RETURNING submitter_staff_id, receiver_staff_id, status`,
        [caseId, bothConfirmed, staffId]
      );
      const updatedCase = updateResult.rows[0];

      if (bothConfirmed) {
        const recipients = [updatedCase.submitter_staff_id, updatedCase.receiver_staff_id, mediatorStaffId].filter(
          (id) => id && id !== staffId
        );
        for (const recipientId of recipients) {
          await c.query(
            `INSERT INTO notifications
               (tenant_id, recipient_staff_id, trigger_type, source_table, source_id, title, body, related_staff_id)
             VALUES ($1, $2, 'discrepancy_resolved', 'discrepancy_cases', $3, $4, $5, $6)`,
            [
              req.tenantId,
              recipientId,
              caseId,
              "Kasus diskusi sudah selesai",
              "Kedua pihak sudah setuju sama kesimpulan penengah. Kasus ini resmi ditutup.",
              staffId
            ]
          );
        }
      } else {
        const otherPartyId = isSubmitter ? updatedCase.receiver_staff_id : updatedCase.submitter_staff_id;
        await c.query(
          `INSERT INTO notifications
             (tenant_id, recipient_staff_id, trigger_type, source_table, source_id, title, body, related_staff_id)
           VALUES ($1, $2, 'discrepancy_confirmed', 'discrepancy_cases', $3, $4, $5, $6)`,
          [
            req.tenantId,
            otherPartyId,
            caseId,
            `${roleLabel} sudah konfirmasi`,
            "Salah satu pihak sudah setuju sama kesimpulan penengah. Giliran kamu konfirmasi juga ya.",
            staffId
          ]
        );
      }

      return { message, caseRow: { ...caseRow, ...updatedCase }, mediatorStaffId, bothConfirmed };
    });

    broadcastToDiscrepancyCase(req.tenantId, result.caseRow, result.mediatorStaffId, {
      type: "discrepancy_message",
      discrepancy_case_id: caseId,
      message: result.message,
      photo: null,
    });

    res.status(201).json({ message: result.message, resolved: result.bothConfirmed });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error("Error POST /v1/discrepancy-cases/:id/confirm:", err);
    res.status(500).json({ error: "Waduh, gagal kekirim konfirmasinya. Coba cek koneksi lo dan ulangi ya." });
  } finally {
    client.release();
  }
});


// POST /v1/discrepancy-cases/:id/force-resolve
// Mediator memutus sepihak kasus severity NORMAL, walau salah satu/kedua pihak belum/tidak setuju.
// Kasus severity SERIOUS wajib eskalasi ke owner (endpoint terpisah), tidak bisa lewat sini.
app.post("/v1/discrepancy-cases/:id/force-resolve", tenantResolver, requireApiKey, requireStaffSession, async (req, res) => {
  const { id: caseId } = req.params;
  const { staffId } = req.staffSession;

  const client = await pool.connect();
  try {
    const result = await withTenantAndStaff(client, req.tenantId, staffId, async (c) => {
      const caseResult = await c.query(
        `SELECT id, submitter_staff_id, receiver_staff_id, mediator_id, status, severity, resolution_notes
         FROM discrepancy_cases WHERE id = $1`,
        [caseId]
      );
      if (caseResult.rows.length === 0) {
        throw { statusCode: 404, message: "Kasusnya gak ketemu, atau lo emang gak terlibat di kasus ini." };
      }
      const caseRow = caseResult.rows[0];
      if (caseRow.status === "RESOLVED") {
        throw { statusCode: 409, message: "Kasus ini udah kelar (RESOLVED), gak bisa diproses lagi." };
      }
      if (caseRow.severity === "SERIOUS") {
        throw {
          statusCode: 403,
          message: "Kasus severity SERIOUS gak bisa diputus sepihak. Wajib eskalasi ke owner ya."
        };
      }
      if (!caseRow.resolution_notes || !caseRow.resolution_notes.trim()) {
        throw { statusCode: 409, message: "Belum ada kesimpulan yang ditulis. Tulis kesimpulan dulu sebelum memutus." };
      }

      let mediatorStaffId = null;
      if (caseRow.mediator_id) {
        const mediatorCheck = await c.query(
          `SELECT staff_id FROM tenant_mediators WHERE id = $1`,
          [caseRow.mediator_id]
        );
        if (mediatorCheck.rows.length > 0) mediatorStaffId = mediatorCheck.rows[0].staff_id;
      }

      const isMediator = mediatorStaffId === staffId;
      if (!isMediator) {
        throw {
          statusCode: 403,
          message: "Cuma penengah kasus ini yang bisa memutus sepihak, biar tetap netral."
        };
      }

      const msgResult = await c.query(
        `INSERT INTO discrepancy_thread_messages
           (tenant_id, discrepancy_case_id, sender_staff_id, message_type, action_subtype, content)
         VALUES ($1, $2, $3, 'mediator_action', 'force_resolved', $4)
         RETURNING *`,
        [
          req.tenantId,
          caseId,
          staffId,
          "Penengah memutus kasus ini secara sepihak berdasarkan kesimpulan yang sudah ditulis, tanpa menunggu persetujuan penuh kedua pihak."
        ]
      );
      const message = msgResult.rows[0];

      const updateResult = await c.query(
        `UPDATE discrepancy_cases
         SET status = 'RESOLVED',
             resolved_at = NOW(),
             resolved_by_staff_id = $2,
             resolved_with_mandate = true
         WHERE id = $1
         RETURNING submitter_staff_id, receiver_staff_id, status`,
        [caseId, staffId]
      );
      const updatedCase = updateResult.rows[0];

      const recipients = [updatedCase.submitter_staff_id, updatedCase.receiver_staff_id];
      for (const recipientId of recipients) {
        await c.query(
          `INSERT INTO notifications
             (tenant_id, recipient_staff_id, trigger_type, source_table, source_id, title, body, related_staff_id)
           VALUES ($1, $2, 'discrepancy_force_resolved', 'discrepancy_cases', $3, $4, $5, $6)`,
          [
            req.tenantId,
            recipientId,
            caseId,
            "Kasus diputus penengah",
            "Penengah sudah memutus kasus diskusi ini berdasarkan kesimpulan yang ditulis, meski belum ada persetujuan penuh dari kedua pihak. Kasus ini resmi ditutup.",
            staffId
          ]
        );
      }

      return { message, caseRow: { ...caseRow, ...updatedCase }, mediatorStaffId };
    });

    broadcastToDiscrepancyCase(req.tenantId, result.caseRow, result.mediatorStaffId, {
      type: "discrepancy_message",
      discrepancy_case_id: caseId,
      message: result.message,
      photo: null,
    });

    res.status(201).json({ message: result.message });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error("Error POST /v1/discrepancy-cases/:id/force-resolve:", err);
    res.status(500).json({ error: "Waduh, gagal memutus kasusnya. Coba cek koneksi lo dan ulangi ya." });
  } finally {
    client.release();
  }
});


// POST /v1/discrepancy-cases/:id/owner-resolve
// Owner memutus kasus discrepancy (severity apapun), pakai wewenang penuh pemilik tenant.
// Owner boleh pakai resolution_notes yang sudah ada, atau nulis kesimpulannya sendiri.
app.post("/v1/discrepancy-cases/:id/owner-resolve", tenantResolver, requireApiKey, requireStaffSession, async (req, res) => {
  const { id: caseId } = req.params;
  const { resolution_notes } = req.body || {};
  const { staffId, role } = req.staffSession;

  if (!isPrivileged(role)) {
    return res.status(403).json({ error: "Cuma owner yang bisa memutus kasus lewat sini." });
  }

  const client = await pool.connect();
  try {
    const result = await withTenantAndStaff(client, req.tenantId, staffId, async (c) => {
      const caseResult = await c.query(
        `SELECT id, submitter_staff_id, receiver_staff_id, mediator_id, status, resolution_notes
         FROM discrepancy_cases WHERE id = $1`,
        [caseId]
      );
      if (caseResult.rows.length === 0) {
        throw { statusCode: 404, message: "Kasusnya gak ketemu." };
      }
      const caseRow = caseResult.rows[0];
      if (caseRow.status === "RESOLVED") {
        throw { statusCode: 409, message: "Kasus ini udah kelar (RESOLVED), gak bisa diproses lagi." };
      }

      const ownerWroteNew = resolution_notes && resolution_notes.trim();
      const finalNotes = ownerWroteNew ? resolution_notes.trim() : caseRow.resolution_notes;
      if (!finalNotes || !finalNotes.trim()) {
        throw {
          statusCode: 400,
          message: "Belum ada kesimpulan sama sekali. Tulis kesimpulannya dulu ya (lewat resolution_notes)."
        };
      }

      let mediatorStaffId = null;
      if (caseRow.mediator_id) {
        const mediatorCheck = await c.query(
          `SELECT staff_id FROM tenant_mediators WHERE id = $1`,
          [caseRow.mediator_id]
        );
        if (mediatorCheck.rows.length > 0) mediatorStaffId = mediatorCheck.rows[0].staff_id;
      }

      const msgResult = await c.query(
        `INSERT INTO discrepancy_thread_messages
           (tenant_id, discrepancy_case_id, sender_staff_id, message_type, action_subtype, content)
         VALUES ($1, $2, $3, 'owner_action', 'owner_resolved', $4)
         RETURNING *`,
        [req.tenantId, caseId, staffId, finalNotes]
      );
      const message = msgResult.rows[0];

      const updateResult = await c.query(
        `UPDATE discrepancy_cases
         SET resolution_notes = $1,
             status = 'RESOLVED',
             resolved_at = NOW(),
             resolved_by_staff_id = $2,
             resolved_with_mandate = true
         WHERE id = $3
         RETURNING submitter_staff_id, receiver_staff_id, status`,
        [finalNotes, staffId, caseId]
      );
      const updatedCase = updateResult.rows[0];

      const recipients = [updatedCase.submitter_staff_id, updatedCase.receiver_staff_id, mediatorStaffId].filter(
        (id) => id && id !== staffId
      );
      for (const recipientId of recipients) {
        await c.query(
          `INSERT INTO notifications
             (tenant_id, recipient_staff_id, trigger_type, source_table, source_id, title, body, related_staff_id)
           VALUES ($1, $2, 'discrepancy_owner_resolved', 'discrepancy_cases', $3, $4, $5, $6)`,
          [
            req.tenantId,
            recipientId,
            caseId,
            "Kasus diputus owner",
            "Owner sudah memutus kasus diskusi ini secara final. Kasus ini resmi ditutup.",
            staffId
          ]
        );
      }

      return { message, caseRow: { ...caseRow, ...updatedCase }, mediatorStaffId };
    });

    broadcastToDiscrepancyCase(req.tenantId, result.caseRow, result.mediatorStaffId, {
      type: "discrepancy_message",
      discrepancy_case_id: caseId,
      message: result.message,
      photo: null,
    });

    res.status(201).json({ message: result.message });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error("Error POST /v1/discrepancy-cases/:id/owner-resolve:", err);
    res.status(500).json({ error: "Waduh, gagal memutus kasusnya. Coba cek koneksi lo dan ulangi ya." });
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
      // Identitas staff (token) SENGAJA TIDAK dicek di sini (P1-3, CHECKPOINT
      // Bagian 114) -- token tidak boleh lewat query string URL karena
      // berisiko kerekam di access log. Verifikasi staff dipindah ke pesan
      // pertama setelah koneksi terbuka, lihat wss.on("connection", ...).
      callback(true);
    } catch (err) {
      console.error("WS tenant validation error:", err.message);
      callback(false, 500, "Internal error");
    }
  },
});

// P1-3: token staff tidak lagi lewat query string (?token=...) saat handshake.
// Alur baru: koneksi dibuka dulu tanpa identitas staff, client WAJIB kirim
// pesan pertama {type: "auth", token: "..."} dalam WS_AUTH_TIMEOUT_MS,
// baru boleh kirim pesan lain. Selama koneksi hidup, sesi dicek ulang tiap
// WS_SESSION_RECHECK_MS supaya Revoke/Offboard (endpoint REST yang sudah
// ada) ikut efektif memutus koneksi live, bukan cuma REST call baru.
const WS_AUTH_TIMEOUT_MS = 5000;
const WS_SESSION_RECHECK_MS = 30000;

wss.on("connection", (ws, req) => {
  ws.tenantId = req.tenantId;
  ws.staffId = null;
  ws.role = null;
  ws.authToken = null;
  ws.authenticated = false;
  ws.typingCaseId = null; // kasus mana yang lagi diketik staff ini, kalau ada
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  let recheckInterval = null;

  const authTimeout = setTimeout(() => {
    if (!ws.authenticated) {
      console.log(`WS: koneksi ditutup, tidak auth dalam ${WS_AUTH_TIMEOUT_MS}ms (tenant ${ws.tenantId})`);
      ws.close(4001, "auth timeout");
    }
  }, WS_AUTH_TIMEOUT_MS);

  ws.on("message", async (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return; // abaikan pesan yang bukan JSON valid
    }

    if (!ws.authenticated) {
      if (data.type !== "auth" || !data.token) {
        return; // pesan pertama wajib auth, abaikan pesan lain sebelum itu
      }
      const session = sessionMap.get(data.token);
      if (!session || session.expiresAt < Date.now()) {
        console.log(`WS: auth gagal (sesi tidak ditemukan/kadaluarsa), tenant ${ws.tenantId}`);
        ws.close(4001, "auth gagal");
        return;
      }
      if (session.tenantId !== ws.tenantId) {
        console.log(`WS: auth gagal (sesi bukan untuk tenant ini), tenant ${ws.tenantId}`);
        ws.close(4001, "auth gagal");
        return;
      }
      // Refresh TTL, konsisten dengan pola requireStaffSession di REST.
      session.expiresAt = Date.now() + SESSION_TTL_MS;
      ws.staffId = session.staffId;
      ws.role = session.role;
      ws.authToken = data.token;
      ws.authenticated = true;
      clearTimeout(authTimeout);

      recheckInterval = setInterval(() => {
        const s = sessionMap.get(ws.authToken);
        if (!s || s.expiresAt < Date.now()) {
          console.log(`WS: koneksi ditutup, sesi dicabut/kadaluarsa di tengah jalan (staff ${ws.staffId}, tenant ${ws.tenantId})`);
          ws.close(4003, "sesi dicabut");
        }
      }, WS_SESSION_RECHECK_MS);

      ws.send(JSON.stringify({ type: "auth_ok" }));
      return;
    }

    if (data.type === "typing_start" || data.type === "typing_stop") {
      await handleTypingSignal(ws, data.type, data.discrepancy_case_id);
    }
  });

  ws.on("close", () => {
    clearTimeout(authTimeout);
    if (recheckInterval) clearInterval(recheckInterval);

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

// P1-3 lanjutan: ping/pong berkala supaya nginx proxy_read_timeout (default 60s)
// tidak memutus paksa koneksi WS yang authenticated tapi lagi idle (staff diem
// baca chat, dst). Ping/pong ini beda tujuan dari WS_SESSION_RECHECK_MS di atas --
// yang itu soal keamanan (revoke), ini soal menjaga koneksi tetap hidup wajar.
const WS_HEARTBEAT_MS = 25000;
const wsHeartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log(`WS: koneksi di-terminate, tidak respon ping (tenant ${ws.tenantId})`);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, WS_HEARTBEAT_MS);

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
