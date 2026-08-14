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
