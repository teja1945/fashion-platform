# CHECKPOINT — Fashion Platform (Multi-Tenant SaaS)

> Update terakhir: 4 Agustus 2026 (malam — SSH key fixed, password login dimatikan)
> Cara pakai: paste/replace isi file ini ke `CHECKPOINT.md` di repo GitHub kamu tiap selesai sesi. Sesi berikutnya (room manapun) tinggal kasih raw link file ini ke Claude sebelum mulai kerja, biar konteks lengkap tanpa perlu re-explain.

---

## 1. Arah Proyek

Platform multi-tenant SaaS untuk bisnis fashion — **bukan** duplikat-per-brand seperti LTOS lama.

- Dipakai oleh: brand owner, vendor konveksi, custom tailor, pabrik
- Tampilan depan (frontend) beda per tipe tenant, disusun dari **componentized blocks**
- Backend, produksi, dan inventory **sama untuk semua tipe tenant**

## 2. Model Bisnis

- Uang customer masuk **langsung ke tenant** — platform tidak memegang transaksi
- Platform dapat pemasukan dari tenant lewat: fee per-transaksi / bulanan / kontrak tahunan
- Disimpan di tabel `tenant_billing`

## 3. Akses Tenant

- Subdomain per tenant: `namatenant.domain.com`
- 1 backend + 1 database untuk semua tenant
- Isolasi data lewat filter `tenant_id` di setiap query

## 4. Infrastruktur

- VPS aktif dan sudah **fully secured via SSH key** (lihat bagian 11 — hardening SSH selesai)
- Setup infra dilakukan **sebelum** mulai coding versi baru
- LTOS lama tetap di Termux sebagai proyek terpisah, tidak diganggu

## 5. Skema Database v2

File aktif: `fashion_platform_schema_v2.sql` (lihat folder `db/`)
File lama (arsip, referensi): `garment_production_schema.sql` (v1, single-tenant)

Tabel yang sudah ada di v2:
- `tenants`
- `tenant_billing`
- `orders`, `order_specs`, `order_spec_materials`
- `payments`
- `fabric_inventory`, `inventory_ledger`
- `shipments`
- `tenant_pipeline_stages` (pipeline produksi configurable per tenant)
- `production_jobs`, `production_events` (event-sourced, generalisasi pola LTOS)
- `staff`, `job_locks`, `work_log`, `production_stage_photos`

## 6. Stage Produksi

- **Tidak ada** konsultasi di tahap produksi — itu murni fase WEB, sudah masuk `order_specs`
- **Gudang** adalah stage produksi pertama (opsional per tenant):
  - Fungsi: verifikasi fisik bahan sebelum cutting
  - **Bukan** titik konsumsi stok — `STOCK_CONSUMED` tetap terjadi di tahap cutting

## 7. Ganti Kain (Gudang)

Alur approval 2 lapis:
1. Admin PIN dulu (filter internal)
2. Baru dikirim ke customer untuk approve/reject (transparansi)

Tabel baru: `spec_substitution_requests`

## 8. Reject/Cancel Massal + Notifikasi Customer

**Aturan notifikasi:**
- SELALU kirim notif kalau: cancel permanen, atau butuh keputusan customer
- Reject yang bisa diperbaiki: TIDAK kirim notif kecuali kumulatif menyebabkan delay
- Agregasi WAJIB per total order (bukan per-bundle-kecil), pakai kolom `last_notified_qty` supaya tidak spam

**Pilihan customer saat butuh keputusan** (tabel `customer_decisions`):
- REFUND
- WAIT_REPRODUCTION
- CHOOSE_ALTERNATIVE

## 9. No-Response Handling

- Eskalasi bertahap: reminder → coba telfon manual → default action di deadline
- **Bukan** langsung diam-diam jalan otomatis
- Kebijakan deadline & default action di-**snapshot** ke `orders.checkout_policy_snapshot` saat checkout — supaya perubahan kebijakan di kemudian hari tidak menimpa kesepakatan order lama
- Deadline **configurable per tenant**: `tenants.default_response_deadline_days`

---

## BELUM DIEKSEKUSI (next steps)

### Skema
- [ ] Tabel `spec_substitution_requests`
- [ ] Tabel `customer_decisions`
- [ ] Tabel `customer_notifications`
- [ ] Kolom `checkout_policy_snapshot` di `orders`
- [ ] Kolom `default_response_deadline_days` di `tenants`

### Infrastruktur — Hardening (lihat detail di bagian 11)
- [x] Setup SSH key yang benar dari Termux — **SELESAI**
- [x] Disable `PasswordAuthentication` — **SELESAI, sekarang `no`**
- [ ] Firewall UFW aktif
- [ ] Install Fail2Ban
- [ ] Verifikasi user `Rakyat` sudah non-root dengan sudo access yang benar
- [ ] Setup backup manual rutin (`pg_dump` ke storage terpisah)
- [ ] Install Node.js 20 LTS
- [ ] Project Supabase baru (terpisah dari LTOS lama)

### Backend
- [ ] Function/procedure spec-lock (atomik: reserve inventory + ledger + event)
- [ ] Backend skeleton: tenant resolver middleware
- [ ] Mulai dari 1 tipe tenant dulu: **brand ready-stock** (paling simpel), baru generalisasi ke 4 tipe lain

---

## Catatan Kolaborasi

- Repo: public, satu sumber kebenaran untuk semua room/sesi Claude
- Strategi branch: untuk saat ini (fase desain, belum ada kode jalan), **cukup commit langsung ke `main`**. Branch `work/<topik>` baru dipakai kalau sudah mulai coding beneran.
- Tidak ada koneksi otomatis Claude ↔ GitHub saat ini (belum ada connector GitHub tersedia) — update file ini secara manual: copy isi terbaru dari Claude → paste/commit lewat GitHub app.
- Tiap sesi baru, kasih **raw link** `CHECKPOINT.md` ini ke Claude sebelum minta lanjut kerja (raw link, bukan link blob GitHub biasa — lebih ringan diproses).
- **Kalau ada beberapa room jalan paralel, selalu fetch ulang raw link GitHub** — jangan asumsi versi di room tertentu itu yang paling final, karena room lain mungkin sudah update lebih baru.
- **Claude tidak bisa kasih warning otomatis kalau limit chat mau habis** — jadi update file ini harus proaktif, di tiap titik keputusan penting kekunci, bukan nunggu limit mepet.

---

## 10. Constraint Pembayaran (Penting — Berlaku ke Semua Keputusan Infra)

Kartu yang tersedia:
- Kartu ATM/debit BRI — jaringan **GPN** (domestik Indonesia), **bukan** Visa/Mastercard. Tidak bisa dipakai untuk transaksi/verifikasi internasional.
- SeaBank — kartu **virtual**. Ditolak oleh layanan yang mensyaratkan kartu fisik (misal Oracle Cloud eksplisit menolak kartu virtual/prepaid).
- **Tidak ada** kartu kredit atau kartu debit fisik berlogo Visa/Mastercard.

**Konsekuensi:**
- Oracle Cloud Free Tier: **tidak bisa dipakai** (mensyaratkan kartu kredit/debit yang berfungsi seperti kredit, no PIN, no virtual/prepaid)
- Claude Pro / Claude Code subscription bulanan: **kemungkinan besar juga terhambat** untuk sekarang, karena subscription internasional umumnya butuh kartu yang sama
- Jasa pihak ketiga "jual VCC" (virtual credit card) via WhatsApp/Telegram: **tidak direkomendasikan** — risiko penipuan/data disalahgunakan, dan tetap berpotensi ditolak Oracle karena statusnya virtual

**Keputusan yang diambil:** pakai infrastruktur yang menerima pembayaran domestik langsung (transfer bank/e-wallet), bukan cari jalan pintas kartu virtual/pihak ketiga.

## 11. Keputusan & Status Infrastruktur

- **VPS: Biznet Gio, paket NEO Lite (~Rp50.000/bulan) — AKTIF & SECURED**
  - OS: **Ubuntu 22.04.5 LTS** (terkonfirmasi lewat SSH, sesuai rencana awal)
  - Data center: Jakarta
  - Username: `Rakyat`
  - Pembayaran: transfer bank/e-wallet domestik (resmi, langsung ke provider — bukan lewat perantara)
  - Alasan pilih: harga termurah di antara provider lokal, kredibel, tidak butuh kartu internasional
  - Alternatif kalau perlu ganti: IDCloudHost (storage NVMe lebih besar), DomaiNesia (tarif renewal flat)
- **Akses SSH: FULLY SECURED (4 Agustus 2026 malam)**
  - Login sekarang **hanya bisa via SSH key** — password login sudah dimatikan total (`PasswordAuthentication no` di `/etc/ssh/sshd_config.d/60-cloudimg-settings.conf`)
  - Tervalidasi: `ssh Rakyat@<ip_vps>` dari Termux langsung masuk tanpa diminta password
  - Root cause masalah SSH minggu-minggu sebelumnya **ditemukan**: 1 karakter di public key (`j` vs `J`) berubah/salah ketik saat proses copy-paste lewat noVNC di browser — bukan masalah format key atau kompatibilitas OpenSSH seperti dugaan awal
  - Fix: `ssh-copy-id Rakyat@<ip_vps>` dari Termux (bukan copy-paste manual, bukan lewat VNC) — jauh lebih reliable
- **Database: Supabase free tier** (belum berubah dari rencana awal, belum di-setup)
- **Node.js: rencana pakai versi 20 LTS** (belum di-install)

### Pelajaran penting — Console/VNC vs SSH/Termux

- **Hindari VNC/Console browser buat command presisi** (termasuk paste public key) — karakter, terutama huruf besar dan simbol, sering ke-drop/berubah saat diketik/paste lewat keyboard Android di browser
- **Termux (app native) jauh lebih reliable** untuk semua kerjaan SSH — prinsip ini sudah terbukti 2x (setup awal susah lewat VNC, akhirnya solved total lewat Termux + `ssh-copy-id`)
- Kalau nanti nemu masalah SSH/key lagi di masa depan: **cek dulu kemungkinan typo/karakter salah** sebelum curiga ke hal yang lebih rumit (format key, versi OpenSSH, dll)

### Hardening — status per item (urutan sebelum lanjut install lain-lain):
- [x] Setup SSH key yang benar dari Termux, verifikasi bisa login pakai key tanpa password — **SELESAI**
- [x] Disable password login (`PasswordAuthentication no`) — **SELESAI**, restart `ssh` service berhasil tanpa error, konfirmasi via `systemctl status ssh` (`active running`)
- [ ] Firewall UFW aktif (allow OpenSSH + port yang dibutuhkan saja)
- [ ] Install Fail2Ban (proteksi brute-force SSH)
- [ ] Verifikasi user `Rakyat` non-root dengan sudo access yang benar (kemungkinan sudah oke, tinggal dicek — `Rakyat` sudah bisa `sudo`)
- [ ] Setup backup manual rutin (`pg_dump` disimpan di storage terpisah, misal Google Drive)
- [ ] Pertimbangkan hapus key `ssh-rsa` lama dari `authorized_keys` kalau sudah dipastikan tidak dipakai lagi (saat ini masih ada 2 key: `ssh-rsa` lama + `ssh-ed25519 fashion-platform` yang sudah fixed)

### Belum dilakukan sekarang (sengaja ditunda, bukan lupa):
- Docker/Kubernetes — over-engineering untuk fase ini
- Pindah ke cloud besar (AWS/GCP) — nunggu ada kebutuhan skala nyata
- Claude Code terpasang permanen — nunggu kartu internasional beres atau proyek sudah generate income

## 12. Tool Development — Kapan Baru Relevan (Bukan Sekarang)

Sudah dibahas dan diputuskan **ditunda**, bukan ditolak — dipakai nanti di fase yang sesuai:

| Tool | Fungsi | Kapan baru relevan |
|---|---|---|
| **Claude Code** | Agentic coding, akses langsung ke file/repo/terminal | Begitu mulai coding backend beneran (bukan fase desain), dan kartu internasional/API credit sudah tersedia |
| **MCP (Model Context Protocol)** | Konektor AI ↔ tools eksternal (GitHub, Supabase, dll) | Begitu ada repo aktif dipakai coding & database live yang butuh diakses langsung oleh AI |
| **Graphite** | Visualisasi stacked PR, review kode berbasis graph/node | Begitu ada banyak perubahan kode kecil yang saling ketergantungan, atau sudah ada tim/kolaborator review |

**Prinsip umum:** jangan pasang tool baru sebelum ada kebutuhan nyata yang dia selesaikan — matched ke fase proyek saat itu, bukan ke rasa "biar canggih".

## 13. Analisis Kode LTOS Lama — Strategi Basis Backend

**Keputusan besar:** kode backend LTOS (di `~/ltos/src` di Termux) **TIDAK dibuang** — dipakai sebagai basis/fondasi backend fashion-platform yang baru. Ini bukan proyek yang harus dimulai dari nol; sebagian besar konsep inti di checkpoint bagian 5-9 **sudah ada implementasinya** di LTOS, tinggal digeneralisasi dari single-tenant ke multi-tenant.

### Struktur file LTOS (`~/ltos/src/`)

- `schema.sql` — skema database inti (event store + projection)
- `server.js` — Express app: REST endpoints, staff auth, lock system, WebSocket relay
- `stateLayer.js` — logic apply event ke projection, dengan gap handling & optimistic locking
- `versioning.js` — assign nomor versi event secara atomik (row lock + transaction)
- `worker.js` — background job: gap monitor + bundle-split reconciler
- `ingestion.js` — validasi & routing event masuk, termasuk logic reject/cancel sebagian (bundle allocation)
- `db.js` — koneksi pool ke Postgres (Supabase)
- `package.json` — dependency minimal: `express`, `ws`, `pg`

### Pemetaan konsep: checkpoint (rencana) ↔ LTOS (implementasi existing)

| Konsep di checkpoint | Status di LTOS | Catatan |
|---|---|---|
| `production_events` (event-sourced) | ✅ Ada, sangat matang | Tabel `events` + `state_version_tracker`, strict versioning per entity, replay-safe |
| Gap/consistency handling | ✅ Ada | `pending_events` (buffer out-of-order), `gap_status` (state machine OPEN→RECOVERING→ESCALATED), auto-monitor tiap 10 detik |
| Reject/cancel massal (bagian 8) | ✅ Ada, sudah di-refactor jadi general | `BUNDLE_ALLOCATION` — 1 bundle bisa dipecah jadi N bagian (reject/cancel) sekaligus, masing-masing dengan alasan & target stage sendiri. Evolusi dari versi awal `BUNDLE_SPLIT` yang cuma bisa 1-ke-2 |
| Job locks | ✅ Ada | `order_locks` — staff cuma bisa pegang 1 order aktif (kecuali admin override pakai PIN), terikat ke `assigned_stage` staff |
| Staff & role | ✅ Ada | Tabel `staff`, PIN login (`pgcrypto`), role admin/staff, session token 8 jam, rate limit brute-force (per staff_id + per IP) |
| Real-time update | ✅ Ada | Postgres `LISTEN/NOTIFY` di-relay ke WebSocket — tidak butuh Redis/Kafka |
| Pipeline stage per tenant (configurable) | ⚠️ Parsial | LTOS pakai `STAGE_ORDER` hardcode (fixed array). Rencana baru: `tenant_pipeline_stages`, configurable per tenant — perlu digeneralisasi |
| Upload foto per stage | ✅ Ada | `production_stage_photos` — upload ke Supabase Storage, validasi stage & ukuran max 5MB |
| Multi-tenant (`tenant_id`) | ❌ Belum ada | LTOS itu single-tenant (1 toko). **Ini kerjaan utama generalisasi**: semua tabel & query perlu ditambah `tenant_id` |
| Billing per tenant | ❌ Belum ada | Perlu dibangun dari nol, tidak relevan di LTOS (single-tenant) |
| WEB/consultation → `order_specs` | ❌ Belum ada di LTOS | LTOS sepertinya mulai dari titik order sudah masuk produksi, bukan dari konsultasi awal customer |

### Pelajaran desain penting dari histori refactoring LTOS

Ditemukan lewat file `fix_*.js` (script refactoring, bukan bug fix): LTOS awalnya pakai desain **`BUNDLE_SPLIT`** yang cuma bisa split 1 bundle jadi maksimal 2 bagian (lolos vs reject). Setelah dipakai, ketemu keterbatasan — realita sering butuh lebih dari 2 kemungkinan sekaligus (reject dengan beberapa alasan berbeda + cancel sebagian, dalam 1 bundle yang sama). Di-refactor jadi **`BUNDLE_ALLOCATION`** yang general (N alokasi sekaligus, tiap alokasi punya `type` reject/cancel + `reason` + `target_stage` sendiri).

**Implikasi buat proyek baru:** langsung mulai dari desain `BUNDLE_ALLOCATION` (versi general), skip desain `BUNDLE_SPLIT` yang sudah terbukti kurang cukup — tidak perlu mengulang proses trial-error yang sama.

### Environment variables yang dibutuhkan (nilai tersimpan di `.bashrc` Termux lama — JANGAN taruh nilainya di checkpoint/chat manapun ke depannya)

- `DATABASE_URL` — koneksi Postgres (Supabase, region `ap-southeast-1`)
- `SUPABASE_URL` — endpoint API Supabase
- `SUPABASE_SECRET_KEY` — akses Supabase Storage (upload foto stage)
- `API_KEY` — proteksi endpoint REST (custom, buat autentikasi server-to-server)
- `PORT` — opsional, default 3000

**Catatan keamanan:** kredensial di atas sempat ter-paste ke chat Claude saat proses eksplorasi (4 Agustus). Karena ini kredensial milik sendiri (bukan pihak lain), tidak wajib segera diganti, tapi disarankan **rotate password Supabase** di kemudian hari sebagai kebiasaan baik. Ke depan: environment variables harus disimpan di file `.env` terpisah + masuk `.gitignore`, tidak pernah ditulis ke `.bashrc` atau di-paste ke chat manapun (termasuk ke Claude).

### Next steps — generalisasi LTOS ke multi-tenant

- [ ] Copy struktur `schema.sql` LTOS jadi basis `fashion_platform_schema_v2.sql`, tambahkan `tenant_id` ke semua tabel projection (`order_state` → jadi bagian dari `production_jobs`), termasuk composite unique constraint yang melibatkan `tenant_id`
- [ ] Adaptasi `stateLayer.js`, `versioning.js` — tambahkan `tenant_id` di semua query WHERE clause
- [ ] Adaptasi `ingestion.js` — `STAGE_ORDER` hardcode diganti jadi query ke `tenant_pipeline_stages` (configurable per tenant)
- [ ] Adaptasi `server.js` — semua endpoint perlu tenant resolver middleware (baca `tenant_id` dari subdomain, sesuai checkpoint bagian 3), staff/lock/session di-scope per tenant
- [ ] `worker.js` (gap monitor, bundle reconciler) — pastikan advisory lock key tidak bentrok antar-tenant kalau nanti dijalankan sebagai 1 proses untuk semua tenant sekaligus
- [ ] Belum ada di LTOS, perlu dibangun baru: `tenant_billing`, alur WEB/consultation → `order_specs`, `spec_substitution_requests` (ganti kain), `customer_decisions`, `customer_notifications`
- [ ] File `fix_*.js` di root `~/ltos/` — sudah selesai dieksekusi (mengubah `BUNDLE_SPLIT` jadi `BUNDLE_ALLOCATION`), tidak perlu dijalankan lagi, aman diarsipkan/dihapus dari proyek baru
- [ ] Belum dicek: `PROGRESS.md` (208KB, kemungkinan berisi catatan keputusan historis), `scanner.html` (UI staff, belum dilihat)

### Hasil audit kode LTOS (4 Agustus 2026) — perbaikan saat generalisasi ke multi-tenant

**Kekuatan yang harus dipertahankan:**
- Parameterized queries di semua tempat → aman dari SQL injection
- PIN staff di-hash pakai `pgcrypto` (`crypt()`), tidak disimpan plain text
- Transaction + row lock (`FOR UPDATE`) di `versioning.js` → aman dari race condition antar-request bersamaan
- Rate limiting brute-force PIN sudah ada (per staff_id + per IP)
- Pesan error login tidak membocorkan apakah staff_id valid atau tidak (digabung jadi 1 pesan generik)

**Perlu diperbaiki/disempurnakan saat generalisasi:**
- [ ] **Rate limiter & session in-memory** (`rateLimitMap`, `sessionMap`, `rateBuckets` di `server.js`/`ingestion.js`) — cuma jalan benar kalau 1 instance server. Begitu proyek discale jadi multi-instance, harus pindah ke Redis (shared state antar-instance)
- [ ] **API_KEY tunggal untuk semua endpoint** — perlu diubah jadi API key granular per tenant/integrasi, supaya kalau 1 key bocor, dampaknya cuma ke 1 tenant, bukan semua
- [ ] **Validasi format input PIN** belum ada di endpoint login (tidak fatal, query tetap aman karena parameterized, tapi sebaiknya ditambah validasi panjang/format sebelum ke database)
- [ ] **Logging penting** (login, lock override, force-unlock) saat ini cuma ke `console.error`/file log lokal. Sebaiknya event penting juga disimpan ke tabel database sendiri, supaya bisa diaudit tanpa perlu SSH ke server tiap tenant

**Kesimpulan audit:** tidak ditemukan celah keamanan fatal. Semua temuan bersifat "perlu disempurnakan untuk skala multi-tenant", bukan kesalahan mendasar. Kode ini layak dijadikan basis backend proyek baru.

## 14. VPS Security Hardening — SSH Key Fix (4 Agustus 2026, sesi malam)

**Masalah:** login masih minta password meski key `ssh-ed25519 fashion-platform` sudah terdaftar di `authorized_keys` server sejak sesi sebelumnya.

**Debug process:**
1. Cek `authorized_keys` di server (`cat ~/.ssh/authorized_keys`) — ada 2 key: `ssh-rsa` lama + `ssh-ed25519 fashion-platform`
2. Bandingkan dengan public key asli di Termux (`cat ~/.ssh/id_ed25519.pub`)
3. **Ketemu root cause:** satu karakter berbeda — server punya `...AAAAIAhj/9G6yKxDuRW...` (huruf kecil `j`), Termux asli punya `...AAAAIAhJ/9G6yKxDuRW...` (huruf besar `J`). Key di server **rusak/corrupt**, kemungkinan besar akibat proses copy-paste lewat noVNC browser di sesi sebelumnya (dikonfirmasi sesuai dugaan di bagian 11)

**Fix:**
1. `ssh-copy-id Rakyat@<ip_vps>` dari Termux — menambahkan public key yang benar ke server (minta password sekali)
2. Verifikasi: `ssh Rakyat@<ip_vps>` langsung masuk tanpa password — **berhasil**
3. Matikan password login: `sudo sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config.d/60-cloudimg-settings.conf`
4. Restart service: `sudo systemctl restart ssh`
5. Validasi sebelum keluar sesi: `sudo systemctl status ssh` → `active (running)`, tidak ada error
6. Test final: `exit` dari VPS, lalu `ssh Rakyat@<ip_vps>` dari Termux lagi — **langsung masuk tanpa password, konfirmasi hardening berhasil**

**Status akhir:** VPS sekarang **hanya bisa diakses via SSH key**, password authentication mati total. Ini menyelesaikan item hardening prioritas utama yang tertunda sejak beberapa sesi lalu.

**Belum dibersihkan:** key `ssh-rsa` lama masih ada di `authorized_keys` — belum dihapus, kemungkinan aman dibiarkan atau bisa di-cleanup nanti kalau dipastikan tidak dipakai.

## 15. Rencana Deploy Frontend — Vercel (Belum Dieksekusi)

**Sumber:** masukan dari teman, bukan keputusan Claude sepihak.

**Rencana:**
- Frontend akan di-deploy via **Vercel**, auto-deploy dari GitHub tiap kali push — supaya dapat link publik yang bisa dibagikan ke orang (calon user, investor, dll) tanpa perlu VPS aktif buat demo
- **Deploy per-komponen, bukan 1 project besar** — sejalan dengan arsitektur `componentized blocks` yang sudah direncanakan di bagian 1 (tampilan beda per tipe tenant). Tiap blok/komponen frontend bisa jadi project Vercel sendiri-sendiri, supaya gampang dicari dan dikelola satu-satu
- Backend tetap di VPS Biznet Gio — Vercel hanya untuk frontend, tidak menggantikan rencana backend yang sudah ada

**Status:** BELUM dieksekusi — belum ada kode frontend sama sekali di proyek ini (masih fase desain skema + generalisasi backend LTOS). Vercel baru relevan begitu mulai ada kode frontend beneran.

**Akun yang sudah tersedia (belum dipakai):** GitHub, Supabase, Vercel — ketiganya sudah punya akun, tinggal connect CLI di Termux/VPS satu-satu begitu masing-masing relevan dipakai (GitHub: sekarang, buat push checkpoint & kode; Supabase: sekarang, buat setup database yang sudah lama tertunda; Vercel: nanti, begitu ada kode frontend).

## 16. Percobaan Claude Code — Status: SEDANG BERJALAN (belum kelar, disambung room lain)

**Konteks:** ingin coba pasang Claude Code buat lihat sendiri sejauh mana bisa dipakai tanpa kartu internasional (bagian 10), daripada cuma nebak-nebak dari asumsi.

### Percobaan 1 — di Termux: GAGAL, platform tidak didukung
- `npm install -g @anthropic-ai/claude-code` — berhasil install package, tapi ada warning postinstall script belum jalan
- Fix manual postinstall (`node .../install.cjs`) → error jelas:
  ```
  Unsupported platform: android arm
  Supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64, linux-x64-musl, linux-arm64-musl, linux-arm64-android, linux-x64-android, win32-x64, win32-arm64
  ```
- **Kesimpulan:** Termux di HP ini jalan di arsitektur **android arm (32-bit)**, bukan arm64 — Claude Code tidak punya native binary untuk itu. **Claude Code TIDAK BISA dipasang langsung di Termux/HP ini.**

### Percobaan 2 — di VPS: BERHASIL sejauh ini, masih proses onboarding
- VPS pakai `linux-x64` — platform yang didukung
- **Install Node.js 20 LTS di VPS** (belum ada sebelumnya) — sukses:
  ```
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install nodejs -y
  ```
  Terverifikasi: `node -v` → v20.20.2, `npm -v` → 10.8.2
- **Install Claude Code di VPS** — sukses, tanpa warning apapun:
  ```
  sudo npm install -g @anthropic-ai/claude-code
  ```
- Jalanin `claude` — **berhasil start**, masuk ke onboarding wizard (pilih tema tampilan). Belum sampai ke tahap login/autentikasi Anthropic — jadi **belum ketahuan apakah kartu internasional (bagian 10) beneran jadi penghalang atau tidak**.

### Next steps (lanjutkan di room berikutnya, dari titik ini)
- [ ] Lanjutkan onboarding `claude` di VPS (posisi terakhir: baru pilih tema tampilan, tekan Enter buat pakai default Dark mode)
- [ ] Lihat apa langkah setelah tema — dugaan kuat berikutnya adalah step **login/autentikasi** (API key atau OAuth ke akun Anthropic)
- [ ] **Titik kritis yang ingin diketahui:** apakah login/subscription Claude Code benar-benar kebentur constraint kartu (bagian 10), atau ada opsi lain (misal API key dari Anthropic Console yang metode pembayarannya beda dari subscription Pro)
- [ ] Kalau ternyata kebentur pembayaran juga: kembali ke rencana semula (Claude Code ditunda, bagian 12), lanjut kerja pakai `gh` CLI (belum login) + Supabase CLI (belum diinstall) buat generalisasi schema/backend LTOS
- [ ] Kalau ternyata BISA jalan (ada jalur pembayaran yang works): ini bisa mengubah banyak rencana di bagian 12 — Claude Code bisa dipakai langsung di VPS buat bantu coding backend generalisasi LTOS

**Catatan penting:** proses ini masih di tengah jalan saat sesi berakhir (limit chat habis). Room berikutnya tinggal lanjut dari `claude` yang masih standby di posisi pilihan tema — SSH ke VPS lagi (`ssh Rakyat@103.58.101.155`), lalu kemungkinan perlu jalanin `claude` ulang kalau sesi terminal sebelumnya sudah putus.
