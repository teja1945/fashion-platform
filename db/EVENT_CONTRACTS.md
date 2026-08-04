# Event Contracts — Fashion Platform

> Dibuat: 5 Agustus 2026
> Tujuan: mendefinisikan struktur setiap event type di `production_events` supaya konsisten, versioned, dan tidak merusak projection/replay saat berkembang ke multi-tenant.
> Sumber: event type existing diekstrak langsung dari kode LTOS (`ingestion.js`), bukan ditulis dari asumsi.

## Aturan umum

- Setiap event WAJIB punya: `type`, `version`, `tenant_id`, `payload`
- `version` dimulai dari `v1`. Kalau struktur payload berubah (field ditambah dengan makna beda, field dihapus, tipe data berubah), bikin `v2` — JANGAN ubah `v1` yang sudah ada, supaya event lama tetap bisa di-replay
- Menambah field baru yang opsional (tidak mengubah makna field lama) TIDAK butuh bump version — tapi field baru harus punya default value yang aman kalau tidak ada di event lama
- `tenant_id` WAJIB ada di semua event mulai dari generalisasi multi-tenant (event LTOS lama tidak punya ini, single-tenant)

---

## Event Existing (dari LTOS, sudah teruji jalan)

### `order.created` (v1)
```json
{
  "type": "order.created",
  "version": 1,
  "tenant_id": "uuid",
  "payload": {
    "order_id": "uuid",
    "customer_id": "uuid",
    "items": [
      { "item_id": "uuid", "quantity": "number", "spec": "object" }
    ]
  }
}
```

### `order.updated` (v1)
```json
{
  "type": "order.updated",
  "version": 1,
  "tenant_id": "uuid",
  "payload": {
    "order_id": "uuid",
    "changes": "object"
  }
}
```

### `order.item_added` (v1)
```json
{
  "type": "order.item_added",
  "version": 1,
  "tenant_id": "uuid",
  "payload": {
    "order_id": "uuid",
    "item_id": "uuid",
    "quantity": "number"
  }
}
```

### `order.stage_changed` (v1)
```json
{
  "type": "order.stage_changed",
  "version": 1,
  "tenant_id": "uuid",
  "payload": {
    "order_id": "uuid",
    "from_stage": "string",
    "to_stage": "string",
    "staff_id": "uuid"
  }
}
```

### `order.cancelled` (v1)
```json
{
  "type": "order.cancelled",
  "version": 1,
  "tenant_id": "uuid",
  "payload": {
    "order_id": "uuid",
    "reason": "string",
    "allocations": [
      { "type": "reject|cancel", "quantity": "number", "reason": "string", "target_stage": "string|null" }
    ]
  }
}
```
> Catatan: struktur `allocations` ini adalah hasil refactor `BUNDLE_SPLIT` → `BUNDLE_ALLOCATION` yang sudah dijelaskan di CHECKPOINT.md bagian 13 — sudah general (N alokasi sekaligus), jangan mundur ke desain lama.

### `payment.initiated` (v1)
```json
{
  "type": "payment.initiated",
  "version": 1,
  "tenant_id": "uuid",
  "payload": {
    "order_id": "uuid",
    "amount": "number",
    "method": "string"
  }
}
```

### `payment.received` (v1)
```json
{
  "type": "payment.received",
  "version": 1,
  "tenant_id": "uuid",
  "payload": {
    "order_id": "uuid",
    "amount": "number",
    "payment_id": "uuid"
  }
}
```

### `payment.failed` (v1)
```json
{
  "type": "payment.failed",
  "version": 1,
  "tenant_id": "uuid",
  "payload": {
    "order_id": "uuid",
    "reason": "string"
  }
}
```

### `qc.passed` (v1)
```json
{
  "type": "qc.passed",
  "version": 1,
  "tenant_id": "uuid",
  "payload": {
    "order_id": "uuid",
    "stage": "string",
    "staff_id": "uuid"
  }
}
```

### `qc.failed` (v1)
```json
{
  "type": "qc.failed",
  "version": 1,
  "tenant_id": "uuid",
  "payload": {
    "order_id": "uuid",
    "stage": "string",
    "reason": "string",
    "staff_id": "uuid"
  }
}
```

### `shipment.dispatched` (v1)
```json
{
  "type": "shipment.dispatched",
  "version": 1,
  "tenant_id": "uuid",
  "payload": {
    "order_id": "uuid",
    "tracking_number": "string",
    "courier": "string"
  }
}
```

### `shipment.delivered` (v1)
```json
{
  "type": "shipment.delivered",
  "version": 1,
  "tenant_id": "uuid",
  "payload": {
    "order_id": "uuid",
    "delivered_at": "timestamp"
  }
}
```

---

## Event Baru — Dibutuhkan untuk Multi-Tenant (belum ada di LTOS)

Ini event yang perlu ditambahkan sesuai rencana di CHECKPOINT.md bagian 7-9 & 13. Struktur di bawah masih draft awal — perlu direview lagi saat mulai implementasi.

### `spec.substitution_requested` (v1) — draft
Terkait CHECKPOINT.md bagian 7 (ganti kain, approval 2 lapis)
```json
{
  "type": "spec.substitution_requested",
  "version": 1,
  "tenant_id": "uuid",
  "payload": {
    "order_id": "uuid",
    "original_material_id": "uuid",
    "substitute_material_id": "uuid",
    "reason": "string",
    "requested_by_staff_id": "uuid",
    "admin_approved": "boolean"
  }
}
```

### `spec.substitution_decided` (v1) — draft
```json
{
  "type": "spec.substitution_decided",
  "version": 1,
  "tenant_id": "uuid",
  "payload": {
    "order_id": "uuid",
    "substitution_request_id": "uuid",
    "decision": "APPROVED|REJECTED",
    "decided_by": "customer|admin"
  }
}
```

### `customer.decision_made` (v1) — draft
Terkait CHECKPOINT.md bagian 8-9 (REFUND / WAIT_REPRODUCTION / CHOOSE_ALTERNATIVE)
```json
{
  "type": "customer.decision_made",
  "version": 1,
  "tenant_id": "uuid",
  "payload": {
    "order_id": "uuid",
    "decision": "REFUND|WAIT_REPRODUCTION|CHOOSE_ALTERNATIVE",
    "triggered_by": "customer|deadline_default"
  }
}
```

### `notification.sent` (v1) — draft
```json
{
  "type": "notification.sent",
  "version": 1,
  "tenant_id": "uuid",
  "payload": {
    "order_id": "uuid",
    "channel": "string",
    "status": "pending|sent|failed"
  }
}
```

---

## Next steps

- [ ] Review draft event baru di atas bersama saat mulai coding modul terkait (spec substitution, customer decisions, notification)
- [ ] Tambahkan event untuk `tenant_billing` kalau sudah didesain
- [ ] File ini disimpan di folder `db/` repo, sejajar dengan `fashion_platform_schema_v2.sql`
