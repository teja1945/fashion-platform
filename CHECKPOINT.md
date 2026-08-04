# CHECKPOINT — Fashion Platform (Multi-Tenant SaaS)

> Update terakhir: 4 Agustus 2026
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

- Pindah dari Termux ke VPS (lihat bagian 11 — sekarang **aktif dan bisa diakses**)
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
- [ ] Setup SSH key yang benar dari Termux (percobaan sebelumnya lewat VNC gagal, key lama tidak valid)
- [ ] Disable `PasswordAuthentication` (sekarang **yes**, sementara — harus balik ke **no** setelah key jalan)
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

## 11. Keputusan & Status Infrastruktur

- **VPS: Biznet Gio, paket NEO Lite (~Rp50.000/bulan) — AKTIF**
  - OS: **Ubuntu 22.04.5 LTS** (terkonfirmasi lewat SSH, sesuai rencana awal)
  - Data center: Jakarta
  - IP: `103.58.101.155`
  - Username: `Rakyat`
  - Pembayaran: transfer bank/e-wallet domestik (resmi, langsung ke provider — bukan lewat perantara)
  - Alasan pilih: harga termurah di antara provider lokal, kredibel, tidak butuh kartu internasional
  - Alternatif kalau perlu ganti: IDCloudHost (storage NVMe lebih besar), DomaiNesia (tarif renewal flat)
- **Akses SSH: BERHASIL dari Termux** — `ssh Rakyat@103.58.101.155`
  - Status saat ini: pakai **password authentication** (sementara, lihat catatan hardening di bawah)
  - Password Console (portal Biznet Gio) sudah diganti dari default ke password custom
- **Database: Supabase free tier** (belum berubah dari rencana awal, belum di-setup)
- **Node.js: rencana pakai versi 20 LTS** (belum di-install)

### Catatan penting — Console/VNC vs SSH
- Setup awal (hari pertama) sempat lama macet karena mencoba setup SSH key lewat **Console/noVNC di browser HP**. Ternyata noVNC **tidak reliable** untuk mengetik command presisi — karakter (terutama huruf besar dan simbol seperti `$`, `~`, kutip) sering ke-drop atau berubah saat diketik lewat keyboard Android di browser.
- **Solusi yang dipakai:** karena SSH key gagal ter-setup dengan bersih, sementara diaktifkan `PasswordAuthentication yes` di `/etc/ssh/sshd_config.d/60-cloudimg-settings.conf` (pakai command `sudo sed -i` yang lebih reliable daripada edit manual di nano) — supaya bisa akses via SSH dari Termux tanpa tergantung VNC lagi.
- **Prinsip ke depan:** hindari VNC/Console kalau bisa. Begitu akses SSH tersedia, semua kerjaan (termasuk baca/edit config) dikerjakan lewat SSH dari Termux, karena Termux (app native) tidak kena masalah karakter seperti VNC di browser.
- File `authorized_keys` di server berisi 2 key: 1 key `ssh-rsa` lama (dari setup Termux sebelumnya, kemungkinan masih valid) + 1 key `ssh-ed25519` baru bernama `fashion-platform` (belum terverifikasi valid — perlu di-tes ulang setelah setup key yang lebih rapi dari Termux).

### Hardening — status per item (urutan sebelum lanjut install lain-lain):
1. [ ] Setup SSH key yang benar dari Termux (`ssh-copy-id` atau setara), verifikasi bisa login pakai key tanpa password
2. [ ] Setelah key terverifikasi jalan: disable password login lagi (`PasswordAuthentication no`, `PermitRootLogin no`)
3. [ ] Firewall UFW aktif (allow OpenSSH + port yang dibutuhkan saja)
4. [ ] Install Fail2Ban (proteksi brute-force SSH)
5. [ ] Verifikasi user `Rakyat` non-root dengan sudo access yang benar (kemungkinan sudah oke, tinggal dicek)
6. [ ] Setup backup manual rutin (`pg_dump` disimpan di storage terpisah, misal Google Drive)

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
