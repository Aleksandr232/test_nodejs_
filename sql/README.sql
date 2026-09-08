-- Schema is applied by the app on startup (src/migrate.js).
-- This file documents the model for reviewers.

-- products: denormalized stock for the hot storefront query
-- INDEX idx_vitrine (in_stock, sku) — covering filter+order for витрина

-- orders: row lock + GET_LOCK(order_id); статусы этапа 2: partially_fulfilled, refunded
-- order_items: позиция заказа, отдельный request_id и код
-- claimed_codes: PK(code) — наш источник истины, ответу поставщика не верим
-- payment_events: PK event_id — webhook idempotency
-- inventory_keys: UNIQUE(code) — физический ключ
-- supplier_issues: PK request_id — timeout ≠ новая выдача; код может врать
-- ledger_entries: double-entry, UNIQUE(order_id, item_id, event_type, account, direction)
--   payment / delivery / refund; оплачено = выдано + возвращено
-- order_events: append-only, точка-in-time без UPDATE задним числом
-- supplier_call_log: RPM лимит поставщика
