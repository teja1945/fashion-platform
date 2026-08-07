const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const { Client } = require("pg");

const { pool } = require("./db");
const crypto = require("crypto");
const { ingestEvent } = require("./ingestion");
const { startGapMonitor, startBundleSplitReconciler } = require("./worker");
const tenantResolver = require("./middleware/tenantResolver");

const app = express();
app.use(express.json({ limit: "10mb" }));
const staticPath = require("path");
app.get("/scanner.html", (_req, res) => res.sendFile(staticPath.join(__dirname, "scanner.html")));
app.use("/assets", express.static(staticPath.join(__dirname, "assets")));
app.get("/v1/whoami", tenantResolver, (req, res) => { res.json({ tenantId: req.tenantId, subdomain: req.tenantSubdomain }); });

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

app.post("/v1/events", requireApiKey, async (req, res) => {
  try {
    const result = await ingestEvent(req.body);
    res.status(result.httpStatus).json(result.body);
  } catch (err) {
    console.error("ingestion error:", err);
    res.status(500).json({ error: "internal error" });
  }
});

app.get("/v1/orders", requireApiKey, async (_req, res) => {
  const result = await pool.query(
    `SELECT os.*, gs.status AS gap_status
     FROM order_state os
     LEFT JOIN gap_status gs ON gs.entity_id = os.entity_id
     ORDER BY os.updated_at DESC`
  );
  res.json(result.rows);
});

// --- Staff PIN login ---
// Rate limit sederhana in-memory: mencegah brute-force PIN (4 digit = 10.000 kombinasi).
// Dibatasi per staff_id (target spesifik) DAN per IP (distribusi serangan).
// Guard `size > 10000 -> clear()` mencegah Map ini tumbuh tanpa batas selama
// proses jalan lama tanpa restart (pola sama seperti rateBuckets di ingestion.js).
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

// --- Staff session tokens (fix celah token/session) ---
const sessionMap = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 jam

function createSession(staff) {
  if (sessionMap.size > 10000) sessionMap.clear();
  const token = crypto.randomBytes(32).toString("hex");
  sessionMap.set(token, {
    staff_id: staff.staff_id,
    role: staff.role,
    assigned_stage: staff.assigned_stage,
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
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  req.staffSession = session;
  next();
}

app.get("/v1/staff/list", requireApiKey, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT staff_id, name FROM staff WHERE active = true ORDER BY name`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("staff list error:", err);
    res.status(500).json({ error: "internal error" });
  }
});

app.post("/v1/staff/login", requireApiKey, async (req, res) => {
  const { staff_id, pin } = req.body || {};
  const ip = req.ip;

  if (!staff_id || !pin) {
    return res.status(400).json({ error: "staff_id dan pin wajib diisi" });
  }

  // rate limit per staff_id (utama -- mencegah brute-force target spesifik)
  const staffKey = `staff:${staff_id}`;
  if (!checkRateLimit(staffKey, 5, 30_000)) {
    return res.status(429).json({ error: "Terlalu banyak percobaan PIN, coba lagi sebentar lagi" });
  }

  // rate limit per IP (sekunder -- mencegah distribusi serangan lewat banyak staff_id)
  const ipKey = `ip:${ip}`;
  if (!checkRateLimit(ipKey, 20, 30_000)) {
    return res.status(429).json({ error: "Terlalu banyak request, coba lagi sebentar lagi" });
  }

  try {
    const result = await pool.query(
      `SELECT staff_id, name, role, assigned_stage FROM staff
       WHERE staff_id = $1 AND active = true AND pin_hash = crypt($2, pin_hash)`,
      [staff_id, pin]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: "PIN salah atau staff tidak aktif" });
    }
    const staff = result.rows[0];
    const token = createSession(staff);
    res.json({ ok: true, staff, token });
  } catch (err) {
    console.error("staff login error:", err);
    res.status(500).json({ error: "internal error" });
  }
});
app.post("/v1/staff/revoke", requireApiKey, requireStaffSession, async (req, res) => {
  if (req.staffSession.role !== "admin") {
    return res.status(403).json({ error: "hanya admin yang bisa revoke sesi staff" });
  }
  const { target_staff_id } = req.body || {};
  if (!target_staff_id) {
    return res.status(400).json({ error: "target_staff_id wajib diisi" });
  }
  let revokedCount = 0;
  for (const [token, session] of sessionMap.entries()) {
    if (session.staff_id === target_staff_id) {
      sessionMap.delete(token);
      revokedCount += 1;
    }
  }
  console.log("REVOKE: admin " + req.staffSession.staff_id + " revoke " + revokedCount + " sesi milik staff " + target_staff_id);
  res.json({ ok: true, revoked_sessions: revokedCount });
});

app.post("/v1/staff/offboard", requireApiKey, requireStaffSession, async (req, res) => {
  if (req.staffSession.role !== "admin") {
    return res.status(403).json({ error: "hanya admin yang bisa offboard staff" });
  }
  const { target_staff_id } = req.body || {};
  if (!target_staff_id) {
    return res.status(400).json({ error: "target_staff_id wajib diisi" });
  }
  try {
    const result = await pool.query(
      "UPDATE staff SET active = false WHERE staff_id = $1 RETURNING staff_id, name",
      [target_staff_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "staff tidak ditemukan" });
    }
    let revokedCount2 = 0;
    for (const [token, session] of sessionMap.entries()) {
      if (session.staff_id === target_staff_id) {
        sessionMap.delete(token);
        revokedCount2 += 1;
      }
    }
    console.log("OFFBOARD: admin " + req.staffSession.staff_id + " offboard staff " + result.rows[0].name + " (" + target_staff_id + "), active=false + revoke " + revokedCount2 + " sesi");
    res.json({ ok: true, staff: result.rows[0], revoked_sessions: revokedCount2 });
  } catch (err) {
    console.error("offboard error:", err);
    res.status(500).json({ error: "internal error" });
  }
});

app.post("/v1/lock/acquire", requireApiKey, requireStaffSession, async (req, res) => {
  const { entity_id, override_admin_pin } = req.body || {};
  const staff_id = req.staffSession.staff_id;
  if (!entity_id) {
    return res.status(400).json({ error: "entity_id wajib diisi" });
  }

  try {
    const staffCheck = await pool.query(
      `SELECT role, assigned_stage FROM staff WHERE staff_id = $1 AND active = true`,
      [staff_id]
    );
    if (staffCheck.rows.length === 0) {
      return res.status(403).json({ error: "staff tidak ditemukan atau tidak aktif" });
    }

    const { role, assigned_stage } = staffCheck.rows[0];

    if (role !== "admin") {
      const orderCheck = await pool.query(
        `SELECT stage FROM order_state WHERE entity_id = $1`,
        [entity_id]
      );
      if (orderCheck.rows.length === 0) {
        return res.status(404).json({ error: "order tidak ditemukan" });
      }
      if (orderCheck.rows[0].stage !== assigned_stage) {
        return res.status(403).json({
          error: "order ini bukan bagian kerjamu",
          your_stage: assigned_stage,
          order_stage: orderCheck.rows[0].stage,
        });
      }

      const otherLock = await pool.query(
        `SELECT entity_id FROM order_locks WHERE locked_by = $1 AND entity_id != $2`,
        [staff_id, entity_id]
      );
      if (otherLock.rows.length > 0) {
        if (!override_admin_pin) {
          return res.status(409).json({
            error: "kamu masih pegang order lain, selesaikan atau lepas dulu",
            active_order: otherLock.rows[0].entity_id,
          });
        }
        const adminCheck = await pool.query(
          `SELECT staff_id, name FROM staff WHERE role = 'admin' AND active = true AND pin_hash = crypt($1, pin_hash)`,
          [override_admin_pin]
        );
        if (adminCheck.rows.length === 0) {
          return res.status(403).json({ error: "PIN admin salah" });
        }
        console.log(`OVERRIDE: staff ${staff_id} acquire order baru ${entity_id} sambil masih pegang ${otherLock.rows[0].entity_id}, disetujui admin ${adminCheck.rows[0].name}`);
      }
    }

    const result = await pool.query(
      `INSERT INTO order_locks (entity_id, locked_by)
       VALUES ($1, $2)
       ON CONFLICT (entity_id) DO UPDATE
         SET locked_by = EXCLUDED.locked_by, locked_at = now()
         WHERE order_locks.locked_by = $2
       RETURNING *`,
      [entity_id, staff_id]
    );

    if (result.rows.length === 0) {
      const current = await pool.query(
        `SELECT ol.locked_by, s.name, ol.locked_at FROM order_locks ol
         JOIN staff s ON s.staff_id = ol.locked_by
         WHERE ol.entity_id = $1`,
        [entity_id]
      );
      return res.status(409).json({
        error: "order sedang dikerjakan orang lain",
        locked_by: current.rows[0]?.name,
        locked_at: current.rows[0]?.locked_at,
      });
    }

    const stageResult = await pool.query(
      "SELECT stage FROM order_state WHERE entity_id = $1",
      [entity_id]
    );
    const currentStage = stageResult.rows[0]?.stage || null;

    await pool.query(
      "UPDATE work_log SET ended_at = now() WHERE staff_id = $1 AND entity_id = $2 AND ended_at IS NULL",
      [staff_id, entity_id]
    );

    await pool.query(
      "INSERT INTO work_log (staff_id, entity_id, stage, started_at) VALUES ($1, $2, $3, now())",
      [staff_id, entity_id, currentStage]
    );

    res.json({ ok: true, lock: result.rows[0] });
  } catch (err) {
    console.error("lock acquire error:", err);
    res.status(500).json({ error: "internal error" });
  }
});

app.post("/v1/lock/release", requireApiKey, requireStaffSession, async (req, res) => {
  const { entity_id } = req.body || {};
  const staff_id = req.staffSession.staff_id;
  if (!entity_id) {
    return res.status(400).json({ error: "entity_id wajib diisi" });
  }

  try {
    const result = await pool.query(
      `DELETE FROM order_locks WHERE entity_id = $1 AND locked_by = $2 RETURNING *`,
      [entity_id, staff_id]
    );

    if (result.rows.length === 0) {
      return res.status(409).json({ error: "lock tidak ditemukan atau bukan milik staff ini" });
    }

    await pool.query(
      "UPDATE work_log SET ended_at = now() WHERE id = (SELECT id FROM work_log WHERE staff_id = $1 AND entity_id = $2 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1)",
      [staff_id, entity_id]
    );

    res.json({ ok: true, released: result.rows[0] });
  } catch (err) {
    console.error("lock release error:", err);
    res.status(500).json({ error: "internal error" });
  }
});
app.post("/v1/lock/force-unlock", requireApiKey, requireStaffSession, async (req, res) => {
  const { entity_id } = req.body || {};
  const admin_staff_id = req.staffSession.staff_id;
  if (!entity_id) {
    return res.status(400).json({ error: "entity_id wajib diisi" });
  }

  try {
    const adminCheck = await pool.query(
      `SELECT staff_id, name, role FROM staff WHERE staff_id = $1 AND active = true`,
      [admin_staff_id]
    );
    if (adminCheck.rows.length === 0 || adminCheck.rows[0].role !== "admin") {
      return res.status(403).json({ error: "staff ini bukan admin atau tidak aktif" });
    }

    const result = await pool.query(
      `DELETE FROM order_locks WHERE entity_id = $1 RETURNING *`,
      [entity_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "tidak ada lock aktif untuk order ini" });
    }

    console.log(`FORCE-UNLOCK: order ${entity_id} dipaksa unlock oleh admin ${adminCheck.rows[0].name} (${admin_staff_id}), sebelumnya dikunci oleh ${result.rows[0].locked_by}`);

    res.json({ ok: true, unlocked: result.rows[0], unlocked_by_admin: adminCheck.rows[0].name });
  } catch (err) {
    console.error("force-unlock error:", err);
    res.status(500).json({ error: "internal error" });
  }
});
app.post("/v1/photos", requireApiKey, requireStaffSession, async (req, res) => {
  const { entity_id, stage, photo_base64 } = req.body || {};
  const staff_id = req.staffSession.staff_id;
  const ALLOWED_STAGES = ["cutting", "sewing", "qc", "finishing"];

  if (!entity_id || !stage || !photo_base64) {
    return res.status(400).json({ error: "entity_id, stage, dan photo_base64 wajib diisi" });
  }
  if (!ALLOWED_STAGES.includes(stage)) {
    return res.status(400).json({ error: "stage tidak valid untuk foto wajib", allowed: ALLOWED_STAGES });
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

  try {
    const staffCheck = await pool.query(
      `SELECT staff_id FROM staff WHERE staff_id = $1 AND active = true`,
      [staff_id]
    );
    if (staffCheck.rows.length === 0) {
      return res.status(403).json({ error: "staff tidak ditemukan atau tidak aktif" });
    }

    const orderCheck = await pool.query(
      `SELECT stage FROM order_state WHERE entity_id = $1`,
      [entity_id]
    );
    if (orderCheck.rows.length === 0) {
      return res.status(404).json({ error: "order tidak ditemukan" });
    }
    if (orderCheck.rows[0].stage !== stage) {
      return res.status(403).json({
        error: "stage foto tidak cocok dengan stage order saat ini",
        order_stage: orderCheck.rows[0].stage,
        sent_stage: stage,
      });
    }

    const storagePath = `${entity_id}/${stage}-${Date.now()}.jpg`;
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
      console.error("SUPABASE_URL atau SUPABASE_SECRET_KEY belum di-set di environment.");
      return res.status(503).json({ error: "server belum dikonfigurasi (Supabase Storage)" });
    }

    const uploadUrl = `${SUPABASE_URL}/storage/v1/object/stage-photos/${storagePath}`;
    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        "Content-Type": "image/jpeg",
      },
      body: buffer,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      console.error("upload foto ke Supabase Storage gagal:", uploadRes.status, errText);
      return res.status(502).json({ error: "gagal upload foto ke storage" });
    }

    const insertResult = await pool.query(
      `INSERT INTO stage_photos (entity_id, stage, staff_id, storage_path) VALUES ($1, $2, $3, $4) RETURNING *`,
      [entity_id, stage, staff_id, storagePath]
    );

    res.json({ ok: true, photo: insertResult.rows[0] });
  } catch (err) {
    console.error("photos error:", err);
    res.status(500).json({ error: "internal error" });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/v1/realtime" });

async function setupRealtimeRelay() {
  let currentClient = null;
  let reconnecting = false;

  const connect = async () => {
    const client = new Client({
      connectionString: process.env.DATABASE_URL || "postgres://localhost:5432/ltos",
    });

    currentClient = client;

    client.on("error", (err) => {
      console.error("listenClient error (pre-ready):", err.message);
    });

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
    client.on("end", () => {
      scheduleReconnect("disconnected");
    });
    client.on("notification", (msg) => {
      const payload = msg.payload;
      wss.clients.forEach((ws) => {
        if (ws.readyState === ws.OPEN) ws.send(payload);
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
  console.log(`LTOS ingestion gateway running on port ${PORT}`);
  await setupRealtimeRelay();
  startGapMonitor();
  startBundleSplitReconciler();
});
