import { pool, withOrderLock } from "../db.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { ledgerDelivery } from "./ledger.js";

const RECOVERABLE = new Set(["paid", "delivering", "out_of_stock", "delivery_failed"]);

// TODO(explain): sleep — backoff между retry timeout, не между 5xx (там сразу fallback).
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// TODO(explain): maskCode — полный ключ не должен попасть в JSON-логи.
function maskCode(code) {
  if (!code || code.length < 4) return "***";
  return `***${code.slice(-4)}`;
}

// TODO(explain): callSupplier — AbortController = наш таймаут; timeout отделяем от 5xx,
// иначе ловушка «поставщик выдал, ответ не дошёл» неотличима от отказа.
async function callSupplier(baseUrl, body, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/issue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.status === "ok" && json.code) {
      return { kind: "ok", code: json.code, request_id: json.request_id };
    }
    return {
      kind: "error",
      http: res.status,
      reason: json.reason || "supplier_error",
    };
  } catch (err) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return { kind: "timeout" };
    }
    return { kind: "error", reason: err.message || "network" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Retry the SAME request_id. Never mint a new id after timeout —
 * the supplier may have already allocated a code.
 * TODO(explain): callWithRetry — timeout → backoff + тот же request_id;
 * явный error → return (можно fallback). Новый id после timeout = второй ключ.
 */
async function callWithRetry(name, baseUrl, body) {
  const retries = config.suppliers.retries;
  const timeoutMs = config.suppliers.timeoutMs;
  let last = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    logger.info({
      event: "fulfillment.supplier_call",
      supplier: name,
      order_id: body.order_id,
      request_id: body.request_id,
      attempt,
    });

    last = await callSupplier(baseUrl, body, timeoutMs);

    if (last.kind === "ok") {
      logger.info({
        event: "fulfillment.supplier_ok",
        supplier: name,
        order_id: body.order_id,
        request_id: body.request_id,
        code: maskCode(last.code),
        attempt,
      });
      return last;
    }

    if (last.kind === "timeout") {
      logger.warn({
        event: "fulfillment.supplier_timeout",
        supplier: name,
        order_id: body.order_id,
        request_id: body.request_id,
        attempt,
        note: "timeout_is_not_failure_retry_same_request_id",
      });
      await sleep(150 * 2 ** (attempt - 1));
      continue;
    }

    logger.warn({
      event: "fulfillment.supplier_error",
      supplier: name,
      order_id: body.order_id,
      request_id: body.request_id,
      reason: last.reason,
      attempt,
    });
    return last;
  }

  return last;
}

// TODO(explain): completeDelivery — WHERE delivery_code IS NULL; леджер в той же транзакции.
async function completeDelivery(conn, order, code, supplier, requestId) {
  const [upd] = await conn.execute(
    `UPDATE orders
     SET status = 'delivered',
         delivery_code = ?,
         supplier_used = ?,
         request_id = ?,
         delivered_at = NOW(3),
         updated_at = NOW(3),
         next_retry_at = NULL,
         last_error = NULL,
         lock_until = NULL
     WHERE id = ? AND status IN ('paid','delivering','out_of_stock','delivery_failed')
       AND delivery_code IS NULL`,
    [code, supplier, requestId, order.id]
  );

  if (upd.affectedRows === 0) {
    logger.info({ event: "fulfillment.already_delivered", order_id: order.id });
    return false;
  }

  await ledgerDelivery(conn, order.id, order.amount);
  logger.info({
    event: "fulfillment.delivered",
    order_id: order.id,
    supplier,
    request_id: requestId,
    code: maskCode(code),
  });
  return true;
}

// TODO(explain): markRecoverable — out_of_stock/delivery_failed не crash; next_retry_at глушит busy-loop.
async function markRecoverable(conn, orderId, status, error) {
  const delaySec = status === "out_of_stock" ? 15 : 5;
  await conn.execute(
    `UPDATE orders
     SET status = ?,
         last_error = ?,
         fulfillment_attempts = fulfillment_attempts + 1,
         updated_at = NOW(3),
         lock_until = NULL,
         next_retry_at = DATE_ADD(NOW(3), INTERVAL ? SECOND)
     WHERE id = ? AND status IN ('paid','delivering','out_of_stock','delivery_failed')`,
    [status, error?.slice(0, 255) || status, delaySec, orderId]
  );
}

// TODO(explain): fulfillOrder — HTTP вне транзакции; timeout A ≠ fallback B;
// B только на 4xx/5xx и со своим request_id-B.
export async function fulfillOrder(orderId) {
  const claimed = await withOrderLock(orderId, async (conn) => {
    const [rows] = await conn.execute("SELECT * FROM orders WHERE id = ? FOR UPDATE", [orderId]);
    const order = rows[0];
    if (!order) return null;
    if (order.status === "delivered") return { skip: true, reason: "already_delivered" };
    if (!RECOVERABLE.has(order.status)) return { skip: true, reason: order.status };
    if (
      order.status === "delivering" &&
      order.lock_until &&
      new Date(order.lock_until).getTime() > Date.now()
    ) {
      return { skip: true, reason: "in_flight" };
    }
    if (order.delivery_code) {
      await completeDelivery(conn, order, order.delivery_code, order.supplier_used || "A", order.request_id);
      return { skip: true, reason: "had_code" };
    }

    await conn.execute(
      `UPDATE orders
       SET status = 'delivering',
           lock_until = DATE_ADD(NOW(3), INTERVAL 45 SECOND),
           updated_at = NOW(3)
       WHERE id = ?`,
      [orderId]
    );
    return { order };
  });

  if (!claimed || claimed.skip) return claimed;

  const order = claimed.order;
  const requestIdA = `req_${order.id}-A`;

  const resultA = await callWithRetry("A", config.suppliers.A, {
    request_id: requestIdA,
    sku: order.sku,
    order_id: order.id,
  });

  if (resultA.kind === "ok") {
    await withOrderLock(orderId, async (conn) => {
      const [rows] = await conn.execute("SELECT * FROM orders WHERE id = ? FOR UPDATE", [orderId]);
      if (!rows[0] || rows[0].status === "delivered") return;
      await completeDelivery(conn, rows[0], resultA.code, "A", requestIdA);
    });
    return { delivered: true, supplier: "A" };
  }

  if (resultA.kind === "timeout") {
    // Do NOT fallback: A may already hold a code for this request_id.
    logger.warn({
      event: "fulfillment.timeout_no_fallback",
      order_id: orderId,
      request_id: requestIdA,
    });
    await withOrderLock(orderId, async (conn) => {
      await markRecoverable(conn, orderId, "delivery_failed", "supplier_A_timeout");
    });
    return { failed: true, reason: "timeout" };
  }

  logger.info({
    event: "fulfillment.fallback",
    order_id: orderId,
    from: "A",
    to: "B",
    reason: resultA.reason,
  });

  const requestIdB = `req_${order.id}-B`;
  const resultB = await callWithRetry("B", config.suppliers.B, {
    request_id: requestIdB,
    sku: order.sku,
    order_id: order.id,
  });

  if (resultB.kind === "ok") {
    await withOrderLock(orderId, async (conn) => {
      const [rows] = await conn.execute("SELECT * FROM orders WHERE id = ? FOR UPDATE", [orderId]);
      if (!rows[0] || rows[0].status === "delivered") return;
      await completeDelivery(conn, rows[0], resultB.code, "B", requestIdB);
    });
    return { delivered: true, supplier: "B" };
  }

  const stockFail =
    resultA.reason === "out_of_stock" && (resultB.reason === "out_of_stock" || resultB.kind !== "ok");
  const status = stockFail ? "out_of_stock" : "delivery_failed";

  await withOrderLock(orderId, async (conn) => {
    await markRecoverable(conn, orderId, status, resultB.reason || resultA.reason || status);
  });

  return { failed: true, status };
}

// TODO(explain): recoverStuckOrders — дожим без брокера; безопасность = идемпотентность, не «один воркер».
export async function recoverStuckOrders() {
  const [rows] = await pool.query(
    `SELECT id FROM orders
     WHERE status IN ('paid','delivering','out_of_stock','delivery_failed')
       AND delivery_code IS NULL
       AND (next_retry_at IS NULL OR next_retry_at <= NOW(3))
       AND (lock_until IS NULL OR lock_until <= NOW(3))
     ORDER BY updated_at ASC
     LIMIT 10`
  );

  for (const row of rows) {
    try {
      await fulfillOrder(row.id);
    } catch (err) {
      logger.error({ event: "recovery.error", order_id: row.id, err: err.message });
    }
  }
}

// TODO(explain): startRecoveryWorker — setInterval ок для ядра; в проде outbox + очередь.
export function startRecoveryWorker() {
  const tick = async () => {
    try {
      await recoverStuckOrders();
    } catch (err) {
      logger.error({ event: "recovery.tick_error", err: err.message });
    }
  };
  const id = setInterval(tick, 3000);
  if (id.unref) id.unref();
  logger.info({ event: "recovery.started" });
}
