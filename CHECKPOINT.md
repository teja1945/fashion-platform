# CHECKPOINT — Fashion Platform

*Diperbarui otomatis oleh Claude, bagian 37*

## Ringkasan Proyek
Multi-tenant SaaS fashion platform, solo development dari Android (Termux + browser), tanpa PC/laptop. VPS Biznet Gio (domestik, terima GPN card). Database: Supabase (project `fashion-platform`, id `kwhybffbcqopqbbnuigg`).

## Status Infrastruktur
- **VPS**: Biznet Gio NEO Lite XS 1.1, IP `103.58.101.155`, user `rakyat`. SSH key-based auth sudah jalan dari Termux.
- **Database**: Supabase Postgres (bukan lokal di VPS). Role `app_user` dipakai app (least-privilege: INSERT/SELECT/UPDATE/DELETE saja, tanpa DDL). DDL/migration harus lewat Supabase MCP tool (`apply_migration`), bukan psql biasa dari VPS.
- **Env**: `$DATABASE_URL` di `.env` tidak auto-export ke shell baru — tiap sesi Termux baru harus jalankan `export $(grep DATABASE_URL .env | xargs)` dulu sebelum psql manual.
- **Git**: repo `teja1945/fashion-platform`, branch `main`. Commit terakhir: `f14e67f`.
- **PENTING — ada 2 clone repo terpisah**: satu di VPS (`~/fashion-platform` via SSH), satu lagi di Termux lokal HP (`/data/data/com.termux/files/home/fashion-platform`). **SELALU cek prompt/hostname sebelum git commit/push** — kalau prompt `~/fashion-platform $` tanpa `Rakyat@fashion-platform:`, itu tandanya sedang di Termux lokal, BUKAN VPS. Jalankan `whoami && hostname && pwd` untuk mastiin lokasi sebelum operasi git apapun. Selalu `git fetch origin && git status` dulu di awal sesi baru, di kedua clone, sebelum commit.

## Progres Besar Bagian 37 (sesi ini)
1. **Audit & fix 3 bug bigint string-concat** di `stateLayer.js`:
   - `lastApplied` di `tryApplyToState` (baris ~66)
   - `actualCurrent` di `applyWithOptimisticLock` (baris ~124)
   - `lastApplied` + `rowSeqVersion` di `chainApplyFromBuffer` (baris ~187, ~193) — bug ini bikin gap-close **nyaris tidak pernah jalan** karena strict `===` antara string vs number.
2. **Bug baru ditemukan & fixed**: `openGapIfNeeded()` insert ke `production_events` tanpa isi `sequence_version` (NOT NULL violation), lalu setelah dicoba pakai `current_version` sebagai `sequence_version` malah bentrok unique constraint `(tenant_id, production_job_id, sequence_version)`.
   - **Solusi**: dibuat tabel baru `gap_audit_log` (via Supabase migration `add_gap_audit_log`) khusus buat audit event `gap.opened`, terpisah dari `production_events`. Punya RLS policy `tenant_isolation` sama seperti tabel lain, granted ke `app_user`.
3. **Verifikasi end-to-end sukses**: skenario gap (event lompat → buffer → susulan → auto chain-apply-close) sudah dites manual dan **current_version naik otomatis + gap_status balik CLOSED** setelah event yang hilang disusulkan.
4. **Commit besar `f14e67f`**: ternyata room-room sebelumnya sudah mengerjakan jauh lebih banyak dari yang tercatat di checkpoint bagian 36, tapi belum sempat di-commit:
   - `server.js` (531 baris) — sudah lengkap dengan endpoint `/v1/events`, `/v1/orders`, staff login/session (`/v1/staff/*`), sistem lock/unlock order (`/v1/lock/*`), dan photo upload ke Supabase Storage (`/v1/photos`)
   - `middleware/tenantResolver.js` — resolver tenant dari subdomain
   - `schema.sql` — snapshot schema database
   - File-file debug/test: `check-job.js`, `cleanup.js`, `reset-job.js`, `test-e2e.js`, dll
   - **File-file ini BELUM diaudit menyeluruh** oleh sesi ini — hanya lolos `node --check` (syntax check), belum direview logic-nya satu per satu.
5. **Insiden git 2-clone**: sempat ada commit checkpoint (`5ef73e9`) yang dibuat di clone Termux lokal berdasarkan histori lama (`a338760`), nyimpang dari GitHub (`f14e67f`). Diselesaikan dengan `git reset --hard origin/main` di clone Termux lokal — TIDAK ADA data yang hilang karena VPS clone tidak tersentuh. Pelajaran: selalu verifikasi lokasi kerja (VPS vs Termux lokal) sebelum operasi git.

## PENTING — Yang Belum Diaudit
`server.js` 531 baris berisi fitur besar (staff auth, lock/unlock, photo upload) yang dikerjakan room lain tanpa sempat di-review sesi ini. **Prioritas audit berikutnya**: baca dan cross-check logic di endpoint-endpoint ini sebelum dianggap production-ready, terutama:
- `/v1/staff/login`, `/v1/staff/revoke`, `/v1/staff/offboard` (auth & session)
- `/v1/lock/acquire`, `/v1/lock/release`, `/v1/lock/force-unlock` (concurrency control)
- `/v1/photos` (dependency ke `SUPABASE_URL`/`SUPABASE_SECRET_KEY` env vars — perlu dicek apakah sudah di-set di VPS)

## Next Steps (urutan prioritas)
1. **Audit menyeluruh `server.js`** — terutama endpoint lock/unlock dan staff auth (concurrency & security-sensitive)
2. Desain child bundle (`BUNDLE_ALLOCATION`) — masih return 501 di `ingestion.js`, blocker lama, belum disentuh
3. Function spec-lock (atomik reserve inventory + ledger + event) — belum disentuh
4. Desain validasi 2 pihak staff jahit vs QC — masih ide
5. Sisa hardening VPS: UFW, Fail2Ban, backup rutin, cleanup `ssh-rsa` lama — belum blocking tapi disarankan sebelum backend live

## Pelajaran Bagian 37
- **Ada 2 clone repo (VPS + Termux lokal) — selalu cek `whoami && hostname && pwd` sebelum git commit/push.** Kalau hostname `localhost` dan path `/data/data/com.termux/...`, itu Termux lokal, bukan VPS.
- **Cross-session sync masih rawan**: beberapa room sempat kerja paralel/berurutan tanpa commit, dan checkpoint sempat ketinggalan jauh dari kondisi kode sebenarnya. Selalu jalankan `git fetch origin && git log --oneline -5` + `git log --oneline origin/main -5` untuk membandingkan, jangan cuma percaya isi CHECKPOINT.md.
- **`node --check` (syntax check) tidak cukup** untuk memastikan kode benar — hanya menjamin tidak ada syntax error, bukan logic error. File besar seperti `server.js` masih perlu audit logic manual.
- **DDL harus lewat Supabase MCP**, psql role `app_user` di VPS tidak punya hak `CREATE TABLE`/`ALTER TABLE` (by design, least-privilege).
- **Env var tidak persist antar sesi Termux baru** — selalu re-export `DATABASE_URL` tiap kali reconnect SSH.
