# CHECKPOINT — Fashion Platform (Multi-Tenant SaaS)

> Update terakhir: 2 Agustus 2026
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

- Pindah dari Termux ke **Oracle Cloud Free Tier** (gratis permanen, bukan trial)
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

### Infrastruktur
- [ ] Setup akun Oracle Cloud
- [ ] Provision VPS
- [ ] Install Node + pm2 + Nginx
- [ ] Tes domain gratisan + HTTPS
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
- Tiap sesi baru, kasih raw link `CHECKPOINT.md` ini ke Claude sebelum minta lanjut kerja.
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

## 11. Keputusan Infrastruktur (Final untuk Fase Ini)

- **VPS: Biznet Gio, paket NEO Lite (~Rp50.000/bulan)**
  - OS: Ubuntu 22.04 LTS
  - Data center: Jakarta
  - Pembayaran: transfer bank/e-wallet domestik (resmi, langsung ke provider — bukan lewat perantara)
  - Alasan pilih: harga termurah di antara provider lokal, kredibel, tidak butuh kartu internasional
  - Alternatif kalau perlu ganti: IDCloudHost (storage NVMe lebih besar), DomaiNesia (tarif renewal flat)
- **Database: Supabase free tier** (belum berubah dari rencana awal)
- **Akses dari HP:** SSH via Termux (`pkg install openssh`, lalu `ssh user@ip_vps`)
- **Node.js: pakai versi 20 LTS** (bukan 18 — upgrade rekomendasi dari review kedua)

### Hardening wajib begitu VPS aktif (urutan sebelum install apapun lain):
1. Setup SSH key (ed25519), lalu **disable password login** (`PasswordAuthentication no`, `PermitRootLogin no` di `/etc/ssh/sshd_config`)
2. Firewall UFW aktif (allow OpenSSH + port yang dibutuhkan saja)
3. Install Fail2Ban (proteksi brute-force SSH)
4. Buat user non-root buat kerja sehari-hari (`adduser` + `usermod -aG sudo`)
5. Setup backup manual rutin (`pg_dump` disimpan di storage terpisah, misal Google Drive) — VPS murah lokal tidak selalu reliable untuk snapshot otomatis

### Belum dilakukan sekarang (sengaja ditunda, bukan lupa):
- Docker/Kubernetes — over-engineering untuk fase ini
- Pindah ke cloud besar (AWS/GCP) — nunggu ada kebutuhan skala nyata
- Claude Code terpasang permanen — nunggu kartu internasional beres atau proyek sudah generate income

## 13. Progress VPS (Update Terbaru)

- **VPS Biznet Gio SUDAH AKTIF** — nama service: `NEO Lite - XS 1.1 - fashion-platform`
- Spek: 1 vCPU, 1GB RAM, 60GB Disk — Rp59.000/bulan (sedikit di atas estimasi awal ~50rb, masih wajar)
- OS: Ubuntu 22.04 (polos, bukan varian CyberPanel/HestiaCP/aapanel)
- Username & password SSH: **disimpan sendiri oleh user di notes HP** — jangan diketik ulang di chat manapun demi keamanan
- Cara akses: dari Termux HP, `pkg install openssh` (sudah tersedia dari setup LTOS lama)

### Next step yang lagi dikerjakan (belum selesai saat checkpoint ini ditulis):
- [ ] Login pertama kali ke VPS via `ssh USERNAME@IP_VPS` dari Termux
- [ ] Setelah berhasil login, LANJUTKAN ke checklist hardening di bagian **11** (SSH key, disable password login, UFW, Fail2Ban, non-root user) — **urutan ini penting, jangan install Node.js/apapun dulu sebelum hardening selesai**
- [ ] Baru setelah hardening: install Node.js 20 LTS, setup PostgreSQL/koneksi ke Supabase

### Kendala saat ini (belum terselesaikan — perlu bantuan support Biznet Gio):
- Password Console Access sudah di-reset berkali-kali via dashboard, tetap muncul "Login incorrect" baik di Console maupun asumsi di sistem terkait
- SSH key sudah diganti dari keypair lama `Rakyat` ke keypair baru `rakyat1745` (dibuat sendiri via `ssh-keygen -t ed25519` di Termux), sudah di-restart/reboot, tapi SSH dari Termux tetap gagal: `Permission denied (publickey)`
- Sudah dicoba: reset password 2x, restart manual, update SSH key + reboot otomatis dari sistem — semua tidak berhasil membuka akses
- **Kesimpulan sementara:** kemungkinan bug/delay sinkronisasi credential ke VM dari sisi platform Biznet Gio, bukan kesalahan langkah user
- **Next action:** hubungi support Biznet Gio via WhatsApp (ikon hijau di portal), minta bantuan reset akses manual ke service `fashion-platform` (username: `rakyat`, IP: `103.58.101.155`)
- Public key yang sudah didaftarkan (kalau perlu dikirim ulang ke support atau dicoba manual via `authorized_keys`):
  ```
  ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAhJ/9G6yKxDuRW+iReQN4z4EyhoibgDYnAmbwFf3PrG fashion-platform
  ```
- Private key ini tersimpan di HP user, di Termux path `~/.ssh/id_ed25519` — jangan generate baru dulu sebelum konfirmasi dari support, biar tidak makin membingungkan state key di server

### Update: Setelah Rebuild Instance (masih belum berhasil)
- Sudah dilakukan REBUILD instance (Stop → Rebuild → pilih Ubuntu-22.04) atas saran support Biznet Gio
- Fingerprint host berubah lagi (normal, karena rebuild = OS fresh install)
- SSH dengan key `Rakyat1945.pem` (yang di-generate otomatis via fitur "Create" di form Create NEO Lite) TETAP gagal: `Permission denied (publickey)` — bahkan setelah rebuild
- File private key ada di Termux: `~/.ssh/Rakyat1945.pem` (permission 600 sudah diset)
- Sedang mencoba reset password Console Access lagi untuk dicoba login via "Open Console" (browser terminal) — belum ada hasil konklusif saat checkpoint ini ditulis
- **Kesimpulan kuat sekarang:** ini bukan human error dari user. Sudah dicoba: reset password berkali-kali, ganti SSH key 2x (manual import + auto-generate), restart, DAN rebuild penuh — semua tetap gagal. Ini indikasi kuat ada bug/masalah sistemik di platform Biznet Gio untuk service spesifik ini.
- Support Biznet Gio sudah dihubungi via WhatsApp, sudah kasih beberapa saran (semua sudah dicoba: cek port dengan nmap [hasil: port 22 terbuka], ganti SSH key via portal, generate SSH key otomatis, rebuild instance) — belum ada solusi final dari mereka

### Kalau sesi berikutnya lanjut dari sini:
- JANGAN ulangi generate SSH key baru lagi atau rebuild lagi tanpa arahan baru dari support — sudah dicoba maksimal dari sisi user
- Tanyakan ke user: apakah reset password Console yang terakhir dicoba berhasil, dan apakah ada balasan baru dari support Biznet Gio
- Kalau masih gagal total dan support tidak bisa membantu lebih lanjut: pertimbangkan serius untuk PINDAH PROVIDER (IDCloudHost atau DomaiNesia, sudah ada di catatan alternatif) — jangan buang lebih banyak waktu di satu service yang bermasalah dari sisi platform
- Kalau pindah provider: minta refund/komplain resmi ke Biznet Gio dulu kalau relevan (service tidak bisa diakses sejak awal karena bug platform, bukan salah user)

## 14. Tool Development — Kapan Baru Relevan (Bukan Sekarang)

Sudah dibahas dan diputuskan **ditunda**, bukan ditolak — dipakai nanti di fase yang sesuai:

| Tool | Fungsi | Kapan baru relevan |
|---|---|---|
| **Claude Code** | Agentic coding, akses langsung ke file/repo/terminal | Begitu mulai coding backend beneran (bukan fase desain), dan kartu internasional/API credit sudah tersedia |
| **MCP (Model Context Protocol)** | Konektor AI ↔ tools eksternal (GitHub, Supabase, dll) | Begitu ada repo aktif dipakai coding & database live yang butuh diakses langsung oleh AI |
| **Graphite** | Visualisasi stacked PR, review kode berbasis graph/node | Begitu ada banyak perubahan kode kecil yang saling ketergantungan, atau sudah ada tim/kolaborator review |

**Prinsip umum:** jangan pasang tool baru sebelum ada kebutuhan nyata yang dia selesaikan — matched ke fase proyek saat itu, bukan ke rasa "biar canggih".
## 13. Status Setup VPS & Troubleshooting Akses (3 Agustus 2026)

- VPS Biznet Gio NEO Lite aktif & running (region West Java, Ubuntu 22.04)
- **Blocker awal:** tidak bisa login ke Console Access (user `rakyat`) — selalu "Login incorrect", meski sudah reset password berkali-kali
- Dashboard portal ternyata **tidak punya tombol reset password untuk Console Access** — hanya ada "Change SSH Key" untuk SSH Access
- Coba jalur SSH pakai private key lama (`Rakyat1945.pem`) dari dashboard — juga gagal "Permission denied (publickey)", meski key valid dan ter-load sempurna setelah beberapa kali convert format (PEM → OpenSSH modern, hapus karakter `\r`)
- Sudah kirim tiket ke support@biznetgio.com dengan detail teknis lengkap

## 14. Solusi dari Support: Ganti Keypair — Masih Gagal (3 Agustus 2026)

- Support Biznet Gio konfirmasi solusi: ganti keypair SSH lewat portal (bukan reset Console password)
- Langkah yang sudah dilakukan sesuai instruksi resmi:
  1. Generate keypair baru (ED25519) pakai `ssh-keygen -t ed25519 -f ~/fashion-platform-new -N ""` di Termux (bukan PuTTYGen, karena kerja dari HP Android)
  2. Public key diupload ke portal (SSH Key > Add SSH Key), nama: `fashion-platform-new`
  3. Keypair di-assign ke service via SSH Access > Change SSH Key > Confirm
  4. Tunggu restart otomatis (~10 menit)
  5. Test login: `ssh -i ~/fashion-platform-new rakyat@103.58.101.155`
- **Hasil: TETAP "Permission denied (publickey)"** — sama seperti keypair lama
- **Kesimpulan kuat:** baik Console Access, keypair lama, maupun keypair baru (sesuai prosedur resmi) semuanya gagal → root cause murni di sisi server/provider (kemungkinan proses update `authorized_keys` di VM tidak berjalan)
- **Public key fingerprint yang dipakai:** `SHA256:Y+vmTWw5PysL4+0krODANzkpPPwVOzUKfdMb6xDU160`
- **Status:** sudah reply tiket dengan detail hasil percobaan ini, menunggu eskalasi lebih lanjut dari support (kemungkinan perlu dicek manual dari sisi mereka)
- Belum lanjut ke tahap hardening (SSH key, UFW, Fail2Ban) karena masih belum bisa masuk VPS sama sekali

## 15. Catatan Teknis Termux (Referensi)

- Kalau muncul error "type -1" saat SSH coba load private key (padahal `ssh-keygen -y` bisa baca key-nya), convert ulang formatnya pakai `ssh-keygen -p -N "" -f <keyfile>` (tanpa `-m PEM`) — convert ke format OpenSSH modern yang lebih kompatibel dengan OpenSSH versi baru (10.x di Termux)
- Termux di HP ini punya masalah akses `/sdcard/Download/` langsung (permission denied meski izin storage sudah "Semua File") — solusinya copy-paste isi file manual lewat text editor + nano, bukan lewat `cp`/`ls` langsung ke storage

## 16. Catatan Tool AI (Belum Relevan Sekarang)

- Sempat ditanya soal MCP & "CLI AI" oleh teman — dikonfirmasi masih sesuai keputusan di bagian 12: ditunda sampai fase coding aktif
- Opsi CLI AI coding assistant yang ada (buat referensi nanti kalau sudah waktunya): Claude Code, Gemini CLI, Codex CLI, Aider, Cursor
