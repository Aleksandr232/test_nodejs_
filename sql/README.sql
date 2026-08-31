-- Schema is applied by the app on startup (src/migrate.js).
-- This file documents the model for reviewers.

-- products: denormalized stock for the hot storefront query
-- INDEX idx_vitrine (in_stock, sku) — covering filter+order for витрина

-- orders: row lock + GET_LOCK(order_id) for exactly-once payment/fulfillment
-- payment_events: PK event_id — webhook idempotency
-- inventory_keys: UNIQUE(code) — one key never goes to two orders
-- supplier_issues: PK request_id — timeout ≠ new issue
-- ledger_entries: double-entry, SUM(debit)=SUM(credit)
