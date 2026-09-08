import { pool } from "../db.js";
import { ledgerBalance, ledgerSnapshot } from "./ledger.js";

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
    WHERE o.status IN ('delivered','partially_fulfilled','refunded') AND p.event_id IS NULL
  `);

  const [orphanKeys] = await pool.query(`
    SELECT k.code, k.sku, k.issued_to_order_id, k.issued_request_id
    FROM inventory_keys k
    LEFT JOIN claimed_codes c ON c.code = k.code
    WHERE k.status = 'issued' AND c.code IS NULL
  `);

  const [dupDeliveries] = await pool.query(`
    SELECT code, COUNT(*) AS owners
    FROM claimed_codes
    GROUP BY code
    HAVING COUNT(*) > 1
  `);

  const [codeInTwoItems] = await pool.query(`
    SELECT delivery_code AS code, COUNT(*) AS items
    FROM order_items
    WHERE delivery_code IS NOT NULL
    GROUP BY delivery_code
    HAVING COUNT(*) > 1
  `);

  const [moneyMismatch] = await pool.query(`
    SELECT
      o.id,
      o.status,
      o.amount AS paid,
      COALESCE(SUM(CASE WHEN i.status = 'delivered' THEN i.amount ELSE 0 END), 0) AS delivered,
      COALESCE(SUM(CASE WHEN i.status = 'refunded' THEN i.amount ELSE 0 END), 0) AS refunded
    FROM orders o
    LEFT JOIN order_items i ON i.order_id = o.id
    WHERE o.status IN ('delivered','partially_fulfilled','refunded')
    GROUP BY o.id, o.status, o.amount
    HAVING ABS(o.amount - COALESCE(SUM(CASE WHEN i.status = 'delivered' THEN i.amount ELSE 0 END), 0)
                         - COALESCE(SUM(CASE WHEN i.status = 'refunded' THEN i.amount ELSE 0 END), 0)) > 0.001
  `);

  const [stolenAttempts] = await pool.query(`
    SELECT s.request_id, s.order_id, s.code, s.supplier, c.order_id AS claimed_by_order, c.item_id AS claimed_by_item
    FROM supplier_issues s
    JOIN claimed_codes c ON c.code = s.code
    WHERE c.request_id <> s.request_id
  `);

  const ledger = await ledgerBalance();

  return {
    paid_not_delivered: paidNotDelivered,
    delivered_not_paid: deliveredNotPaid,
    orphan_issued_keys: orphanKeys,
    orders_with_multiple_codes: dupDeliveries,
    code_on_two_items: codeInTwoItems,
    money_mismatch: moneyMismatch,
    supplier_code_conflicts: stolenAttempts,
    ledger,
    ok:
      deliveredNotPaid.length === 0 &&
      dupDeliveries.length === 0 &&
      codeInTwoItems.length === 0 &&
      moneyMismatch.length === 0 &&
      ledger.balanced,
  };
}

export async function moneyAt(at) {
  return ledgerSnapshot(at);
}
