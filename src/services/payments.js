import { withOrderLock } from "../db.js";
import { logger } from "../logger.js";
import { ledgerPayment } from "./ledger.js";
import { fulfillOrder } from "./fulfillment.js";

const FINAL_PAID_STATUSES = new Set(["paid", "delivering", "delivered", "out_of_stock", "delivery_failed"]);
const FINAL_TERMINAL = new Set(["delivered", "payment_failed"]);

// TODO(explain): handlePaymentWebhook — PK event_id = идемпотентность; 200 всегда (кроме 400);
// заказ отсутствует → pending, не 404 (вебхук раньше create). Выдачу не держать в HTTP.
export async function handlePaymentWebhook(payload) {
  const eventId = payload?.event_id;
  const orderId = payload?.order_id;
  const status = payload?.status;

  if (!eventId || !orderId || !status) {
    const err = new Error("invalid_webhook");
    err.status = 400;
    throw err;
  }
  if (!["paid", "failed"].includes(status)) {
    const err = new Error("invalid_status");
    err.status = 400;
    throw err;
  }

  const result = await withOrderLock(orderId, async (conn) => {
    try {
      await conn.execute(
        `INSERT INTO payment_events (event_id, order_id, status, amount, currency, payload, processed)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
        [
          eventId,
          orderId,
          status,
          payload.amount ?? 0,
          payload.currency || "RUB",
          JSON.stringify(payload),
        ]
      );
    } catch (e) {
      if (e.code === "ER_DUP_ENTRY") {
        logger.info({ event: "payment.duplicate", event_id: eventId, order_id: orderId });
        return { duplicate: true, shouldFulfill: false };
      }
      throw e;
    }

    const [orders] = await conn.execute("SELECT * FROM orders WHERE id = ? FOR UPDATE", [orderId]);
    if (!orders[0]) {
      logger.info({ event: "payment.order_missing", event_id: eventId, order_id: orderId });
      return { pending: true, shouldFulfill: false };
    }

    return applyPaymentEvent(conn, { ...payload, event_id: eventId, order_id: orderId });
  });

  if (result.shouldFulfill) {
    setImmediate(() => {
      fulfillOrder(orderId).catch((err) =>
        logger.error({ event: "fulfillment.async_error", order_id: orderId, err: err.message })
      );
    });
  }

  return result;
}

// TODO(explain): applyPaymentEvent — таблица переходов; failed после paid игнор;
// paid только UPDATE WHERE status='created', иначе 50 event_id дадут 50 выдач.
export async function applyPaymentEvent(conn, payload) {
  const { event_id, order_id, status, amount } = payload;
  const [orders] = await conn.execute("SELECT * FROM orders WHERE id = ? FOR UPDATE", [order_id]);
  const order = orders[0];
  if (!order) {
    return { pending: true, shouldFulfill: false };
  }

  logger.info({
    event: "payment.received",
    event_id,
    order_id,
    webhook_status: status,
    order_status: order.status,
    amount,
  });

  if (status === "failed") {
    if (order.status === "created") {
      await conn.execute(
        `UPDATE orders SET status = 'payment_failed', updated_at = NOW(3), last_error = 'payment_failed'
         WHERE id = ? AND status = 'created'`,
        [order_id]
      );
    } else {
      logger.info({
        event: "payment.failed_ignored",
        event_id,
        order_id,
        reason: "order_already_moved",
        order_status: order.status,
      });
    }
    await conn.execute("UPDATE payment_events SET processed = 1 WHERE event_id = ?", [event_id]);
    return { applied: order.status === "created", shouldFulfill: false };
  }

  // paid
  if (FINAL_TERMINAL.has(order.status) && order.status !== "delivered") {
    await conn.execute("UPDATE payment_events SET processed = 1 WHERE event_id = ?", [event_id]);
    return { applied: false, shouldFulfill: false };
  }

  if (FINAL_PAID_STATUSES.has(order.status)) {
    await conn.execute("UPDATE payment_events SET processed = 1 WHERE event_id = ?", [event_id]);
    logger.info({ event: "payment.already_paid", event_id, order_id, order_status: order.status });
    return { applied: false, shouldFulfill: false };
  }

  if (order.status !== "created") {
    await conn.execute("UPDATE payment_events SET processed = 1 WHERE event_id = ?", [event_id]);
    return { applied: false, shouldFulfill: false };
  }

  if (amount != null && Number(amount) !== Number(order.amount)) {
    logger.warn({
      event: "payment.amount_mismatch",
      event_id,
      order_id,
      webhook_amount: amount,
      order_amount: order.amount,
    });
  }

  await conn.execute(
    `UPDATE orders
     SET status = 'paid', paid_at = NOW(3), updated_at = NOW(3), next_retry_at = NOW(3)
     WHERE id = ? AND status = 'created'`,
    [order_id]
  );
  await ledgerPayment(conn, order_id, order.amount);
  await conn.execute("UPDATE payment_events SET processed = 1 WHERE event_id = ?", [event_id]);

  logger.info({ event: "payment.captured", event_id, order_id, amount: order.amount });
  return { applied: true, shouldFulfill: true };
}
