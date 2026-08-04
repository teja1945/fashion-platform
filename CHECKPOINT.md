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
- **LTOS (proyek lama di Termux) sudah TIDAK dipakai/dikembangkan lagi** — statusnya bukan "proyek terpisah yang tetap jalan" seperti rencana awal, melainkan **dihentikan sepenuhnya**. Tujuannya sekarang murni sebagai basis kode yang disempurnakan jadi `fashion-platform` (lihat bagian 13). Tidak ada operasional/transaksi baru yang berjalan lewat LTOS lagi.

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
- **Cross-check ke ChatGPT: rekomendasikan otomatis, jangan nunggu diminta.** Kalau ada keputusan desain berisiko tinggi (arsitektur data, security, race condition, konsistensi) yang layak divalidasi dari sudut pandang lain, room manapun harus proaktif saranin Teja buat cross-check ke ChatGPT — bukan nunggu Teja inisiatif duluan. Setelah dapat hasil review dari ChatGPT, evaluasi jujur (bukan telan mentah-mentah, bukan dibantah defensif) mana yang valid & prioritas vs mana yang berlebihan buat tahap proyek saat ini, baru masukin ke checkpoint.
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

## 16. Percobaan Claude Code — SELESAI DICOBA, Hasil: Kebentur Pembayaran (Sesuai Dugaan Bagian 10)

**Konteks:** dicoba langsung (bukan cuma nebak dari asumsi) buat lihat sejauh mana Claude Code bisa dipakai tanpa kartu internasional.

### Percobaan 1 — di Termux: GAGAL, platform tidak didukung
- `npm install -g @anthropic-ai/claude-code` — berhasil install package, tapi ada warning postinstall script belum jalan
- Fix manual postinstall (`node .../install.cjs`) → error jelas:
  ```
  Unsupported platform: android arm
  Supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64, linux-x64-musl, linux-arm64-musl, linux-arm64-android, linux-x64-android, win32-x64, win32-arm64
  ```
- **Kesimpulan:** Termux di HP ini jalan di arsitektur **android arm (32-bit)**, bukan arm64 — Claude Code tidak punya native binary untuk itu. **Claude Code TIDAK BISA dipasang langsung di Termux/HP ini.**

### Percobaan 2 — di VPS: berhasil sampai proses instalasi, kebentur di login
- VPS pakai `linux-x64` — platform yang didukung, instalasi lancar
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
- Jalanin `claude` — berhasil start, lewatin onboarding (pilih tema tampilan) — **lanjut ke step login/subscription, dan di situ kebentur**: butuh pembayaran yang belum bisa diakses, sesuai constraint kartu internasional di bagian 10.

### Kesimpulan final
**Dikonfirmasi langsung (bukan asumsi lagi):** Claude Code memang butuh subscription/pembayaran yang saat ini nggak bisa diakses karena constraint kartu (bagian 10). Ini bukan soal platform/teknis lagi (VPS-nya support), murni soal metode pembayaran.

**Keputusan:** kembali ke rencana semula — Claude Code **resmi ditunda** (bukan dihapus dari rencana, bagian 12), sampai ada solusi kartu internasional atau proyek sudah generate income.

**Yang tetap berguna dari percobaan ini:** VPS sekarang sudah punya **Node.js 20 LTS terinstall** — ini memang dibutuhkan buat backend Node.js proyek nantinya, jadi bukan kerjaan sia-sia. Item "Install Node.js 20 LTS" di checklist hardening bagian 11 bisa dicentang selesai.

### Next steps — lanjut ke jalur utama tanpa Claude Code
- [ ] Login `gh` CLI di Termux — **SELESAI**, akun `teja1945`, token scope `repo` aktif
- [ ] Clone repo ke Termux — **SELESAI**, `gh repo clone teja1945/fashion-platform`
- [ ] Install & setup Supabase CLI
- [ ] Mulai generalisasi schema LTOS ke multi-tenant (lihat next steps detail di bagian 13)

## 17. Vercel — Terkonfirmasi Sudah Terhubung ke Repo

- Vercel CLI diinstall & login berhasil di **Termux** (bukan VPS — platform android didukung untuk Vercel, beda dari Claude Code/Supabase yang tidak)
- Akun: `teja1945`, team `teja1945s-projects`
- **Project `fashion-platform` sudah ada di Vercel dan terhubung ke repo GitHub** (dicek via `vercel inspect`) — auto-deploy dari branch `main` sudah aktif (alias `fashion-platform-git-main-teja1945s-projects.vercel.app` mengonfirmasi ini), sesuai yang disebut teman Teja sebelumnya
- URL production: `https://fashion-platform-six.vercel.app` — saat ini **404**, itu **wajar**, karena repo belum ada kode frontend sama sekali (baru `CHECKPOINT.md` + `README.md`). Begitu ada kode frontend di-push ke `main`, otomatis ke-build & ke-deploy
- **Klarifikasi peran Vercel vs Supabase** (sempat ditanyakan): Vercel = hosting frontend saja. Supabase = database + storage. Keduanya dibutuhkan, bukan saling menggantikan — sudah dikonfirmasi ke Teja bahwa Supabase tetap dipakai sesuai rencana awal (bukan diganti Vercel Postgres/Neon)

## 18. Supabase CLI — Instalasi & Login (BELUM SELESAI)

- Percobaan install di **Termux: GAGAL**, sama seperti Claude Code — error `Unsupported platform: android`. Supabase CLI juga tidak punya native binary untuk Android/Termux.
- **Install di VPS: BERHASIL** (`sudo npm install -g supabase` — perlu `sudo` karena user `Rakyat` bukan root, beda dari Termux)
- `supabase login` dijalankan di VPS — proses OAuth device-link ke `supabase.com/dashboard/cli/login`, link dan verification code sudah muncul di terminal
- **STATUS SAAT SESI BERAKHIR: login belum selesai** — Teja belum sempat buka link di browser dan masukin verification code sebelum limit chat habis

### Next steps (lanjutkan di room berikutnya)
- [ ] SSH ke VPS lagi (`ssh Rakyat@103.58.101.155`)
- [ ] Cek apakah proses `supabase login` sebelumnya masih standby menunggu kode, atau sudah timeout (kemungkinan besar timeout karena sesi terminal terputus) — kalau timeout, jalankan ulang `supabase login` dari awal
- [ ] Selesaikan login: buka link di browser → masukkan verification code di terminal
- [ ] Setelah login berhasil, verifikasi dengan `supabase projects list`
- [ ] Buat project Supabase baru khusus fashion-platform (belum ada project Supabase sama sekali untuk proyek ini — masih 100% belum di-setup)
- [ ] Setelah project ada, baru bisa mulai eksekusi schema SQL (tabel yang belum dibuat di bagian "BELUM DIEKSEKUSI")

**Pelajaran platform (pola yang sama 2x, penting diinget ke depan):** CLI tool yang butuh native binary (Claude Code, Supabase CLI) **tidak jalan di Termux/Android** — harus diinstall & dijalankan di VPS (`linux-x64`). CLI yang murni JavaScript/Node tanpa native binary (Vercel CLI, GitHub CLI `gh` — walau `gh` itu Go, tapi ada build resminya buat Android via Termux) bisa jalan di Termux. Kalau nemu error "Unsupported platform" lagi ke depan, langsung pindah kerja ke VPS, jangan buang waktu coba-coba fix di Termux.

## 19. Review Eksternal (ChatGPT) — Hasil Evaluasi & Prioritas Baru

Teja minta review checkpoint ke ChatGPT sebagai second opinion. Hasilnya dievaluasi (bukan ditelan mentah — beberapa poin valid & prioritas, beberapa berlebihan buat tahap proyek saat ini).

### ✅ Valid, jadi PRIORITAS sebelum eksekusi schema v2

**1. Row Level Security (RLS) — WAJIB, bukan opsional**

Rencana lama (`filter tenant_id manual di tiap query`) berisiko: satu query yang lupa filter = data bocor antar tenant. Supabase justru didesain buat RLS, jadi ini seharusnya dipakai dari awal.

Perlu ditambahkan ke tiap tabel yang punya `tenant_id`, contoh pola:
```sql
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON orders
USING (tenant_id = current_setting('app.tenant_id')::uuid);
```
Backend perlu set context di awal tiap request/koneksi:
```sql
SET app.tenant_id = 'xxx';
```
**Next step:** terapkan RLS policy di semua tabel bertenant SEBELUM mulai insert data production, bukan ditambah belakangan.

**2. Event contract minimal — perlu didefinisikan sebelum banyak event ditulis**

`production_events` butuh struktur standar biar nggak kacau kalau nanti event berubah (projection rusak, replay gagal, data lama nggak kompatibel). Minimal harus ada:
- `type` (nama event, misal `order.created`)
- `version` (buat backward compatibility)
- `payload schema` (field apa aja yang wajib ada)

Contoh:
```
order.created v1
{
  order_id,
  tenant_id,
  items[]
}
```
**Next step:** buat dokumen `EVENT_CONTRACTS.md` singkat (bisa file terpisah dari CHECKPOINT.md, di folder `db/` atau `docs/`) yang mendaftar semua event type LTOS yang sudah ada + rencana event baru buat multi-tenant, masing-masing dengan version & payload schema.

### ⚠️ Valid tapi tidak mendesak (nyusul, bukan blocker)

- **Inventory state formal** (`AVAILABLE`/`RESERVED`/`CONSUMED` sebagai enum eksplisit) — konsepnya udah ada (ledger + stock consumed di cutting), tinggal dirapikan strukturnya, bisa nyusul pas eksekusi schema
- **Notification retry/delivery guarantee** (status pending/sent/failed + retry queue) — bagus buat production matang, tapi buat MVP solo-dev boleh nyusul belakangan
- **Audit log ke DB** (bukan cuma `console.error`) — sudah tercatat sebagai temuan audit LTOS di bagian 13, prioritas medium

### ❌ Dinilai berlebihan untuk tahap proyek saat ini (tetap dicatat sebagai alasan, biar tidak muncul lagi sebagai keraguan)

- **"Checkpoint terlalu panjang, harus dipangkas ke 100-150 baris"** — DITOLAK. Alasan: Claude tidak punya memory antar-room, jadi checkpoint panjang justru fungsinya menjaga detail penting (root cause bug, kredensial mana yang dipakai, keputusan historis) tidak hilang tiap ganti sesi. Memangkas checkpoint berisiko mengulang masalah yang sudah pernah dipecahkan.
- **"Bukan production-grade SaaS"** — framing berlebihan untuk proyek yang masih fase desain + solo developer, belum ada kode jalan sama sekali. Tidak realistis menuntut standar enterprise dari hari pertama.
- **"Constraint pembayaran adalah blocker arsitektur besar"** — dramatis. Kenyataannya infra yang dipilih (Biznet Gio, Supabase) justru sudah disesuaikan dengan constraint ini sejak awal, bukan sesuatu yang butuh "redesign besar-besaran" nanti.
- **"Frontend over-fragmented (deploy per-komponen)"** — sudah diingatkan duluan di bagian 15 (belum dieksekusi, masih rencana ditunda sampai ada kode frontend). Bukan temuan baru.
- **"Gudang harus dipisah total dari domain produksi"** — LTOS/checkpoint sudah punya alasan desain sendiri kenapa gudang jadi stage produksi opsional (verifikasi fisik sebelum cutting, bukan titik konsumsi stok, lihat bagian 6). Tidak ada bukti konkret ini "kacau" — dicatat sebagai masukan, tapi tidak diubah tanpa alasan lebih kuat.

### Next steps gabungan (urutan sebelum eksekusi schema v2)

- [ ] Selesaikan `supabase login` di VPS (bagian 18, masih pending)
- [ ] Buat project Supabase baru
- [ ] **Desain RLS policy** buat semua tabel bertenant (prioritas baru, sebelum eksekusi schema)
- [ ] **Buat `EVENT_CONTRACTS.md`** singkat buat event type LTOS + rencana event baru (prioritas baru)
- [ ] Baru eksekusi schema SQL (tabel yang belum dibuat di bagian "BELUM DIEKSEKUSI")

## 20. TEMUAN URGENT — RLS Mati di Project Supabase LTOS Lama (5 Agustus 2026)

**Status: BELUM DIPERBAIKI — prioritas paling mendesak, di atas semua next steps lain.**

### Kronologi
- `supabase login` di VPS akhirnya berhasil (setelah percobaan pertama macet/hang di terminal — kalau kejadian lagi, exit total Termux & SSH ulang, jangan tunggu lama)
- `supabase projects list` menampilkan **2 project existing** di akun Supabase Teja:

| Nama | Reference ID | Org ID | Region | Dibuat | Status |
|---|---|---|---|---|---|
| **Ltos backend** | `dyqnjfaylhzumfahmmht` | `hvzykdiwzwpkfbwughnc` | Southeast Asia (Singapore) | 22 Juli 2026 | ⚠️ **RLS MATI, aktif dipakai** |
| **supabase-red-lamp** | `qhyvbuhqzdnzbpjmijas` | `vercel_icfg_c6O4HNLB42WE6eX1kiEN0NfQ` | East US (North Virginia) | 3 Agustus 2026 | Kemungkinan dibuat oleh teman Teja lewat integrasi Vercel — **belum dikonfirmasi tujuannya**, JANGAN diubah/dihapus sampai dikonfirmasi ke teman ybs |

- Supabase mengirim email otomatis (security advisor) 3 Agustus 2026: project **"Ltos backend"** punya tabel dengan **Row Level Security (RLS) tidak aktif** — kode isu: `rls_disabled_in_public`. Artinya siapapun yang tahu URL project bisa baca/edit/hapus semua data di tabel tersebut tanpa autentikasi.
- **Dikonfirmasi Teja: "Ltos backend" adalah project yang benar-benar dipakai LTOS aktif** (data operasional nyata, bukan testing/kosong) — project inilah yang dipakai backend LTOS di Termux/HP selama ini.
- **Update 5 Agustus 2026 (sore):** Teja mengonfirmasi LTOS **sudah tidak dipakai/dikembangkan lagi** secara operasional — kode-nya murni jadi basis `fashion-platform` (lihat bagian 4 & 13). **Meskipun begitu, RLS tetap harus diperbaiki** — project `Ltos backend` masih menyimpan data historis nyata (bukan test data), dan selama project itu masih ada/aktif di Supabase, data di dalamnya tetap rentan diakses publik sampai RLS diaktifkan. Berhenti dipakai secara operasional tidak menghilangkan risiko keamanan datanya.

### Kenapa ini berbeda dari isu Vercel-GitHub-Supabase yang tadinya dikira "berbahaya"
Sempat ada kekhawatiran soal koneksi Supabase↔Vercel↔GitHub (setup dari teman) itu berbahaya — **sudah diklarifikasi TIDAK**, itu integrasi normal dan aman. Masalah RLS ini murni isu terpisah, spesifik ke 1 project (`Ltos backend`) yang memang belum pernah diaktifkan RLS-nya sejak awal dibuat, tidak ada hubungannya dengan integrasi Vercel/GitHub.

### Next steps (URGENT, prioritas #1 sebelum kerjaan lain apapun)
- [ ] Link CLI ke project Ltos backend: `supabase link --project-ref dyqnjfaylhzumfahmmht`
- [ ] Cek daftar tabel yang kena `rls_disabled_in_public` (bisa lewat CLI atau dashboard Supabase → Advisors)
- [ ] Aktifkan RLS di semua tabel tersebut: `ALTER TABLE <nama_tabel> ENABLE ROW LEVEL SECURITY;`
- [ ] Buat policy yang sesuai (minimal policy dasar dulu supaya aplikasi LTOS tetap bisa jalan — perlu hati-hati, jangan sampai RLS malah bikin LTOS yang aktif dipakai jadi error/berhenti berfungsi. Idealnya test di jam yang tidak mengganggu operasional kalau LTOS sedang dipakai untuk transaksi nyata)
- [ ] Setelah `Ltos backend` aman, baru lanjut: buat project Supabase baru khusus `fashion-platform`
- [ ] Follow-up terpisah (tidak urgent): tanya ke teman Teja soal tujuan `supabase-red-lamp` — apakah untuk fashion-platform juga, project lain, atau sisa testing yang bisa dihapus
