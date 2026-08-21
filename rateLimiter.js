// rateLimiter.js -- pengganti rateLimitMap in-memory (P1-1 bagian 2,
// CHECKPOINT Bagian 125). Kenapa perlu: sama seperti sessionMap dulu,
// rateLimitMap disimpan pakai `new Map()` di memori proses Node -- setiap
// kali pm2 restart, semua hitungan percobaan PIN gagal ke-reset ke 0.
// Bukan bug fatal (beda dari session yang bikin staff logout paksa), tapi
// tetap gap nyata: staff/penyerang yang lagi "ketahan" rate limit dapat
// "reset gratis" tiap kali ada deploy/restart.
//
// Koneksi Redis TERPISAH dari sessionStore.js (bukan reuse) -- konsisten
// pola tiap modul berdiri sendiri (db.js punya pool sendiri, sessionStore.js
// punya koneksi sendiri). ioredis ringan, nambah 1 koneksi tidak masalah
// di skala project ini.
//
// KEPUTUSAN DESAIN (disepakati dengan Teja): fail-OPEN kalau Redis error/
// down -- request TETAP diizinkan lanjut (rate limit dianggap lolos),
// bukan fail-closed. Alasan: rate limiter cuma proteksi TAMBAHAN (lapis
// ke-2, PIN yang benar tetap wajib) -- kalau Redis down dan kita pilih
// fail-closed, dampaknya lebih parah dari masalah yang mau dicegah (SEMUA
// staff di SEMUA tenant tidak bisa login sama sekali, padahal Redis down
// biasanya soal infrastruktur bukan lagi ada serangan). Beda dari
// sessionStore.js yang fail dengan close(4002) untuk WS -- itu soal
// identitas/otorisasi yang sudah dipegang, ini soal proteksi sebelum
// otorisasi terjadi.

const Redis = require("ioredis");

const redis = new Redis({
  host: "127.0.0.1",
  port: 6379,
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: 3,
});

redis.on("error", (err) => {
  console.error("Redis connection error (rateLimiter):", err.message);
});

function rateLimitKey(key) {
  return `ratelimit:${key}`;
}

// Fixed-window counter pakai Redis INCR + PEXPIRE.
// Sama seperti checkRateLimit(key, limit, windowMs) versi in-memory lama:
// hitung berapa kali dipanggil dalam window waktu tertentu, return true
// kalau masih di bawah limit, false kalau sudah lewat.
async function checkRateLimit(key, limit, windowMs) {
  const redisKey = rateLimitKey(key);
  try {
    const count = await redis.incr(redisKey);
    if (count === 1) {
      // Baru pertama kali kena increment di window ini -- set TTL supaya
      // key otomatis hilang sendiri setelah window habis (pengganti
      // "clear() manual kalau size > 10000" versi in-memory lama, Redis
      // TTL sudah otomatis bersih-bersih per key, tidak perlu global clear).
      await redis.pexpire(redisKey, windowMs);
    }
    return count <= limit;
  } catch (err) {
    // Fail-open: Redis error/down -> izinkan request lanjut. Log supaya
    // kelihatan di operasional (bukan diam-diam), tapi TIDAK memblokir
    // staff yang jujur cuma gara-gara Redis lagi bermasalah.
    console.error("checkRateLimit Redis error, fail-open (izinkan lanjut):", err.message);
    return true;
  }
}

// ==== TAMBAHAN: Progressive Lockout ====
// LAPIS TAMBAHAN di atas checkRateLimit (fixed-window) di atas.
// checkRateLimit nahan spam CEPAT (5x/30 detik), fungsi ini nahan orang
// yang SABAR nyoba pelan-pelan dalam waktu lama.
//
// Pola: hitungan gagal beruntun disimpan di Redis (key terpisah dari
// ratelimit:*, prefix "lockout:"). Tiap gagal, counter naik + durasi kunci
// berikutnya dihitung dari tabel LOCKOUT_STAGES_MS. Begitu PIN BENAR,
// counter dihapus total (reset ke 0). TTL counter di-refresh TIAP gagal
// (bukan cuma sekali di awal) supaya "24 jam" dihitung dari percobaan
// TERAKHIR, bukan percobaan pertama.
//
// Fail-open konsisten dengan checkRateLimit: Redis error/down -> lockout
// dianggap tidak aktif, request tetap lanjut (PIN yang benar tetap syarat
// utama, ini cuma proteksi tambahan).

const LOCKOUT_COUNTER_TTL_MS = 24 * 60 * 60 * 1000; // 24 jam sejak gagal terakhir

// index array = jumlah gagal beruntun - LOCKOUT_STARTS_AT_FAILURE_COUNT
// gagal ke-1..4: belum dikunci
// gagal ke-5: kunci 1 menit, ke-6: 5 menit, ke-7: 30 menit, ke-8+: 60 menit (plafon)
const LOCKOUT_STAGES_MS = [
  60_000,        // setelah gagal ke-5
  5 * 60_000,    // setelah gagal ke-6
  30 * 60_000,   // setelah gagal ke-7
  60 * 60_000,   // setelah gagal ke-8 dan seterusnya (plafon)
];
const LOCKOUT_STARTS_AT_FAILURE_COUNT = 5;

function lockoutCounterKey(staffKey) {
  return `lockout:count:${staffKey}`;
}
function lockoutUntilKey(staffKey) {
  return `lockout:until:${staffKey}`;
}

// Dipanggil SEBELUM cek PIN. Return { locked: true, retryAfterMs } kalau
// sedang dikunci, atau { locked: false } kalau boleh lanjut cek PIN.
async function checkProgressiveLockout(staffKey) {
  try {
    const untilRaw = await redis.get(lockoutUntilKey(staffKey));
    if (!untilRaw) {
      return { locked: false };
    }
    const until = parseInt(untilRaw, 10);
    const now = Date.now();
    if (now < until) {
      return { locked: true, retryAfterMs: until - now };
    }
    return { locked: false };
  } catch (err) {
    console.error("checkProgressiveLockout Redis error, fail-open (izinkan lanjut):", err.message);
    return { locked: false };
  }
}

// Dipanggil SETELAH cek PIN salah. Naikkan counter, pasang kunci baru
// kalau sudah lewat ambang LOCKOUT_STARTS_AT_FAILURE_COUNT.
async function recordFailedPinAttempt(staffKey) {
  try {
    const countKey = lockoutCounterKey(staffKey);
    const count = await redis.incr(countKey);
    await redis.pexpire(countKey, LOCKOUT_COUNTER_TTL_MS);
    if (count >= LOCKOUT_STARTS_AT_FAILURE_COUNT) {
      const stageIndex = Math.min(
        count - LOCKOUT_STARTS_AT_FAILURE_COUNT,
        LOCKOUT_STAGES_MS.length - 1
      );
      const durationMs = LOCKOUT_STAGES_MS[stageIndex];
      const until = Date.now() + durationMs;
      await redis.set(lockoutUntilKey(staffKey), until, "PX", durationMs);
      return { justLocked: true, durationMs };
    }
    return { justLocked: false };
  } catch (err) {
    console.error("recordFailedPinAttempt Redis error, gagal catat (fail-open):", err.message);
    return { justLocked: false };
  }
}

// Dipanggil SETELAH PIN benar -- reset total, staff yang jujur tidak
// kebawa "hutang" gagal dari percobaan sebelumnya.
async function resetLockout(staffKey) {
  try {
    await redis.del(lockoutCounterKey(staffKey), lockoutUntilKey(staffKey));
  } catch (err) {
    console.error("resetLockout Redis error (tidak fatal):", err.message);
  }
}

module.exports = {
  checkRateLimit,
  checkProgressiveLockout,
  recordFailedPinAttempt,
  resetLockout,
};
