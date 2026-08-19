>>> WAJIB DIBACA DULU SEBELUM APAPUN LAIN: lihat Bagian 64 "FILOSOFI PRODUK — 9 RASA" di bawah (termasuk Rasa Grosir, Kepemimpinan, Ketelitian — ditambahkan Bagian 88 & 14 Agustus 2026). Semua fitur baru (endpoint, UI, notifikasi, teks, dashboard) WAJIB dicek balik ke 9 Rasa sebelum dianggap selesai. Ini prinsip permanen, bukan sekadar 1 dari banyak ide di checkpoint ini. <<<

CHECKPOINT — Fashion Platform (Multi-Tenant SaaS)
Update terakhir: 14 Agustus 2026 (split kedua — arsip Bagian 1-88 lengkap, filosofi jadi 9 Rasa)

Cara pakai:
- File ini isinya STATUS TERKINI + NEXT STEPS AKTIF saja. Histori lengkap:
  - Bagian 1-53: CHECKPOINT_ARCHIVE.md (dibekukan 8 Agustus 2026)
  - Bagian 1-88 lengkap (snapshot sebelum diringkas): CHECKPOINT_ARCHIVE_2.md (dibekukan 14 Agustus 2026)
  Rujuk nomor bagian di archive terkait kalau butuh detail (root cause bug, command persis, alasan desain).
- Tiap sesi baru: kasih raw link CHECKPOINT.md ini (format commit SHA) ke Claude sebelum minta lanjut kerja — SEKALIAN kasih output `wc -l CHECKPOINT.md` di pesan yang sama (lihat SOP di bagian Kolaborasi & Cache).
- Kalau butuh histori detail suatu topik, kasih juga raw link archive yang relevan dengan SHA yang sama.
- Kedua file archive TIDAK PERNAH diedit lagi — cuma dibaca sebagai referensi historis. Semua update selanjutnya HANYA masuk ke CHECKPOINT.md (file ini). Kalau file ini membengkak lagi, lakukan split baru (arsipkan versi lama jadi CHECKPOINT_ARCHIVE_3.md, mulai ringkas lagi).

===================================================================
1. ARAH PROYEK (ringkas — detail penuh di archive bagian 1-13)
===================================================================
- Platform multi-tenant SaaS fashion: brand owner, vendor konveksi, custom tailor, pabrik. 1 backend + 1 database untuk semua tenant, isolasi via tenant_id + RLS (wajib, bukan opsional).
- Uang customer masuk langsung ke tenant, platform dapat fee (tenant_billing).
- Frontend beda per tipe tenant (componentized blocks), backend/produksi/inventory sama untuk semua.
- Basis backend: kode LTOS lama (Termux, single-tenant) digeneralisasi jadi multi-tenant. LTOS sendiri sudah dihentikan operasionalnya, murni jadi basis kode.
- Constraint pembayaran: tidak ada kartu kredit/debit internasional (cuma BRI/GPN domestik + SeaBank virtual) — ini kenapa VPS Biznet Gio + Supabase dipilih (terima transfer domestik), dan kenapa Claude Code masih tertunda. Detail lengkap di archive bagian 10.

===================================================================
2. IDENTIFIER KUNCI
===================================================================
- Repo GitHub: teja1945/fashion-platform (public)
- VPS: Biznet Gio, Jakarta, user Rakyat, IP <VPS_IP, lihat CHECKPOINT_LOCAL.md>, Ubuntu 22.04.5 LTS
- Supabase project (aktif): <SUPABASE_PROJECT_ID, lihat CHECKPOINT_LOCAL.md> — https://<SUPABASE_PROJECT_ID, lihat CHECKPOINT_LOCAL.md>.supabase.co
- Supabase project lama (LTOS, di-pause): <SUPABASE_PROJECT_ID_LAMA, lihat CHECKPOINT_LOCAL.md> — JANGAN dihapus, ada data historis, RLS sudah aman
- Demo tenant ID: <DEMO_TENANT_ID, lihat CHECKPOINT_LOCAL.md>, subdomain testing "demo" (host: demo.fashion-platform.local)
- Demo production job (testing): <DEMO_JOB_ID, lihat CHECKPOINT_LOCAL.md> — sudah dipakai bolak-balik reset ke stage jahit untuk testing berulang, aman dipakai ulang
- Staff test tenant demo: Admin Demo (role owner, id <ADMIN_DEMO_ID>), Staff Gudang/Cutting/Jahit/QC/Packing(finishing) Demo — semua PIN direset ke nilai yang sama, lihat CHECKPOINT_LOCAL.md untuk id & PIN lengkap
- Vercel: project fashion-platform terhubung ke repo, auto-deploy dari main, URL https://fashion-platform-six.vercel.app (masih 404, belum ada kode frontend)

===================================================================
3. STATUS INFRASTRUKTUR — HARDENING DASAR TUNTAS ✅
===================================================================
[x] SSH key-only, UFW default-deny (cuma port 22 publik), Fail2Ban aktif, user non-root+sudo, backup pg_dump otomatis harian (retensi 14 hari), pm2+systemd (server.js auto-restart tervalidasi lewat reboot), Node.js 20 LTS.

Belum ada (prioritas berikutnya):
[ ] HTTPS/SSL — backend masih HTTP polos, WAJIB sebelum expose ke publik/domain live
[ ] Rate limiting API level umum (bukan cuma endpoint PIN)
[ ] Restore drill (backup baru diverifikasi tidak-corrupt, belum pernah benar-benar di-restore ke instance kosong)

Detail kronologi: archive bagian 11, 14, 43-46.

===================================================================
4. STATUS BACKEND — RINGKASAN
===================================================================
- Schema v2, semua tabel RLS aktif, role app_user (non-superuser, no bypass RLS).
- Struktur kolom akurat HANYA bisa diverifikasi via `\d nama_tabel` langsung ke DB — file schema di repo tidak merepresentasikan skema live sepenuhnya.
- Tenant resolver middleware (subdomain → tenant_id), event-sourcing pipeline (versioning.js, stateLayer.js, ingestion.js) — jalan, tenant-aware.
- Header/auth: `x-api-key`, `x-staff-token`.
- MCP terhubung: Supabase & Vercel aktif dari chat Claude.
- VPS punya akses push ke GitHub via PAT (expired ~awal November 2026 — INGAT perpanjang).
- Pola wajib akses DB: `withTenant(client, tenantId, fn)` untuk endpoint biasa, `withTenantAndStaff(client, tenantId, staffId, fn)` untuk endpoint yang nyentuh tabel RLS staff-scoped (discrepancy_cases dst) — endpoint yang masih pakai withTenant biasa di tabel staff-scoped akan dapat 0 rows (fail-closed, bukan bug).
- JANGAN query tabel RLS-protected pakai `pool.query()` langsung di luar transaksi — current_setting bisa dapat koneksi pool "kosong", gagal cast uuid tidak konsisten. Selalu lewat transaksi yang sudah tenant-scoped.
- Cara verifikasi data manual via psql: RLS tabel utama pakai session variable `app.tenant_id` (BUKAN `app.current_tenant_id`). SET harus digabung dalam satu perintah `-c` yang sama dengan query-nya: `psql "$DATABASE_URL" -c "SET app.tenant_id = '<uuid-tenant>'; SELECT ... ;"`. Tanpa SET ini, semua query balik 0 rows walau data utuh (RLS bekerja sesuai desain, bukan indikasi data hilang). Tabel `tenants` sendiri cuma bisa diakses `service_role`, app_user gak akan pernah bisa SELECT langsung meski context sudah di-SET.

Bug-bug kritis historis (sudah diperbaiki, detail di archive, jangan diulang):
- orders.production_job_id, sequence_version string-concat bigint, GRANT USAGE schema extensions (archive bagian 35, 36, 39)
- UUID empty-string broadcast error (archive bagian 80) — root cause: query RLS-protected table via pool.query() di luar transaksi

===================================================================
5. NEXT STEPS AKTIF
===================================================================
[ ] POST /v1/mediators/:id/backups — auto-provision tenant_mediators untuk backup_staff_id yang belum terdaftar (prinsip: ruang mediator disediakan di depan saat ditunjuk jadi cadangan, BUKAN otomatis "naik jabatan" pas resign — lihat archive bagian 87)
[ ] POST /v1/mediators/:id/resign — logic resign & reassignment lengkap (skema desain archive bagian 74), baru aman dikerjakan setelah endpoint backups selesai
[ ] Endpoint discrepancy case: discrepancy_reason (staff jahit kasih alasan), eskalasi manual ke owner, DAN resolve/tutup kasus — desain lengkap sudah ada (archive bagian 76: penengah tulis resolution_notes → submitter+receiver wajib confirm → RESOLVED, forced-resolution untuk severity NORMAL kalau ada yang nolak, WAJIB eskalasi owner untuk severity SERIOUS). RESOLVED bersifat FINAL PERMANEN, tidak ada mekanisme reopen — kejelasan harus dicapai SEBELUM RESOLVED, bukan sesudah. Belum ada satupun endpoint ini dibangun sampai Bagian 88 — kasus discrepancy yang sudah dibuka (auto-create bagian 82) belum bisa ditutup resmi.
[ ] Extend trigger_type + RLS insert notifications untuk jenis lain (stok kosong bagian 72, darurat staff bagian 73, mesin rusak — peta Modul F bagian 88)
[ ] Selidiki DeprecationWarning "client.query() already executing" di worker/realtime relay (belum ketemu sumber pasti, bukan bug fungsional, dicatat archive bagian 84)
[ ] Tabel tenant_trusted_staff (Bagian 72, kasus stok kosong gudang awal)
[ ] Voice note: endpoint upload audio + message_type voice_note di thread diskusi, boleh dikirim semua pihak (submitter/receiver/mediator)
[ ] scanner.html belum sinkron dengan pipeline final (gudang→cutting→jahit→qc→finishing→shipped) — masih pakai daftar stage lama (7 stage beda total, archive bagian 60), nunggu integrasi sama stage dinamis (bagian 61) sebelum dirombak
[ ] HTTPS/SSL sebelum backend expose ke publik/domain live
[ ] Desain child bundle (BUNDLE_ALLOCATION) — blocker lama, ingestion.js return HTTP 501 untuk event ini

===================================================================
6. CHECKLIST KEAMANAN — HIDUP, DIREVIEW TIAP ADA FITUR BARU
===================================================================
Prinsip: tidak ada sistem 100% aman, target realistis = minimalkan risiko + tahan serangan umum + cepat tahu kalau ada yang aneh.

Sudah ada: RLS semua tabel (termasuk staff-scoped untuk discrepancy_cases & thread), parameterized queries, PIN di-hash pgcrypto, UFW+Fail2Ban, SSH key-only, rate limiting brute-force PIN, pesan error login tidak bocorkan validitas staff_id, backup rutin, insert-only enforced di level DB untuk thread_messages/photos (REVOKE UPDATE/DELETE dari app_user).

Belum ada (perlu direview ke depan):
[ ] Rate limiting API level umum
[ ] HTTPS/SSL (prioritas paling dekat)
[ ] Validasi input lebih ketat di semua endpoint
[ ] Audit log admin actions terpisah dari production_events (force-unlock, revoke staff, eskalasi manual)
[ ] Monitoring/alerting otomatis (login gagal beruntun, pola akses aneh)
[ ] Enkripsi data sensitif tambahan — SEKARANG CAKUPANNYA: nomor telepon/alamat customer, DAN phone_number staff (plaintext, konsisten sama customer_contact) — review bareng semua field sensitif ini sekaligus, bukan ditambal satu-satu
[ ] Rate limiter & session in-memory masih single-instance — perlu Redis kalau nanti multi-instance
[ ] API_KEY tunggal untuk semua endpoint — pertimbangkan granular per tenant
[ ] Integritas foto bukti — EXIF timestamp vs waktu submission, perceptual hash (bisa 1 modul sama buat production_stage_photos & discrepancy_thread_photos, keduanya simpan storage_path)
[ ] Restore drill (lihat bagian 3)

Prinsip wajib untuk fitur self-service baru: selalu tanya "kalau disalahgunakan, dampaknya sejauh mana?" — dan tenant/staff TIDAK PERNAH dikasih akses ke infrastruktur/kredensial Teja dalam bentuk apapun.

ATURAN WAJIB (13 Agustus 2026): sebelum nulis kode baru yang manggil fungsi/helper yang sudah ada di codebase, WAJIB grep/lihat dulu definisi fungsi itu — bukan cuma nebak dari endpoint lain yang polanya mirip. Verifikasi dependency itu langkah PERTAMA.

ATURAN WAJIB (13 Agustus 2026): sebelum bikin endpoint baru yang melibatkan otorisasi staff, WAJIB cek dulu pola otorisasi serupa yang sudah ada di checkpoint (misal: call_log & summon-owner cuma boleh mediator, bukan "semua pihak terlibat") — bukan cuma niru pola generik.

ATURAN WAJIB (kalau ada perubahan nilai enum-like di kolom otorisasi seperti role/status): WAJIB grep semua tempat yang cek nilai lama itu secara hardcode sebelum migration dianggap selesai — migration skema doang TIDAK CUKUP.

ATURAN WAJIB (14 Agustus 2026, Rasa Ketelitian): tiap kali nulis judul bagian baru "SELESAI & TERUJI" di CHECKPOINT.md, WAJIB eksplisit sebutin rasa mana yang diterapkan + wujud konkretnya di fitur itu — bukan cuma klaim umum "sudah dicek 9 rasa" tanpa detail. Tujuannya biar kelihatan jelas di histori, gampang diaudit balik kalau ternyata ada yang kelewat.

===================================================================
7. IDE-IDE BELUM DIRISET MATANG (belum keputusan final, jangan mulai coding sebelum next steps aktif selesai)
===================================================================
Daftar ringkas — detail lengkap tiap ide ada di archive pada nomor bagian yang disebut:

A. Visual configurator tenant konveksi — archive bagian 25
B. QR code dual-jalur customer vs produksi — archive bagian 26
C. Verifikasi 2 pihak staff jahit vs QC + notif WA ke QC — SEBAGIAN BESAR SUDAH DIEKSEKUSI (lihat bagian 57, 61, 71-87 di archive 2), sisanya jadi next steps aktif di atas
D. Tenant theme settings + Pattern library & multi-format export — archive bagian 47
E. Tenant kaos: sablon 3D + upload gambar sendiri — archive bagian 48
F. Sistem upah staff jahit (borongan per pcs) — archive bagian 49
G. Dashboard analytics owner, ruang komplain customer, sistem sewa modular per fitur — archive bagian 50
H. Login email+password + kustomisasi dashboard personal — archive bagian 51
I. 2FA login + subdomain custom pilihan tenant — archive bagian 53
J. Automation "AI mikir + AI eksekusi" — archive bagian 28
K. Adopsi BTOS: visual mannequin 3D, decision center actionable, sewa modular "akses vs pemakaian", entry point trial — archive bagian 67
L. Hardening internal: restore drill, integritas foto, audit log admin, offline-first scanner, skor supplier — archive bagian 68 (restore drill & integritas foto sudah masuk checklist keamanan di atas)
M. Gudang final terhubung ke lokasi rak & data siap kirim — archive bagian 69
N. Adopsi BTOS lanjutan: Resume Don't Recreate, antrian real-time walk-in, AI Vision Judge — archive bagian 70
O. Struktur organisasi pabrik fleksibel: level jabatan, PPIC, QC independen, HRD, shift — archive bagian 77 (diperluas jadi peta besar di bagian 88 di bawah)
P. i18n multi-bahasa per tenant (UI + data yang tenant input sendiri) — dicatat 9 Agustus, belum diriset
Q. Custom nada dering notifikasi per jenis (in-app) — dicatat 9 Agustus, belum diriset
R. Anti-kecurangan submission/QC (kolusi 2 pihak): foto wajib, silang-cek qty vs bahan terpakai, deteksi pola "terlalu mulus", rotasi pasangan kerja — archive bagian 57 lanjutan
S. QR kode detail bawa nama staff + spesifikasi barang (kredit kerja, anti-kecurangan) — archive bagian 57 lanjutan
T. Dashboard "barang selesai siap kirim" — archive bagian 57, 69
U. Diskusi gudang di awal siklus untuk kain cacat/reject — archive bagian 58, lihat juga ringkasan Lapis 2 bagian 9 di bawah
V. Manajemen supplier (tabel suppliers, evaluasi performa, formula skor) — archive bagian 59, 68 poin 5
W. Tipe bayaran staff fleksibel per tenant: harian/piece-rate/bulanan — archive bagian 62
X. Absensi & lembur anti-kecurangan via HP (WebAuthn, geofencing, selfie, timestamp server) — archive bagian 63
Y. AI Copywriter (generate caption/deskripsi produk) & AI Admin Sales/CS Chatbot — archive bagian 65
Z. Roadmap ekspansi modul pelengkap dari LTOS: Customer Journey Portal, Decision Center, Master Data Center, Quotation Engine, Customer Digital Profile, Appointment Scheduling, Fitter App, AI Render Preview — archive bagian 66
AA. Darurat staff di tengah pekerjaan (Lapor Darurat, QR multi-scan, split upah manual) — lihat ringkasan bagian 9 di bawah, desain lengkap archive bagian 73

===================================================================
8. TOOL DEVELOPMENT — STATUS
===================================================================
- Claude Code: ditunda (bukan ditolak), kebentur constraint pembayaran (bagian 1). Sudah dicoba langsung di VPS, sukses sampai step login, gagal di situ. Eksplorasi Google Play billing (GoPay/ShopeePay/Google Play balance/vouchers domestik) sebagai alternatif — status BELUM DIEKSEKUSI, terakhir dicek beberapa hari lalu.
- MCP (Supabase, Vercel): aktif dan dipakai rutin dari chat Claude.
- Detail percobaan lengkap: archive bagian 16, 28.

===================================================================
9. RINGKASAN SKEMA TABEL AKTIF (Lapis 2 — sistem mediator & diskusi discrepancy)
===================================================================
Ringkasan struktur — detail migration & keputusan desain lengkap ada di archive bagian 74-88.

tenant_mediators: id, tenant_id, staff_id, line_scope (nullable, general kalau kosong), has_full_mandate (default false, TIDAK otomatis pindah ke cadangan), is_active, assigned_by, created_at, updated_at. UNIQUE(tenant_id, staff_id) — staff gak bisa didaftarkan dobel jadi mediator.

mediator_backups: mediator_id, backup_staff_id, priority_order (1 = dicoba duluan). UNIQUE(mediator_id, priority_order), UNIQUE(mediator_id, backup_staff_id). Cadangan WAJIB sudah jadi tenant_mediators resmi duluan (disediakan di depan pas ditunjuk, bukan otomatis pas resign — lihat archive bagian 87).

discrepancy_cases: id, tenant_id, stage_quantity_submission_id (FK, UNIQUE — 1 submission = 1 kasus), production_job_id, submitter_staff_id, receiver_staff_id, mediator_id (nullable — bisa kosong kalau tidak ada mediator aktif, lihat fallback escalated_to_admin di archive bagian 82), status (OPEN/IN_DISCUSSION/RESOLVED/ESCALATED_TO_OWNER), severity (NORMAL/SERIOUS, default NORMAL), resolution_notes, submitter_confirmed_at, receiver_confirmed_at, resolved_by_staff_id, resolved_at, resolved_with_mandate. RLS staff-scoped (bukan cuma tenant-isolation) — akses cuma submitter/receiver/mediator/owner, fail-closed kalau app.staff_id kosong.

discrepancy_thread_messages: id, tenant_id, discrepancy_case_id, sender_staff_id (nullable untuk row otomatis sistem), message_type (text/photo/call_log/mediator_action/correction), action_subtype (khusus mediator_action: joined_case/summoned_owner), content, call_to_staff_id, target_staff_id, corrects_message_id (self-FK, untuk ralat tanpa hapus riwayat). INSERT-ONLY di level DB (REVOKE UPDATE/DELETE). call_log CUMA boleh ditulis mediator.

discrepancy_thread_photos: id, tenant_id, message_id (FK), storage_path, uploaded_by_staff_id, uploaded_at. Generic, tidak terikat stage produksi (beda dari production_stage_photos). INSERT-ONLY.

mediator_reassignment_log: id, tenant_id, discrepancy_case_id, old_mediator_id (nullable), new_mediator_id, reason, triggered_by_staff_id, created_at. Jejak permanen perpindahan mediator (belum ada endpoint yang insert ke sini — nunggu logic resign, next steps bagian 5).

notifications: generic, trigger_type-based, related_staff_id (FK staff — "tujuan hubungin balik" via WA, nomor mentah bukan link jadi), RLS insert-scoped via submitter/receiver/mediator/owner. Baru cover trigger_type discrepancy_summoned_owner — jenis lain (stok kosong, darurat staff, mesin rusak) masih next steps aktif.

reserve_fabric_inventory(...) — function DB (bukan tabel), atomik reserve stok kain + ledger, row-lock FOR UPDATE, SECURITY INVOKER. Dipakai saat order masuk produksi butuh bahan. Trigger utama buat laporan stok kosong (ide U/bagian 72) dan disebut sebagai nilai jual audit ekspor (Modul G, bagian 88).

===================================================================
88. PETA BESAR STRUKTUR PABRIK GARMEN (14 Agustus 2026, riset/rencana, belum diimplementasi — dipertahankan utuh, bukan diringkas, karena jadi peta acuan jangka panjang)
===================================================================
Latar belakang: proyek diarahkan juga bisa ditawarkan ke pabrik skala penuh, bukan cuma konveksi kecil.

FILOSOFI KE-7 — "RASA GROSIR": platform sedia ruang dan kebutuhan sebanyak mungkin di depan (grosir/wholesale), semaksimal mungkin sebelum dibutuhkan — bukan tambal satu-satu pas kepepet. Tenant tinggal aktifkan fitur yang relevan. Sudah dipraktikkan di bagian 87 (cadangan mediator disiapkan di depan, bukan "naik jabatan" mendadak).

ALUR PRODUKSI LENGKAP: Sales/Merchandising → Costing → Desain → CAD/Pattern → Sampel → ACC Buyer → Purchasing → Cutting → Jahit (sub-stage custom) → QC → Finishing (sub-stage custom) → QC akhir → Gudang barang jadi → Pengiriman → Retur/Komplain

MODUL A — Alur Produksi Utama (linear, jantung sistem). Implikasi teknis terbesar: stage jahit & finishing perlu 2 LEVEL (stage utama → sub-stage custom per tenant), perluasan pola modular bagian 61/66.
MODUL B — PPIC: visibility lintas semua production_jobs, pantau gap_status/deadline.
MODUL C — Industrial Engineering: waktu standar, kapasitas line. Opsional, referensi doang.
MODUL D — Finance: invoice buyer, bayar supplier, payroll, refund retur. Nyambung ke Modul A di titik trigger saja.
MODUL E — HRD: rekrutmen, pelatihan, performa, absensi. Terpisah total dari Modul A.
MODUL F — Maintenance/Teknisi: "lapor mesin rusak" → notifikasi teknisi, pakai pola tabel notifications yang sudah ada (extend trigger_type, bukan bangun dari nol).
MODUL G — Compliance/Audit (fitur laporan, bukan modul aktif): audit trail yang sudah dibangun dari awal (event-sourcing, mediator_reassignment_log, production_events) = NILAI JUAL untuk pabrik ekspor (USTR dkk), tinggal export dari data yang sudah ada.
MODUL H — Subkontraktor: field assigned_to_type (internal/vendor-eksternal) di sub-stage.
MODUL I — Database Buyer/Customer: pertimbangkan tabel customers/buyers terpisah untuk buyer berulang (ekspor) — belum diputuskan.
MODUL J — Retur/Komplain: alur sekarang berhenti di "Pengiriman", belum ada tempat retur — masuk Modul D atau modul sendiri, belum diputuskan.

TIDAK PERLU masuk sistem: Marketing (di luar siklus operasional), GA/Safety/Environment (administratif fisik).

HIERARKI LAPANGAN: Operator → Leader (pimpin 1 line) → Foreman (koordinasi beberapa line) → Supervisor (operasional harian, target, kualitas). Leader/Supervisor kandidat alami buat mediator/backup (bagian 74-87).

STATUS: peta/riset, belum ada tabel/kode diimplementasi. Prioritas eksekusi TETAP ngikutin next steps aktif (bagian 5) — ini peta acuan jangka panjang, bukan next step langsung.

===================================================================
64. FILOSOFI PRODUK — 9 RASA — Wajib Diterapkan Nyata di Setiap Langkah
===================================================================
Status: PRINSIP PERMANEN. Berlaku untuk SEMUA pengembangan ke depan, dicek di setiap step — harus kelihatan wujud nyatanya di kode/UI/teks, bukan cuma diingat.

Platform TIDAK punya departemen marketing, sales, copywriter, atau CS secara langsung — tapi setiap sudut platform harus TERASA seolah-olah ada 9 "rasa" ini:

1. Rasa Copywriting — cara platform "ngomong". Teks (notifikasi, tombol, error) ditulis kaya manusia ngomong, bukan "Error: submission failed" tapi "Waduh, gagal kekirim. Coba cek koneksi lo dan ulangi ya."

2. Rasa Sales — cara platform bikin orang PERCAYA. Dashboard nunjukin bukti nyata kejujuran sistem — riwayat lengkap barang, foto bukti kelihatan langsung.

3. Rasa Marketing — cara platform nunjukkin dirinya. Gaya bahasa/visual konsisten, data ditampilkan sebagai cerita/progress (dashboard "barang siap kirim"), bukan tabel angka mentah.

4. Rasa Talent/Penghargaan — cara platform menghargai orang di baliknya. QR kode bawa nama staff pengerjanya, ditampilin sebagai kredit kerja (bukan cuma anti-kecurangan).

5. Rasa Customer Service — cara platform bantu orang PAS ADA MASALAH. Error kasih tau langkah selanjutnya. Fitur membingungkan dikasih penjelasan singkat di tempat. Ada jalan jelas buat benerin kesalahan manusia.

6. Rasa Keamanan — cara platform JAGA kepercayaan orang di dalamnya. Jejak tidak bisa dihapus/ditimpa diam-diam (event, bukan field yang diganti tanpa bekas — koreksi = catatan baru). Otorisasi jelas siapa boleh apa. Tidak ada "setengah jalan" (atomic). Data sensitif diperlakukan hati-hati. Transparan ke yang berhak, tertutup ke yang tidak.

7. Rasa Grosir — cara platform SEDIAKAN RUANG DI DEPAN (ditambahkan 14 Agustus 2026, bagian 88). Sedia kapasitas/fitur semaksimal mungkin sebelum dibutuhkan, tenant tinggal aktifkan yang relevan — bukan tambal satu-satu pas kepepet.

8. Rasa Kepemimpinan — sosok yang menyambungkan semua rasa jadi satu kesatuan (ditambahkan 14 Agustus 2026). LEVEL UTAMA: cara Claude/Teja ngerjain kerjaan dengan 1 visi yang nyambung, bukan mutusin per fitur sendiri-sendiri. Kalau level ini gak jalan, rasa lain bisa kepasang tapi gak nyambung satu sama lain (contoh nyata kejadian pas level ini gak ada: 5 titik otorisasi hardcode role="admin" lupa di-update pas role owner ditambah, archive bagian 76). LEVEL TURUNAN: ada sosok/role yang jadi "pemimpin" nyata di tiap fitur — mediator jadi pemimpin di kasus discrepancy, owner jadi pemimpin di tingkat tenant, gudang jadi "pemimpin siklus" (buka & tutup siklus produksi, bagian 57).

9. Rasa Ketelitian — cara platform gak pernah asal, selalu dicek ulang sebelum dianggap kelar (ditambahkan 14 Agustus 2026). Sudah dipraktikkan lewat aturan-aturan wajib yang ada (cek dependency sebelum nulis kode, cek pola otorisasi sebelum bikin endpoint baru, grep semua tempat kena kalau ubah enum) — sekarang diresmikan jadi rasa, bukan cuma "aturan teknis" terpisah. Termasuk: testing tiap skenario (bukan cuma happy path), baca ulang checkpoint penuh sebelum lanjut kerja.

SIFAT & CARA EKSEKUSI: filosofi ini BUKAN dokumen final, tapi wadah belajar dua arah — Teja belajar dunia marketing/sales/CS/copywriting dari luar DAN dari eksekusi platform ini sendiri. Cara eksekusi (WAJIB): setiap kali Claude mengerjakan sesuatu yang menyentuh salah satu rasa — nulis teks, bikin tampilan, desain alur — BENERAN MASUK ke cara mikir peran itu, bukan nempelin filosofi sebagai label.

ATURAN WAJIB: setiap kali mengerjakan fitur baru (endpoint, UI, notifikasi, dashboard, pesan error, apapun) — cek balik ke 9 filosofi ini SEBELUM dianggap selesai. Tidak harus semua 9 diterapkan sekaligus di 1 fitur, minimal 1-2 yang kelihatan wujud nyatanya. Wajib disebutkan eksplisit rasa mana + wujud konkretnya di judul bagian "SELESAI & TERUJI" (lihat aturan Rasa Ketelitian di checklist keamanan bagian 6).

CATATAN PENERAPAN KE KODE LAMA: wajib untuk kerjaan baru mulai sekarang. Kode/teks/UI lama TIDAK perlu dirombak buru-buru — masuk daftar "polish pass" belakangan.

===================================================================
CARA MENCATAT IDE BARU — INSTRUKSI UNTUK SEMUA ROOM/SESI
===================================================================
Kalau Teja menyampaikan ide baru di sesi manapun, room manapun WAJIB ikuti pola ini:

1. Tulis ide itu sebagai BAGIAN BARU BERNOMOR (nomor lanjut dari bagian terakhir — cek dulu nomor bagian tertinggi, JANGAN tebak/asal nomor. Nomor tertinggi saat ini: 88).
2. Judul bagian: "[NOMOR]. Ide Awal — [nama ide singkat] ([tanggal], BELUM DIRISET MATANG)"
3. Isi selengkap mungkin dari hasil diskusi — TIDAK perlu diringkas saat pertama dicatat.
4. Tulis draft-nya, tunjukkan ke Teja untuk direview.
5. Setelah disetujui, APPEND (bukan overwrite) ke CHECKPOINT.md via `cat >> CHECKPOINT.md << 'EOF' ... EOF` di VPS, verifikasi dengan `tail`, baru commit & push.
6. TAMBAHKAN JUGA satu baris ringkasan ide itu ke daftar bagian 7 di atas.
7. JANGAN taruh ide baru ke file archive manapun — sudah dibekukan permanen.
8. Kalau CHECKPOINT.md ini sendiri sudah mulai kepanjangan lagi — usulkan split baru ke Teja, jangan diam-diam dibiarkan membengkak.

===================================================================
KOLABORASI & CACHE — WAJIB DIBACA TIAP SESI BARU
===================================================================
- Repo public, satu sumber kebenaran untuk semua room/sesi Claude. Commit langsung ke main (belum pakai branch, solo dev fase aktif).
- MASALAH CACHE raw.githubusercontent.com: query string ?t= TIDAK CUKUP. WAJIB pakai commit SHA di path URL — commit SHA didapat dari `git log -1 --oneline -- CHECKPOINT.md` di VPS.
- SOP WAJIB (ditambahkan 14 Agustus 2026, dari insiden nyata fetch kepotong): setiap kasih raw link CHECKPOINT.md ke Claude sesi baru, SEKALIAN kasih output `wc -l CHECKPOINT.md` di pesan yang sama. Kalau Claude menyebut bagian terakhir yang dia baca dengan nomor JAUH lebih kecil dari yang seharusnya (cek dulu bagian terakhir yang ditulis) — JANGAN percaya itu sudah lengkap, langsung minta `tail -c 20000 CHECKPOINT.md` (atau `sed -n 'START,ENDp'` kalau tahu range baris pastinya) tanpa berdebat dulu. Ini BUKAN soal cache, murni limitasi ekstraksi tool fetch Claude sendiri, TERBUKTI nyata (kejadian 14 Agustus 2026).
- Room paralel bisa hasilkan kontradiksi kalau nulis bagian sama bersamaan. Kalau nemu info meragukan, JANGAN percaya salah satu versi — verifikasi ke sumber asli (database, file di server).
- SELALU `git pull` sebelum mulai edit/append file apapun yang bakal di-push — VPS punya akses push (PAT), risiko tabrakan lebih tinggi.
- SELALU `git log --oneline -10` di awal sesi sebelum mulai menulis file yang berpotensi sudah dikerjakan room lain.
- Cara edit/append file di VPS: `cat >> nama_file << 'EOF' ... EOF` untuk NAMBAH (bukan nano). `>>` = append, `>` = overwrite total. Verifikasi dengan `tail -N nama_file` setelah append, sebelum commit & push.
- Cross-check ke ChatGPT: rekomendasikan proaktif kalau ada keputusan desain berisiko tinggi (arsitektur data, security, race condition, konsistensi) — jangan nunggu Teja minta duluan. Evaluasi jujur hasilnya.
- Workflow Teja: satu-langkah-satu-waktu. Claude kasih 1 command/langkah, tunggu hasil dari Teja, baru lanjut ke langkah berikutnya. Jangan kasih banyak command sekaligus.
- KLARIFIKASI POLA PEMAKAIAN (17 Agustus 2026): 4 akun Claude yang dipakai
  Teja jalan BERGANTIAN saat kena limit, BUKAN paralel bersamaan -- risiko
  konflik/kontradiksi di atas jauh lebih rendah untuk pola ini. Tetap wajib:
  (a) push ke GitHub SEBELUM pindah akun, commit progress kecil-kecil kalau
  memungkinkan (jangan nunggu semua kelar baru commit), (b) kalau kena limit
  di tengah kerjaan yang belum selesai/belum ditest, sempetin catat status
  "SERAH-TERIMA KE SESI BERIKUTNYA" dulu (pola yang sudah dipakai Bagian
  121/125) sebelum akun itu gak bisa diakses lagi.

===================================================================
ATURAN WAJIB (14 Agustus 2026): jelasin pakai bahasa sederhana dari awal
===================================================================
Tiap kali ada keputusan desain yang perlu persetujuan Teja (pilihan A vs B,
dst), jelasin PAKAI CONTOH KONKRET/SKENARIO NYATA duluan -- bukan istilah
teknis dulu baru disederhanain belakangan pas ditanya. Anggap tiap
pertanyaan itu kayak ngejelasin ke orang yang baru pertama denger konsepnya,
bukan ke sesama developer. Ini berlaku di SEMUA room/sesi Claude ke depan,
bukan cuma sesi ini -- ditemukan dari pola berulang kali Teja perlu minta
"sederhanain" sebelum bisa jawab.

[Bagian 89-114 diarsipkan 16 Agustus 2026 -- lihat CHECKPOINT_ARCHIVE_3.md untuk detail lengkap: alur Stitch/Figma/v0, 4 endpoint discrepancy, audit ChatGPT 15 temuan, checkGaps fix, HTTPS/SSL setup, foto wajib, CodeQL+Dependabot, rate limiter global, P0-1/P0-2/P0-3, P1-2/P1-4/P1-5]

## 115. P1-3: Token WebSocket dipindah dari query string ke pesan pertama setelah connect -- SELESAI & TERUJI (16 Agustus 2026)

Konteks: melanjutkan sisa temuan audit ChatGPT (Bagian 105) -- token staff
untuk WebSocket /v1/realtime sebelumnya dikirim lewat query string URL
(?token=...), berisiko kerekam di access log nginx/reverse proxy.

Rasa yang dipenuhi: Rasa Keamanan (token tidak lagi nempel di URL/log
manapun; ditemukan dan ditutup gap tambahan bahwa Revoke/Offboard yang
sudah ada sebelumnya tidak berlaku untuk koneksi WS yang sudah auth) dan
Rasa Ketelitian (2 kali percobaan sed/python gagal karena asumsi teks tidak
exact-match ke whitespace asli file -- diperbaiki dengan pendekatan berbasis
nomor baris yang diverifikasi dulu isi baris awal/akhirnya sebelum override;
endpoint Revoke DAN Offboard dicek satu-satu, tidak diasumsikan sama tanpa
verifikasi).

**Proses diskusi desain (dicatat karena cukup panjang, biar tidak hilang
kalau perlu direview ulang):**
- Opsi awal yang dipertimbangkan: (A) Sec-WebSocket-Protocol header saat
  handshake, (B) token dikirim sebagai pesan pertama setelah connect,
  (C) cookie session (didiskon karena arsitektur staff login sekarang
  pakai token bearer, bukan cookie browser).
- Sempat condong ke Opsi A (lebih sederhana) dengan alasan "belum ada
  tenant nyata yang pakai" -- ditegur dan dikoreksi: standar keamanan
  tidak boleh diturunkan hanya karena belum ada yang pakai, justru momen
  paling murah untuk dibangun benar dari awal (sejalan visi Bagian 97,
  bukan proyek uji coba).
- Diputuskan Opsi B murni -- token TIDAK PERNAH lewat handshake/header/URL
  sama sekali, hanya jadi WS message biasa setelah koneksi terbuka.
- Di tengah diskusi, ditemukan gap tambahan yang tidak diduga sebelumnya:
  endpoint POST /v1/staff/revoke dan POST /v1/staff/offboard (sudah ada
  lama) menghapus token dari sessionMap -- tapi desain WS auth yang cuma
  dicek sekali di awal koneksi tidak akan pernah tahu kalau di tengah
  jalan token itu dihapus. Staff yang di-revoke (misal ketahuan curang,
  HP dicuri) REST-nya langsung ke-block, tapi WS tetap hidup tanpa batas
  waktu. Ini gap nyata untuk sistem yang harus dipakai serius, bukan
  hal kecil yang bisa dilewatkan.
- Solusi: re-check berkala ke sessionMap selama koneksi WS hidup. Angka
  interval didiskusikan (bukan asal pilih) -- karena cek ke sessionMap
  itu murah (in-memory Map, bukan query database), dipilih 30 detik:
  cukup responsif untuk kasus darurat (staff dicurigai, harus putus
  cepat) tanpa membebani server berlebihan.
- Dikonfirmasi endpoint Offboard JUGA menghapus dari sessionMap (bahkan
  lebih lengkap dari Revoke -- sekalian set is_active=false di tabel
  staff) -- jadi 1 mekanisme re-check cukup untuk menutup kedua kasus.

**Perubahan kode (server.js, baris 1708-1773 lama diganti):**
1. `verifyClient` disederhanakan -- hanya cek tenant/subdomain dari Host
   header (tidak rahasia). Baca token dari query string dihapus total.
2. `wss.on("connection", ...)` -- begitu connect: `ws.authenticated = false`.
   Timeout 5 detik (`WS_AUTH_TIMEOUT_MS`), kalau belum auth dalam waktu itu
   koneksi ditutup paksa (close code 4001).
3. Pesan pertama WAJIB `{type: "auth", token: "..."}` -- divalidasi persis
   pola requireStaffSession (lookup sessionMap, cek expiry, cek tenant
   cocok, refresh TTL `session.expiresAt` -- konsisten dengan REST).
   Berhasil -> `ws.authenticated = true`, kirim balik `{type: "auth_ok"}`,
   mulai interval re-check. Gagal -> close code 4001.
4. Interval re-check tiap `WS_SESSION_RECHECK_MS` (30 detik) -- cek ulang
   `sessionMap.get(ws.authToken)` masih ada & belum expired. Kalau sudah
   dihapus (kena Revoke/Offboard) atau expired -> close code 4003.
   Interval di-clear di `ws.on("close")` supaya tidak jadi memory leak.
5. Logic typing_start/typing_stop yang sudah ada TETAP SAMA, cuma sekarang
   jalan setelah `ws.authenticated === true`.
6. Logging ditambahkan di 3 titik penutupan paksa (auth timeout, auth
   gagal, sesi dicabut di tengah jalan) -- konsisten dengan pola
   console.log yang sudah dipakai endpoint Revoke/Offboard.

**Verifikasi sebelum eksekusi (Rasa Ketelitian):**
- Dicek dulu apakah ada client existing yang connect ke /v1/realtime lewat
  query string token (scanner.html, test-e2e.js, test-e2e-step2.js,
  scripts/) -- SEMUA KOSONG, tidak ada satupun client yang pernah pakai
  endpoint ini. Perubahan dipastikan tidak breaking apapun yang sudah ada.
- Pola requireStaffSession (REST) dibaca lengkap dulu sebelum menyusun
  validasi WS, supaya konsisten (termasuk refresh TTL) -- bukan menulis
  ulang logic session dari nol dengan gaya beda sendiri.

**Kendala teknis saat eksekusi:** 2x percobaan replace pakai exact-text-match
(python3 heredoc) GAGAL karena file asli ternyata punya trailing whitespace
di beberapa baris "kosong" yang tidak terlihat di terminal biasa -- baru
ketahuan setelah `cat -A`. Diperbaiki dengan pendekatan berbasis nomor
baris (verifikasi isi baris awal/akhir dulu sebelum override), bukan lagi
cocokkan teks mentah.

**Testing (4 skenario, semua LULUS, dijalankan via wscat/node ws manual di VPS):**
1. Connect tanpa kirim auth sama sekali, dibiarkan diam -> koneksi auto-close
   dalam 5 detik, code 4001 reason "auth timeout". LULUS.
2. Connect + kirim {"type":"auth","token":"token-ngasal-salah"} -> ditolak
   langsung, close code 4001 reason "auth gagal". LULUS.
3. Login staff QC Demo (dapat token asli) -> connect + kirim auth dengan
   token itu -> server balas {"type":"auth_ok"}, koneksi tetap terbuka. LULUS.
4. Sambil koneksi Test 3 masih terbuka (dijalankan via background node process
   supaya tidak terputus gara-gara pindah sesi terminal), staff itu di-revoke
   lewat POST /v1/staff/revoke (Admin Demo) -> re-check interval 30 detik
   mendeteksi sesi sudah tidak ada di sessionMap, koneksi WS auto-close code
   4003 reason "sesi dicabut" dalam <30 detik. LULUS -- bukti konkret bahwa
   Revoke di REST benar-benar ikut memutus koneksi WS yang sudah authenticated,
   bukan cuma asumsi dari baca kode.

**Kendala teknis saat testing (dicatat untuk sesi berikutnya):** wscat tidak
bisa dijalankan lewat pipe/background biasa (butuh mode interaktif, langsung
exit kalau stdin bukan terminal) -- solusinya pakai `node -e` dengan library
`ws` langsung, dijalankan via `nohup ... &` supaya proses tetap hidup di VPS
lepas dari sesi terminal/HP yang dipakai untuk mengetik command lain secara
bersamaan (dibutuhkan untuk Test 4, connect + revoke harus tumpang tindih).

**Temuan tambahan saat Test 4 (tidak diduga sebelumnya): nginx proxy_read_timeout
default 60 detik memutus paksa koneksi WS yang authenticated tapi idle (tidak
ada pesan lewat) lebih dari 60 detik -- close code 1006, TERPISAH dari logic
kode P1-3 manapun.** Ini bukan soal keamanan (tidak terkait revoke/kecurangan
staff), murni soal pengalaman staff jujur yang diam sebentar (baca chat, mikir
balasan) bisa kehilangan koneksi real-time tanpa sadar. Diperbaiki di sesi yang
sama, lihat Bagian 116.


**Status: P1-3 dari audit ChatGPT (Bagian 105) SELESAI & TERUJI.**
13 dari 15 temuan sekarang sudah dibenerin total.
2 sisanya: P0-6 (schema drift file), P1-1 (session in-memory -> Redis).

**Next steps Bagian 115:**
[ ] P1-1: session/rate-limit dari in-memory Map() ke Redis (atau catat
    eksplisit constraint "1 instance only" di deployment)
[ ] P0-6: regenerate file schema dari live database (schema drift)
[ ] k6 load testing (belum dieksekusi, next steps lama)
[ ] Daftar terbuka Bagian 109 (backup/DR, .env permission, dst)
[ ] Investigasi DeprecationWarning client.query() yang masih tersisa
    (Bagian 92/98/114)

## 116. Fix tambahan: WS ping/pong heartbeat cegah nginx proxy_read_timeout motong koneksi idle -- SELESAI & TERUJI (16 Agustus 2026)

**Rasa yang dipenuhi:** Rasa Customer Service (staff jujur yang sekadar diam sebentar -- baca chat, mikir balasan -- tidak lagi kehilangan koneksi real-time tanpa sebab yang dia sadari) dan Rasa Ketelitian (temuan di luar scope testing awal tetap ditelusuri sampai akar penyebab sebelum diperbaiki, bukan dibiarkan karena "bukan tujuan sesi ini").

**Konteks:** ditemukan saat testing Test 4 Bagian 115 (lihat catatan "Temuan tambahan" di bagian itu) -- koneksi WS yang authenticated tapi idle lebih dari 60 detik ter-close paksa code 1006, ternyata bukan dari logic kode P1-3, melainkan `proxy_read_timeout` default nginx (60 detik) yang menganggap koneksi nganggur kalau tidak ada data lewat dalam rentang itu.

**Klarifikasi penting (sempat didiskusikan karena awalnya membingungkan):** ini SAMA SEKALI tidak terkait ke WS_SESSION_RECHECK_MS (re-check 30 detik untuk deteksi Revoke/Offboard, Bagian 115). Dua mekanisme beda tujuan: WS_SESSION_RECHECK_MS itu soal keamanan (mendeteksi staff yang sengaja di-revoke manusia lain), sedangkan timeout nginx ini murni soal koneksi idle wajar yang tidak ada hubungannya dengan kecurangan/otorisasi staff sama sekali.

**Opsi yang dipertimbangkan:**
- Opsi A -- naikin angka `proxy_read_timeout` di nginx. Simpel tapi koneksi yang sudah mati beneran (HP mati/sinyal hilang tanpa pernah kirim sinyal apapun) baru ketahuan setelah waktu yang lebih lama, boros resource.
- Opsi B (DIPILIH) -- ping/pong berkala dari server. Lebih standar untuk WebSocket, otomatis bedain koneksi yang beneran mati vs cuma idle wajar, deteksi lebih cepat & presisi.

**Perubahan kode (server.js, setelah blok `wss.on("connection", ...)`, commit 7613ae5):**
1. Per-koneksi: `ws.isAlive = true` di-set saat connect, `ws.on("pong", ...)` di-set `ws.isAlive = true` tiap kali client balas pong.
2. Interval global `WS_HEARTBEAT_MS = 25000` (25 detik) -- tiap tick, loop semua `wss.clients`: kalau `ws.isAlive === false` (belum pernah balas pong sejak ping terakhir) -> `ws.terminate()` (putus paksa, dianggap mati). Kalau masih alive -> set `isAlive = false` lalu `ws.ping()` (nunggu pong balik sebelum tick berikutnya).
3. Angka 25 detik dipilih supaya ping terjadi jauh sebelum batas 60 detik nginx -- selalu ada "aktivitas" yang bikin nginx tidak anggap koneksi nganggur.

**Testing (LULUS):**
1. Connect + auth (staff QC Demo, token baru), koneksi dibiarkan idle (tidak kirim pesan apapun) selama 90 detik penuh (melewati batas 60 detik nginx yang sebelumnya bikin close 1006).
2. Hasil: 3x "got ping from server" tercatat di client log (~25s, ~50s, ~75s sesuai interval), dan **tidak ada close sama sekali** sampai proses dihentikan manual. LULUS -- perbandingan langsung dengan kondisi sebelum fix (Bagian 115 awal, idle >60s selalu close 1006) membuktikan perbaikan ini efektif menutup gap yang ditemukan.

**Verifikasi sebelum commit:** `node -c server.js` syntax OK, `git diff` dicek penuh (cuma 18 baris insertion sesuai rencana, tidak ada yang kesenggol), error log dipantau bersih setelah restart PM2.

**Status: SELESAI & TERUJI.** Ini menutup gap yang ditemukan di tengah testing P1-3 (Bagian 115) -- bukan bagian dari 15 temuan audit ChatGPT (Bagian 105), melainkan temuan operasional baru yang muncul dari testing manual yang teliti.

**Next steps Bagian 116:** tidak ada next step baru dari perbaikan ini -- next steps aktif tetap seperti yang tercatat di Bagian 115 (P1-1 session Redis, P0-6 schema drift, k6 load testing, daftar terbuka Bagian 109, DeprecationWarning client.query()).

## 117. Tenant Isolation Testing -- Bagian 109 poin #10 -- SELESAI & TERUJI (16 Agustus 2026)

**Rasa yang dipenuhi:** Rasa Keamanan (isolasi antar tenant -- risiko paling kritis untuk SaaS multi-tenant -- dibuktikan langsung dengan data nyata, bukan diasumsikan aman dari baca kode) dan Rasa Ketelitian (2 lapis proteksi dites terpisah -- level API/subdomain DAN level database/RLS -- bukan cuma 1 lapis dianggap mewakili semua).

**Konteks:** poin #10 dari daftar terbuka Bagian 109 ("Tenant isolation testing... Belum pernah ada test eksplisit"). Dites sesi ini pakai 2 tenant demo yang sudah ada (Demo Tenant/subdomain "demo", Demo Tenant Kedua/subdomain "demo2").

**Keputusan desain saat testing:** sempat dipertimbangkan bikin endpoint GET-by-ID baru khusus buat testing yang lebih detail, TAPI diputuskan TIDAK -- menambah endpoint baru cuma untuk keperluan tes menambah permukaan yang perlu direview keamanannya sendiri (sejalan Bagian 101, tidak bikin kode baru tanpa rencana matang). Sebagai gantinya, RLS (mekanisme yang otomatis berlaku di SEMUA query database, tidak tergantung endpoint mana) dites LANGSUNG di level database via psql dengan role app_user (persis role yang dipakai server.js), tanpa perlu endpoint tambahan apapun.

**Testing (5 skenario, semua LULUS):**

Level API (lewat endpoint yang sudah ada):
1. Baseline -- API key tenant "demo" + subdomain "demo" ke GET /v1/orders -> 200, cuma menampilkan order milik "demo" sendiri (order_id a6f807b1...), tidak ada bocoran data "demo2" walau "demo2" juga punya data. LULUS.
2. Silang -- API key tenant "demo2" + subdomain "demo" ke GET /v1/staff/list -> 401 "API key tidak valid." LULUS.
3. Silang balik -- API key tenant "demo" + subdomain "demo2" ke GET /v1/staff/list -> 401 "API key tidak valid." LULUS.

Level Database (RLS langsung, role app_user, tanpa lewat endpoint apapun):
4. Konteks app.tenant_id di-SET ke "demo" (8ae20661...), query SELECT order dengan id milik "demo2" (2c16b932-7b2e-4f46-bdc5-3b93db6e2ce1, ID valid & benar-benar ada di database) -> 0 rows. RLS menyembunyikan total, seolah data itu tidak pernah ada. LULUS -- ini bukti paling kuat karena ID-nya presisi dan valid, bukan sekadar dicoba sembarang.
5. Pembanding -- konteks app.tenant_id di-SET ke "demo2" (f06b9548...), query SELECT dengan id yang sama persis -> 1 row, tampil normal. LULUS -- konfirmasi RLS benar-benar MEMFILTER berdasarkan tenant yang tepat, bukan menolak semua request tanpa pandang bulu (bukan bug fail-closed total yang kebetulan terlihat aman).

**Kendala teknis saat testing:** psql manual awalnya gagal 2x -- pertama karena `$DATABASE_URL` belum di-load ke shell (perlu `source .env` dengan `set -a`/`set +a`, bukan `cut -d=` manual yang berisiko salah potong kalau connection string punya karakter `=` di dalamnya), kedua karena tabel `tenants` sendiri memang tidak bisa di-SELECT oleh app_user (sesuai catatan lama Bagian 4) sehingga sempat dicoba lewat Supabase MCP `execute_sql` untuk lihat daftar tenant -- tapi `SET ROLE app_user` ditolak MCP (role MCP beda dari role backend), jadi query RLS-nya balik dijalankan via psql VPS yang memang sudah connect sebagai app_user secara native lewat DATABASE_URL.

**Status: Tenant Isolation Testing SELESAI & TERUJI, poin #10 Bagian 109 RESMI TERTUTUP.** Proteksi terbukti berlapis dan konsisten di 2 level berbeda (API key/subdomain, dan RLS database) -- bukan cuma 1 lapis yang kebetulan menutupi celah di lapis lain.

**Catatan batasan testing (jujur dicatat, bukan diklaim tuntas 100%):** API yang ada sekarang cuma punya endpoint list (GET /v1/orders, /v1/staff/list, /v1/notifications), tidak ada GET-by-ID -- jadi skenario "API key & subdomain sah untuk tenant A, tapi resource ID yang diminta lewat endpoint milik tenant B" belum bisa dites lewat jalur HTTP asli. Skenario itu digantikan test level database (test 4-5 di atas) yang menguji mekanisme yang sama (RLS) secara langsung -- risikonya dianggap tertutup, tapi kalau nanti ada endpoint GET-by-ID baru, sebaiknya diulang juga test serupa lewat HTTP untuk kelengkapan.

**Next steps Bagian 117:** tidak ada next step baru dari testing ini. Next steps aktif tetap seperti Bagian 115/116 (P1-1 session Redis, P0-6 schema drift, k6 load testing, sisa daftar terbuka Bagian 109 poin #1,3,4,5,7,8,11, DeprecationWarning client.query()).

## 118. Progress -- Bagian 109 sisa poin cepat: CORS BELUM DIEKSEKUSI (keputusan desain sudah disepakati, serah-terima ke sesi berikutnya) (16 Agustus 2026)

**Status: KEPUTUSAN DESAIN SUDAH DISEPAKATI, KODE BELUM DITULIS SAMA SEKALI.** Sesi ini habis waktu di tengah diskusi CORS sebelum sempat eksekusi -- room berikutnya WAJIB baca bagian ini dulu sebelum lanjut, jangan mulai dari nol.

**Temuan awal:** CORS sama sekali belum dikonfigurasi di server.js (grep "cors\|Access-Control" -> 0 hasil, package "cors" juga belum ada di package.json). Ini poin #8 dari daftar terbuka Bagian 109.

**Diskusi yang terjadi (penting dibaca urutannya, karena keputusan akhir beda dari asumsi awal):**
1. Sempat dipertimbangkan tunda CORS sampai frontend mulai dibikin (biar domain final pasti) -- DIKOREKSI: domain final SUDAH ada (benangrasa.com, Bagian 99), jadi tidak perlu ditunda.
2. Rencana awal: pattern wildcard `*.benangrasa.com` doang, cukup untuk kebutuhan sekarang (1 tenant demo + rencana v1 1 klien kecil).
3. Teja menegur pendekatan itu terlalu sempit -- **PRINSIP DITEGASKAN ULANG: jangan menyepelekan kebutuhan cuma karena sekarang masih kecil/1 klien, ini persis Rasa Grosir (Bagian 88/95) yang sudah jadi prinsip permanen.** Skenario konkret yang dibahas: tenant besar (misal "Konveksi Makmur") suatu saat mau pakai domain custom sendiri (produksi.konveksimakmur.com) bukan subdomain benangrasa.com, demi branding sendiri.

**KEPUTUSAN DESAIN YANG SUDAH DISEPAKATI (siap dieksekusi langsung, tidak perlu didiskusikan ulang):**
- CORS dibangun dengan struktur **daftar/list origin yang bisa diperluas**, BUKAN wildcard hardcode mati satu baris. Sekarang isinya cuma pattern `*.benangrasa.com` + domain utama, tapi strukturnya (array/list, dicek pakai regex untuk wildcard subdomain) sudah siap ditambah entry baru kapan saja.
- ANALOGI yang disepakati: gerbang yang baca dari "daftar tamu" yang bisa ditambah, bukan gerbang yang cuma kenal 1 nama dan harus dibongkar total kalau mau nambah.
- Ini levelnya STRUKTUR/kerangka (sesuai prinsip Bagian 95), BUKAN logic penuh "tenant self-service pilih domain sendiri dari dashboard" -- itu ide besar terpisah yang belum diriset (poin I daftar ide, archive bagian 53), TIDAK dikerjakan sekarang.

**3 KETERBATASAN yang WAJIB dipahami sebelum dianggap "selesai" (disampaikan Claude, disetujui arahnya oleh Teja):**
1. Daftar origin yang diizinkan masih di-hardcode di kode (array biasa di server.js), BUKAN baca dari tabel database. Kalau nanti ada tenant minta domain custom beneran, masih perlu edit kode + deploy ulang manual -- belum self-service.
2. CORS cuma soal "browser boleh nampilin hasil ke halaman web mana". tenantResolver (fungsi yang nentuin request ini punya tenant_id apa) SAMA SEKALI BELUM diupdate untuk mengenali domain custom -- sekarang cuma baca subdomain pola `X.benangrasa.com`. CORS mengizinkan browser manggil, TAPI backend belum tahu cara translate domain custom ke tenant_id yang benar. Ini 2 sistem terpisah yang harus diupdate BERSAMAAN nanti, CORS doang tidak cukup.
3. Kalau nanti domain custom tenant beneran dieksekusi, itu combo 3 langkah: (a) DNS tenant diarahkan ke server Benangrasa -- mirip pola Bagian 99 tapi domain milik tenant, (b) tenantResolver diperluas mengenali domain custom -> tenant_id, (c) sertifikat SSL terpisah perlu di-generate khusus domain itu (certbot ulang). BELUM DIRISET SAMA SEKALI cara teknis detailnya -- next step besar tersendiri, bukan sekadar tambah baris CORS.

**NEXT STEP LANGSUNG (paling prioritas buat sesi berikutnya, tinggal eksekusi tanpa perlu diskusi ulang):**
[ ] `npm install cors` di VPS
[ ] Tulis middleware CORS di server.js: origin function yang cek regex `/\.benangrasa\.com$/` ATAU persis `benangrasa.com`, DITAMBAH array kosong/siap-isi untuk domain custom tenant ke depan (misal `const CUSTOM_TENANT_ORIGINS = []` dengan komentar penjelasan)
[ ] Testing: request dari origin benangrasa.com/subdomain -> harus lolos (header Access-Control-Allow-Origin muncul benar). Request dari origin asing (misal evil.com atau domain mirip seperti benangrasa.com.evil.ru) -> harus DITOLAK.
[ ] git diff dicek penuh sebelum commit (kebiasaan wajib Bagian 103), commit & push
[ ] Update CHECKPOINT.md dengan hasil testing aktual (bukan placeholder)

**Next steps Bagian 109 lain yang MASIH BELUM DISENTUH sama sekali (belum didiskusikan apapun):**
[ ] #5 session/token expiry & revocation (sebagian relevan dari kerja WS Bagian 115/116, tapi belum di-cross-check eksplisit)
[ ] #7 validasi MIME foto (KEMUNGKINAN BESAR sudah kejawab di P1-4/P1-5 Bagian 114 -- magic byte JPEG check -- tinggal cross-check baca ulang kode, bukan kerjaan baru)
[ ] #11 kebijakan lockout PIN (rate limit sudah ada tapi belum ada lockout permanen setelah percobaan gagal berkelanjutan jangka panjang)
[ ] #1 backup/DR (cek plan Supabase apakah include PITR)
[ ] #3 uptime monitoring/alerting otomatis
[ ] #4 audit trail siapa-ubah-apa di luar production_events

**Next steps lama yang masih menumpuk (belum berubah dari Bagian 115/116/117):**
[ ] P1-1 session/rate-limit ke Redis (atau catat eksplisit constraint "1 instance only")
[ ] P0-6 regenerate file schema dari live database (schema drift)
[ ] k6 load testing
[ ] Investigasi DeprecationWarning client.query() yang masih tersisa (Bagian 92/98/114)
[ ] Frontend web responsive -- MASIH BELUM TERSENTUH SAMA SEKALI, item terbesar dari target v1 (Bagian 97)
[ ] Endpoint mediator backup/resign yang lama tertunda (next steps lama Bagian 5)

**Catatan:** CHECKPOINT.md di-split 16 Agustus 2026 -- Bagian 89-114 diarsipkan ke CHECKPOINT_ARCHIVE_3.md, file ini sekarang 490 baris (Bagian 1-9, 64, 88, 115-118 + next steps aktif).

## 119. Verifikasi tuntas audit ChatGPT ronde 2 (17 poin) -- SEMUA DIVERIFIKASI KE SUMBER ASLI (16 Agustus 2026)

**Rasa yang dipenuhi:** Rasa Ketelitian (audit eksternal ronde 2 TIDAK diterima mentah maupun ditolak mentah -- setiap dari 17 poin diverifikasi satu-satu ke sumber asli: Supabase live via MCP, kode server.js/worker.js/db.js/ingestion.js di VPS, Vercel API via MCP -- sebelum dipercaya atau dicatat; 1 poin terbukti salah/basi ditemukan dan dikoreksi, bukan diikuti buta).

**Konteks:** Teja minta cross-check audit ChatGPT ronde 2 (lebih dalam dari Bagian 105, menyilang GitHub+Supabase live+migration history+RLS+event chain+Vercel+CI). Semua 17 poin + 1 catatan authorization diverifikasi tuntas satu-satu, bukan diterima langsung.

**HASIL: 16 dari 17 poin TERBUKTI VALID. 1 poin TERBUKTI SALAH/BASI. Plus 1 bug baru ditemukan di luar 17 poin.**

### Temuan BARU paling kritis (belum pernah tercatat sebelumnya):

**P0-BARU-1: Worker gap-monitor bypass event allocator -- INSERT SELALU GAGAL TOTAL, lebih parah dari klaim awal.**
worker.js baris 69-70 (`gap.escalated`) dan 152-153 (`gap.resolved`) INSERT langsung ke production_events TANPA mengisi kolom `sequence_version`. Dicek struktur tabel: `sequence_version` adalah NOT NULL TANPA default value -- artinya INSERT ini PASTI gagal (constraint violation) setiap kali dijalankan, bukan cuma "sequence_version kosong". Dikonfirmasi: `SELECT count(*) FROM production_events WHERE event_type IN ('gap.escalated','gap.resolved')` = 0 baris, PADAHAL gap_audit_log historis (Bagian 112) menunjukkan gap pernah terjadi 4x. Errornya ketutup try-catch PER-TENANT di checkGaps() (baris ~107-111, `catch(err){console.error(...)}`), gak keliatan sebagai crash.

**DAMPAK LEBIH SERIUS dari dugaan awal:** `withTenant()` di db.js TRANSAKSIONAL (BEGIN/COMMIT/ROLLBACK, dikonfirmasi baris 33-41). Karena UPDATE gap_status dan INSERT event ada di transaksi yang SAMA, kalau INSERT gagal maka SELURUH transaksi ROLLBACK -- termasuk UPDATE gap_status='ESCALATED' yang seharusnya berhasil. Artinya **fitur eskalasi gap otomatis 100% diam-diam TIDAK PERNAH benar-benar berfungsi**, meski kode kelihatan seperti sudah menghandle-nya.

manuallyResolveGap() (jalur gap.resolved) kena bug sama persis, TAPI dikonfirmasi via `grep -rn "manuallyResolveGap"` -- fungsi ini cuma di-export, TIDAK ADA satupun endpoint di server.js yang memanggilnya. Jadi ini dead code, bug laten tapi belum berdampak nyata.

**Dampak nyata SEKARANG:** NOL. Dicek `SELECT * FROM production_jobs WHERE gap_status IN ('OPEN','RECOVERING','ESCALATED')` -- kosong, semua job CLOSED. Tapi ini P0 nyata untuk ke depan: begitu ada job produksi asli yang gap lama, eskalasi otomatis gak akan pernah aktif.

**P0-BARU-2: job_locks race condition -- dikonfirmasi struktur + kode.**
Index live: `UNIQUE(tenant_id, production_job_id, released_at)` -- BUKAN partial unique index. `released_at` nullable (dikonfirmasi). Kode acquire lock (server.js baris ~383-419) pakai pola SELECT active lock dulu baru INSERT, TANPA FOR UPDATE atau proteksi atomic. Kode sendiri PUNYA KOMENTAR yang mengakui masalah ini ("unique constraint TIDAK cukup buat ini") tapi solusi yang dipilih (cek eksplisit di app-level) TETAP TIDAK menutup celah race condition -- 2 request bersamaan masih bisa lolos SELECT bersamaan sebelum salah satu sempat INSERT. Solusi sebenarnya butuh partial unique index `WHERE released_at IS NULL` di level DB, bukan app-level check.

**BUG BARU (di luar 17 poin audit ChatGPT): pesan error mediator gak sinkron sama logic authorization.**
server.js baris 262-263: endpoint assign mediator pakai `isPrivileged()` (cek role IN admin,owner -- baris 82-84), TAPI pesan error di baris 263 bilang "hanya owner yang bisa menunjuk mediator" -- TIDAK SESUAI logic aslinya yang sebenarnya mengizinkan admin juga. Kalau desain bisnis memang "owner+admin boleh" (konsisten sama pola override_admin_pin di job_locks baris ~383, dan owner-resolve Bagian 93 yang eksplisit izinkan admin), maka ini cuma bug pesan/dokumentasi -- TAPI tetap harus diperbaiki karena bisa bikin bingung staff/audit di kemudian hari. Butuh keputusan eksplisit dari Teja: perbaiki pesannya (admin memang boleh), atau perbaiki logic-nya (owner only)?

### Tabel ringkas 17 poin (semua diverifikasi ke sumber asli):

| # | Klaim | Status | Sumber verifikasi |
|---|---|---|---|
| 1 | job_locks race condition | VALID | pg_indexes + server.js baris 383-419 |
| 2 | Worker bypass allocator | VALID, lebih parah | worker.js + struktur tabel + query count |
| 3 | BUNDLE_ALLOCATION 501 | VALID | ingestion.js baris 115-118 |
| 4 | CORS belum ada | VALID | grep server.js (kosong) |
| 5 | Vercel bukan aplikasi | VALID | Vercel MCP get_project: live=false, framework=null |
| 6 | Event chain lebih baik | VALID | production_events + production_jobs live |
| 7 | Event immutability | VALID | pg_trigger (2 trigger aktif) |
| 8 | Security Advisor bersih | VALID | get_advisors security: lints=[] |
| 9 | RLS performance warning | VALID | get_advisors performance (dikenal sejak Bagian 107) |
| 10 | FK tanpa index | VALID | get_advisors performance (dikenal) |
| 11 | Schema reproducibility | VALID | db/ cuma 1 file statis vs 45 migration live |
| 12 | Session in-memory | VALID | grep server.js (Map()) |
| 13 | Backend masih HTTP | **SALAH/BASI** | curl https berhasil, nginx config SSL aktif (Bagian 99-100) |
| 14 | PIN lockout belum ada | VALID | grep server.js (kosong) |
| 15 | Test suite lemah | VALID | package.json scripts.test |
| 16 | Audit trail admin | Belum dicek kode (konsisten Bagian 109 #4) | - |
| 17 | Monitoring/alerting | Belum dicek kode (konsisten Bagian 109 #3) | - |

**Pelajaran penting:** audit eksternal ronde 2 ini jauh lebih akurat dari yang pertama (Bagian 105) DAN menemukan 1 hal yang audit pertama TIDAK temukan (worker bypass allocator) -- bukti konkret kenapa audit berlapis (Bagian 106) bernilai, tapi verifikasi manual TETAP wajib karena tetap ada 1 poin yang basi/salah (klaim HTTPS) yang kalau diterima mentah akan mengarahkan sesi berikutnya kerja ulang sesuatu yang sudah selesai.

**Status: VERIFIKASI SELESAI TUNTAS. BELUM ADA PERBAIKAN KODE APAPUN dieksekusi di bagian ini -- murni fase investigasi/konfirmasi.**

**Next steps Bagian 119 (urutan prioritas, didiskusikan dengan Teja di sesi berikutnya):**
[ ] P0-BARU-1: Perbaiki worker.js -- semua event (termasuk gap.escalated/gap.resolved) WAJIB lewat assignVersionAndStoreInTx() seperti alur normal (Bagian 110), bukan INSERT langsung
[ ] P0-BARU-2: Tambah partial unique index job_locks: CREATE UNIQUE INDEX ... ON job_locks(tenant_id, production_job_id) WHERE released_at IS NULL
[ ] P0-6 lama: schema/migration reproducibility -- regenerate dari live database atau bikin folder migration history di repo
[ ] Perbaiki pesan error mediator (baris 263) -- putuskan dulu sama Teja: admin boleh (perbaiki pesan) atau owner-only (perbaiki logic)?
[ ] CORS (next step Bagian 118, belum berubah)
[ ] P1-1 session ke Redis, PIN progressive lockout, test suite CI gate -- prioritas menyusul setelah 2 P0-BARU di atas
[ ] #16/#17 (audit trail admin, monitoring) -- belum diverifikasi kodenya, masih asumsi dari Bagian 109

## 120. P0-BARU-1: worker.js gap-monitor bypass event allocator -- FIXED & TERUJI (17 Agustus 2026)

**Rasa yang dipenuhi:** Rasa Keamanan (transaksi gap.escalated/gap.resolved
sekarang benar-benar atomic dengan UPDATE gap_status -- tidak ada lagi
rollback diam-diam yang bikin fitur "kelihatan" jalan padahal tidak) dan
Rasa Ketelitian (testing end-to-end di VPS pakai job demo, bukan cuma baca
kode dan asumsi benar -- termasuk nemuin dan verifikasi efek samping tak
terduga dari cara setup test-nya sendiri sebelum dianggap selesai).

**Konteks:** temuan P0-BARU-1 dari audit ChatGPT ronde 2 (Bagian 119) --
worker.js INSERT langsung ke production_events untuk event gap.escalated
(baris 69-70 lama) dan gap.resolved (baris 152-153 lama) TANPA mengisi
sequence_version (NOT NULL, tanpa default). INSERT selalu gagal constraint
violation, ketutup try-catch per-tenant jadi tidak keliatan sebagai crash.
Karena withTenant() transaksional, gagalnya INSERT bikin SELURUH transaksi
ROLLBACK -- termasuk UPDATE gap_status='ESCALATED' yang seharusnya berhasil.
Eskalasi gap otomatis 100% diam-diam tidak pernah berfungsi sejak awal.

**Perbaikan (commit 2baf322):** kedua titik INSERT diganti manggil
assignVersionAndStoreInTx() (versioning.js) -- pola yang sama persis dipakai
endpoint confirm submission (server.js baris 793). Fungsi ini yang benar
mengisi sequence_version (row lock FOR UPDATE ke production_jobs, ambil
next_sequence_version), insert event, update next_sequence_version, dan
apply ke state (tryApplyToState) -- semua dalam transaksi yang sama.
Tambahan require("./versioning") di baris 2 worker.js.

**Testing (VPS, job demo 25352257-..., 2 skenario, semua LULUS):**
1. gap.escalated: job di-set manual RECOVERING + insert event gap.opened
   palsu dengan created_at mundur 10 menit (lewat ambang GAP_THRESHOLD +
   GRACE_PERIOD = 360 detik) -> tunggu 1 tick checkGaps() (interval 10
   detik) -> job otomatis ESCALATED, event gap.escalated ter-insert dengan
   sequence_version terisi (19), next_sequence_version ikut naik. LULUS.
2. gap.resolved (manuallyResolveGap, dead code -- tidak ada endpoint yang
   panggil, tapi tetap diverifikasi karena bug sama persis): dipanggil
   langsung lewat script node sekali-pakai -> {resolved: true}, event
   gap.resolved ter-insert dengan sequence_version terisi (20). LULUS.

**Efek samping tak terduga saat testing (ditelusuri sampai akar penyebab,
bukan dibiarkan karena "bukan tujuan sesi ini" -- konsisten Bagian 116):**
Karena setup skenario 1 pakai raw INSERT manual ke production_events (bukan
lewat tryApplyToState), current_version job jadi tidak sinkron dengan
next_sequence_version/sequence_version event yang baru. Event gap.escalated
dan gap.resolved yang barusan berhasil di-insert (via assignVersionAndStoreInTx
yang sudah benar) malah ke-BUFFER ke pending_events (bukan hilang/korup) --
tryApplyToState() mendeteksi "out-of-order" dan openGapIfNeeded() otomatis
nyetel ulang gap_status='OPEN' sebagai bentuk kehati-hatian sistem (dikonfirmasi
lewat gap_audit_log, dan ternyata sudah pernah kejadian juga tanggal 7 & 9
Agustus dari testing-testing lama -- bukan pertama kali). Ini PERILAKU SAH
dari mekanisme gap-detection/buffer/chain-apply yang sudah ada sebelumnya
(stateLayer.js), bukan bug baru dari perbaikan P0-BARU-1 -- justru jadi
bukti tambahan bahwa mekanisme itu bekerja sesuai desain (menangkap
inkonsistensi, bukan korupsi data diam-diam).

**Cleanup:** dipanggil tryApplyToState() manual untuk event sequence_version
18 (yang tadinya di-insert raw tanpa lewat state layer) -> chainApplyFromBuffer()
otomatis meneruskan 19 dan 20 secara rekursif. Hasil akhir: current_version=20,
next_sequence_version=20 (sinkron), gap_status=CLOSED (disetel otomatis oleh
closeGapIfOpen(), bukan ditimpa manual), pending_events kosong (0 rows).
Job demo kembali ke state bersih, siap dipakai testing berikutnya.

**Catatan untuk testing gap serupa di masa depan:** JANGAN insert event
manual ke production_events dengan raw SQL tanpa lewat assignVersionAndStoreInTx/
tryApplyToState -- akan memicu ketidaksinkronan current_version vs
sequence_version dan event ter-buffer sampai gap tertutup manual (seperti
yang terjadi sesi ini). Kalau perlu simulasi gap lagi, pertimbangkan bikin
helper script test yang lewat jalur resmi dari awal.

**Status: P0-BARU-1 SELESAI & TERUJI.**

**Next steps Bagian 120 (urutan belum berubah dari Bagian 119, P0-BARU-1 sudah dicoret):**
[ ] P0-BARU-2: partial unique index job_locks (CREATE UNIQUE INDEX ...
    ON job_locks(tenant_id, production_job_id) WHERE released_at IS NULL)
[ ] P0-6 lama: schema/migration reproducibility
[ ] Perbaiki pesan error mediator (baris 263) -- keputusan Teja: admin
    boleh (perbaiki pesan) atau owner-only (perbaiki logic)?
[ ] CORS (Bagian 118, desain sudah disepakati, belum dieksekusi)
[ ] P1-1 session ke Redis, PIN progressive lockout, test suite CI gate
[ ] #16/#17 Bagian 119 (audit trail admin, monitoring) -- belum diverifikasi kodenya

## 121. P0-BARU-2: job_locks race condition -- SEBAGIAN SELESAI, SERAH-TERIMA KE SESI BERIKUTNYA (17 Agustus 2026)

**Status: LAPIS DATABASE SELESAI & TERUJI. LAPIS APLIKASI KODE SUDAH DITULIS
TAPI BELUM DITEST ULANG SETELAH FIX TERAKHIR. Room berikutnya WAJIB baca
bagian ini dulu sebelum lanjut, jangan mulai dari nol.**

**Lapis 1 -- Database (SELESAI & TERUJI):**
Partial unique index ditambah via migration `add_partial_unique_index_job_locks_active`
(Supabase project kwhybffbcqopqbbnuigg):
Diverifikasi langsung: 2 INSERT manual ke job yang sama (released_at NULL)
di 1 transaksi -> INSERT kedua ditolak `23505 duplicate key`. LULUS. Ini
menutup celah asli (unique constraint lama `(tenant_id, production_job_id,
released_at)` TIDAK partial, jadi 2 row released_at=NULL dianggap "distinct"
oleh Postgres -- tidak pernah benar-benar mencegah apa-apa).

**Lapis 2 -- Aplikasi (kode sudah ditulis, BELUM ditest ulang):**
server.js endpoint POST /v1/lock/acquire (skitar baris 417-446) diubah:
INSERT job_locks dibungkus try/catch, kalau kena error code "23505" (race
beneran kejadian, lolos dari SELECT activeLock check di atasnya karena
window kecil antara SELECT dan INSERT), balas 409 "job sedang dikerjakan
orang lain" -- sama seperti pesan normal, bukan 500.

**Bug ditemukan & sudah diperbaiki saat testing pertama (percobaan 1
GAGAL):** catch block pertama langsung coba SELECT raceLock tanpa
ROLLBACK dulu -- di Postgres begitu 1 statement gagal dalam transaksi
(INSERT kena 23505), transaksi itu langsung berstatus "aborted" (kode
25P02), SEMUA query berikutnya di transaksi yang sama otomatis ditolak
sampai ada ROLLBACK. Testing manual race (2 curl paralel, staff Jahit
Demo vs Admin Demo, keduanya lolos SELECT activeLock lalu INSERT
bersamaan) membuktikan ini nyata: race 1 dapat 500 "internal error"
(bukan 409 yang diharapkan), log PM2 konfirmasi 25P02 dari SELECT
raceLock yang gagal karena transaksi sudah aborted.

**Fix (belum ditest ulang):** ditambah `SAVEPOINT before_lock_insert`
sebelum INSERT, `RELEASE SAVEPOINT` kalau sukses, dan `ROLLBACK TO
SAVEPOINT before_lock_insert` di awal catch block SEBELUM query
raceLock -- supaya transaksi "unfreeze" ke titik aman sebelum lanjut
query lain, tapi transaksi utama (withTenant BEGIN/COMMIT) tetap
lanjut normal.

**File di VPS sekarang:**
- server.js -- SUDAH diedit dengan fix SAVEPOINT, syntax valid (node -c
  lulus), TAPI BELUM di-commit ke git, BELUM di-restart ulang ke PM2
  dengan kode fix ini (restart terakhir masih pakai kode SEBELUM
  SAVEPOINT fix, itu yang dites dan gagal 500).
- server.js.bak-p0baru2 -- backup SEBELUM percobaan pertama (tanpa
  SAVEPOINT sama sekali)
- server.js.bak-p0baru2-v2 -- backup SETELAH percobaan pertama (ada
  catch block tapi belum ada SAVEPOINT, ini yang gagal 500 pas dites)
  Kedua backup ini TIDAK ke-track git (pola *.bak* sudah di .gitignore,
  dikonfirmasi lagi di sesi ini).

**Lock nyangkut dari testing (PERLU DIBERESIN sebelum lanjut apapun):**
Admin Demo (35afaab6-...) masih pegang active lock di job demo
(25352257-4cff-4377-85d7-2a63b05146fe) dari percobaan race yang gagal.
Cek dulu: `SELECT * FROM job_locks WHERE production_job_id=
'25352257-4cff-4377-85d7-2a63b05146fe' AND released_at IS NULL` -- kalau
ada row, release dulu (endpoint POST /v1/lock/release, atau manual UPDATE
released_at=now() kalau endpointnya gagal) sebelum testing ulang, supaya
tidak dikira lock aktif yang "sah".

**NEXT STEP LANGSUNG (tinggal eksekusi, tidak perlu diskusi ulang):**
[ ] Bersihkan lock nyangkut (lihat di atas)
[ ] `pm2 restart fashion-platform` -- load kode SAVEPOINT fix
[ ] Ulangi testing race: 2 curl paralel (Jahit Demo + Admin Demo) ke job
    yang sama -- kali ini SATU harus dapat 200 ok:true, SATU LAGI harus
    dapat 409 "job sedang dikerjakan orang lain" (BUKAN 500)
[ ] Kalau LULUS: `node -c server.js`, diff review, git add + commit +
    push, update CHECKPOINT.md (append Bagian 122, tandai P0-BARU-2
    SELESAI & TERUJI, coret dari next steps)
[ ] Kalau masih gagal: cek log PM2 error lagi, kemungkinan ada detail
    lain yang belum ketangkap -- jangan asumsi SAVEPOINT otomatis benar
    tanpa bukti test baru
[ ] Hapus server.js.bak-p0baru2 dan server.js.bak-p0baru2-v2 setelah
    fix final dikonfirmasi lulus dan sudah di-commit

**Next steps lain yang belum berubah dari Bagian 120 (P0-BARU-2 di atas
prioritas paling depan begitu sesi ini lanjut):**
[ ] P0-6 lama: schema/migration reproducibility
[ ] Perbaiki pesan error mediator (baris 263 lama server.js -- nomor
    baris mungkin bergeser akibat perubahan Bagian 121, cek ulang) --
    keputusan Teja: admin boleh (perbaiki pesan) atau owner-only
    (perbaiki logic)?
[ ] CORS (Bagian 118, desain sudah disepakati, belum dieksekusi)
[ ] P1-1 session ke Redis, PIN progressive lockout, test suite CI gate
[ ] #16/#17 Bagian 119 (audit trail admin, monitoring) -- belum diverifikasi kodenya

## 122. P0-BARU-2: job_locks race condition -- SELESAI & TERUJI, lapis aplikasi (17 Agustus 2026)

**Rasa yang dipenuhi:** Rasa Keamanan (celah race condition acquire lock
sekarang tertutup di 2 lapis -- database via partial unique index, DAN
aplikasi via SAVEPOINT yang membalas 409 manusiawi alih-alih 500/crash) dan
Rasa Ketelitian (percobaan pertama SAVEPOINT sempat gagal 500 karena token
staff basi akibat pm2 restart menghapus sessionMap in-memory -- ditelusuri
sampai akar penyebab sebelum retest, bukan diasumsikan fix salah).

**Konteks:** melanjutkan Bagian 121 (serah-terima) -- lapis database sudah
selesai (partial unique index), lapis aplikasi (SAVEPOINT fix di endpoint
POST /v1/lock/acquire) sudah ditulis tapi belum ditest ulang karena lock
nyangkut dari percobaan race pertama yang gagal.

**Langkah yang dieksekusi sesi ini:**
1. Lock nyangkut (Admin Demo, job demo) dibersihkan via POST /v1/lock/release.
2. `pm2 restart fashion-platform` -- load kode SAVEPOINT fix.
3. Retest race pertama GAGAL sementara: kedua token staff lama ("sesi
   kadaluarsa") -- ternyata BUKAN bug SAVEPOINT, murni efek pm2 restart
   menghapus sessionMap in-memory (P1-1, belum pindah ke Redis, konsisten
   catatan lama). Staff Jahit Demo & Admin Demo login ulang (PIN dari
   CHECKPOINT_LOCAL.md), dapat token baru.
4. Retest race dengan token baru: 2 curl paralel ke job demo yang sama --
   Staff Jahit Demo dapat 200 ok:true, Admin Demo dapat 409 "job sedang
   dikerjakan orang lain" dengan locked_by & locked_at yang benar. LULUS --
   tidak ada 500, tidak ada transaksi aborted diam-diam.

**Kode final (server.js, commit 2c06d18, 37 insertion/5 deletion):**
INSERT job_locks dibungkus SAVEPOINT before_lock_insert. Sukses -> RELEASE
SAVEPOINT lanjut normal. Kena 23505 (race asli, lolos dari SELECT activeLock
check di atasnya) -> ROLLBACK TO SAVEPOINT dulu (supaya transaksi tidak
berstatus aborted 25P02 dan menolak query berikutnya) -> baru SELECT siapa
pemegang lock yang menang -> balas 409 dengan nama staff & waktu lock,
bukan 500. Error lain (bukan 23505) tetap di-throw normal, tidak ketutup.

**Verifikasi sebelum commit:** `node -c server.js` syntax OK, `git diff`
dibaca penuh (tidak ada yang kesenggol di luar blok lock/acquire), pesan
commit rujuk CHECKPOINT Bagian 119/120/121 untuk jejak konteks.

**Status: P0-BARU-2 SELESAI & TERUJI di kedua lapis (database + aplikasi).**
Kedua P0-BARU dari audit ChatGPT ronde 2 (Bagian 119) sekarang tertutup.

**Next steps Bagian 122 (belum berubah dari Bagian 120/121, 2 P0-BARU sudah
tuntas semua):**
[ ] P0-6 lama: schema/migration reproducibility -- regenerate dari live
    database atau bikin folder migration history di repo
[ ] Perbaiki pesan error mediator (nomor baris server.js perlu dicek ulang,
    mungkin bergeser akibat perubahan Bagian 121/122) -- keputusan Teja:
    admin boleh (perbaiki pesan) atau owner-only (perbaiki logic)?
[ ] CORS (Bagian 118, desain sudah disepakati -- struktur list origin +
    regex wildcard subdomain, siap dieksekusi tanpa diskusi ulang)
[ ] P1-1 session/rate-limit ke Redis (makin nyata kebutuhannya -- pm2
    restart barusan langsung logout semua staff aktif di tengah kerja)
[ ] PIN progressive lockout (Bagian 109 #11 / Bagian 119 poin 14)
[ ] Test suite CI gate (Bagian 119 poin 15)
[ ] #16/#17 Bagian 119 (audit trail admin, monitoring) -- belum diverifikasi
    kodenya, masih asumsi dari Bagian 109

## 123. Fix pesan error mediator -- SELESAI (17 Agustus 2026)

**Konteks:** bug ditemukan di Bagian 119 (audit ChatGPT ronde 2) -- endpoint
POST /v1/mediators pakai `isPrivileged()` (PRIVILEGED_ROLES = ["admin",
"owner"], baris 82-84) untuk cek otorisasi, tapi pesan error 403-nya bilang
"hanya owner yang bisa menunjuk mediator" -- tidak sesuai logic asli yang
sebenarnya juga mengizinkan admin.

**Keputusan Teja:** logic sudah benar (admin+owner memang boleh, konsisten
pola job_locks override_admin_pin & owner-resolve Bagian 93) -- yang
diperbaiki cuma pesannya, bukan logic-nya.

**Perbaikan (commit 4e66ccc):** baris 263 server.js, "hanya owner yang bisa
menunjuk mediator" -> "hanya admin/owner yang bisa menunjuk mediator".
Verifikasi baris persis dulu via sed sebelum edit (konsisten pola
verifikasi Bagian 115/121), `node -c` OK, git diff cuma 1 baris.

**Status: SELESAI.** Item "Perbaiki pesan error mediator" dicoret dari next
steps Bagian 119/120/121/122.

**Next steps aktif sekarang (urutan disepakati dengan Teja):**
[ ] CORS (Bagian 118, desain sudah disepakati -- struktur list origin +
    regex wildcard subdomain, siap dieksekusi tanpa diskusi ulang) -- NEXT
[ ] P1-1 session/rate-limit ke Redis (urgensi makin nyata sejak restart
    Bagian 122 logout semua staff aktif)
[ ] P0-6 lama: schema/migration reproducibility
[ ] PIN progressive lockout (Bagian 109 #11 / Bagian 119 poin 14)
[ ] Test suite CI gate (Bagian 119 poin 15)
[ ] #16/#17 Bagian 119 (audit trail admin, monitoring) -- belum diverifikasi
    kodenya, masih asumsi dari Bagian 109

## 124. CORS -- SELESAI & TERUJI (17 Agustus 2026)

**Rasa yang dipenuhi:** Rasa Grosir (struktur list origin + regex disiapkan
di depan untuk domain custom tenant, bukan wildcard hardcode mati yang
harus dibongkar ulang tiap ada kebutuhan baru -- persis prinsip yang
ditegaskan Teja di Bagian 118) dan Rasa Ketelitian (percobaan pertama pakai
`callback(new Error(...))` menghasilkan 500 generic untuk origin asing --
bukan bug fungsional tapi cara nolak yang kasar/noise; diperbaiki ke
`callback(null, false)` setelah testing awal, bukan dibiarkan karena
"sudah menutup celah keamanannya").

**Konteks:** melanjutkan Bagian 118 (desain sudah disepakati, kode belum
ditulis) -- poin #8 daftar terbuka Bagian 109.

**Implementasi (server.js, commit b7d3032):**
- `npm install cors`
- `ALLOWED_ORIGIN_PATTERNS`: array regex, sekarang isinya
  `/^https:\/\/([a-z0-9-]+\.)?benangrasa\.com$/` (cover domain utama +
  semua subdomain sekaligus).
- `CUSTOM_TENANT_ORIGINS`: array kosong siap-isi untuk domain custom tenant
  ke depan -- struktur/kerangka saja (sesuai prinsip Bagian 95), BUKAN
  logic penuh self-service pilih domain dari dashboard (itu ide besar
  terpisah, poin I archive bagian 53, belum diriset).
- Origin function: undefined origin (curl/server-to-server) selalu
  diizinkan (bukan proteksi terhadap non-browser). Origin cocok pattern ->
  izinkan. Tidak cocok -> `callback(null, false)` (tolak halus, tidak
  nyetel header CORS sama sekali, TIDAK throw Error ke Express error
  handler).
- `credentials: false` -- staff pakai token bearer (x-staff-token), bukan
  cookie, konsisten arsitektur auth yang sudah ada.

**Percobaan pertama (dikoreksi sebelum commit):** versi awal pakai
`callback(new Error("Origin tidak diizinkan oleh CORS"))` untuk origin yang
ditolak -- fungsinya BENAR (header CORS tetap tidak muncul untuk origin
asing), tapi implementasinya bikin Express jatuh ke default error handler
-> response 500 Internal Server Error. Ini bukan celah keamanan (browser
tetap block karena tidak ada header Access-Control-Allow-Origin), tapi
berpotensi numpuk noise di error log tiap ada scan/percobaan origin asing,
dan tidak jelas dibedakan dari error asli. Diperbaiki ke `callback(null,
false)` -- pola standar library `cors`, tidak melempar exception.

**Testing (3 skenario OPTIONS preflight, semua LULUS setelah fix):**
1. Origin `https://demo.benangrasa.com` -> 204 No Content, header
   `Access-Control-Allow-Origin: https://demo.benangrasa.com` muncul.
2. Origin `https://evil.com` -> 200 OK, TIDAK ADA header
   Access-Control-Allow-Origin sama sekali (browser akan block).
3. Origin mirip-menipu `https://benangrasa.com.evil.ru` -> 200 OK, TIDAK
   ADA header CORS (regex `$` di akhir pattern mencegah domain "menempel"
   di belakang string benangrasa.com dianggap valid).

**3 KETERBATASAN yang WAJIB dipahami (belum ditutup, dicatat eksplisit,
bukan diklaim tuntas -- sama seperti sudah disampaikan di Bagian 118):**
1. Origin list masih hardcode di kode (array biasa di server.js), BUKAN
   baca dari tabel database. Domain custom tenant baru = edit kode + deploy
   ulang manual, belum self-service.
2. tenantResolver (fungsi resolve tenant_id dari request) SAMA SEKALI BELUM
   diupdate mengenali domain custom -- masih cuma baca subdomain pola
   `X.benangrasa.com`. CORS mengizinkan browser manggil, tapi backend belum
   tahu translate domain custom -> tenant_id. 2 sistem terpisah, harus
   diupdate BERSAMAAN nanti.
3. Domain custom tenant beneran = combo 3 langkah belum diriset: (a) DNS
   tenant diarahkan ke server Benangrasa, (b) tenantResolver diperluas
   mengenali domain custom, (c) sertifikat SSL terpisah (certbot ulang per
   domain). Next step besar tersendiri, bukan sekadar tambah baris CORS.

**Status: CORS SELESAI & TERUJI.** Poin #8 daftar terbuka Bagian 109
RESMI TERTUTUP (untuk cakupan struktur/kerangka -- bukan self-service
penuh, lihat keterbatasan di atas).

**Next steps aktif sekarang:**
[ ] P1-1 session/rate-limit ke Redis (urgensi makin nyata sejak restart
    Bagian 122 logout semua staff aktif) -- NEXT, prioritas disepakati Teja
[ ] P0-6 lama: schema/migration reproducibility
[ ] PIN progressive lockout (Bagian 109 #11 / Bagian 119 poin 14)
[ ] Test suite CI gate (Bagian 119 poin 15)
[ ] #16/#17 Bagian 119 (audit trail admin, monitoring) -- belum diverifikasi
    kodenya, masih asumsi dari Bagian 109
[ ] Domain custom tenant self-service (ide besar terpisah, poin I archive
    bagian 53) -- belum diriset, next step besar sendiri kalau ada tenant
    yang benar-benar minta

## 125. P1-1 bagian 1: Migrasi session staff in-memory Map ke Redis -- SEBAGIAN SELESAI, SERAH-TERIMA KE SESI BERIKUTNYA (17 Agustus 2026)

**Status: SESSION STORE SELESAI & TERUJI SOLID, TERMASUK WS AUTH
END-TO-END (diverifikasi 17 Agustus 2026, lihat testing tambahan di
bawah). RATE LIMITER (P1-1 bagian 2) BELUM DISENTUH -- satu-satunya
next step besar tersisa dari P1-1. Room berikutnya WAJIB baca bagian
ini dulu sebelum lanjut.**

**Rasa yang dipenuhi:** Rasa Keamanan (sesi staff tidak lagi hilang total
tiap pm2 restart -- gap nyata yang ketahuan langsung dari kejadian Bagian
122, sekarang tertutup dengan bukti konkret bukan asumsi) dan Rasa
Ketelitian (saat verify-before-write ke endpoint /v1/staff/revoke,
ditemukan endpoint itu SEBELUMNYA tidak punya try/catch sama sekali --
ditambahkan sekalian, bukan cuma migrasi sessionMap->sessionStore doang).

**Konteks:** melanjutkan next step Bagian 122/124 -- sessionMap in-memory
(new Map() di proses Node) hilang total tiap pm2 restart, semua staff
yang lagi login otomatis logout paksa di tengah kerja. Kejadian nyata
Bagian 122 (restart abis deploy SAVEPOINT fix, 2 staff demo langsung
"sesi kadaluarsa").

**Perubahan (commit 01170fc, 4 file, 219 insertion/41 deletion):**

sessionStore.js (baru):
- Session disimpan di Redis pakai native TTL (SET ... PX), bukan lagi
  size-based clear() manual.
- Index staff_sessions:{tenantId}:{staffId} (Redis SET) untuk fitur
  revoke-by-staff_id tanpa scan seluruh keyspace, dengan lazy cleanup
  token basi saat ditemukan.
- Redis client (ioredis) maxRetriesPerRequest: 3 -- gagal cepat kalau
  Redis down, tidak hang tanpa batas.

server.js -- 8 titik migrasi dari sessionMap ke sessionStore:
1. requireStaffSession jadi async, try/catch Redis error -> 503
2. createSession di endpoint login -> await sessionStore.createSession
3. /v1/staff/revoke -- TAMBAH try/catch baru (sebelumnya endpoint ini
   TIDAK ada try/catch sama sekali, ketemu pas verify-before-write)
4. /v1/staff/offboard -- ganti loop, try/catch sudah ada sebelumnya
5-6. WS auth (pesan pertama) -- async, try/catch -> close(4002) kalau
     Redis error
7. WS recheck interval -- setInterval jadi async, error Redis di
   recheck TIDAK menutup koneksi (beda dari auth awal) -- error transient
   tidak boleh melempar staff keluar dari koneksi aktif

**Testing (VPS, semua LULUS):**
- Login -> token tersimpan benar di Redis (verified via redis-cli
  GET/TTL, TTL 28778s ~ 8 jam sesuai SESSION_TTL_MS)
- PEMBUKTIAN UTAMA: token bertahan setelah pm2 restart --update-env
- /v1/staff/revoke dengan 2 session aktif milik 1 staff ->
  revoked_sessions: 2, keduanya benar-benar mati (redis-cli KEYS
  kosong, request selanjutnya 401)
- CORS (Bagian 124) tetap jalan normal setelah restart, tidak kesenggol
- redis-cli ping -> PONG, Redis service hidup & stabil di VPS

**WS auth end-to-end -- SUDAH DITEST, LULUS (tambahan 17 Agustus 2026):**
Ditest pakai pola node -e + ws + nohup (sama seperti Bagian 115):
1. Login Staff QC Demo -> connect WS + kirim {type:"auth",token} ->
   server balas {"type":"auth_ok"} langsung. LULUS.
2. Koneksi dibiarkan hidup di background (nohup), Admin Demo revoke
   sesi Staff QC Demo lewat POST /v1/staff/revoke (target_staff_id) ->
   revoked_sessions:1.
3. Re-check interval mendeteksi sesi sudah tidak ada di sessionStore
   Redis -> koneksi WS auto-close code 4003 reason "sesi dicabut",
   ~3 menit setelah connect (dalam batas wajar re-check 30 detik).
   LULUS -- bukti konkret sessionStore Redis yang baru tetap memutus
   koneksi WS aktif, sama seperti sessionMap in-memory lama (Bagian 115).

**BELUM DIKERJAKAN SAMA SEKALI:**
- Rate limiter (rateLimitMap, brute-force PIN protection) MASIH
  in-memory -- ini P1-1 bagian kedua, sengaja dipisah jadi commit
  terpisah karena concern beda (session vs brute-force protection).
  Artinya: pm2 restart sekarang AMAN buat session staff, TAPI counter
  rate-limit PIN masih ke-reset tiap restart (tidak separah session
  hilang -- cuma proteksi brute-force sementara "lupa" hitungannya).

**NEXT STEP LANGSUNG (urutan disepakati, tinggal eksekusi):**
[ ] Test WS auth end-to-end pakai WS client asli (bukan cuma percaya kode
    sama dengan REST) -- pola testing dari Bagian 115 bisa dipakai ulang
[ ] P1-1 bagian 2: migrasi rateLimitMap ke Redis (commit terpisah)
[ ] P0-6 lama: schema/migration reproducibility
[ ] PIN progressive lockout (Bagian 109 #11 / Bagian 119 poin 14)
[ ] Test suite CI gate (Bagian 119 poin 15)
[ ] #16/#17 Bagian 119 (audit trail admin, monitoring) -- belum
    diverifikasi kodenya, masih asumsi dari Bagian 109

## 126. P1-1 bagian 2: Migrasi rate limiter ke Redis + perjelas pesan error login -- SELESAI & TERUJI (17 Agustus 2026)

**Rasa yang dipenuhi:** Rasa Keamanan (counter rate-limit brute-force PIN tidak lagi ke-reset gratis tiap pm2 restart -- dibuktikan langsung, bukan diasumsikan) dan Rasa Customer Service (pesan error login yang tadinya generic "internal error" diperjelas jadi kasih tau staff ini gangguan sementara, bukan salah mereka).

**Konteks:** melanjutkan P1-1 bagian 1 (Bagian 125, session ke Redis) -- rate limiter (rateLimitMap) juga masih in-memory, sengaja dipisah jadi commit sendiri karena concern beda (session vs brute-force protection).

**Keputusan desain (didiskusikan sebelum eksekusi):**
- rateLimiter.js bikin koneksi Redis SENDIRI, bukan reuse punya sessionStore.js -- konsisten pola tiap modul berdiri sendiri (db.js punya pool sendiri, sessionStore.js punya koneksi sendiri).
- Fail-OPEN kalau Redis error/down (beda dari sessionStore yang fail-closed untuk create session) -- rate limiter cuma proteksi TAMBAHAN, PIN yang benar tetap wajib. Kalau dipilih fail-closed, dampaknya lebih parah dari masalah yang mau dicegah (semua staff gak bisa login sama sekali gara-gara Redis down, padahal Redis down biasanya soal infrastruktur bukan lagi diserang).

**Perubahan (commit f2e03f8, 2 file, 75 insertion/16 deletion):**

rateLimiter.js (baru): fixed-window counter pakai Redis INCR + PEXPIRE, logic sama persis dengan checkRateLimit versi in-memory lama, cuma medianya pindah. try/catch di sekeliling operasi Redis -- error di-log tapi return true (izinkan lanjut), bukan throw.

server.js:
- require("./rateLimiter") ditambah
- Blok rateLimitMap/checkRateLimit lama dihapus, diganti komentar penunjuk
- 2 titik pemanggilan (staffKey, ipKey di endpoint login) ditambah await
- Pesan error 500 di endpoint login diperjelas dari "internal error" jadi "Layanan sedang gangguan sementara, coba lagi beberapa saat lagi" -- HANYA di endpoint ini, BELUM di 13 titik "internal error" lain di server.js (sengaja tidak dirombak sekaligus, sesuai prinsip Bagian 64 "kode lama tidak perlu dirombak buru-buru" -- masuk daftar polish pass, lihat next steps)

**Testing (VPS, semua LULUS):**
1. 6 percobaan login PIN salah beruntun -> percobaan 1-5 kena "PIN salah", percobaan ke-6 kena 429 "Terlalu banyak percobaan PIN". LULUS.
2. Verifikasi langsung ke Redis: redis-cli KEYS "ratelimit:*" -> muncul key ratelimit:staff:... dan ratelimit:ip:..., TTL 30 (sesuai window). LULUS -- bukti counter beneran di Redis, bukan kebetulan.
3. PEMBUKTIAN UTAMA: pm2 restart --update-env -> key rate-limit masih ada di Redis (TTL lanjut turun, tidak reset ke awal). LULUS -- beda dari versi in-memory lama yang pasti hilang total tiap restart.
4. Fail-open: Redis di-stop manual (systemctl stop redis-server), coba login -> tetap dapat respons 500 dari endpoint, TAPI dikonfirmasi lewat baca kode+urutan eksekusi bahwa checkRateLimit sendiri SUDAH return true (fail-open bekerja, tidak jadi penyebab blokir) -- 500 yang muncul berasal dari titik LAIN (sessionStore.createSession, lihat temuan di bawah), bukan dari rate limiter. Redis dinyalakan lagi (systemctl start redis-server), dikonfirmasi PONG.

**Temuan tambahan saat testing fail-open (dicatat karena penting, bukan bug rate limiter):** waktu Redis mati total, endpoint login TETAP gagal (500) -- bukan karena rate limiter (yang terbukti fail-open), tapi karena sessionStore.createSession() di sessionStore.js tidak punya try/catch dan gagal keras kalau Redis tidak bisa diakses. Ini DIPUTUSKAN SEBAGAI PERILAKU YANG BENAR (bukan bug untuk diperbaiki) -- kalau session store juga dipaksa fail-open, staff akan dapat token yang kelihatan berhasil login tapi tidak pernah tersimpan di mana pun, sehingga request berikutnya langsung "sesi tidak ditemukan" -- lebih membingungkan daripada gagal jelas dari awal. Rate limiter dan session store SENGAJA punya perilaku gagal yang berbeda: rate limiter fail-open (proteksi tambahan), session store fail-closed (tanpa Redis, sesi tidak berguna sama sekali).

**Verifikasi sebelum commit:** node -c server.js syntax OK, git diff dibaca penuh (cuma menyentuh require, blok rateLimitMap lama, 2 pemanggilan, dan 1 pesan error -- tidak ada yang kesenggol di luar itu), git status dicek rateLimiter.js masuk sebagai file baru sebelum git add.

**Status: P1-1 SELESAI & TERUJI PENUH -- kedua bagian (session Bagian 125 + rate limiter Bagian 126) sudah dimigrasi ke Redis dan dites end-to-end termasuk skenario pm2 restart.**

**Next steps Bagian 126:**
[ ] Polish pass: 13 titik lain pesan "internal error" di server.js masih generic -- belum direview satu-satu, bukan prioritas mendesak (item polish, bukan bug)
[ ] P0-6 lama: schema/migration reproducibility
[ ] PIN progressive lockout (Bagian 109 #11 / Bagian 119 poin 14)
[ ] Test suite CI gate (Bagian 119 poin 15)
[ ] #16/#17 Bagian 119 (audit trail admin, monitoring) -- belum diverifikasi kodenya, masih asumsi dari Bagian 109

## 127. Ide Awal -- Rencana pemasangan tools audit/security otomatis (17 Agustus 2026, BELUM DIRISET MATANG)

**Konteks:** setelah cross-check audit ChatGPT ronde 3 (yang sebagian besar akurat, lihat verifikasi langsung via Supabase MCP hari ini), didiskusikan tools otomatis apa aja yang bisa nambah lapis proteksi/visibility ke depan. Sengaja dicatat sebagai rencana dulu sebelum eksekusi, karena daftarnya lumayan besar (11 item) dan bakal dikerjain bertahap lintas sesi -- BELUM ADA SATUPUN yang dipasang di bagian ini.

**Yang sudah dipakai (existing, bukan bagian rencana ini):** Supabase Security/Performance Advisor, GitHub CodeQL, Dependabot.

**Prinsip yang disepakati saat diskusi:** awalnya sempat dipertimbangkan skip beberapa tools dengan alasan "belum ada trafik/user asli, belum perlu" -- DIKOREKSI oleh Teja, konsisten dengan Rasa Grosir (Bagian 88/95/118): bedanya bukan "kecil vs besar", tapi "murah dipasang sekarang vs mahal kalau ditunda sampai kepepet". Analogi yang disepakati: pasang pipa ekstra pas bangun pondasi itu murah, bongkar tembok buat pasang pipa pas rumah udah jadi itu mahal.

**Daftar tools (11 item, bertahap sesuai tingkat effort):**

Tingkat 1 -- instant, gak perlu install (mulai dari sini):
[ ] npm audit -- cek kerentanan dependency, bawaan npm
[ ] gitleaks -- scan git history cari kredensial ke-commit gak sengaja (PENTING: repo public, beberapa kali pegang API key di terminal sepanjang sesi kerja)

Tingkat 2 -- install/config sekali, jalan otomatis terus:
[ ] Lynis -- general check-up konfigurasi VPS (SSH, firewall, permission)
[ ] testssl.sh -- cek konfigurasi HTTPS/SSL (validasi setup certbot Bagian 99-100)
[ ] eslint-plugin-security -- nempel ke ESLint (kalau belum ada, setup dulu), nandain pola kode beresiko pas nulis

Tingkat 3 -- butuh akun eksternal/integrasi:
[ ] UptimeRobot -- monitoring uptime + alert kalau server down (nutup gap Bagian 109 poin #3)
[ ] Sentry -- error tracking real-time dari production (worth dipasang sekarang walau trafik masih sepi, karena setup-nya murah, nunggu sampai ada trafik nyata baru pasang itu yang mahal)
[ ] Snyk -- SAST + dependency check lebih dalam dari Dependabot (BUKAN redundant -- Snyk punya reachability analysis, database kerentanan lebih luas, dan Snyk Code buat baca kode sendiri lintas-file, bukan cuma pattern-matching per baris kayak eslint-plugin-security)
[ ] Cloudflare (WAF gratis tier) -- nahan serangan real-time di depan VPS begitu backend kebuka ke publik, nyambung ke rencana domain custom tenant (Bagian 118)

Tingkat 4 -- paling berat, butuh waktu khusus:
[ ] Semgrep -- custom rule scanning, butuh belajar dulu
[ ] OWASP ZAP -- dynamic testing (simulasi serangan ke app yang lagi jalan), banyak false positive kalau gak dikonfigurasi hati-hati -- lebih aman dicoba SEKARANG ke tenant demo sebelum ada data tenant asli, daripada nanti pas udah ada data sungguhan

**Yang DIPUTUSKAN TIDAK dipasang:**
(tidak ada -- awalnya Snyk sempat dipertimbangkan redundant dengan Dependabot, tapi dikoreksi setelah dianalisis lebih dalam: keduanya overlap di dependency check, tapi Snyk Code dan reachability analysis itu kemampuan yang Dependabot tidak punya. Keputusan akhir: pasang semua 11 item, bertahap.)

**Status: RENCANA TERCATAT, EKSEKUSI BELUM DIMULAI.** Sesi berikutnya mulai dari Tingkat 1 (npm audit, sudah di ambang eksekusi saat sesi ini berakhir).

## 128. Kapasitas VPS saat ini -- temuan & rekomendasi (17 Agustus 2026, BELUM DIEKSEKUSI)

**Konteks:** dicek spek VPS aktual (free -h, nproc, df -h) di tengah diskusi kesiapan platform buat nampung banyak tenant.

**Temuan:** VPS Biznet Gio saat ini 1 CPU core, RAM ~957Mi (total), TIDAK ADA SWAP SAMA SEKALI (0B). Disk aman (55GB nganggur dari 58GB). Sekarang cukup buat testing/demo, tapi 2 titik nyata yang perlu diawasi:
1. 1 CPU core -- semua proses (server.js, Nginx, Redis, worker gap-monitor) gantian di 1 core, gak paralel beneran. Makin banyak staff/tenant aktif bersamaan, makin sering "antri".
2. Tanpa swap, begitu RAM abis, OS langsung matiin proses paling gede makan memory (biasanya Node.js) mendadak -- bukan melambat pelan-pelan. Berkat migrasi session ke Redis (Bagian 125), staff gak sampai logout paksa kalau ini kejadian dan PM2 auto-restart, tapi tetap ada downtime pas restart.

**Rekomendasi bertingkat (disepakati saat diskusi):**
[ ] Tingkat 1 -- pasang SWAP sekarang, gratis (pakai disk nganggur), gak ada alasan nunda
[ ] Tingkat 1 -- setel PM2 restart otomatis kalau Node.js lewat batas memory tertentu (proaktif, bukan nunggu OS maksa matiin)
[ ] Tingkat 2 -- upgrade RAM/CPU VPS -- TUNGGU sampai ada sinyal nyata kepenuhan (misal dari data Sentry/UptimeRobot, Bagian 127), bukan tebak-tebak. VPS Biznet Gio kemungkinan besar bisa dibayar domestik tanpa masalah (beda dari isu Claude Pro), jadi upgrade ini gampang dieksekusi kapan pun siap
[ ] Tingkat 3 (jauh) -- pisahin beban (worker terpisah dari server API, atau VPS kedua buat load balancing) -- sudah dimungkinkan berkat migrasi Redis (session/rate-limit gak nempel 1 proses), tapi belum perlu dipikirin sekarang

**Soal ganti VPS (didiskusikan, BELUM diputuskan):**
- Upgrade spek di Biznet Gio yang sama itu gampang (tinggal resize dari dashboard provider, gak perlu pindah data/konfigurasi apapun)
- Pindah ke provider LAIN itu beda cerita -- install ulang semua dari nol (Node/Nginx/Redis/PM2), setup ulang SSL, pindah DNS, DAN berpotensi balik ke masalah pembayaran domestik yang jadi alasan awal Biznet Gio dipilih (Bagian 1)
- Dicek Hostinger sebagai contoh: speknya kuat (server Indonesia tersedia, sampai 8 core/32GB), TAPI metode pembayarannya cuma kartu internasional (Visa/MasterCard/dll) + PayPal/crypto -- TIDAK terlihat ada opsi transfer bank domestik langsung kayak provider lokal (IDCloudHost dll). Resiko sama persis kayak kejadian Claude Pro (kartu GPN/BRI kemungkinan ditolak). BELUM dicoba langsung di checkout Hostinger buat mastiin.

**Status: TEMUAN TERCATAT, BELUM ADA EKSEKUSI.**

## 129. Ide Awal -- Skenario tenant bawa infrastruktur sendiri (domain/VPS) (17 Agustus 2026, BELUM DIRISET MATANG)

**Konteks:** didiskusikan gimana kalau tenant udah punya domain dan/atau VPS sendiri, mau pakai platform Benangrasa. Ada beberapa skenario beda, konsekuensi teknis & bisnisnya beda jauh.

**Skenario A -- tenant cuma punya domain, mau nunjuk ke server Benangrasa (PALING MASUK AKAL, sesuai arsitektur sekarang):**
VPS tenant TIDAK kepake sama sekali di skenario ini -- cuma domain mereka yang "nunjuk" ke IP VPS Benangrasa, mirip pola CDN/reverse-proxy. Ini udah sebagian direncanain di Bagian 118/124 (CORS custom domain), tapi 3 langkah belum dieksekusi:
[ ] Verifikasi kepemilikan domain (WAJIB sebelum aktivasi -- pola umum: suruh tenant pasang TXT record berisi kode unik, dicek dulu sebelum lanjut, biar gak bisa asal klaim domain orang lain)
[ ] Perluas tenantResolver supaya kenal domain custom -> tenant_id (sekarang cuma baca pola X.benangrasa.com)
[ ] Isi CUSTOM_TENANT_ORIGINS di CORS (struktur udah siap dari Bagian 124, tinggal diisi per tenant)
[ ] Jalanin certbot per domain tenant (manual sekarang, PERLU DIOTOMATISASI kalau tenant-nya banyak -- Let's Encrypt juga ada rate limit per domain per minggu, worth diperhatiin)
[ ] Tabel database baru: tenant_custom_domains (domain, tenant_id, status_verifikasi) -- MURAH dibangun sekarang walau belum dipakai, mahal kalau nambah belakangan pas data numpuk

**Skenario B -- tenant mau VPS sendiri TAPI kontrol tetap di Benangrasa (jalan tengah kalau tenant "maksa" mau VPS sendiri):**
Tenant beli/bayar VPS-nya (kepemilikan billing/fisik ada nama mereka), tapi Benangrasa yang install, pegang akses SSH/root, dan urus semua maintenance/update. Tenant gak pernah pegang akses langsung. Resiko bisnis (tenant kabur gak bayar tapi tetap jalan pakai kode) HILANG karena mereka gak pernah pegang "kunci". Biasanya cukup buat alasan compliance/branding tenant tanpa perlu lepas kendali penuh.

**Skenario C -- tenant maksa VPS + akses penuh (self-hosted beneran, root SSH mereka pegang):**
Ini LEPAS KENDALI TOTAL -- konsekuensi besar, BUKAN keputusan teknis lagi:
- Resiko bisnis: begitu tenant pegang kode+database, apa insentif mereka tetap bayar? Perlu model lisensi jelas (bayar untuk UPDATE & SUPPORT, bukan cuma akses)
- Perlu paket instalasi yang gampang dipasang ulang (kemungkinan Docker), bukan proses manual kayak sekarang
- Keamanan server jadi tanggung jawab tenant sepenuhnya -- semua hardening yang udah dibangun (UFW, Fail2Ban, dst) harus mereka ulang sendiri, gak ada jaminan mereka lakuin
- Kalau beneran kejadian: charge jauh lebih mahal (model lisensi + setup fee + kontrak support tahunan, bukan langganan biasa), WAJIB kontrak tertulis jelas, WAJIB konsultasi ke ahli hukum lisensi software (bukan keputusan teknis semata)

**Prinsip yang disepakati:** JANGAN bangun infrastruktur Skenario B/C dari sekarang tanpa ada klien nyata yang minta -- kemungkinan besar kebutuhan detailnya baru jelas pas ada klien beneran ngobrol. Skenario A (poin tenant_custom_domains) yang worth disiapin strukturnya sekarang karena murah dan nyambung ke rencana domain custom yang udah ada (Bagian 118/124, ide poin I archive bagian 53).

**Status: IDE TERCATAT, BELUM ADA EKSEKUSI SAMA SEKALI.**

## 130. Checklist kesiapan sebelum jual ke publik + temuan arsitektur pembayaran (17 Agustus 2026, BELUM DIRISET MATANG SEPENUHNYA -- 1 TEMUAN SUDAH DIVERIFIKASI)

**Konteks:** didiskusikan resiko-resiko non-teknis (legal, bisnis, operasional) yang perlu disiapin sebelum Benangrasa mulai dijual ke tenant nyata -- bukan cuma soal kode/infrastruktur. Bukan nasihat hukum resmi, cuma daftar area yang perlu ditindaklanjuti/dikonsultasikan.

**TEMUAN PENTING -- diverifikasi langsung ke Supabase + kode (Rasa Ketelitian), bukan asumsi:**

Resiko regulasi terbesar yang diidentifikasi: kalau uang customer LEWAT sistem/rekening yang dikontrol platform sebelum diterusin ke tenant (walau cuma numpang lewat), itu berpotensi masuk kategori Penyedia Jasa Pembayaran (PJP) yang diawasi Bank Indonesia -- butuh izin resmi. Kalau uang customer LANGSUNG ke rekening/gateway tenant sendiri (platform cuma nagih fee terpisah), itu di luar cakupan aturan itu.

Dicek struktur tabel live (payments: id, tenant_id, order_id, amount, currency, status, payment_method, timestamps -- terlihat seperti CATATAN/LOG status doang, tidak ada kolom escrow/platform_account; tenant_billing: id, tenant_id, billing_model, fee_amount, fee_percentage, currency, billing_status -- terlihat seperti tagihan platform-ke-tenant, terpisah dari uang customer). Dicek juga grep -i "midtrans\|xendit\|payment_gateway\|webhook.*payment\|stripe" server.js -> NOL hasil, belum ada integrasi payment gateway apapun di kode.

**Kesimpulan:** ini justru momen paling murah buat mengunci arsitektur yang aman, SEBELUM ada kode yang komit ke pola lain. Prinsip desain yang WAJIB dipegang saat nanti bangun fitur payment:
- Tenant daftar akun payment gateway (Midtrans/Xendit/dll) atas nama bisnis mereka sendiri, pakai kredensial mereka sendiri
- Uang customer masuk LANGSUNG ke akun tenant, TIDAK PERNAH lewat akun/kredensial platform
- Tabel payments di sistem Benangrasa cuma buat TRACKING/LAPORAN (baca status dari webhook tenant), BUKAN tempat uang ditampung
- tenant_billing (fee langganan) itu transaksi TERPISAH, platform-ke-tenant, beda dari alur customer-ke-tenant

**Resiko lain yang diidentifikasi (belum diverifikasi mendalam, sekadar daftar):**
1. UU Perlindungan Data Pribadi (PDP) -- platform udah nyimpen data sensitif (nomor telepon/alamat customer, data staff, checkpoint Bagian 6) -- begitu ada tenant nyata pakai data customer asli, kena kewajiban UU PDP termasuk lapor kalau ada kebocoran
2. Restore drill belum pernah dieksekusi (gap lama, Bagian 3/109) -- resiko makin nyata begitu ada tenant produksi yang gantungin operasional harian
3. Solo dev, belum ada kapasitas dukungan 24/7 -- server down di luar jam kerja jadi masalah bisnis tenant begitu ada yang gantungin operasional nyata
4. Repo GitHub masih public -- begitu mulai jual, kompetitor bisa ambil kode mentah-mentah
5. Kesiapan administrasi bisnis (rekening bisnis, invoice resmi, ambang batas PPh/PPN) -- belum dicek/disiapin

**Rencana bertingkat (disepakati prinsipnya, belum semua dieksekusi):**
[ ] Tingkat 1 (murah, sekarang): kunci prinsip arsitektur pembayaran di atas SEBELUM nulis kode payment gateway apapun
[ ] Tingkat 1 (murah, sekarang): eksekusi restore drill (Bagian 3/109, gap lama)
[ ] Tingkat 1 (murah, sekarang): draft awal Terms of Service + Privacy Policy (gak perlu pengacara buat draft awal, direview pengacara nanti pas mau jual beneran)
[ ] Tingkat 1 (murah, sekarang): catatan rencana insiden sederhana (urutan langkah kalau server down)
[ ] Tingkat 2 (perlu nanya org lain, tapi mulai sekarang): 1x konsultasi status PJP ke konsultan hukum fintech/baca panduan resmi OJK-BI, biar yakin posisi aman
[ ] Tingkat 2: cek ambang batas kewajiban lapor pajak (PPh/PPN)
[ ] Tingkat 3 (boleh nunggu): bikin badan usaha resmi (PT/CV) + rekening bisnis
[ ] Tingkat 3 (boleh nunggu): privatize repo penuh + kontrak lisensi detail (relevan terutama kalau Skenario C Bagian 129 kejadian)

**Status: CHECKLIST TERCATAT. 1 temuan (arsitektur pembayaran) SUDAH DIVERIFIKASI ke live data. Sisanya BELUM DIEKSEKUSI.**

## 131. Ide Awal — Business Continuity / Disaster Recovery Checklist untuk solo dev (17 Agustus 2026, BELUM DIRISET MATANG)

Konteks: diskusi soal risiko kalau Teja gak pegang HP/gak bisa dihubungi
seminggu (liburan/pindah/ke luar negeri), dan risiko kalau data/infrastruktur
hilang (hacker rusak data, Supabase/GitHub/VPS bangkrut). Belum satupun
dieksekusi, murni daftar hasil diskusi.

A. Ketahanan saat Teja gak bisa dihubungi (liburan/pindah/luar negeri):
[ ] Alerting otomatis (UptimeRobot dkk, sudah tercatat Bagian 127) kirim
    notif ke channel yang TETAP bisa diakses walau ganti negara/nomor HP
    (email > SMS)
[ ] Semua akun kritis (Biznet Gio, Supabase, GitHub, domain registrar)
    pindah dari 2FA berbasis SMS ke 2FA app (Authenticator) -- SMS OTP ke
    nomor Indonesia berisiko gak kebaca kalau roaming/ganti SIM di luar negeri
[ ] Runbook darurat 1 halaman: langkah 1-2-3 kalau server down, bisa
    dieksekusi orang lain (bukan cuma Teja) tanpa harus paham 130+ bagian
    checkpoint
[ ] Identifikasi 1 orang kedua yang dipercaya, punya akses darurat
    (SSH/kredensial minimal) buat kondisi Teja bener-bener gak bisa dihubungi
[ ] Cek firewall/security group VPS gak ada pembatasan geografis IP
    (kemungkinan aman berdasar catatan UFW default-deny + port 22 doang,
    tapi belum dicek ulang eksplisit)
[ ] Pertimbangkan tmux/screen di VPS biar proses gak keputus kalau koneksi
    SSH dari luar negeri gak stabil

B. Ketahanan data (hacker rusak/hapus, Supabase/GitHub/VPS bangkrut):
[ ] Backup off-site -- prinsip 3-2-1 (minimal 3 salinan, 2 media beda, 1
    lokasi terpisah dari VPS produksi). Backup pg_dump SEKARANG kemungkinan
    cuma ada di VPS itu sendiri -- kalau VPS/hacker kompromi server, backup
    ikut kena juga. PALING PRIORITAS dari semua poin di checklist ini.
[ ] Restore drill (gap lama Bagian 3/109/130) -- backup pg_dump format
    PostgreSQL standar, portable ke instance manapun, TAPI belum pernah
    benar-benar dites restore ke instance kosong
[ ] Cek plan Supabase apakah include PITR (Point-in-Time Recovery) sebagai
    lapis proteksi tambahan di luar pg_dump manual
[ ] Clone repo ke minimal 1 tempat lain (laptop pribadi Teja) -- gak cuma
    gantung di GitHub + VPS
[ ] Backup file konfigurasi VPS penting (nginx config, .env struktur tanpa
    isi rahasia, PM2 config, CHECKPOINT.md) -- sering keluput karena fokus
    cuma ke database
[ ] Dokumentasi proses provisioning VPS dari nol (checklist: install
    Node 20, clone repo, install PM2/nginx/Redis, restore .env, setup SSL,
    arahkan DNS) -- database sudah terpisah di Supabase jadi migrasi VPS
    "cuma" mindahin compute, bukan data
[ ] DNS TTL rendah -- bikin perpindahan ke IP VPS baru lebih cepat
    propagasi kalau kepepet
[ ] Simpan kredensial akun Biznet Gio di password manager -- biar kalau
    perlu buka tiket darurat/export data terakhir sebelum akun bener-bener
    ditutup, Teja masih bisa akses

Prinsip yang disepakati: risiko VPS/GitHub bangkrut relatif RINGAN karena
database sudah dipisah ke Supabase dan kode ada di 2+ tempat (VPS+GitHub).
Risiko PALING BERAT adalah backup cuma 1 salinan di 1 tempat (belum
memenuhi 3-2-1) DAN restore drill belum pernah dibuktikan berhasil.

Status: CHECKLIST TERCATAT, BELUM ADA EKSEKUSI SAMA SEKALI.

## 132. Ide Awal — Radar Teknologi: pemantauan berkala perkembangan AI/tools relevan (17 Agustus 2026, BELUM DIRISET MATANG)

Konteks: Teja mau gak ketinggalan perkembangan AI/tools terbaru yang bisa
diadopsi ke proyek (coding agent baru, model lebih murah, tools security,
dst), tanpa harus habisin waktu riset manual sendiri di luar jam kerja
proyek.

MEKANISME GANDA yang disepakati (2 trigger, saling menjaga -- kalau salah
satu kelewat, yang lain jadi cadangan):

Trigger 1 -- Reminder kalender berulang tiap 2 minggu (Senin jam 9 pagi):
[x] Event sudah disimpan manual ke kalender Teja (17 Agustus 2026). Akses
    Calendar Claude di app masih belum diizinkan (jadi bukan native lewat
    tool Claude), tapi remindernya sudah AKTIF dan cukup buat tujuannya.

Trigger 2 -- Cek otomatis tiap kali CHECKPOINT.md dibuka di sesi/room baru:
[ ] SETIAP sesi baru dimulai dan Teja kasih raw link CHECKPOINT.md ke
    Claude (termasuk saat pindah akun gara-gara limit habis) -- Claude
    WAJIB cek tanggal "Radar Teknologi" terakhir tercatat di checkpoint.
    Kalau sudah >= 2 minggu sejak itu (atau belum pernah ada sama sekali),
    Claude TAWARIN ke Teja di awal sesi: "udah 2 minggu+ sejak radar
    teknologi terakhir, mau di-scan sekarang?" -- bukan otomatis langsung
    jalanin tanpa tanya (biar gak ganggu kalau Teja lagi buru-buru mau
    lanjut kerjaan teknis).
[ ] Ini jadi cadangan kalau Trigger 1 (reminder kalender) kelewat/gak
    kebuka HP-nya -- karena pola pemakaian Teja pindah akun cukup sering
    (tiap kena limit), trigger ini kemungkinan lebih sering "nangkep" momen
    yang tepat dibanding reminder 2 mingguan doang.

Alur tiap kali radar dijalankan (baik dari Trigger 1 maupun 2):
[ ] Claude web search perkembangan AI/tools terkini
[ ] Disaring bareng Teja: worth diadopsi ke Benangrasa vs sekadar dicatat
    buat referensi
[ ] Kalau ada yang worth diadopsi -- dicatat sebagai section baru bernomor
    di CHECKPOINT.md (ikut pola "CARA MENCATAT IDE BARU" yang sudah ada)
[ ] SETIAP radar dijalankan (walau hasilnya "gak ada yang relevan") --
    tanggal & ringkasan singkat dicatat sebagai 1 baris di bagian ini
    (bukan section baru tiap kali), biar Trigger 2 di sesi berikutnya bisa
    ngecek tanggal terakhir dengan akurat.

Log radar (diisi tiap kali dijalankan, baris baru di bawah -- BUKAN
overwrite):
- [belum pernah dijalankan]

Status: MEKANISME DISEPAKATI, AKTIF SEBAGIAN (Trigger 1 aktif via kalender
manual, Trigger 2 baru jadi ATURAN tertulis mulai sekarang -- perlu
dibuktikan jalan konsisten di sesi-sesi berikutnya).

## 133. Ide Awal — Pelengkap tools security (Tingkat 1.5, tambahan ke Bagian 127) (17 Agustus 2026, BELUM DIRISET MATANG)

Konteks: lanjutan diskusi Bagian 127 (11 tools) -- Teja tegas target "tahan
virus, tahan hacker, tahan error, tahan gap, tahan banting apapun". Prinsip
disepakati: tidak ada sistem 100% aman (konsisten Bagian 6) -- target
realistis adalah naikin biaya serangan, percepat deteksi, kecilkan blast
radius, percepat recovery -- BUKAN "gak akan pernah kejadian apa-apa".

Tambahan tools per kategori (belum ada di 11 daftar Bagian 127):

A. Deteksi malware/intrusion level VPS (paling relevan -- proyek nerima
   upload foto staff, production_stage_photos & discrepancy_thread_photos):
[ ] ClamAV -- scan file upload sebelum disimpan (paling langsung jawab
    kekhawatiran "virus" di jalur upload)
[ ] rkhunter / chkrootkit -- deteksi rootkit di VPS
[ ] AIDE -- checksum snapshot file sistem, alert kalau ada perubahan
    diam-diam (deteksi intrusion, beda dari ClamAV yang scan file upload)
[ ] auditd -- log kernel-level siapa akses/ubah file apa (forensik kalau
    ada insiden)

B. Patch & supply-chain:
[ ] unattended-upgrades -- auto-patch keamanan OS Ubuntu, paling murah
    dieksekusi (banyak breach dari celah lama yang patch-nya sudah ada
    tapi belum di-apply, bukan zero-day)
[ ] Socket.dev / npm-audit-resolver -- deteksi supply-chain attack di
    dependency npm (kode jahat disusupin ke package), lebih agresif dari
    Dependabot yang sudah ada

C. Header & validasi HTTP (belum kecatat sama sekali):
[ ] helmet.js -- header keamanan Express standar, murah (beberapa baris
    kode), cegah clickjacking/MIME-sniffing
[ ] CSP (Content Security Policy) -- relevan begitu ada frontend, cegah XSS
[ ] HSTS -- paksa HTTPS, cegah downgrade ke HTTP

D. Validasi input terstruktur:
[ ] zod atau joi -- validasi skema input konsisten di semua endpoint
    (nyambung ke item lama checklist keamanan Bagian 6 "validasi input
    lebih ketat" yang belum ditutup)

E. Deteksi & respons insiden:
[ ] Log terpusat di luar server (Logtail/Papertrail dkk) -- kalau hacker
    masuk, mereka biasa hapus log lokal untuk nutup jejak; log yang sudah
    "kabur" ke luar server tidak bisa mereka hapus
[ ] Honeypot sederhana -- endpoint palsu yang tidak pernah dipanggil
    aplikasi normal, akses ke situ = jelas serangan/scan, ban otomatis

F. Resiliensi (bukan cuma proteksi dari serangan eksternal, juga dari bug
   sendiri):
[ ] Staging environment terpisah dari produksi -- SEKARANG semua testing
    kelihatan langsung ke server produksi (dari pola testing di checkpoint
    ini) -- risiko besar, bug saat testing bisa langsung kena data nyata
[ ] Feature flag / kemampuan matikan fitur cepat tanpa rollback penuh
[ ] Database connection pooling limit -- cegah 1 bug menghabiskan semua
    koneksi (connection exhaustion)
[ ] Circuit breaker pattern -- kalau 1 komponen (misal Redis) down, sistem
    lain tetap jalan sebisa mungkin, tidak ikut collapse semua

G. Level bisnis (bukan teknis, relevan untuk "tahan banting" total):
[ ] Cyber insurance -- begitu proyek jalan komersial, jaring pengaman
    finansial terakhir kalau kejadian terburuk beneran terjadi

EFEK SAMPING yang harus diwaspadai kalau semua dipasang sekaligus (jangan
asal pasang semua tanpa pertimbangan ini):
- Alert fatigue -- makin banyak scanner (OWASP ZAP, eslint-security, dst),
  makin banyak false positive, risiko mulai skip alert kalau tidak dikelola
- Overhead performa -- VPS sekarang 1 core, RAM ~1GB (Bagian 128), jalanin
  ClamAV+auditd+AIDE dkk bersamaan bisa berasa beratnya, perlu diuji
  dampak resource satu-satu sebelum full pasang semua
- Maintenance jadi beban sendiri -- solo dev + belasan tools security =
  makin banyak yang perlu dipantau/di-update rutin; tools yang tidak
  di-update malah kasih rasa aman palsu

Status: DAFTAR TERCATAT, BELUM ADA EKSEKUSI. Digabung prioritasnya dengan
11 tools Bagian 127 di sesi eksekusi berikutnya -- perlu disortir ulang
bareng Teja mana yang paling depan (kemungkinan besar: unattended-upgrades
dan ClamAV paling murah & langsung relevan ke upload foto yang sudah aktif
dipakai).

## 134. Ide Awal — Pelengkap Business Continuity/DR: kecepatan pemulihan (tambahan ke Bagian 131) (17 Agustus 2026, BELUM DIRISET MATANG)

Konteks: lanjutan diskusi Bagian 131 -- fokus khusus ke "apa yang bikin
pemulihan CEPAT vs LAMBAT", bukan cuma "ada backup atau tidak".

Faktor yang paling menentukan kecepatan pemulihan (urutan dampak, dari
yang paling berpengaruh):
[ ] Restore drill sudah PERNAH dibuktikan jalan sebelumnya -- faktor #1;
    restore pertama kali dicoba pas insiden beneran pasti lambat (coba-coba,
    panik), restore yang sudah pernah dites tinggal eksekusi runbook
[ ] Runbook tertulis (bukan di kepala Teja saja) -- sudah tercatat Bagian
    131, dipertegas lagi karena paling menentukan kalau Teja tidak
    available (nyambung ke skenario liburan/luar negeri)
[ ] Kecepatan DETEKSI, bukan cuma kecepatan fix -- UptimeRobot/Sentry
    (Bagian 127) menentukan gap antara kejadian dan Teja sadar ada masalah;
    kalau baru sadar dari komplain tenant, itu waktu yang hilang percuma
    sebelum pemulihan bahkan mulai
[ ] Database sudah terpisah dari compute (SUDAH BAGUS, arsitektur existing)
    -- Supabase terpisah dari VPS, kalau VPS rusak data tetap selamat,
    cuma perlu bangun ulang server
[ ] Provisioning VPS dari nol yang sudah terdokumentasi (sudah tercatat
    Bagian 131) -- dipertegas: kalau cuma dokumentasi manual step-by-step,
    manusia tetap harus eksekusi tiap baris; kalau script otomatis, lebih
    cepat lagi (lihat poin Infrastructure as Code di bawah)

Tambahan yang mempercepat lebih jauh (belum kecatat sebelumnya):
[ ] Infrastructure as Code -- 1 script bash/Docker yang otomatis setup
    semua dari nol (install dependency, clone repo, restore .env, start
    service), beda level dari sekadar dokumentasi manual
[ ] VPS snapshot berkala -- cek apakah Biznet Gio nyediain fitur snapshot
    server utuh (bukan cuma backup database); kalau ada snapshot fresh,
    restore tinggal "nyalain snapshot itu", jauh lebih cepat dari install
    ulang dari nol
[ ] Standby/warm backup server -- level paling advance, BELUM PERLU
    sekarang (VPS masih kecil), baru relevan kalau sudah ada tenant nyata
    yang gantung ke uptime tinggi
[ ] Rollback cepat untuk masalah dari deploy sendiri (bukan serangan) --
    git revert cepat/feature flag; realistisnya lebih SERING kepakai
    daripada skenario hacker/bencana, karena banyak "insiden" itu bug dari
    kode baru sendiri

Proteksi terhadap BACKUP itu sendiri (baru, belum kecatat -- penting
karena pola serangan ransomware klasik: rusak data produksi + backup
sekaligus):
[ ] Immutable/write-once backup -- backup yang tidak bisa dihapus/diubah
    selama periode tertentu, menutup celah kalau akun penyimpan backup
    ikut dikompromikan
[ ] Backup terenkripsi -- data sensitif (nomor telepon/alamat customer,
    Bagian 6) yang ada di backup sama bahayanya kalau bocor dengan
    database live bocor
[ ] Checksum/verifikasi otomatis tiap backup selesai -- bukan cuma restore
    drill sesekali, tapi tiap backup harian otomatis dicek utuh/tidak
    korup, biar ketahuan cepat kalau ada backup gagal diam-diam

Target waktu eksplisit (konsep standar DR, belum pernah didefinisikan
untuk Benangrasa):
[ ] Tentukan RTO (Recovery Time Objective) -- berapa lama maksimal boleh
    down sebelum dianggap gawat
[ ] Tentukan RPO (Recovery Point Objective) -- berapa banyak data maksimal
    boleh hilang; backup harian saat ini berarti RPO ~24 jam (insiden jam
    11 malam = data sejak jam 00:00 berpotensi hilang) -- perlu diputuskan
    apakah ini cukup atau perlu backup lebih sering

Proses (bukan tools):
[ ] Post-mortem tertulis tiap ada insiden produksi -- apa yang terjadi,
    kenapa bisa terjadi, apa yang dilakukan biar tidak terulang (checkpoint
    ini sudah punya insting ke arah ini lewat pola "SERAH-TERIMA" dan
    catatan kendala teknis di tiap bagian, tinggal diformalkan khusus
    untuk insiden produksi)
[ ] Rencana komunikasi ke tenant saat insiden -- status page sederhana
    atau minimal WA blast manual; diam saat insiden yang bikin tenant
    panik/tidak percaya, bukan durasi downtime itu sendiri

Level lanjutan (dicatat untuk masa depan, BELUM relevan sekarang):
[ ] Read replica database -- fallback baca data kalau instance utama
    Supabase bermasalah, relevan kalau trafik sudah naik
[ ] Blue-green / canary deployment -- deploy ke sebagian kecil trafik
    dulu, deteksi masalah SEBELUM full-rollout (lebih maju dari sekadar
    rollback cepat setelah masalah kejadian)

Status: DAFTAR TERCATAT, BELUM ADA EKSEKUSI. Prioritas tereksekusi
tersarankan (urutan dari Bagian 130 diskusi): restore drill dulu (buktikan
backup bisa dipulihkan) -> runbook tertulis -> alerting cepat -> VPS
snapshot kalau provider menyediakan -> baru mikirin standby server (nanti
kalau sudah ada tenant nyata).

## 135. Ide Awal — Pelengkap terakhir: pentest berkala + dependency pinning (tambahan ke Bagian 133) (17 Agustus 2026, BELUM DIRISET MATANG)

Konteks: 2 poin susulan yang tadinya dianggap "diminishing returns" tapi
tetap diminta dicatat oleh Teja -- prinsip: lebih baik tercatat dan belum
dieksekusi, daripada terlupa karena tidak ditulis.

[ ] Jadwal pentest berkala -- bukan cuma OWASP ZAP sekali jalan (Bagian
    127), tapi disiplin diulang tiap beberapa bulan ATAU setiap ada fitur
    besar baru yang dirilis (bukan jadwal kalender kaku semata)
[ ] Dependency pinning / lockfile audit -- pastikan package-lock.json
    dikunci ke versi persis (bukan range "^"), supaya `npm install` tidak
    diam-diam menarik versi baru yang belum divalidasi -- relevan langsung
    ke gap Socket.dev/supply-chain attack yang sudah dicatat Bagian 133

Status: DAFTAR TERCATAT, BELUM ADA EKSEKUSI.

## 136. Eksekusi Tingkat 1 Bagian 127: npm audit + gitleaks -- SELESAI & TERUJI (19 Agustus 2026)

**Rasa yang dipenuhi:** Rasa Ketelitian (setelah 2 hari beruntun cuma
ngumpulin ide/rencana tanpa eksekusi -- Bagian 127-135 -- sesi ini sengaja
berhenti nulis ide baru dan ambil 1 item paling murah dari backlog sampai
tuntas dicoba, bukan didiskusikan lagi).

**Konteks:** item Tingkat 1 dari daftar 11 tools security Bagian 127
(instant, gak perlu install berat) -- dieksekusi langsung, bukan sekadar
direncanakan.

**Hasil:**
- `npm audit` di ~/fashion-platform -> 0 vulnerabilities.
- gitleaks v8.30.1 (binary langsung dari GitHub releases, bukan lewat
  package manager) -> `gitleaks git .` scan 185 commit, ~1.27 MB -> 0 leaks
  found. Menjawab langsung kekhawatiran Bagian 127 soal API key yang
  beberapa kali dipegang di terminal sepanjang sesi kerja -- terbukti
  tidak ada yang ke-commit ke git history.

**Kendala teknis kecil:** URL `releases/latest/download/gitleaks_8.21.2_...`
404 karena nomor versi di URL manual sudah basi (redirect ke v8.30.1 tapi
nama file tetap pakai versi lama) -- diperbaiki dengan cek nama asset yang
benar dulu (`gitleaks_8.30.1_linux_x64.tar.gz`) sebelum retry.

**File sementara sudah dibersihkan** (gitleaks.tar.gz, gitleaks-report.json)
setelah dikonfirmasi hasilnya. Binary `~/gitleaks` dibiarkan terpasang di
VPS untuk dipakai ulang nanti (Bagian 135: rencana pentest berkala).

**Status: 2 dari 2 item Tingkat 1 Bagian 127 SELESAI & TERUJI, 0 temuan
di keduanya.** Dicoret dari daftar Tingkat 1 -- lanjut ke Tingkat 2
(unattended-upgrades, eslint-plugin-security, Lynis, testssl.sh) atau item
lain sesuai prioritas Teja di sesi berikutnya.

**Next steps aktif tetap seperti Bagian 126 (belum tersentuh):**
[ ] Polish pass 13 titik pesan "internal error" generic
[ ] P0-6 -- schema/migration reproducibility
[ ] PIN progressive lockout
[ ] Test suite CI gate
[ ] #16/#17 Bagian 119 -- audit trail admin & monitoring

## 137. Eksekusi lanjutan: SWAP, PM2 memory limit, unattended-upgrades auto-reboot -- SELESAI & TERUJI (19 Agustus 2026)

**Konteks:** melanjutkan Bagian 136 di sesi yang sama.

### 3. SWAP 2GB -- SELESAI & TERUJI
Dibuat swapfile 2GB (rule 2x RAM, RAM aktual ~957Mi): fallocate + chmod 600 + mkswap + swapon + tambah ke /etc/fstab. Testing: swapoff+swapon -a (simulasi baca fstab) -> swap 2.0Gi balik aktif tanpa reboot beneran. LULUS.

### 4. PM2 max_memory_restart 500M -- SELESAI & TERUJI
Dibuat ecosystem.config.js (baru, commit ke repo). max_memory_restart 500M dipilih karena heap usage aktual cuma ~19MB (25x headroom). pm2 delete + start ecosystem.config.js + save. Testing: pm2 show konfirmasi 524288000 bytes, curl localhost:3000 -> 404 (hidup normal). Commit 97f8c0a.

### 5. unattended-upgrades auto-reboot -- SELESAI & TERUJI
Ditemukan sudah aktif dari default Ubuntu 22.04 (bukan setup manual), log konfirmasi auto-patch jalan nyata. Yang belum aktif: Automatic-Reboot. Verifikasi dulu: timezone WIB (aman jam 02:00 bukan jam kerja), redis-server enabled (auto-start abis reboot), tidak ada reboot pending sekarang. Diaktifkan: Automatic-Reboot true, waktu 02:00. Testing: dry-run --debug config valid.

**Next: lanjut Bagian 138 untuk temuan Lynis (Redis/SSL/SSH hardening).**

## 138. Lynis audit + hardening Redis, SSL/TLS nginx, SSH -- SELESAI & TERUJI (19 Agustus 2026)

**Rasa yang dipenuhi:** Rasa Ketelitian (setelah 2 hari Bagian 127-135 cuma ngumpulin ide tanpa eksekusi, sesi ini disiplin tuntasin item demi item sampai dites & commit) dan Rasa Keamanan (3 celah nyata ditutup: Redis tanpa password, TLS lemah, SSH tanpa batas percobaan).

lynis v3.0.7 diinstall, sudo lynis audit system dijalankan. Hasil: Hardening index 65/100, 0 warnings, 54 suggestions. 3 dipilih untuk dieksekusi sekarang (relevan langsung ke stack aktif), 51 sisanya ditunda dengan alasan konkret per kategori (butuh reformat disk, resiko kekunci akses, overhead VPS 1 core/1GB) -- bukan ditunda tanpa alasan.

### Redis requirepass + rename-command CONFIG
Password digenerate (openssl rand -base64 32), disimpan REDIS_PASSWORD di .env (gitignored, permission 600). redis.conf baris 790 diisi requirepass. sessionStore.js dan rateLimiter.js ditambah password: process.env.REDIS_PASSWORD (commit f9a9680).

Urutan restart WAJIB: (1) pm2 restart --update-env DULU (load password ke kode selagi Redis belum requirepass), BARU (2) systemctl restart redis-server. Kalau kebalik, staff logout paksa massal.

rename-command CONFIG juga ditambahkan (openssl rand -hex 16 buat nama baru), baris baru ditambah di redis.conf baris 807 (tidak menimpa contoh asli).

Testing semua LULUS: login staff sebelum restart Redis berhasil (kode baru jalan) -> redis-cli GET konfirmasi data tersimpan -> restart Redis -> ping tanpa auth -> NOAUTH -> login lagi setelah restart -> berhasil (PM2 reconnect pakai password benar) -> CONFIG GET dengan auth benar -> unknown command (rename berhasil).

Kendala kecil: test login pakai field subdomain di body salah, tenant resolve lewat Host header. Format benar: curl -H "Host: demo.fashion-platform.local" -H "x-api-key: <dari .env>" -d staff_id+pin ke /v1/staff/login.

### SSL/TLS nginx hardening
nginx.conf baris 32: ssl_protocols TLSv1 TLSv1.1 TLSv1.2 TLSv1.3 diganti jadi cuma TLSv1.2 TLSv1.3 (TLSv1/1.1 deprecated sejak 2020). Ditambah ssl_ciphers eksplisit modern. Testing: nginx -t OK, reload (bukan restart), curl https biasa -> 404 normal, curl --tlsv1.1 --tls-max 1.1 -> 000 (ditolak, terbukti).

### SSH hardening
sshd_config 4 baris diubah: MaxAuthTries 6->3, AllowAgentForwarding yes->no, X11Forwarding yes->no, Compression delayed->no. SENGAJA TIDAK ganti port SSH default -- resiko kekunci akses, manfaat cuma obscurity, Fail2Ban sudah lebih substantif. Testing: sshd -t OK, reload ssh, koneksi terminal tetap hidup.

**Status akhir sesi: 7 dari 7 item Tingkat 1/2 (Bagian 136+137+138) dieksekusi TUNTAS, bukan cuma direncanakan. Semua di-test dengan bukti konkret, commit terpisah (97f8c0a, f9a9680).**

**Pelajaran penting:** pola 2 hari Bagian 127-135 murni ngumpulin ide tanpa eksekusi, dikoreksi eksplisit oleh Teja di tengah sesi ini. Perbaikan bukan "kerjain semua 54 saran Lynis sekaligus", tapi triase jujur: yang murah+relevan dieksekusi sekarang, sisanya ditunda dengan alasan konkret.

**Next steps aktif (belum berubah dari Bagian 126, 3 item Lynis dicoret dari 51 sisa Bagian 127/133):**
[ ] Polish pass 13 titik pesan "internal error" generic
[ ] P0-6 -- schema/migration reproducibility
[ ] PIN progressive lockout
[ ] Test suite CI gate
[ ] #16/#17 Bagian 119 -- audit trail admin & monitoring
[ ] 51 saran Lynis sisanya (Tingkat 2+ Bagian 127/133) -- menyusul, bukan mendesak
