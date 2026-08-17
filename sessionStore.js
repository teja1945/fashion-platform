// sessionStore.js -- pengganti sessionMap in-memory (P1-1, CHECKPOINT
// Bagian 122/125). Kenapa perlu: server.js pakai `new Map()` di memori
// proses Node -- setiap kali pm2 restart (deploy, crash, dll), SEMUA staff
// yang lagi login otomatis logout paksa di tengah kerja (kejadian nyata
// Bagian 122). Redis simpan session di luar proses Node, jadi restart app
// tidak lagi menghapus sesi staff yang masih aktif.
//
// Pola pemakaian sama seperti db.js: modul terpisah, di-require dari
// server.js, tidak bikin instance Redis baru di file lain.

const Redis = require("ioredis");
const crypto = require("crypto");

const redis = new Redis({
  host: "127.0.0.1",
  port: 6379,
  maxRetriesPerRequest: 3,
  // Kalau Redis down, jangan bikin app hang nunggu retry selamanya --
  // mending gagal cepat (staff dapat error, bisa retry) daripada request
  // menggantung tanpa batas.
});

redis.on("error", (err) => {
  console.error("Redis connection error (sessionStore):", err.message);
});

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 jam, sama seperti sebelumnya

function sessionKey(token) {
  return `session:${token}`;
}

function staffSessionsKey(tenantId, staffId) {
  return `staff_sessions:${tenantId}:${staffId}`;
}

async function createSession(tenantId, staff) {
  const token = crypto.randomBytes(32).toString("hex");
  const session = {
    tenantId,
    staffId: staff.id,
    role: staff.role,
    assignedStage: staff.assigned_stage,
    fullName: staff.full_name,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };

  await redis
    .multi()
    .set(sessionKey(token), JSON.stringify(session), "PX", SESSION_TTL_MS)
    .sadd(staffSessionsKey(tenantId, staff.id), token)
    .pexpire(staffSessionsKey(tenantId, staff.id), SESSION_TTL_MS + 60000)
    .exec();

  return token;
}

async function getSession(token) {
  const raw = await redis.get(sessionKey(token));
  if (!raw) return null;
  return JSON.parse(raw);
}

async function touchSession(token, session) {
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  await redis.set(sessionKey(token), JSON.stringify(session), "PX", SESSION_TTL_MS);
}

async function deleteSession(token, tenantId, staffId) {
  const multi = redis.multi().del(sessionKey(token));
  if (tenantId && staffId) {
    multi.srem(staffSessionsKey(tenantId, staffId), token);
  }
  await multi.exec();
}

async function revokeStaffSessions(tenantId, staffId) {
  const key = staffSessionsKey(tenantId, staffId);
  const tokens = await redis.smembers(key);
  if (tokens.length === 0) return 0;

  let revokedCount = 0;
  const multi = redis.multi();
  for (const token of tokens) {
    multi.get(sessionKey(token));
  }
  const results = await multi.exec();

  const delMulti = redis.multi();
  for (let i = 0; i < tokens.length; i++) {
    const [, value] = results[i];
    delMulti.srem(key, tokens[i]);
    if (value) {
      delMulti.del(sessionKey(tokens[i]));
      revokedCount += 1;
    }
  }
  await delMulti.exec();

  return revokedCount;
}

module.exports = {
  createSession,
  getSession,
  touchSession,
  deleteSession,
  revokeStaffSessions,
  SESSION_TTL_MS,
};
