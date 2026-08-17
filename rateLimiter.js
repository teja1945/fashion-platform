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

module.exports = {
  checkRateLimit,
};
