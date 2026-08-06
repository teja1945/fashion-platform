CHECKPOINT — Fashion Platform (Multi-Tenant SaaS)
Update terakhir: 6 Agustus 2026 (role app_user diverifikasi & disinkronkan, kontradiksi checkpoint diperbaiki) Cara pakai: paste/replace isi file ini ke CHECKPOINT.md di repo GitHub kamu tiap selesai sesi. Sesi berikutnya (room manapun) tinggal kasih raw link file ini ke Claude sebelum mulai kerja, biar konteks lengkap tanpa perlu re-explain.

1. Arah Proyek
Platform multi-tenant SaaS untuk bisnis fashion — bukan duplikat-per-brand seperti LTOS lama.

Dipakai oleh: brand owner, vendor konveksi, custom tailor, pabrik
Tampilan depan (frontend) beda per tipe tenant, disusun dari componentized blocks
Backend, produksi, dan inventory sama untuk semua tipe tenant
2. Model Bisnis
Uang customer masuk langsung ke tenant — platform tidak memegang transaksi
Platform dapat pemasukan dari tenant lewat: fee per-transaksi / bulanan / kontrak tahunan
Disimpan di tabel tenant_billing
3. Akses Tenant
Subdomain per tenant: namatenant.domain.com
1 backend + 1 database untuk semua tenant
Isolasi data lewat filter tenant_id di setiap query (DAN RLS — lihat bagian 19 & 22, RLS wajib bukan opsional)
4. Infrastruktur
VPS aktif dan sudah fully secured via SSH key (lihat bagian 11 — hardening SSH selesai)
Setup infra dilakukan sebelum mulai coding versi baru
LTOS (proyek lama di Termux) sudah TIDAK dipakai/dikembangkan lagi — statusnya bukan "proyek terpisah yang tetap jalan" seperti rencana awal, melainkan dihentikan sepenuhnya. Tujuannya sekarang murni sebagai basis kode yang disempurnakan jadi fashion-platform (lihat bagian 13). Tidak ada operasional/transaksi baru yang berjalan lewat LTOS lagi.
5. Skema Database v2
File aktif: fashion_platform_schema_v2.sql (lihat folder db/) File lama (arsip, referensi): garment_production_schema.sql (v1, single-tenant)

Tabel yang sudah ada di v2 (19 tabel, sudah dieksekusi — lihat bagian 24):

tenants
tenant_billing
orders, order_specs, order_spec_materials
payments
fabric_inventory, inventory_ledger
shipments
tenant_pipeline_stages (pipeline produksi configurable per tenant)
production_jobs, production_events (event-sourced, generalisasi pola LTOS)
staff, job_locks, work_log, production_stage_photos
spec_substitution_requests, customer_decisions, customer_notifications (tabel baru)
6. Stage Produksi
Tidak ada konsultasi di tahap produksi — itu murni fase WEB, sudah masuk order_specs
Gudang adalah stage produksi pertama (opsional per tenant):
Fungsi: verifikasi fisik bahan sebelum cutting
Bukan titik konsumsi stok — STOCK_CONSUMED tetap terjadi di tahap cutting
7. Ganti Kain (Gudang)
Alur approval 2 lapis:

Admin PIN dulu (filter internal)
Baru dikirim ke customer untuk approve/reject (transparansi)
Tabel: spec_substitution_requests (sudah dibuat, lihat bagian 24)

8. Reject/Cancel Massal + Notifikasi Customer
Aturan notifikasi:

SELALU kirim notif kalau: cancel permanen, atau butuh keputusan customer
Reject yang bisa diperbaiki: TIDAK kirim notif kecuali kumulatif menyebabkan delay
Agregasi WAJIB per total order (bukan per-bundle-kecil), pakai kolom last_notified_qty supaya tidak spam
Pilihan customer saat butuh keputusan (tabel customer_decisions, sudah dibuat):

REFUND
WAIT_REPRODUCTION
CHOOSE_ALTERNATIVE
9. No-Response Handling
Eskalasi bertahap: reminder → coba telfon manual → default action di deadline

Bukan langsung diam-diam jalan otomatis
Kebijakan deadline & default action di-snapshot ke orders.checkout_policy_snapshot saat checkout — supaya perubahan kebijakan di kemudian hari tidak menimpa kesepakatan order lama
Deadline configurable per tenant: tenants.default_response_deadline_days
Status skema untuk fitur ini: kolom checkout_policy_snapshot dan default_response_deadline_days sudah ada di schema v2 (lihat bagian 24)

BELUM DIEKSEKUSI (sisa next steps backend, per 6 Agustus 2026)
Skema — SEMUA SUDAH SELESAI (lihat bagian 24), tidak ada lagi item skema pending di sini.

Infrastruktur — Hardening (lihat detail di bagian 11)
 Setup SSH key yang benar dari Termux — SELESAI
 Disable PasswordAuthentication — SELESAI
 Firewall UFW aktif — BELUM
 Install Fail2Ban — BELUM
 Verifikasi user Rakyat sudah non-root dengan sudo access yang benar — kemungkinan sudah oke, tinggal dicek
 Setup backup manual rutin (pg_dump ke storage terpisah) — BELUM
 Install Node.js 20 LTS — SELESAI (lihat bagian 16)
 Project Supabase baru (terpisah dari LTOS lama) — SELESAI, reference kwhybffbcqopqbbnuigg (lihat bagian 21)

Backend
 Function/procedure spec-lock (atomik: reserve inventory + ledger + event)
 Backend skeleton: tenant resolver middleware
 Mulai dari 1 tipe tenant dulu: brand ready-stock (paling simpel), baru generalisasi ke 4 tipe lain

Catatan Kolaborasi
Repo: public, satu sumber kebenaran untuk semua room/sesi Claude
Strategi branch: untuk saat ini (fase desain, belum ada kode jalan), cukup commit langsung ke main. Branch work/<topik> baru dipakai kalau sudah mulai coding beneran.
Tidak ada koneksi otomatis Claude ↔ GitHub saat ini (belum ada connector GitHub tersedia) — update file ini secara manual: copy isi terbaru dari Claude → paste/commit lewat GitHub app.
Tiap sesi baru, kasih raw link CHECKPOINT.md ini ke Claude sebelum minta lanjut kerja (raw link, bukan link blob GitHub biasa — lebih ringan diproses).
Kalau ada beberapa room jalan paralel, selalu fetch ulang raw link GitHub — jangan asumsi versi di room tertentu itu yang paling final, karena room lain mungkin sudah update lebih baru.
PENTING — masalah CDN caching raw.githubusercontent.com: link raw GitHub sering nge-cache versi lama, TERBUKTI kejadian nyata 6 Agustus (room baru sempat baca versi lama meski sudah pakai query string ?t= cache-bust). Query string ?t=TIMESTAMP TIDAK CUKUP untuk pin ke versi tertentu, karena itu bukan cara resmi GitHub menentukan versi file. SOLUSI YANG TERBUKTI JALAN: pakai commit SHA langsung di path URL, format https://raw.githubusercontent.com/teja1945/fashion-platform/COMMIT_SHA/CHECKPOINT.md (ganti COMMIT_SHA dengan commit hash terbaru dari git push atau git log -1 --oneline). WAJIB selalu kasih link format ini + commit hash ke Claude di awal sesi, dan minta Claude eksplisit konfirmasi konten yang dibaca sudah sesuai commit tersebut sebelum lanjut kerja.

PENTING (pelajaran baru 6 Agustus): room paralel BISA menghasilkan kontradiksi kalau menulis bagian checkpoint yang sama di waktu bersamaan lalu di-commit tanpa disatukan (contoh nyata: 2 versi "bagian 24" sempat ada sekaligus, isinya saling bertentangan soal status role app_user). Kalau nemu info yang meragukan/berpotensi kontradiksi antar bagian checkpoint, JANGAN percaya salah satu versi — verifikasi langsung ke sumber aslinya (query ke database, cek file di server, dll) sebelum lanjut kerja.
Cross-check ke ChatGPT: rekomendasikan otomatis, jangan nunggu diminta. Kalau ada keputusan desain berisiko tinggi (arsitektur data, security, race condition, konsistensi) yang layak divalidasi dari sudut pandang lain, room manapun harus proaktif saranin Teja buat cross-check ke ChatGPT — bukan nunggu Teja inisiatif duluan. Setelah dapat hasil review dari ChatGPT, evaluasi jujur (bukan telan mentah-mentah, bukan dibantah defensif) mana yang valid & prioritas vs mana yang berlebihan buat tahap proyek saat ini, baru masukin ke checkpoint.
Claude tidak bisa kasih warning otomatis kalau limit chat mau habis — jadi update file ini harus proaktif, di tiap titik keputusan penting kekunci, bukan nunggu limit mepet.
10. Constraint Pembayaran (Penting — Berlaku ke Semua Keputusan Infra)
Kartu yang tersedia:

Kartu ATM/debit BRI — jaringan GPN (domestik Indonesia), bukan Visa/Mastercard. Tidak bisa dipakai untuk transaksi/verifikasi internasional.
SeaBank — kartu virtual. Ditolak oleh layanan yang mensyaratkan kartu fisik (misal Oracle Cloud eksplisit menolak kartu virtual/prepaid).
Tidak ada kartu kredit atau kartu debit fisik berlogo Visa/Mastercard.
Konsekuensi:

Oracle Cloud Free Tier: tidak bisa dipakai (mensyaratkan kartu kredit/debit yang berfungsi seperti kredit, no PIN, no virtual/prepaid)
Claude Pro / Claude Code subscription bulanan: terkonfirmasi terhambat (lihat bagian 16 — sudah dicoba langsung, kebentur pembayaran saat login)
Jasa pihak ketiga "jual VCC" (virtual credit card) via WhatsApp/Telegram: tidak direkomendasikan — risiko penipuan/data disalahgunakan, dan tetap berpotensi ditolak Oracle karena statusnya virtual
Keputusan yang diambil: pakai infrastruktur yang menerima pembayaran domestik langsung (transfer bank/e-wallet), bukan cari jalan pintas kartu virtual/pihak ketiga.

Eksplorasi baru (belum dieksekusi, ditunda beberapa hari): jalur Claude Pro (termasuk Claude Code) via Google Play billing — isi saldo Google Play pakai voucher/e-wallet domestik, sebagai alternatif dari billing langsung Anthropic yang kebentur kartu GPN. Opsi BRI dan QRIS ditolak khusus untuk Claude, tapi GoPay/ShopeePay/saldo Google Play/voucher masih berpotensi.

11. Keputusan & Status Infrastruktur
VPS: Biznet Gio, paket NEO Lite (~Rp50.000/bulan) — AKTIF & SECURED
OS: Ubuntu 22.04.5 LTS (terkonfirmasi lewat SSH, sesuai rencana awal)
Data center: Jakarta
Username: Rakyat
IP: 103.58.101.155
Pembayaran: transfer bank/e-wallet domestik (resmi, langsung ke provider — bukan lewat perantara)
Alasan pilih: harga termurah di antara provider lokal, kredibel, tidak butuh kartu internasional
Alternatif kalau perlu ganti: IDCloudHost (storage NVMe lebih besar), DomaiNesia (tarif renewal flat)
Akses SSH: FULLY SECURED (4 Agustus 2026 malam)
Login sekarang hanya bisa via SSH key — password login sudah dimatikan total (PasswordAuthentication no di /etc/ssh/sshd_config.d/60-cloudimg-settings.conf)
Tervalidasi: ssh Rakyat@<ip_vps> dari Termux langsung masuk tanpa diminta password
Root cause masalah SSH minggu-minggu sebelumnya ditemukan: 1 karakter di public key (j vs J) berubah/salah ketik saat proses copy-paste lewat noVNC di browser — bukan masalah format key atau kompatibilitas OpenSSH seperti dugaan awal
Fix: ssh-copy-id Rakyat@<ip_vps> dari Termux (bukan copy-paste manual, bukan lewat VNC) — jauh lebih reliable
Database: Supabase — project baru fashion-platform sudah dibuat & schema v2 sudah dieksekusi (lihat bagian 21, 24). Role app_user (non-superuser, no bypass RLS) sudah lengkap (lihat bagian 24 — final)
Node.js: v20.20.2 terinstall di VPS (lihat bagian 16)
Pelajaran penting — Console/VNC vs SSH/Termux
Hindari VNC/Console browser buat command presisi (termasuk paste public key) — karakter, terutama huruf besar dan simbol, sering ke-drop/berubah saat diketik/paste lewat keyboard Android di browser
Termux (app native) jauh lebih reliable untuk semua kerjaan SSH — prinsip ini sudah terbukti 2x (setup awal susah lewat VNC, akhirnya solved total lewat Termux + ssh-copy-id)
Kalau nanti nemu masalah SSH/key lagi di masa depan: cek dulu kemungkinan typo/karakter salah sebelum curiga ke hal yang lebih rumit (format key, versi OpenSSH, dll)
Hardening — status per item (urutan sebelum lanjut install lain-lain):
 Setup SSH key yang benar dari Termux, verifikasi bisa login pakai key tanpa password — SELESAI
 Disable password login (PasswordAuthentication no) — SELESAI, restart ssh service berhasil tanpa error, konfirmasi via systemctl status ssh (active running)
 Firewall UFW aktif (allow OpenSSH + port yang dibutuhkan saja) — BELUM
 Install Fail2Ban (proteksi brute-force SSH) — BELUM
 Verifikasi user Rakyat non-root dengan sudo access yang benar (kemungkinan sudah oke, tinggal dicek — Rakyat sudah bisa sudo)
 Setup backup manual rutin (pg_dump disimpan di storage terpisah, misal Google Drive) — BELUM
 Pertimbangkan hapus key ssh-rsa lama dari authorized_keys kalau sudah dipastikan tidak dipakai lagi (saat ini masih ada 2 key: ssh-rsa lama + ssh-ed25519 fashion-platform yang sudah fixed) — BELUM
Belum dilakukan sekarang (sengaja ditunda, bukan lupa):
Docker/Kubernetes — over-engineering untuk fase ini
Pindah ke cloud besar (AWS/GCP) — nunggu ada kebutuhan skala nyata
Claude Code terpasang permanen — nunggu kartu internasional beres atau proyek sudah generate income (lihat bagian 10 & 16 buat eksplorasi jalur alternatif)
12. Tool Development — Kapan Baru Relevan (Bukan Sekarang)
Sudah dibahas dan diputuskan ditunda, bukan ditolak — dipakai nanti di fase yang sesuai:

Tool	Fungsi	Kapan baru relevan
Claude Code	Agentic coding, akses langsung ke file/repo/terminal	Begitu mulai coding backend beneran (bukan fase desain), dan kartu internasional/API credit sudah tersedia. Sudah dicoba langsung — lihat bagian 16
MCP (Model Context Protocol)	Konektor AI ↔ tools eksternal (GitHub, Supabase, dll)	Begitu ada repo aktif dipakai coding & database live yang butuh diakses langsung oleh AI
Graphite	Visualisasi stacked PR, review kode berbasis graph/node	Begitu ada banyak perubahan kode kecil yang saling ketergantungan, atau sudah ada tim/kolaborator review
Prinsip umum: jangan pasang tool baru sebelum ada kebutuhan nyata yang dia selesaikan — matched ke fase proyek saat itu, bukan ke rasa "biar canggih".

13. Analisis Kode LTOS Lama — Strategi Basis Backend
Keputusan besar: kode backend LTOS (di ~/ltos/src di Termux) TIDAK dibuang — dipakai sebagai basis/fondasi backend fashion-platform yang baru. Ini bukan proyek yang harus dimulai dari nol; sebagian besar konsep inti di checkpoint bagian 5-9 sudah ada implementasinya di LTOS, tinggal digeneralisasi dari single-tenant ke multi-tenant.

Struktur file LTOS (~/ltos/src/)
schema.sql — skema database inti (event store + projection)
server.js — Express app: REST endpoints, staff auth, lock system, WebSocket relay
stateLayer.js — logic apply event ke projection, dengan gap handling & optimistic locking
versioning.js — assign nomor versi event secara atomik (row lock + transaction)
worker.js — background job: gap monitor + bundle-split reconciler
ingestion.js — validasi & routing event masuk, termasuk logic reject/cancel sebagian (bundle allocation)
db.js — koneksi pool ke Postgres (Supabase)
package.json — dependency minimal: express, ws, pg
Pemetaan konsep: checkpoint (rencana) ↔ LTOS (implementasi existing)
Konsep di checkpoint	Status di LTOS	Catatan
production_events (event-sourced)	✅ Ada, sangat matang	Tabel events + state_version_tracker, strict versioning per entity, replay-safe
Gap/consistency handling	✅ Ada	pending_events (buffer out-of-order), gap_status (state machine OPEN→RECOVERING→ESCALATED), auto-monitor tiap 10 detik
Reject/cancel massal (bagian 8)	✅ Ada, sudah di-refactor jadi general	BUNDLE_ALLOCATION — 1 bundle bisa dipecah jadi N bagian (reject/cancel) sekaligus, masing-masing dengan alasan & target stage sendiri. Evolusi dari versi awal BUNDLE_SPLIT yang cuma bisa 1-ke-2
Job locks	✅ Ada	order_locks — staff cuma bisa pegang 1 order aktif (kecuali admin override pakai PIN), terikat ke assigned_stage staff
Staff & role	✅ Ada	Tabel staff, PIN login (pgcrypto), role admin/staff, session token 8 jam, rate limit brute-force (per staff_id + per IP)
Real-time update	✅ Ada	Postgres LISTEN/NOTIFY di-relay ke WebSocket — tidak butuh Redis/Kafka
Pipeline stage per tenant (configurable)	⚠️ Parsial	LTOS pakai STAGE_ORDER hardcode (fixed array). Rencana baru: tenant_pipeline_stages, configurable per tenant — perlu digeneralisasi
Upload foto per stage	✅ Ada	production_stage_photos — upload ke Supabase Storage, validasi stage & ukuran max 5MB
Multi-tenant (tenant_id)	❌ Belum ada	LTOS itu single-tenant (1 toko). Ini kerjaan utama generalisasi: semua tabel & query perlu ditambah tenant_id
Billing per tenant	❌ Belum ada	Perlu dibangun dari nol, tidak relevan di LTOS (single-tenant)
WEB/consultation → order_specs	❌ Belum ada di LTOS	LTOS sepertinya mulai dari titik order sudah masuk produksi, bukan dari konsultasi awal customer
Pelajaran desain penting dari histori refactoring LTOS
Ditemukan lewat file fix_*.js (script refactoring, bukan bug fix): LTOS awalnya pakai desain BUNDLE_SPLIT yang cuma bisa split 1 bundle jadi maksimal 2 bagian (lolos vs reject). Setelah dipakai, ketemu keterbatasan — realita sering butuh lebih dari 2 kemungkinan sekaligus (reject dengan beberapa alasan berbeda + cancel sebagian, dalam 1 bundle yang sama). Di-refactor jadi BUNDLE_ALLOCATION yang general (N alokasi sekaligus, tiap alokasi punya type reject/cancel + reason + target_stage sendiri).

Implikasi buat proyek baru: langsung mulai dari desain BUNDLE_ALLOCATION (versi general), skip desain BUNDLE_SPLIT yang sudah terbukti kurang cukup — tidak perlu mengulang proses trial-error yang sama.

Environment variables yang dibutuhkan (nilai tersimpan di file .env terpisah — JANGAN taruh nilainya di checkpoint/chat manapun ke depannya)
DATABASE_URL — koneksi Postgres (Supabase, region ap-southeast-1, pakai role app_user via Session Pooler — lihat bagian 24 final)
SUPABASE_URL — endpoint API Supabase
SUPABASE_SECRET_KEY — akses Supabase Storage (upload foto stage)
API_KEY — proteksi endpoint REST (custom, buat autentikasi server-to-server)
PORT — opsional, default 3000
Catatan keamanan: kredensial LTOS lama sempat ter-paste ke chat Claude saat proses eksplorasi (4 Agustus). Karena ini kredensial milik sendiri (bukan pihak lain), tidak wajib segera diganti, tapi disarankan rotate password Supabase di kemudian hari sebagai kebiasaan baik. Ke depan: environment variables harus disimpan di file .env terpisah + masuk .gitignore, tidak pernah ditulis ke .bashrc atau di-paste ke chat manapun (termasuk ke Claude). Status per 6 Agustus: .env sudah dibuat di ~/fashion-platform/.env, sudah dilindungi .gitignore (lihat bagian 24 final).

Next steps — generalisasi LTOS ke multi-tenant
 Copy struktur schema.sql LTOS jadi basis fashion_platform_schema_v2.sql, tambahkan tenant_id ke semua tabel projection (order_state → jadi bagian dari production_jobs), termasuk composite unique constraint yang melibatkan tenant_id — SELESAI (lihat bagian 24)
 Adaptasi stateLayer.js, versioning.js — tambahkan tenant_id di semua query WHERE clause — BELUM
 Adaptasi ingestion.js — STAGE_ORDER hardcode diganti jadi query ke tenant_pipeline_stages (configurable per tenant) — BELUM
 Adaptasi server.js — semua endpoint perlu tenant resolver middleware (baca tenant_id dari subdomain, sesuai checkpoint bagian 3), staff/lock/session di-scope per tenant — BELUM, ini next step utama
 worker.js (gap monitor, bundle reconciler) — pastikan advisory lock key tidak bentrok antar-tenant kalau nanti dijalankan sebagai 1 proses untuk semua tenant sekaligus — BELUM
 Belum ada di LTOS, sudah dibuat skemanya (perlu diimplementasi di backend): tenant_billing, alur WEB/consultation → order_specs, spec_substitution_requests, customer_decisions, customer_notifications
 File fix_*.js di root ~/ltos/ — sudah selesai dieksekusi (mengubah BUNDLE_SPLIT jadi BUNDLE_ALLOCATION), tidak perlu dijalankan lagi, aman diarsipkan/dihapus dari proyek baru
 Belum dicek: PROGRESS.md (208KB, kemungkinan berisi catatan keputusan historis), scanner.html (UI staff, belum dilihat)
Hasil audit kode LTOS (4 Agustus 2026) — perbaikan saat generalisasi ke multi-tenant
Kekuatan yang harus dipertahankan:

Parameterized queries di semua tempat → aman dari SQL injection
PIN staff di-hash pakai pgcrypto (crypt()), tidak disimpan plain text
Transaction + row lock (FOR UPDATE) di versioning.js → aman dari race condition antar-request bersamaan
Rate limiting brute-force PIN sudah ada (per staff_id + per IP)
Pesan error login tidak membocorkan apakah staff_id valid atau tidak (digabung jadi 1 pesan generik)
Perlu diperbaiki/disempurnakan saat generalisasi:

 Rate limiter & session in-memory (rateLimitMap, sessionMap, rateBuckets di server.js/ingestion.js) — cuma jalan benar kalau 1 instance server. Begitu proyek discale jadi multi-instance, harus pindah ke Redis (shared state antar-instance)
 API_KEY tunggal untuk semua endpoint — perlu diubah jadi API key granular per tenant/integrasi, supaya kalau 1 key bocor, dampaknya cuma ke 1 tenant, bukan semua
 Validasi format input PIN belum ada di endpoint login (tidak fatal, query tetap aman karena parameterized, tapi sebaiknya ditambah validasi panjang/format sebelum ke database)
 Logging penting (login, lock override, force-unlock) saat ini cuma ke console.error/file log lokal. Sebaiknya event penting juga disimpan ke tabel database sendiri, supaya bisa diaudit tanpa perlu SSH ke server tiap tenant
Kesimpulan audit: tidak ditemukan celah keamanan fatal. Semua temuan bersifat "perlu disempurnakan untuk skala multi-tenant", bukan kesalahan mendasar. Kode ini layak dijadikan basis backend proyek baru.

14. VPS Security Hardening — SSH Key Fix (4 Agustus 2026, sesi malam)
Masalah: login masih minta password meski key ssh-ed25519 fashion-platform sudah terdaftar di authorized_keys server sejak sesi sebelumnya.

Debug process:

Cek authorized_keys di server (cat ~/.ssh/authorized_keys) — ada 2 key: ssh-rsa lama + ssh-ed25519 fashion-platform
Bandingkan dengan public key asli di Termux (cat ~/.ssh/id_ed25519.pub)
Ketemu root cause: satu karakter berbeda — server punya ...AAAAIAhj/9G6yKxDuRW... (huruf kecil j), Termux asli punya ...AAAAIAhJ/9G6yKxDuRW... (huruf besar J). Key di server rusak/corrupt, kemungkinan besar akibat proses copy-paste lewat noVNC browser di sesi sebelumnya (dikonfirmasi sesuai dugaan di bagian 11)
Fix:

ssh-copy-id Rakyat@<ip_vps> dari Termux — menambahkan public key yang benar ke server (minta password sekali)
Verifikasi: ssh Rakyat@<ip_vps> langsung masuk tanpa password — berhasil
Matikan password login: sudo sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config.d/60-cloudimg-settings.conf
Restart service: sudo systemctl restart ssh
Validasi sebelum keluar sesi: sudo systemctl status ssh → active (running), tidak ada error
Test final: exit dari VPS, lalu ssh Rakyat@<ip_vps> dari Termux lagi — langsung masuk tanpa password, konfirmasi hardening berhasil
Status akhir: VPS sekarang hanya bisa diakses via SSH key, password authentication mati total. Ini menyelesaikan item hardening prioritas utama yang tertunda sejak beberapa sesi lalu.

Belum dibersihkan: key ssh-rsa lama masih ada di authorized_keys — belum dihapus, kemungkinan aman dibiarkan atau bisa di-cleanup nanti kalau dipastikan tidak dipakai.

15. Rencana Deploy Frontend — Vercel (Belum Dieksekusi)
Sumber: masukan dari teman, bukan keputusan Claude sepihak.

Rencana:

Frontend akan di-deploy via Vercel, auto-deploy dari GitHub tiap kali push — supaya dapat link publik yang bisa dibagikan ke orang (calon user, investor, dll) tanpa perlu VPS aktif buat demo
Deploy per-komponen, bukan 1 project besar — sejalan dengan arsitektur componentized blocks yang sudah direncanakan di bagian 1 (tampilan beda per tipe tenant). Tiap blok/komponen frontend bisa jadi project Vercel sendiri-sendiri, supaya gampang dicari dan dikelola satu-satu
Backend tetap di VPS Biznet Gio — Vercel hanya untuk frontend, tidak menggantikan rencana backend yang sudah ada
Status: BELUM dieksekusi — belum ada kode frontend sama sekali di proyek ini (masih fase persiapan backend, database sudah siap). Vercel baru relevan begitu mulai ada kode frontend beneran.

Akun yang sudah tersedia: GitHub (aktif dipakai), Supabase (aktif dipakai), Vercel (terhubung ke repo, lihat bagian 17, tapi belum ada kode buat di-deploy).

16. Percobaan Claude Code — SELESAI DICOBA, Hasil: Kebentur Pembayaran (Sesuai Dugaan Bagian 10)
Konteks: dicoba langsung (bukan cuma nebak dari asumsi) buat lihat sejauh mana Claude Code bisa dipakai tanpa kartu internasional.

Percobaan 1 — di Termux: GAGAL, platform tidak didukung
npm install -g @anthropic-ai/claude-code — berhasil install package, tapi ada warning postinstall script belum jalan
Fix manual postinstall (node .../install.cjs) → error jelas:
Unsupported platform: android arm
Supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64, linux-x64-musl, linux-arm64-musl, linux-arm64-android, linux-x64-android, win32-x64, win32-arm64
Kesimpulan: Termux di HP ini jalan di arsitektur android arm (32-bit), bukan arm64 — Claude Code tidak punya native binary untuk itu. Claude Code TIDAK BISA dipasang langsung di Termux/HP ini.
Percobaan 2 — di VPS: berhasil sampai proses instalasi, kebentur di login
VPS pakai linux-x64 — platform yang didukung, instalasi lancar
Install Node.js 20 LTS di VPS (belum ada sebelumnya) — sukses:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install nodejs -y
Terverifikasi: node -v → v20.20.2, npm -v → 10.8.2
Install Claude Code di VPS — sukses, tanpa warning apapun:
sudo npm install -g @anthropic-ai/claude-code
Jalanin claude — berhasil start, lewatin onboarding (pilih tema tampilan) — lanjut ke step login/subscription, dan di situ kebentur: butuh pembayaran yang belum bisa diakses, sesuai constraint kartu internasional di bagian 10.
Kesimpulan final
Dikonfirmasi langsung (bukan asumsi lagi): Claude Code memang butuh subscription/pembayaran yang saat ini nggak bisa diakses karena constraint kartu (bagian 10). Ini bukan soal platform/teknis lagi (VPS-nya support), murni soal metode pembayaran.

Keputusan: kembali ke rencana semula — Claude Code resmi ditunda (bukan dihapus dari rencana, bagian 12), sampai ada solusi kartu internasional atau proyek sudah generate income. Update 6 Agustus: sedang dieksplorasi jalur Google Play billing sebagai alternatif (lihat bagian 10), belum dieksekusi.

Yang tetap berguna dari percobaan ini: VPS sekarang sudah punya Node.js 20 LTS terinstall — ini memang dibutuhkan buat backend Node.js proyek nantinya, jadi bukan kerjaan sia-sia.

Next steps — lanjut ke jalur utama tanpa Claude Code
 Login gh CLI di Termux — SELESAI, akun teja1945, token scope repo aktif
 Clone repo ke Termux — SELESAI, gh repo clone teja1945/fashion-platform
 Clone repo ke VPS juga — SELESAI (6 Agustus, git clone biasa, dibutuhkan buat file .env dan kerja backend langsung di VPS)
 Install & setup Supabase CLI — SELESAI (lihat bagian 18)
 Mulai generalisasi schema LTOS ke multi-tenant — SELESAI, schema v2 sudah dieksekusi (lihat bagian 13, 24)
17. Vercel — Terkonfirmasi Sudah Terhubung ke Repo
Vercel CLI diinstall & login berhasil di Termux (bukan VPS — platform android didukung untuk Vercel, beda dari Claude Code/Supabase yang tidak)
Akun: teja1945, team teja1945s-projects
Project fashion-platform sudah ada di Vercel dan terhubung ke repo GitHub (dicek via vercel inspect) — auto-deploy dari branch main sudah aktif (alias fashion-platform-git-main-teja1945s-projects.vercel.app mengonfirmasi ini), sesuai yang disebut teman Teja sebelumnya
URL production: https://fashion-platform-six.vercel.app — saat ini 404, itu wajar, karena repo belum ada kode frontend sama sekali. Begitu ada kode frontend di-push ke main, otomatis ke-build & ke-deploy
Klarifikasi peran Vercel vs Supabase (sempat ditanyakan): Vercel = hosting frontend saja. Supabase = database + storage. Keduanya dibutuhkan, bukan saling menggantikan — sudah dikonfirmasi ke Teja bahwa Supabase tetap dipakai sesuai rencana awal (bukan diganti Vercel Postgres/Neon)
18. Supabase CLI — SELESAI
Percobaan install di Termux: GAGAL, sama seperti Claude Code — error Unsupported platform: android. Supabase CLI juga tidak punya native binary untuk Android/Termux.
Install di VPS: BERHASIL (sudo npm install -g supabase)
Login berhasil (percobaan kedua — percobaan pertama sempat macet/hang di terminal, solusinya: tutup paksa Termux, buka baru, SSH ulang, jangan tunggu lama kalau nyangkut)
Pelajaran platform (pola yang sama 2x, penting diinget ke depan): CLI tool yang butuh native binary (Claude Code, Supabase CLI) tidak jalan di Termux/Android — harus diinstall & dijalankan di VPS (linux-x64). CLI yang murni JavaScript/Node tanpa native binary (Vercel CLI, GitHub CLI gh) bisa jalan di Termux. Kalau nemu error "Unsupported platform" lagi ke depan, langsung pindah kerja ke VPS, jangan buang waktu coba-coba fix di Termux.

19. Review Eksternal (ChatGPT) — Hasil Evaluasi & Prioritas Baru
Teja minta review checkpoint ke ChatGPT sebagai second opinion. Hasilnya dievaluasi (bukan ditelan mentah — beberapa poin valid & prioritas, beberapa berlebihan buat tahap proyek saat ini).

✅ Valid, jadi PRIORITAS sebelum eksekusi schema v2 (SEMUA SUDAH DITERAPKAN — lihat bagian 24)
1. Row Level Security (RLS) — WAJIB, bukan opsional. SELESAI diterapkan di semua tabel schema v2, langsung nempel di create table.

2. Event contract minimal. SELESAI — lihat bagian 23, EVENT_CONTRACTS.md sudah dibuat.

⚠️ Valid tapi tidak mendesak (nyusul, bukan blocker)
Inventory state formal (AVAILABLE/RESERVED/CONSUMED sebagai enum eksplisit) — belum, nyusul pas implementasi backend
Notification retry/delivery guarantee (status pending/sent/failed + retry queue) — belum, boleh nyusul belakangan
Audit log ke DB (bukan cuma console.error) — belum, prioritas medium
❌ Dinilai berlebihan untuk tahap proyek saat ini (tetap dicatat sebagai alasan, biar tidak muncul lagi sebagai keraguan)
"Checkpoint terlalu panjang, harus dipangkas ke 100-150 baris" — DITOLAK. Alasan: Claude tidak punya memory antar-room, jadi checkpoint panjang justru fungsinya menjaga detail penting (root cause bug, kredensial mana yang dipakai, keputusan historis) tidak hilang tiap ganti sesi. Memangkas checkpoint berisiko mengulang masalah yang sudah pernah dipecahkan.
"Bukan production-grade SaaS" — framing berlebihan untuk proyek yang masih fase desain + solo developer, belum ada kode jalan sama sekali. Tidak realistis menuntut standar enterprise dari hari pertama.
"Constraint pembayaran adalah blocker arsitektur besar" — dramatis. Kenyataannya infra yang dipilih (Biznet Gio, Supabase) justru sudah disesuaikan dengan constraint ini sejak awal, bukan sesuatu yang butuh "redesign besar-besaran" nanti.
"Frontend over-fragmented (deploy per-komponen)" — sudah diingatkan duluan di bagian 15 (belum dieksekusi, masih rencana ditunda sampai ada kode frontend). Bukan temuan baru.
"Gudang harus dipisah total dari domain produksi" — LTOS/checkpoint sudah punya alasan desain sendiri kenapa gudang jadi stage produksi opsional (verifikasi fisik sebelum cutting, bukan titik konsumsi stok, lihat bagian 6). Tidak ada bukti konkret ini "kacau" — dicatat sebagai masukan, tapi tidak diubah tanpa alasan lebih kuat.
20. RLS di Project Supabase LTOS Lama — SELESAI DIPERBAIKI ✅ (5 Agustus 2026)
Status: BERES. Semua tabel yang publik-accessible sekarang sudah aman.

Kronologi
supabase login di VPS berhasil (percobaan kedua — percobaan pertama sempat macet/hang di terminal, solusinya: tutup paksa Termux, buka baru, SSH ulang, jangan tunggu lama kalau nyangkut)
supabase projects list menampilkan 2 project existing di akun Supabase Teja:
Nama	Reference ID	Org ID	Region	Dibuat	Status
Ltos backend	dyqnjfaylhzumfahmmht	hvzykdiwzwpkfbwughnc	Southeast Asia (Singapore)	22 Juli 2026	✅ RLS AKTIF, sudah diperbaiki
supabase-red-lamp	qhyvbuhqzdnzbpjmijas	vercel_icfg_c6O4HNLB42WE6eX1kiEN0NfQ	East US (North Virginia)	3 Agustus 2026	Kemungkinan dibuat teman Teja lewat integrasi Vercel — belum dikonfirmasi tujuannya, JANGAN diubah/dihapus sampai dikonfirmasi ke teman ybs
Email security advisor Supabase (3 Agustus 2026) memberi tahu: project "Ltos backend" punya banyak tabel dengan RLS mati (rls_disabled_in_public)
Dikonfirmasi: LTOS sudah tidak dipakai/dikembangkan lagi secara operasional (lihat bagian 4) — tapi project Supabase-nya masih menyimpan data historis nyata, jadi tetap perlu diamankan
Diagnosa lengkap via supabase db advisors
supabase link --project-ref dyqnjfaylhzumfahmmht
supabase db advisors --linked --type security --level warn
Ditemukan 13 tabel dengan RLS mati: pending_events, events, request_dedup, state_version_tracker, gap_status, stale_event_log, action_execution_log, customer_orders, order_locks, staff, work_log, stage_photos, order_state

Plus 1 warning ringan (level WARN, bukan ERROR): fungsi notify_order_state_change punya search_path yang mutable — belum diperbaiki, prioritas rendah.

Fix yang dilakukan
Karena LTOS sudah tidak dipakai operasional, solusi paling aman: aktifkan RLS di semua tabel tanpa bikin policy tambahan.

Install PostgreSQL client di VPS: sudo apt install postgresql-client -y
Buat migration lewat Supabase CLI: supabase migration new enable_rls_ltos_backend
Isi file migration dengan 13 baris ALTER TABLE ... ENABLE ROW LEVEL SECURITY;
Push migration: supabase db push
Verifikasi: supabase db advisors --linked --type security --level error → "No issues found" ✅
File migration ada di VPS (~/supabase/migrations/20260804230004_enable_rls_ltos_backend.sql) — arsip perbaikan darurat, bukan bagian dari schema v2.

Sisa next steps
 (Prioritas rendah, tidak urgent) Perbaiki warning function_search_path_mutable di fungsi notify_order_state_change
 Follow-up terpisah (tidak urgent): tanya ke teman Teja soal tujuan supabase-red-lamp
21. Project Supabase Baru untuk fashion-platform — DIBUAT ✅ (5 Agustus 2026)
Reference ID: kwhybffbcqopqbbnuigg Region: Southeast Asia (Singapore) Dashboard: https://supabase.com/dashboard/project/kwhybffbcqopqbbnuigg Org ID: hvzykdiwzwpkfbwughnc (sama dengan org Ltos backend lama)

Konteks — kena limit free tier dulu
Percobaan pertama bikin project baru gagal: akun Supabase free tier dibatasi maksimal 2 project aktif per organisasi.
Limit ini soal jumlah project terpisah, BUKAN soal ukuran/kapasitas 1 project. Limit 500MB storage di free tier longgar untuk fase awal, bisa upgrade ke Pro plan (~$25/bulan) kapan saja.
Solusi: Ltos backend di-pause lewat dashboard (bukan dihapus) — aman karena sudah dikonfirmasi tidak dipakai operasional lagi (bagian 4) dan datanya sudah dilindungi RLS (bagian 20). Bisa di-resume kapan saja sampai 9 September 2027.
supabase-red-lamp tidak diutak-atik — masih menunggu konfirmasi dari teman Teja.
Cara membuat (untuk referensi/diulang di masa depan)
supabase projects create fashion-platform --org-id hvzykdiwzwpkfbwughnc --region ap-southeast-1
Saat diminta password database, kosongkan (langsung Enter) — biar Supabase generate password random yang aman otomatis.

Status project sekarang: schema v2 sudah dieksekusi lengkap (lihat bagian 24), role app_user sudah lengkap.

22. Keputusan Arsitektur — RLS + Koneksi Database (5 Agustus 2026)
Keputusan: backend tetap pakai pg langsung (bukan pindah ke @supabase/supabase-js), sama seperti LTOS. Alasan: LTOS sudah pakai pg, pindah client library berarti nulis ulang seluruh layer database (kerja dobel tidak perlu), dan pg memberi kontrol penuh untuk transaction, row lock (FOR UPDATE), dan LISTEN/NOTIFY yang sudah dipakai LTOS.

Pola penerapan RLS dengan connection pool
Karena backend pakai connection pool (banyak request bergantian pakai koneksi yang sama), wajib pakai SET LOCAL di dalam transaction, bukan SET biasa — supaya tenant_id tidak "nyangkut" ke request lain yang kebetulan pakai koneksi yang sama. SET LOCAL otomatis reset begitu transaction selesai.

Pola standar untuk semua query yang butuh tenant context:

const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(`SET LOCAL app.tenant_id = $1`, [tenantId]);
  // ... query-query lain yang butuh tenant_id di sini, RLS otomatis aktif
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
}
Backend WAJIB connect pakai role app_user (bukan postgres) supaya RLS berlaku efektif — role postgres adalah superuser dan otomatis bypass semua RLS. Lihat bagian 24 untuk status role app_user (SELESAI, lengkap dengan connection string di .env).

⚠️ Hal yang wajib diperhatikan saat implementasi (supaya RLS benar-benar efektif, bukan cuma dekorasi)
Wajib selalu di dalam transaction — kalau ada query yang dijalankan di luar pola BEGIN...SET LOCAL...COMMIT, RLS tidak berlaku dengan benar untuk query itu, berisiko tembus ke data tenant lain.
Role database aplikasi tidak boleh punya privilege BYPASSRLS — sudah dipastikan untuk app_user (rolbypassrls = f, terverifikasi 6 Agustus).
Wajib ditest tiap ada perubahan schema — policy RLS gampang salah desain. Perlu ada rutinitas test manual (coba akses data tenant A pakai context tenant B, harus gagal) tiap kali nambah tabel atau ubah policy. BELUM DILAKUKAN — jadi next step begitu tenant resolver middleware jadi.

Kesimpulan: pola ini solid dan lazim dipakai di sistem production sungguhan. Tapi bukan "pasang sekali lalu aman selamanya" — attention ke 3 poin di atas wajib jadi bagian dari checklist tiap kali menulis kode yang menyentuh database.

23. EVENT_CONTRACTS.md — SELESAI DIBUAT ✅ (5 Agustus 2026)
File: db/EVENT_CONTRACTS.md (sudah di-push ke repo, commit 16dbe86)

Dibuat sesuai rekomendasi review ChatGPT (bagian 19). Isinya diekstrak langsung dari kode LTOS asli (ingestion.js), bukan ditulis dari asumsi — dicari pakai:

grep -oE "[a-z_]+\.[a-z_]+" ~/ltos/src/ingestion.js | sort -u
Isi file
11 event existing yang sudah teruji jalan di LTOS, masing-masing dengan struktur type, version, tenant_id, payload:
Order: order.created, order.updated, order.item_added, order.stage_changed, order.cancelled
Payment: payment.initiated, payment.received, payment.failed
QC: qc.passed, qc.failed
Shipment: shipment.dispatched, shipment.delivered
4 event baru (masih draft, perlu direview lagi saat implementasi) untuk fitur yang direncanakan tapi belum ada di LTOS: spec.substitution_requested, spec.substitution_decided, customer.decision_made, notification.sent
Aturan versioning: field baru opsional tidak perlu bump version; kalau struktur/makna berubah wajib naik version (v1 → v2), v1 lama tidak boleh diubah supaya replay event lama tetap konsisten
Next steps
 Review ulang 4 event draft di atas saat mulai coding modul terkait masing-masing
 Tambah event untuk tenant_billing setelah desain billing lebih matang

24. Schema SQL v2 + Role app_user — SELESAI ✅ (5-6 Agustus 2026, final)
Status: BERES SEPENUHNYA. Ini versi final dan satu-satunya — sebelumnya sempat ada 2 versi bagian "24" yang saling kontradiksi di file ini (kemungkinan akibat 2 room/sesi paralel menulis bagian yang sama tanpa disatukan). Sudah diverifikasi langsung ke database pada 6 Agustus, bukan diasumsikan dari salah satu versi lama.

Schema v2
File db/fashion_platform_schema_v2.sql: 19 tabel (schema inti + tabel baru spec_substitution_requests, customer_decisions, customer_notifications), semua dengan RLS langsung nempel di tiap create table
Migration 20260805023907_schema_v2_core.sql sudah di-push lewat supabase db push, sukses
Sempat ketemu masalah: folder supabase/migrations/ di VPS shared antara 2 project (LTOS lama + fashion-platform baru) — file migration lama ikut coba ke-push dan error. Fix: file migration lama dipindah ke ~/archive-ltos-migrations/ (diarsipkan, bukan dihapus)
Verifikasi: supabase db advisors --linked --type security --level error → "No issues found" ✅
Role app_user — status final (diverifikasi ulang 6 Agustus)
Role app_user sudah ada di database, terverifikasi langsung via query:
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_user';
→ hasil: rolsuper = f, rolbypassrls = f ✅
Password disinkronkan ulang via ALTER ROLE app_user WITH PASSWORD '...' (dijalankan 6 Agustus) — karena role ternyata sudah dibuat di sesi/room lain sebelumnya tanpa status yang jelas tercatat, jadi password disamakan ulang supaya konsisten dengan yang disimpan di .env
GRANT SELECT, INSERT, UPDATE, DELETE sudah ada di semua 19 tabel — diverifikasi via query information_schema.role_table_grants, COUNT(DISTINCT table_name) = 19 ✅
ALTER DEFAULT PRIVILEGES untuk tabel baru ke depannya — sempat kelewat (belum ada saat dicek pakai \ddp), sudah dijalankan ulang 6 Agustus dan sukses
File sementara berisi command (/tmp/create_app_user.sql) sudah dihapus aman pakai shred -u, dikonfirmasi hilang total
.env project
File ~/fashion-platform/.env sudah dibuat, isinya DATABASE_URL pakai role app_user via Session Pooler:
postgresql://app_user:<password>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres
.gitignore sudah dibuat mengecualikan .env dan node_modules/, sudah dikonfirmasi via git status (.env tidak muncul sebagai untracked file)
.gitignore sudah di-commit & push ke GitHub (commit 29da4d4)
Pelajaran penting — koneksi ke database Supabase dari VPS ini WAJIB pakai Session Pooler
VPS Biznet Gio ini tidak punya alamat IPv6 — cuma IPv4
Supabase "Direct connection" defaultnya cuma kasih host IPv6, jadi connect dari VPS ini SELALU gagal dengan error Network is unreachable
Solusi tetap: connect ke database Supabase manapun dari VPS ini harus pakai connection string mode Session pooler, formatnya:
postgresql://postgres.<project-ref>:<password>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres
Ambil dari dashboard: Settings -> Database -> Connect -> pilih "Session pooler" (bukan "Direct connection" yang jadi default)
Pelajaran penting — kontradiksi antar-sesi/room
Sempat ada 2 versi bagian "24" di checkpoint ini dengan klaim yang saling bertentangan soal status role app_user (satu bilang selesai & terverifikasi, satu lagi bilang belum dieksekusi). Ini persis risiko yang sudah diingatkan checkpoint sendiri soal room paralel.
Cara resolusinya: JANGAN percaya salah satu versi begitu saja — cek langsung ke sumber asli (di sini: query ke database via psql). Ternyata role memang sudah ada (dibuat di sesi lain), tapi ALTER DEFAULT PRIVILEGES sempat kelewat — jadi bukan salah satu versi checkpoint yang 100% benar, keduanya sebagian benar sebagian ketinggalan.
Pelajaran ke depan: kalau nemu bagian checkpoint yang meragukan atau kontradiktif, verifikasi dulu ke sumber sebelum lanjut kerja atau asumsi status "selesai".
Next steps (murni next steps backend sekarang, tidak ada lagi item skema/role pending)
 Mulai backend skeleton: tenant resolver middleware (baca tenant_id dari subdomain)
 Function/procedure spec-lock (atomik: reserve inventory + ledger + event)
 Test manual RLS begitu tenant resolver jadi (akses data tenant A pakai context tenant B, harus gagal) — lihat bagian 22
 Adaptasi stateLayer.js, versioning.js, ingestion.js, server.js dari LTOS ke multi-tenant (lihat detail di bagian 13)
 Sisa hardening VPS: UFW, Fail2Ban, backup rutin, cleanup key ssh-rsa lama (lihat bagian 11) — tidak blocking buat mulai coding backend, tapi disarankan dibereskan sebelum backend live/expose port ke publik

25. Ide Awal — Visual Configurator untuk Tenant Konveksi (6 Agustus 2026, BELUM DIRISET MATANG)
Status: IDE AWAL, bukan keputusan final. Riset lebih lanjut ditunda, sambil jalan.

Konteks
Tiap tipe tenant (brand owner, vendor konveksi, custom tailor, pabrik) rencananya punya tampilan depan (frontend) yang beda, sesuai componentized blocks (bagian 1 & 15).
Untuk tenant custom tailor/konveksi, ada ide fitur unggulan: visual configurator — customer bisa "tap-tap" pilih komponen (misal model lengan, kerah, panjang gamis) dan preview baju berubah secara visual, tanpa perlu jelasin lewat teks.

Opsi teknis yang dipertimbangkan (belum final)
Layer-based 2D (kemungkinan lebih realistis buat solo dev + resource terbatas): tiap opsi komponen adalah gambar PNG transparan yang ditumpuk jadi 1 preview.
3D configurator: lebih menarik secara visual tapi jauh lebih berat untuk dikembangkan & di-render, kemungkinan besar tidak cocok untuk tahap awal (solo dev, VPS 1GB RAM, tanpa Claude Code).
Sumber gambar/template
Rencana: konveksi/tenant yang menyediakan gambar tiap opsi komponen (bukan Teja yang menggambar sendiri).
Ide desain data (belum diimplementasi, masih draft):
Tabel baru kemungkinan: garment_component_options (tenant_id, component_type, option_name, image_url, is_active).
Gambar disimpan di Supabase Storage (extend dari yang sudah dipakai untuk production_stage_photos).
Frontend fetch dari tabel ini, bukan hardcode di kode — supaya tenant/komponen baru bisa ditambah tanpa perlu ubah & deploy ulang kode.
Hasil pilihan customer nantinya perlu masuk ke order_specs (fase WEB/consultation sebelum produksi, masih "belum ada di LTOS, perlu dibangun baru" — lihat bagian 13).
Pertanyaan yang belum terjawab (untuk direview saat riset lanjut)
Siapa yang mengelola/upload library gambar komponen — konveksi sendiri lewat admin panel, atau Teja yang bantu setup di awal?
Ada aturan kombinasi yang tidak valid (misal model lengan tertentu tidak cocok dengan kerah tertentu)? Perlu validasi di level data atau UI?
3 tipe tenant lain (brand owner, vendor konveksi jika beda dari custom tailor, pabrik) belum punya fitur unggulan spesifik yang dipikirkan sejauh ini — masih perlu digali.
Next steps
 Riset lebih lanjut soal visual configurator (ditunda, sambil jalan proyek)
 Setelah riset matang, update bagian ini jadi desain final sebelum mulai implementasi
 Jangan mulai coding fitur ini sebelum backend inti (tenant resolver, spec-lock) selesai — ini fitur frontend lanjutan, bukan prioritas sekarang

26. Ide Awal — QR Code Dual-Jalur: Customer vs Produksi (6 Agustus 2026, BELUM DIRISET MATANG)
Status: IDE AWAL, bukan keputusan final.

Konteks
Untuk 1 order/production_job yang sama, direncanakan ada 2 jenis QR code dengan tujuan (endpoint) berbeda, tergantung siapa yang scan:
Customer: tempel di struk/nota atau dikirim lewat WA — scan membuka halaman status order untuk customer (lihat progress, approve keputusan, dll).
Produksi: tempel di bundle kain/baju fisik yang sedang diproses — scan membuka halaman staff untuk update stage produksi (misal tandai selesai cutting, masuk QC).

Prinsip desain
QR code hanya berfungsi sebagai "pintu masuk" berisi ID (order_id atau production_jobs.id) yang diarahkan ke endpoint berbeda sesuai jenis QR — bukan QR itu sendiri yang menentukan hak akses.
Otorisasi tetap ditentukan di sisi server (RLS + role check), bukan dari QR-nya. Staff yang scan QR produksi harus tetap melalui autentikasi staff (PIN/session) yang sudah ada. Customer yang scan QR customer idealnya juga melalui mekanisme token/otentikasi tersendiri.

Pertanyaan keamanan yang belum terjawab (perlu direview saat riset lanjut)
QR customer: apakah cukup berisi order_id polos, atau perlu token unik/random per order supaya tidak bisa ditebak/diakses orang lain yang bukan pemilik order? Cenderung ke arah token unik demi keamanan.
QR produksi: apakah cukup diasumsikan aman karena device scanner dipegang staff internal tenant sendiri (lebih terkontrol), atau tetap perlu binding ke sesi staff yang sedang login?
Apakah QR di-generate sekali di awal order (statis) atau bisa di-refresh/invalidate (misal kalau QR hilang/bocor)?

Next steps
 Riset lebih lanjut soal skema token/keamanan QR (ditunda, sambil jalan proyek)
 Setelah riset matang, update bagian ini jadi desain final sebelum mulai implementasi
 Jangan mulai coding fitur ini sebelum backend inti (tenant resolver, spec-lock) dan customer login (lihat bagian 25 soal frontend customer-facing) selesai
