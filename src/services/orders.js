import { nanoid } from "nanoid";
import { pool, withOrderLock } from "../db.js";
import { logger } from "../logger.js";
import { getProduct } from "./catalog.js";
import { applyPaymentEvent } from "./payments.js";
import { fulfillOrder } from "./fulfillment.js";

// TODO(explain): publicOrder — code только в delivered, не светить ключ на полпути.
function publicOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    sku: row.sku,
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status,
    code: row.status === "delivered" ? row.delivery_code : null,
    supplier: row.supplier_used,
    created_at: row.created_at,
    updated_at: row.updated_at,
    paid_at: row.paid_at,
    delivered_at: row.delivered_at,
    last_error: row.last_error,
  };
}

// TODO(explain): createOrder — опциональный id для «вебхук раньше заказа»;
// после INSERT дочитываем processed=0 под тем же lock; request_id-A фиксируем сразу.
export async function createOrder({ sku, id }) {
  const product = await getProduct(sku);
  if (!product) {
    const err = new Error("sku_not_found");
    err.status = 404;
    throw err;
  }

  const orderId = id || `ord_${nanoid(12)}`;

  const result = await withOrderLock(orderId, async (conn) => {
    const [existing] = await conn.execute("SELECT * FROM orders WHERE id = ? FOR UPDATE", [orderId]);
    if (existing[0]) {
      const err = new Error("order_exists");
      err.status = 409;
      throw err;
    }

    await conn.execute(
      `INSERT INTO orders (id, sku, amount, currency, status, request_id, next_retry_at)
       VALUES (?, ?, ?, ?, 'created', ?, NULL)`,
      [orderId, product.sku, product.price, product.currency, `req_${orderId}-A`]
    );

    const [events] = await conn.execute(
      `SELECT * FROM payment_events WHERE order_id = ? AND processed = 0 ORDER BY created_at ASC FOR UPDATE`,
      [orderId]
    );

    let shouldFulfill = false;
    for (const ev of events) {
      const payload = typeof ev.payload === "string" ? JSON.parse(ev.payload) : ev.payload;
      const applied = await applyPaymentEvent(conn, { ...ev, ...payload, event_id: ev.event_id });
      if (applied.shouldFulfill) shouldFulfill = true;
    }

    const [rows] = await conn.execute("SELECT * FROM orders WHERE id = ?", [orderId]);
    return { order: rows[0], shouldFulfill };
  });

  logger.info({ event: "order.created", order_id: orderId, sku: product.sku, amount: product.price });

  if (result.shouldFulfill) {
    setImmediate(() => {
      fulfillOrder(orderId).catch((err) =>
        logger.error({ event: "fulfillment.async_error", order_id: orderId, err: err.message })
      );
    });
  }

  return publicOrder(result.order);
}

// TODO(explain): getOrder — без lock, иначе полл статуса блокирует выдачу.
export async function getOrder(id) {
  const [rows] = await pool.execute("SELECT * FROM orders WHERE id = ?", [id]);
  if (!rows[0]) return null;
  return publicOrder(rows[0]);
}

export { publicOrder };
