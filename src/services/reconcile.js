import { pool } from "../db.js";
import { ledgerBalance } from "./ledger.js";

// TODO(explain): reconcile — четыре проверки приёмки: paid≠delivered, delivered без paid, сироты, два кода.
export async function reconcile() {
  const [paidNotDelivered] = await pool.query(`
    SELECT id, sku, status, amount, currency, paid_at, updated_at, last_error
    FROM orders
    WHERE status IN ('paid','delivering','out_of_stock','delivery_failed')
  `);

  const [deliveredNotPaid] = await pool.query(`
    SELECT o.id, o.sku, o.status, o.amount
    FROM orders o
    LEFT JOIN payment_events p ON p.order_id = o.id AND p.status = 'paid' AND p.processed = 1
    WHERE o.status = 'delivered' AND p.event_id IS NULL
  `);

  const [orphanKeys] = await pool.query(`
    SELECT k.code, k.sku, k.issued_to_order_id, k.issued_request_id
    FROM inventory_keys k
    LEFT JOIN orders o ON o.id = k.issued_to_order_id
    WHERE k.status = 'issued'
      AND (k.issued_to_order_id IS NULL OR o.id IS NULL OR o.delivery_code IS NULL OR o.delivery_code <> k.code)
  `);

  const [dupDeliveries] = await pool.query(`
    SELECT issued_to_order_id AS order_id, COUNT(*) AS codes
    FROM inventory_keys
    WHERE issued_to_order_id IS NOT NULL
    GROUP BY issued_to_order_id
    HAVING COUNT(*) > 1
  `);

  const ledger = await ledgerBalance();

  return {
    paid_not_delivered: paidNotDelivered,
    delivered_not_paid: deliveredNotPaid,
    orphan_issued_keys: orphanKeys,
    orders_with_multiple_codes: dupDeliveries,
    ledger,
    ok:
      deliveredNotPaid.length === 0 &&
      dupDeliveries.length === 0 &&
      ledger.balanced,
  };
}
