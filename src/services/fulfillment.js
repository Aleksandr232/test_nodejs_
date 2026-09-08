import { pool, withOrderLock } from "../db.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { ledgerDelivery, ledgerRefund } from "./ledger.js";
import { appendEvent } from "./events.js";

const ITEM_RECOVERABLE = new Set(["pending", "delivering", "out_of_stock", "delivery_failed"]);
const ORDER_PAYING = new Set(["paid", "delivering", "out_of_stock", "delivery_failed", "partially_fulfilled"]);
const MAX_FAIL_ATTEMPTS = 5;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function maskCode(code) {
  if (!code || code.length < 4) return "***";
  return `***${code.slice(-4)}`;
}

async function acquireRateSlot(supplier) {
  const rpm = config.suppliers.rateLimitRpm;
  if (rpm <= 0) return true;
  const [[{ cnt }]] = await pool.execute(
    `SELECT COUNT(*) AS cnt FROM supplier_call_log
     WHERE supplier = ? AND called_at > DATE_SUB(NOW(3), INTERVAL 60 SECOND)`,
    [supplier]
  );
  return Number(cnt) < rpm;
}

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
    if (res.status === 429) {
      return { kind: "rate_limited", reason: json.reason || "rate_limited" };
    }
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

async function findAllocated(requestId) {
  const [rows] = await pool.execute(
    "SELECT request_id, supplier, sku, order_id, code FROM supplier_issues WHERE request_id = ?",
    [requestId]
  );
  return rows[0] || null;
}

async function callWithRetry(name, baseUrl, body) {
  const retries = config.suppliers.retries;
  const timeoutMs = config.suppliers.timeoutMs;
  let last = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const slot = await acquireRateSlot(name);
    if (!slot) {
      logger.warn({ event: "fulfillment.rate_limited", supplier: name, request_id: body.request_id });
      return { kind: "rate_limited" };
    }

    logger.info({
      event: "fulfillment.supplier_call",
      supplier: name,
      order_id: body.order_id,
      item_id: body.item_id,
      request_id: body.request_id,
      attempt,
    });

    last = await callSupplier(baseUrl, body, timeoutMs);

    const allocated = await findAllocated(body.request_id);
    if (allocated?.code) {
      logger.info({
        event: "fulfillment.allocation_confirmed",
        supplier: name,
        request_id: body.request_id,
        code: maskCode(allocated.code),
        http_kind: last.kind,
      });
      return { kind: "ok", code: allocated.code, request_id: body.request_id, via: "reconcile" };
    }

    if (last.kind === "ok") {
      logger.warn({
        event: "fulfillment.untrusted_code_ignored",
        supplier: name,
        request_id: body.request_id,
        note: "http_ok_but_no_allocation_for_request_id",
      });
      return { kind: "error", reason: "untrusted_code" };
    }

    if (last.kind === "timeout") {
      logger.warn({
        event: "fulfillment.supplier_timeout",
        supplier: name,
        request_id: body.request_id,
        attempt,
        note: "timeout_is_not_failure_retry_same_request_id",
      });
      await sleep(150 * 2 ** (attempt - 1));
      continue;
    }

    if (last.kind === "rate_limited") {
      return last;
    }

    logger.warn({
      event: "fulfillment.supplier_error",
      supplier: name,
      request_id: body.request_id,
      reason: last.reason,
      attempt,
    });
    return last;
  }

  const allocated = await findAllocated(body.request_id);
  if (allocated?.code) {
    return { kind: "ok", code: allocated.code, request_id: body.request_id, via: "reconcile" };
  }
  return last;
}

async function claimCode(conn, { code, orderId, itemId, requestId, supplier }) {
  try {
    await conn.execute(
      `INSERT INTO claimed_codes (code, order_id, item_id, request_id, supplier)
       VALUES (?, ?, ?, ?, ?)`,
      [code, orderId, itemId, requestId, supplier]
    );
    return { ok: true };
  } catch (e) {
    if (e.code !== "ER_DUP_ENTRY") throw e;
    const [byItem] = await conn.execute("SELECT * FROM claimed_codes WHERE item_id = ?", [itemId]);
    if (byItem[0]) {
      return { ok: true, existing: true, code: byItem[0].code, supplier: byItem[0].supplier };
    }
    const [byCode] = await conn.execute("SELECT * FROM claimed_codes WHERE code = ?", [code]);
    logger.warn({
      event: "fulfillment.code_rejected",
      order_id: orderId,
      item_id: itemId,
      request_id: requestId,
      owner_item: byCode[0]?.item_id,
      owner_order: byCode[0]?.order_id,
      note: "supplier_duplicate_or_stolen_code",
    });
    return { ok: false, reason: "code_already_claimed", owner: byCode[0] };
  }
}

async function rollupOrder(conn, orderId) {
  const [items] = await conn.execute("SELECT * FROM order_items WHERE order_id = ? ORDER BY line_no", [orderId]);
  if (!items.length) return;

  const delivered = items.filter((i) => i.status === "delivered");
  const refunded = items.filter((i) => i.status === "refunded");
  const pending = items.filter((i) => !["delivered", "refunded"].includes(i.status));

  let status;
  if (pending.length) {
    if (pending.every((i) => i.status === "out_of_stock")) status = "out_of_stock";
    else if (pending.every((i) => i.status === "delivery_failed" || i.status === "out_of_stock")) status = "delivery_failed";
    else status = "delivering";
  } else if (delivered.length && refunded.length) status = "partially_fulfilled";
  else if (delivered.length) status = "delivered";
  else status = "refunded";

  const single = items.length === 1 && delivered.length === 1;
  await conn.execute(
    `UPDATE orders
     SET status = ?,
         delivery_code = ?,
         supplier_used = ?,
         request_id = ?,
         delivered_at = CASE WHEN ? IN ('delivered','partially_fulfilled') THEN COALESCE(delivered_at, NOW(3)) ELSE delivered_at END,
         updated_at = NOW(3),
         next_retry_at = CASE WHEN ? = 'delivering' THEN DATE_ADD(NOW(3), INTERVAL 2 SECOND) ELSE NULL END,
         last_error = ?,
         lock_until = NULL
     WHERE id = ? AND status NOT IN ('created','payment_failed')`,
    [
      status,
      single ? delivered[0].delivery_code : null,
      single ? delivered[0].supplier_used : delivered[0]?.supplier_used || null,
      single ? delivered[0].request_id : items[0].request_id,
      status,
      status,
      pending[0]?.last_error || null,
      orderId,
    ]
  );

  await appendEvent(conn, {
    orderId,
    eventType: "order.status",
    payload: {
      status,
      delivered: delivered.length,
      refunded: refunded.length,
      pending: pending.length,
    },
  });
}

async function completeItem(conn, item, code, supplier, requestId) {
  const claimed = await claimCode(conn, {
    code,
    orderId: item.order_id,
    itemId: item.id,
    requestId,
    supplier,
  });
  if (!claimed.ok) return { delivered: false, reason: claimed.reason };
  const finalCode = claimed.code || code;
  const finalSupplier = claimed.supplier || supplier;

  const [upd] = await conn.execute(
    `UPDATE order_items
     SET status = 'delivered',
         delivery_code = ?,
         supplier_used = ?,
         request_id = ?,
         delivered_at = NOW(3),
         next_retry_at = NULL,
         lock_until = NULL,
         last_error = NULL
     WHERE id = ? AND delivery_code IS NULL
       AND status IN ('pending','delivering','out_of_stock','delivery_failed')`,
    [finalCode, finalSupplier, requestId, item.id]
  );
  if (upd.affectedRows === 0) {
    await rollupOrder(conn, item.order_id);
    return { delivered: true, existing: true };
  }

  await ledgerDelivery(conn, item.order_id, item.id, item.amount);
  await appendEvent(conn, {
    orderId: item.order_id,
    itemId: item.id,
    eventType: "item.delivered",
    payload: {
      sku: item.sku,
      amount: Number(item.amount),
      supplier: finalSupplier,
      code: finalCode,
    },
  });
  await rollupOrder(conn, item.order_id);
  logger.info({
    event: "fulfillment.item_delivered",
    order_id: item.order_id,
    item_id: item.id,
    supplier: finalSupplier,
    request_id: requestId,
    code: maskCode(finalCode),
  });
  return { delivered: true };
}

async function refundItem(conn, item, reason) {
  const [upd] = await conn.execute(
    `UPDATE order_items
     SET status = 'refunded',
         refunded_at = NOW(3),
         next_retry_at = NULL,
         lock_until = NULL,
         last_error = ?,
         fulfillment_attempts = fulfillment_attempts + 1
     WHERE id = ? AND status NOT IN ('delivered','refunded')`,
    [(reason || "refunded").slice(0, 255), item.id]
  );
  if (upd.affectedRows === 0) {
    await rollupOrder(conn, item.order_id);
    return false;
  }
  await ledgerRefund(conn, item.order_id, item.id, item.amount);
  await appendEvent(conn, {
    orderId: item.order_id,
    itemId: item.id,
    eventType: "item.refunded",
    payload: { sku: item.sku, amount: Number(item.amount), reason },
  });
  await rollupOrder(conn, item.order_id);
  logger.info({
    event: "fulfillment.item_refunded",
    order_id: item.order_id,
    item_id: item.id,
    amount: Number(item.amount),
    reason,
  });
  return true;
}

async function markItem(conn, item, status, error, delaySecOverride) {
  const delaySec = delaySecOverride ?? (status === "out_of_stock" ? 15 : status === "delivery_failed" ? 5 : 2);
  await conn.execute(
    `UPDATE order_items
     SET status = ?,
         last_error = ?,
         fulfillment_attempts = fulfillment_attempts + 1,
         lock_until = NULL,
         next_retry_at = DATE_ADD(NOW(3), INTERVAL ? SECOND)
     WHERE id = ? AND status NOT IN ('delivered','refunded')`,
    [status, (error || status).slice(0, 255), delaySec, item.id]
  );
  await appendEvent(conn, {
    orderId: item.order_id,
    itemId: item.id,
    eventType: "item.status",
    payload: { status, error },
  });
  await rollupOrder(conn, item.order_id);
}

async function adoptExistingClaim(conn, item) {
  const [claimed] = await conn.execute("SELECT * FROM claimed_codes WHERE item_id = ?", [item.id]);
  if (claimed[0]) {
    await completeItem(conn, item, claimed[0].code, claimed[0].supplier, claimed[0].request_id);
    return true;
  }
  if (item.delivery_code) {
    await completeItem(conn, item, item.delivery_code, item.supplier_used || "A", item.request_id);
    return true;
  }
  return false;
}

export async function fulfillItem(itemId) {
  const [found] = await pool.execute("SELECT order_id FROM order_items WHERE id = ?", [itemId]);
  if (!found[0]) return { skip: true, reason: "missing_item" };
  const orderId = found[0].order_id;

  const claimed = await withOrderLock(orderId, async (conn) => {
    const [rows] = await conn.execute("SELECT * FROM order_items WHERE id = ? FOR UPDATE", [itemId]);
    const item = rows[0];
    if (!item) return { skip: true, reason: "missing_item" };

    const [orders] = await conn.execute("SELECT * FROM orders WHERE id = ? FOR UPDATE", [item.order_id]);
    const order = orders[0];
    if (!order || !ORDER_PAYING.has(order.status)) return { skip: true, reason: order?.status || "no_order" };
    if (!ITEM_RECOVERABLE.has(item.status)) return { skip: true, reason: item.status };

    if (item.status === "delivering" && item.lock_until && new Date(item.lock_until).getTime() > Date.now()) {
      return { skip: true, reason: "in_flight" };
    }

    if (await adoptExistingClaim(conn, item)) {
      return { skip: true, reason: "had_code" };
    }

    const allocatedA = await findAllocated(`req_${item.id}-A`);
    const allocatedB = await findAllocated(`req_${item.id}-B`);
    const allocated = allocatedA || allocatedB;
    if (allocated?.code) {
      const done = await completeItem(conn, item, allocated.code, allocated.supplier, allocated.request_id);
      if (done.delivered) return { skip: true, reason: "reconciled" };
    }

    await conn.execute(
      `UPDATE order_items
       SET status = 'delivering',
           lock_until = DATE_ADD(NOW(3), INTERVAL 45 SECOND)
       WHERE id = ?`,
      [item.id]
    );
    await conn.execute(
      `UPDATE orders SET status = 'delivering', lock_until = DATE_ADD(NOW(3), INTERVAL 45 SECOND), updated_at = NOW(3)
       WHERE id = ? AND status IN ('paid','delivering','out_of_stock','delivery_failed')`,
      [item.order_id]
    );
    return { item };
  });

  if (!claimed || claimed.skip) return claimed;

  const item = claimed.item;
  const requestIdA = `req_${item.id}-A`;
  const resultA = await callWithRetry("A", config.suppliers.A, {
    request_id: requestIdA,
    sku: item.sku,
    order_id: item.order_id,
    item_id: item.id,
  });

  if (resultA.kind === "ok") {
    const applied = await withOrderLock(item.order_id, async (conn) => {
      const [rows] = await conn.execute("SELECT * FROM order_items WHERE id = ? FOR UPDATE", [item.id]);
      if (!rows[0] || rows[0].status === "delivered" || rows[0].status === "refunded") return { delivered: true };
      return completeItem(conn, rows[0], resultA.code, "A", requestIdA);
    });
    if (applied.delivered) return { delivered: true, supplier: "A", item_id: item.id };
    resultA.kind = "error";
    resultA.reason = applied.reason || "code_already_claimed";
  }

  if (resultA.kind === "timeout") {
    logger.warn({ event: "fulfillment.timeout_no_fallback", order_id: item.order_id, item_id: item.id, request_id: requestIdA });
    await withOrderLock(item.order_id, async (conn) => {
      const [rows] = await conn.execute("SELECT * FROM order_items WHERE id = ? FOR UPDATE", [item.id]);
      if (!rows[0] || rows[0].status === "delivered") return;
      const allocated = await findAllocated(requestIdA);
      if (allocated?.code) {
        await completeItem(conn, rows[0], allocated.code, "A", requestIdA);
        return;
      }
      await markItem(conn, rows[0], "delivery_failed", "supplier_A_timeout");
    });
    return { failed: true, reason: "timeout", item_id: item.id };
  }

  if (resultA.kind === "rate_limited") {
    await withOrderLock(item.order_id, async (conn) => {
      const [rows] = await conn.execute("SELECT * FROM order_items WHERE id = ? FOR UPDATE", [item.id]);
      if (rows[0]) await markItem(conn, rows[0], "delivering", "rate_limited", 8);
    });
    return { failed: true, reason: "rate_limited", item_id: item.id };
  }

  logger.info({
    event: "fulfillment.fallback",
    order_id: item.order_id,
    item_id: item.id,
    from: "A",
    to: "B",
    reason: resultA.reason,
  });

  const requestIdB = `req_${item.id}-B`;
  const resultB = await callWithRetry("B", config.suppliers.B, {
    request_id: requestIdB,
    sku: item.sku,
    order_id: item.order_id,
    item_id: item.id,
  });

  if (resultB.kind === "ok") {
    const applied = await withOrderLock(item.order_id, async (conn) => {
      const [rows] = await conn.execute("SELECT * FROM order_items WHERE id = ? FOR UPDATE", [item.id]);
      if (!rows[0] || rows[0].status === "delivered" || rows[0].status === "refunded") return { delivered: true };
      return completeItem(conn, rows[0], resultB.code, "B", requestIdB);
    });
    if (applied.delivered) return { delivered: true, supplier: "B", item_id: item.id };
    resultB.reason = applied.reason || resultB.reason;
  }

  if (resultB.kind === "timeout") {
    await withOrderLock(item.order_id, async (conn) => {
      const [rows] = await conn.execute("SELECT * FROM order_items WHERE id = ? FOR UPDATE", [item.id]);
      if (!rows[0] || rows[0].status === "delivered") return;
      const allocated = await findAllocated(requestIdB);
      if (allocated?.code) {
        await completeItem(conn, rows[0], allocated.code, "B", requestIdB);
        return;
      }
      await markItem(conn, rows[0], "delivery_failed", "supplier_B_timeout");
    });
    return { failed: true, reason: "timeout", item_id: item.id };
  }

  if (resultB.kind === "rate_limited") {
    await withOrderLock(item.order_id, async (conn) => {
      const [rows] = await conn.execute("SELECT * FROM order_items WHERE id = ? FOR UPDATE", [item.id]);
      if (rows[0]) await markItem(conn, rows[0], "delivering", "rate_limited", 8);
    });
    return { failed: true, reason: "rate_limited", item_id: item.id };
  }

  const stockFail = resultA.reason === "out_of_stock" && (resultB.reason === "out_of_stock" || resultB.kind !== "ok");

  await withOrderLock(item.order_id, async (conn) => {
    const [rows] = await conn.execute("SELECT * FROM order_items WHERE id = ? FOR UPDATE", [item.id]);
    const current = rows[0];
    if (!current || current.status === "delivered" || current.status === "refunded") return;

    const allocated = (await findAllocated(requestIdA)) || (await findAllocated(requestIdB));
    if (allocated?.code) {
      const done = await completeItem(conn, current, allocated.code, allocated.supplier, allocated.request_id);
      if (done.delivered) return;
    }

    if (stockFail) {
      await markItem(conn, current, "out_of_stock", resultB.reason || resultA.reason);
      return;
    }

    const stolen = resultA.reason === "code_already_claimed" || resultB.reason === "code_already_claimed";
    const attempts = Number(current.fulfillment_attempts || 0) + 1;
    if (stolen || attempts >= MAX_FAIL_ATTEMPTS || (resultA.kind === "error" && resultB.kind !== "ok")) {
      await refundItem(conn, current, resultB.reason || resultA.reason || "undeliverable");
      return;
    }
    await markItem(conn, current, "delivery_failed", resultB.reason || resultA.reason || "delivery_failed");
  });

  return { failed: true, item_id: item.id };
}

export async function fulfillOrder(orderId) {
  const [items] = await pool.execute(
    `SELECT id FROM order_items
     WHERE order_id = ?
       AND status IN ('pending','delivering','out_of_stock','delivery_failed')
     ORDER BY line_no`,
    [orderId]
  );
  if (!items.length) {
    await withOrderLock(orderId, async (conn) => {
      await rollupOrder(conn, orderId);
    });
    return { skip: true, reason: "no_items" };
  }

  const results = [];
  for (const row of items) {
    try {
      results.push(await fulfillItem(row.id));
    } catch (err) {
      logger.error({ event: "fulfillment.item_error", order_id: orderId, item_id: row.id, err: err.message });
      results.push({ failed: true, item_id: row.id, error: err.message });
    }
  }
  return { order_id: orderId, results };
}

export async function recoverStuckOrders() {
  const [rows] = await pool.query(
    `SELECT i.id
     FROM order_items i
     JOIN orders o ON o.id = i.order_id
     WHERE i.status IN ('pending','delivering','out_of_stock','delivery_failed')
       AND i.delivery_code IS NULL
       AND o.status IN ('paid','delivering','out_of_stock','delivery_failed','partially_fulfilled')
       AND (i.next_retry_at IS NULL OR i.next_retry_at <= NOW(3))
       AND (i.lock_until IS NULL OR i.lock_until <= NOW(3))
     ORDER BY o.paid_at IS NULL, o.paid_at ASC, i.line_no ASC
     LIMIT 20`
  );

  for (const row of rows) {
    try {
      await fulfillItem(row.id);
    } catch (err) {
      logger.error({ event: "recovery.error", item_id: row.id, err: err.message });
    }
  }
}

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

export async function queueStats() {
  const [[items]] = await pool.query(`
    SELECT
      SUM(status IN ('pending','out_of_stock','delivery_failed')) AS queued,
      SUM(status = 'delivering') AS inflight,
      SUM(status = 'delivered') AS delivered,
      SUM(status = 'refunded') AS refunded
    FROM order_items
  `);
  const [[orders]] = await pool.query(`
    SELECT
      SUM(status = 'paid') AS paid,
      SUM(status = 'delivering') AS delivering,
      SUM(status = 'delivered') AS delivered,
      SUM(status = 'partially_fulfilled') AS partially_fulfilled,
      SUM(status = 'refunded') AS refunded
    FROM orders
  `);
  const [rpm] = await pool.query(`
    SELECT supplier, COUNT(*) AS calls_last_minute
    FROM supplier_call_log
    WHERE called_at > DATE_SUB(NOW(3), INTERVAL 60 SECOND)
    GROUP BY supplier
  `);
  const [limits] = await pool.query("SELECT name, rate_limit_rpm FROM supplier_runtime");
  return {
    items: {
      queued: Number(items?.queued || 0),
      inflight: Number(items?.inflight || 0),
      delivered: Number(items?.delivered || 0),
      refunded: Number(items?.refunded || 0),
    },
    orders: {
      paid: Number(orders?.paid || 0),
      delivering: Number(orders?.delivering || 0),
      delivered: Number(orders?.delivered || 0),
      partially_fulfilled: Number(orders?.partially_fulfilled || 0),
      refunded: Number(orders?.refunded || 0),
    },
    suppliers: Object.fromEntries(
      ["A", "B"].map((name) => {
        const limit = limits.find((r) => r.name === name);
        const used = rpm.find((r) => r.supplier === name);
        return [
          name,
          {
            rpm_limit: Number(limit?.rate_limit_rpm || config.suppliers.rateLimitRpm || 0),
            calls_last_minute: Number(used?.calls_last_minute || 0),
          },
        ];
      })
    ),
  };
}
