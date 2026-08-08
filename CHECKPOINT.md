CHECKPOINT — Fashion Platform (Multi-Tenant SaaS)
Update terakhir: 8 Agustus 2026 (file di-split jadi ringkas + arsip)

Cara pakai:
- File ini isinya STATUS TERKINI + NEXT STEPS AKTIF saja. Histori lengkap tiap keputusan/debug/kronologi ada di CHECKPOINT_ARCHIVE.md (satu repo yang sama), rujuk nomor bagian di situ kalau butuh detail (root cause bug, command persis, alasan desain).
- Tiap sesi baru: kasih raw link CHECKPOINT.md ini (format commit SHA, lihat bagian "Kolaborasi & Cache" di bawah) ke Claude sebelum minta lanjut kerja.
- Kalau butuh histori detail suatu topik, kasih juga raw link CHECKPOINT_ARCHIVE.md dengan SHA yang sama.
- CHECKPOINT_ARCHIVE.md TIDAK PERNAH diedit lagi setelah split ini (8 Agustus 2026) — cuma dibaca sebagai referensi historis. Semua update selanjutnya HANYA masuk ke CHECKPOINT.md (file ini). Kalau file ini nanti membengkak lagi, lakukan split baru (arsipkan versi lama, mulai ringkas lagi) — bukan idealnya sering-sering, tapi opsi ini tersedia.

===================================================================
1. ARAH PROYEK (ringkas — detail penuh di archive bagian 1-13)
===================================================================
- Platform multi-tenant SaaS fashion: brand owner, vendor konveksi, custom tailor, pabrik. 1 backend + 1 database untuk semua tenant, isolasi via tenant_id + RLS (wajib, bukan opsional).
- Uang customer masuk langsung ke tenant, platform dapat fee (tenant_billing).
- Frontend beda per tipe tenant (componentized blocks), backend/produksi/inventory sama untuk semua.
- Basis backend: kode LTOS lama (Termux, single-tenant) digeneralisasi jadi multi-tenant. LTOS sendiri sudah dihentikan operasionalnya, murni jadi basis kode.
- Constraint pembayaran: tidak ada kartu kredit/debit internasional (cuma BRI/GPN domestik + SeaBank virtual) — ini kenapa VPS Biznet Gio + Supabase dipilih (terima transfer domestik), dan kenapa Claude Code masih tertunda (lihat bagian 3 di bawah). Detail lengkap di archive bagian 10.

===================================================================
2. IDENTIFIER KUNCI
===================================================================
- Repo GitHub: teja1945/fashion-platform (public)
- VPS: Biznet Gio, Jakarta, user Rakyat, IP 103.58.101.155, Ubuntu 22.04.5 LTS
- Supabase project (aktif): kwhybffbcqopqbbnuigg — https://kwhybffbcqopqbbnuigg.supabase.co
- Supabase project lama (LTOS, di-pause): dyqnjfaylhzumfahmmht — JANGAN dihapus, ada data historis, RLS sudah aman
- Demo tenant ID: 8ae20661-626d-42c9-b930-6c926ca3ce99
- Demo production job (testing): 25352257-4cff-4377-85d7-2a63b05146fe (current_stage: packing)
- Staff test: Admin Demo (id 35afaab6-8095-4763-9029-ba22aaa23607, PIN 1234), Staff Packing Demo (id 5ee69701-fdc5-4a37-8453-4e3de0d51fd0, PIN 1234, assigned_stage packing)
- Vercel: project fashion-platform terhubung ke repo, auto-deploy dari main, URL https://fashion-platform-six.vercel.app (masih 404, belum ada kode frontend)

===================================================================
3. STATUS INFRASTRUKTUR — SEMUA HARDENING TUNTAS ✅ (per 8 Agustus 2026)
===================================================================
[x] SSH: cuma via key, password login mati total. Key lama/corrupt sudah dibersihkan (cuma 1 key ed25519 valid tersisa di authorized_keys)
[x] UFW aktif: default deny incoming, cuma port 22 (OpenSSH) terbuka. Port 3000 (server.js) SENGAJA tidak dibuka ke publik — belum ada frontend live
[x] Fail2Ban aktif: jail sshd, maxretry 5, bantime 3600
[x] User Rakyat non-root dengan sudo access benar
[x] Backup pg_dump otomatis: cron harian jam 3 pagi (~/backup-db.sh), retensi 14 hari, hasil di ~/backups/ (TIDAK di-commit ke git)
[x] pm2 + systemd: server.js jalan sebagai service pm2-Rakyat, auto-restart setelah reboot (tervalidasi lewat reboot beneran)
[x] Node.js 20 LTS terinstall di VPS
[x] VPS sudah pernah di-reboot resmi (kernel + pm2 systemd tervalidasi jalan)

Belum ada (prioritas berikutnya, lihat bagian 6):
[ ] HTTPS/SSL — backend masih HTTP polos, WAJIB sebelum expose ke publik/domain live
[ ] Rate limiting API level umum (bukan cuma endpoint PIN)

Detail kronologi/debug tiap item: archive bagian 11, 14, 43-46.

===================================================================
4. STATUS BACKEND — SEMUA ENDPOINT INTI SUDAH DITES ✅ (per 8 Agustus 2026)
===================================================================
- Schema v2: 19+ tabel dasar + tambahan (pending_events, stale_event_log, gap_audit_log, request_dedup) — semua dengan RLS aktif. Role app_user (non-superuser, no bypass RLS) lengkap dengan grant yang benar.
- Struktur kolom akurat HANYA bisa diverifikasi via `\d nama_tabel` langsung ke DB — file schema di repo (db/fashion_platform_schema_v2.sql) TIDAK merepresentasikan skema live sepenuhnya (ketinggalan kolom-kolom yang ditambah belakangan). Kalau butuh struktur tabel pasti, selalu cek langsung ke database.
- Tenant resolver middleware (subdomain → tenant_id) — jalan, RLS isolasi terverifikasi.
- server.js (versi baru, pakai tenantResolver + withTenant() di semua endpoint bisnis) — di-deploy via pm2, SEMUA endpoint sudah dites & lolos: staff login, lock acquire/release/force-unlock, staff revoke/offboard, orders, photos (upload ke Supabase Storage bucket stage-photos).
- Event-sourcing pipeline (versioning.js, stateLayer.js, ingestion.js) — sudah diadaptasi ke schema v2 dan tenant_id-aware. Testing end-to-end pertama (order.confirmed_for_production → stage_changed → qc.passed → shipment.dispatched) SUKSES.
- worker.js (gap monitor) — jalan, diadaptasi ke production_events. Bundle-split reconciler BELUM diadaptasi (nunggu desain BUNDLE_ALLOCATION, lihat bagian 5).
- Header/auth yang terverifikasi kerja: `x-api-key` (API_KEY di .env), `x-staff-token` (session staff).
- MCP terhubung: Supabase & Vercel aktif dari chat Claude. GitHub connector baru kedeteksi di versi Chrome/web, belum di mobile app.
- VPS punya akses push ke GitHub via Personal Access Token (expired ~awal November 2026 — INGAT perpanjang).

Bug-bug kritis yang sudah ditemukan & diperbaiki (detail lengkap di archive, jangan diulang):
- orders.production_job_id tidak pernah di-update (archive bagian 35)
- sequence_version string-concatenation karena bigint-as-string di node-postgres (archive bagian 36) — CATATAN: field bigint lain yang dibaca lewat pg berpotensi kena bug sama, belum diaudit menyeluruh
- app_user tidak punya GRANT USAGE ke schema extensions, bikin pgcrypto gagal (archive bagian 39)

===================================================================
5. NEXT STEPS AKTIF (backend inti — prioritas utama)
===================================================================
[x] Verifikasi backup pertama otomatis lewat cron — SELESAI 9 Agustus 2026, file 20260809_030001.sql.gz tervalidasi (timestamp sesuai jadwal, gzip tidak corrupt)
[x] Verifikasi channel NOTIFY order_state_changed end-to-end — SELESAI 8 Agustus 2026, detail di bagian 54
[x] Fix bug kebocoran tenant di WebSocket broadcast — SELESAI 8 Agustus 2026, detail di bagian 54
[ ] Desain child bundle (BUNDLE_ALLOCATION) — masih blocker lama, ingestion.js return HTTP 501 untuk event ini
[x] Function/procedure spec-lock (atomik: reserve inventory + ledger) -- SELESAI 9 Agustus 2026, detail bagian 56
[ ] Redesain resolveStageTransition/QC handling dengan validasi quantity 2 pihak (staff jahit submit pending → QC konfirmasi jumlah aktual → discrepancy dicatat dengan jejak) — lihat bagian 7 poin C
[x] Audit field bigint lain yang dibaca lewat pg -- SELESAI 9 Agustus 2026, tidak ada bug tambahan ditemukan (detail bagian 55)
[ ] HTTPS/SSL sebelum backend expose ke publik/domain live

===================================================================
6. CHECKLIST KEAMANAN — HIDUP, DIREVIEW TIAP ADA FITUR BARU
===================================================================
Prinsip: tidak ada sistem 100% aman, target realistis = minimalkan risiko + tahan serangan umum + cepat tahu kalau ada yang aneh.

Sudah ada (fondasi bagus): RLS semua tabel, parameterized queries, PIN di-hash pgcrypto, UFW+Fail2Ban, SSH key-only, rate limiting brute-force PIN, pesan error login tidak bocorkan validitas staff_id, backup rutin.

Belum ada (perlu direview ke depan):
[ ] Rate limiting API level umum
[ ] HTTPS/SSL (prioritas paling dekat)
[ ] Validasi input lebih ketat di semua endpoint
[ ] Audit log lengkap ke DB (bukan cuma console.error)
[ ] Monitoring/alerting otomatis (login gagal beruntun, pola akses aneh)
[ ] Enkripsi data sensitif tambahan (nomor telepon/alamat customer)
[ ] Rate limiter & session in-memory masih single-instance — perlu Redis kalau nanti multi-instance
[ ] API_KEY tunggal untuk semua endpoint — pertimbangkan granular per tenant

Prinsip wajib untuk fitur self-service baru (bagian 7): selalu tanya "kalau disalahgunakan, dampaknya sejauh mana?" — dan tenant/staff TIDAK PERNAH dikasih akses ke infrastruktur/kredensial Teja dalam bentuk apapun.

===================================================================
7. IDE-IDE BELUM DIRISET MATANG (belum keputusan final, jangan mulai coding sebelum backend inti selesai)
===================================================================
Daftar ringkas — detail lengkap tiap ide ada di archive pada nomor bagian yang disebut:

A. Visual configurator tenant konveksi (pilih komponen model, preview visual + harga real-time per komponen) — archive bagian 25
B. QR code dual-jalur: customer (lihat status order) vs produksi (update stage) — archive bagian 26
C. Verifikasi 2 pihak staff jahit vs QC (quantity validation) + notifikasi WA ke QC saat submit — archive bagian 34, 48(update)
D. Tenant theme settings (warna/font/logo per tenant) + Pattern library & multi-format export (PDF tiling/plotter/DXF) untuk konveksi — archive bagian 47
E. Tenant kaos: sablon 3D + upload gambar sendiri — archive bagian 48
F. Sistem upah staff jahit (borongan per pcs, otomatis dari setoran lolos QC, sesi diskusi khusus per kasus reject) — archive bagian 49
G. Fitur level platform: dashboard analytics owner, ruang komplain customer, sistem sewa modular per fitur (prabayar, auto-aktivasi/nonaktif), laporan keuangan tenant sendiri — archive bagian 50
H. Login email+password (approval owner, bukan verifikasi email) + kustomisasi dashboard personal per staff — archive bagian 51
I. 2FA login + subdomain custom pilihan tenant sendiri saat onboarding — archive bagian 53
J. Automation "AI mikir + AI eksekusi" untuk kerja rutin (proyek terpisah, Claude Code jadi opsi utama begitu billing beres) — archive bagian 28

===================================================================
8. TOOL DEVELOPMENT — STATUS
===================================================================
- Claude Code: ditunda (bukan ditolak), kebentur constraint pembayaran (bagian 1). Sudah dicoba langsung di VPS, sukses sampai step login, gagal di situ. Eksplorasi Google Play billing sebagai alternatif — status belum dieksekusi terakhir dicek.
- MCP (Supabase, Vercel): aktif dan dipakai rutin dari chat Claude.
- Detail percobaan lengkap: archive bagian 16, 28.

===================================================================
CARA MENCATAT IDE BARU — INSTRUKSI UNTUK SEMUA ROOM/SESI
===================================================================
Kalau Teja menyampaikan ide baru (fitur, desain, atau apapun yang belum final) di sesi manapun, room manapun WAJIB ikuti pola ini:

1. Tulis ide itu sebagai BAGIAN BARU BERNOMOR (nomor lanjut dari bagian terakhir di CHECKPOINT.md ini — cek dulu nomor bagian tertinggi di bagian 7, JANGAN tebak/asal nomor).
2. Judul bagian: "[NOMOR]. Ide Awal — [nama ide singkat] ([tanggal], BELUM DIRISET MATANG)"
3. Isi selengkap mungkin dari hasil diskusi (konteks, opsi yang dipertimbangkan, pertanyaan belum terjawab, next steps) — TIDAK perlu diringkas saat pertama dicatat, detail penuh itu penting.
4. Tulis draft-nya, tunjukkan ke Teja untuk direview (sesuai workflow satu-langkah-satu-waktu, bagian Kolaborasi di bawah).
5. Setelah disetujui, APPEND (bukan overwrite) ke CHECKPOINT.md via `cat >> CHECKPOINT.md << 'EOF' ... EOF` di VPS, verifikasi dengan `tail`, baru commit & push.
6. TAMBAHKAN JUGA satu baris ringkasan ide itu ke daftar "IDE-IDE BELUM DIRISET MATANG" (bagian 7) supaya tetap kelihatan di ringkasan tanpa perlu scroll ke bawah nyari bagian bernomornya.
7. JANGAN taruh ide baru ke CHECKPOINT_ARCHIVE.md — file itu sudah dibekukan permanen sejak 8 Agustus 2026, isinya tidak pernah ditambah lagi.
8. Kalau CHECKPOINT.md ini sendiri sudah mulai kepanjangan lagi (banyak bagian, mulai berisiko kepotong saat di-fetch) — usulkan split baru ke Teja (ikuti pola yang sama seperti split 8 Agustus 2026 ini), jangan diam-diam dibiarkan membengkak tanpa peringatan.

===================================================================
KOLABORASI & CACHE — WAJIB DIBACA TIAP SESI BARU
===================================================================
- Repo public, satu sumber kebenaran untuk semua room/sesi Claude. Commit langsung ke main (belum pakai branch, masih solo dev fase aktif).
- MASALAH CACHE raw.githubusercontent.com: TERBUKTI nyata, query string ?t= TIDAK CUKUP. WAJIB pakai commit SHA di path URL: https://raw.githubusercontent.com/teja1945/fashion-platform/COMMIT_SHA/CHECKPOINT.md — commit SHA didapat dari `git log -1 --oneline -- CHECKPOINT.md` di VPS.
- CATATAN BARU (8 Agustus 2026): raw fetch oleh Claude kadang KEPOTONG di file besar (bukan soal cache, tapi limitasi ukuran ekstraksi tool fetch Claude sendiri) — ini alasan utama kenapa file ini di-split jadi ringkas + archive. Kalau suatu saat Claude laporan konten kepotong lagi, cara paling reliable: jalankan `tail -c 20000 CHECKPOINT.md` (atau `awk '/^NOMOR_BAGIAN\./,0'`) di VPS, paste manual ke chat.
- Room paralel BISA menghasilkan kontradiksi kalau nulis bagian yang sama bersamaan tanpa disatukan. Kalau nemu info meragukan/kontradiktif, JANGAN percaya salah satu versi — verifikasi ke sumber asli (query database, cek file di server) sebelum lanjut kerja.
- SELALU `git pull` sebelum mulai edit/append file apapun yang bakal di-push (CHECKPOINT.md, kode, dll) — VPS sudah punya akses push (PAT), risiko tabrakan sedikit lebih tinggi sekarang.
- SELALU `git log --oneline -10` di awal sesi sebelum mulai menulis file yang berpotensi sudah dikerjakan room lain.
- Cara edit/append file di VPS: pakai `cat >> nama_file << 'EOF' ... EOF` untuk NAMBAH konten (bukan nano). `>>` = append, `>` = overwrite total (bahaya kalau salah pakai untuk nambah). Verifikasi dengan `tail -N nama_file` setelah append, sebelum commit & push.
- Cross-check ke ChatGPT: rekomendasikan proaktif kalau ada keputusan desain berisiko tinggi (arsitektur data, security, race condition, konsistensi) — jangan nunggu Teja minta duluan. Evaluasi jujur hasilnya, jangan ditelan mentah-mentah.
- Workflow Teja: satu-langkah-satu-waktu. Claude kasih 1 command/langkah, tunggu hasil dari Teja, baru lanjut ke langkah berikutnya. Jangan kasih banyak command sekaligus.

===================================================================
54. Verifikasi NOTIFY order_state_changed End-to-End + Bug Kebocoran Tenant di WebSocket (8 Agustus 2026, SELESAI DIVERIFIKASI)
===================================================================
Status: Next step lama (sejak bagian 38/39) yang akhirnya tuntas dites hari ini.

Temuan awal — trigger tidak pernah ada
- Cek ke database (schema public): TIDAK ADA trigger apapun, dan tidak ada function manapun yang manggil NOTIFY/pg_notify terkait proyek ini
- Asumsi lama di bagian 39 ("trigger sudah ada, dikonfirmasi dari listener startup tanpa error") KELIRU — LISTEN di Postgres selalu sukses walau tidak pernah ada yang NOTIFY, jadi startup tanpa error bukan bukti trigger ada
- server.js sendiri juga tidak ada kode NOTIFY manual di app-level — cuma ada 1 komentar "perlu dicek" di baris 544, tidak ada implementasi

Solusi — DB trigger (bukan app-level)
- Dipilih trigger database (bukan manggil NOTIFY dari app code) supaya tidak bisa lupa/kelewat dari jalur update manapun (termasuk fix data manual via SQL Editor)
- Trigger AFTER UPDATE ON production_jobs, kondisi WHEN (OLD.current_stage IS DISTINCT FROM NEW.current_stage) -- cuma fire kalau stage beneran berubah
- Payload JSON: production_job_id, tenant_id, order_id, old_stage, new_stage, current_version, updated_at
- Security advisor Supabase: sempat warning search_path belum eksplisit di function -- sudah diperbaiki, sekarang 0 warning

Verifikasi end-to-end (SUKSES)
- Level database: psql LISTEN manual + UPDATE current_stage dari sesi lain -- notifikasi diterima dengan payload lengkap dan benar
- Level aplikasi: script node -e pakai package ws, connect ke ws://localhost:3000/v1/realtime, UPDATE stage dari sesi lain -- notifikasi DITERIMA oleh WebSocket client dengan payload lengkap
- Rantai penuh terbukti jalan: DB trigger -> pg_notify -> LISTEN client di server.js (dedicated pg Client, bukan pool -- sudah benar) -> broadcast wss.clients -> WebSocket client nerima
- pm2 sempat di-flush + restart di tengah investigasi untuk dapat log bersih -- warning-warning lama (MaxListenersExceededWarning, DeprecationWarning client.query) tidak muncul lagi setelah restart bersih, dikonfirmasi bukan bug aktif, cuma numpukan log lama

BUG DITEMUKAN -- kebocoran data antar-tenant di WebSocket broadcast (PRIORITAS TINGGI, BELUM DIPERBAIKI)
- Kode broadcast di server.js (wss.clients.forEach(...)) mengirim SEMUA notifikasi ke SEMUA client yang connect ke /v1/realtime, TIDAK ADA filter per-tenant
- Dampak: kalau WebSocket ini dipakai di frontend sungguhan, client tenant A akan menerima notifikasi perubahan stage milik tenant B, C, dst -- pelanggaran isolasi data multi-tenant
- Ini murni ditemukan dari testing kali ini, belum ada perbaikan apapun -- lihat Next Steps Aktif (bagian 5) untuk rencana fix
- Kemungkinan solusi (belum diputuskan): filter di level relay server.js (parse payload, cek tenant_id, cuma kirim ke ws connection yang terasosiasi tenant itu -- perlu cara mengasosiasikan koneksi ws dengan tenant, misal dari query param/token saat handshake)

Next steps
[x] Verifikasi NOTIFY order_state_changed end-to-end -- SELESAI
[x] Fix bug kebocoran tenant di WebSocket broadcast — SELESAI, lihat bagian 54 untuk detail solusi (verifyClient + filter tenant_id)

Update bagian 54 (8 Agustus 2026) — Fix bug kebocoran tenant SELESAI
- Solusi final: pakai opsi verifyClient di WebSocketServer (bukan validasi di dalam wss.on("connection")) -- verifikasi tenant jalan di level HTTP upgrade, SEBELUM handshake WebSocket selesai
- Kenapa verifyClient lebih baik dari validasi di connection handler: client invalid ditolak sebelum sempat dapat status "open" sama sekali (HTTP 403 di level handshake), bukan connect dulu baru di-close -- lebih bersih, tidak ada window waktu client sempat "connected" walau cuma sepersekian detik
- extractSubdomain() di-export dari middleware/tenantResolver.js supaya dipakai ulang, konsisten dengan tenant resolver yang sudah ada untuk REST endpoint
- ws.tenantId di-set dari hasil resolve di verifyClient (nempel ke info.req.tenantId, diambil lagi pas wss.on("connection"))
- Broadcast di client.on("notification") diubah: parse payload dulu buat ambil tenant_id, baru kirim cuma ke ws yang ws.tenantId match
- CATATAN TEKNIS -- pelajaran dari proses coding: hindari python3 -c "..." (double-quote) untuk script yang mengandung tanda ! -- bash melakukan history expansion dan bisa merusak isi string sebelum sampai ke Python. Pakai heredoc python3 << 'PYEOF' ... PYEOF (single-quote delimiter) supaya bash tidak melakukan expansion apapun.
- Testing final: tenant invalid ditolak di handshake (403, tidak ada data terkirim), tenant valid (demo) tetap connect normal dan menerima notifikasi dengan payload benar -- keduanya diverifikasi lewat simulasi header Host manual (ws://localhost:3000 dengan header host: demo.fashion-platform.local)
- Commit: e07dad8

===================================================================
55. Audit Field Bigint Lain (9 Agustus 2026, SELESAI)
===================================================================
Status: Next step lama (bagian 5) yang jadi prioritas karena berhubungan langsung dengan bug sequence_version yang diperbaiki di bagian 36.

Kolom bigint di schema live (cek langsung ke DB, bukan file schema.sql):
- gap_audit_log.version_at_gap
- pending_events.sequence_version
- production_events.sequence_version
- production_jobs.current_version
- production_jobs.next_sequence_version
- stale_event_log.sequence_version

Hasil audit:
- Semua akses kolom ini yang dipakai untuk logika perbandingan/increment (stateLayer.js, versioning.js) sudah dibungkus parseInt(...,10) -- ini perbaikan yang sudah dilakukan di bagian 36
- worker.js men-select production_jobs.current_version (baris 18, alias pj.current_version) tapi kolom ini TIDAK PERNAH dipakai di logic manapun di checkGapsForTenant() -- cuma gap_status, age_seconds, already_escalated, production_job_id yang dipakai. No-op, tidak ada bug.
- Tidak ditemukan bug string-concat tambahan di luar yang sudah diperbaiki di bagian 36.

Kesimpulan: Audit tuntas, tidak ada fix tambahan diperlukan.

===================================================================
56. Function Spec-Lock reserve_fabric_inventory (9 Agustus 2026, SELESAI)
===================================================================
Status: Next step lama (bagian 5), atomik reserve inventory + ledger. Belum termasuk production_events (event-sourcing pipeline terpisah, tidak disentuh di sini).

Struktur tabel terkait:
- fabric_inventory: id, tenant_id, material_name, stock_state, quantity (numeric 12,3), unit, updated_at. RLS tenant_isolation aktif.
- inventory_ledger: id, tenant_id, fabric_inventory_id (FK), order_id (FK, nullable), movement_type, quantity, created_by_staff_id (FK staff), created_at. RLS tenant_isolation aktif.

Function: reserve_fabric_inventory(p_tenant_id, p_fabric_inventory_id, p_order_id, p_quantity, p_staff_id, p_movement_type DEFAULT 'RESERVED')
- Row lock via SELECT ... FOR UPDATE pada fabric_inventory -- cegah race condition kalau 2 proses reserve stok bersamaan
- Validasi: quantity > 0, baris ditemukan (tenant match), stok cukup -- gagal salah satu = RAISE EXCEPTION, seluruh transaksi rollback (tidak ada perubahan parsial)
- Kalau lolos validasi: UPDATE fabric_inventory (kurangi quantity) + INSERT inventory_ledger, satu transaksi atomik
- SECURITY INVOKER (bukan DEFINER) -- jalan pakai izin pemanggil, RLS tenant tetap berlaku normal, bukan bypass
- search_path = public diset eksplisit dari awal (pelajaran dari bagian 54, hindari warning Supabase advisor)
- Return: ledger_id + remaining_quantity
- GRANT EXECUTE diberikan ke app_user

Testing (via Supabase MCP untuk deploy function, psql VPS untuk test):
- Reserve normal (30 dari 100 stok testing "Katun Combed 30s"): SUKSES, quantity jadi 70, ledger_id ter-generate
- Reserve melebihi stok (999 dari 70): DITOLAK bersih dengan pesan jelas ("stok tidak cukup: tersedia 70.000, diminta 999"), quantity tetap 70 (diverifikasi ulang) -- atomik terbukti, tidak ada perubahan parsial
- Security advisor Supabase: 0 warning setelah deploy

Next: function ini belum dipanggil dari endpoint server.js manapun -- masih murni di level database. Integrasi ke endpoint (misal saat order masuk produksi, butuh bahan) belum dikerjakan, jadi next step terpisah kalau mau dipakai di alur bisnis nyata.
