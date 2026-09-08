import { nanoid } from "nanoid";
import { pool, withOrderLock } from "../db.js";
import { logger } from "../logger.js";
import { getProduct } from "./catalog.js";
import { applyPaymentEvent } from "./payments.js";
import { fulfillOrder } from "./fulfillment.js";
import { appendEvent, replayOrderEvents } from "./events.js";
import { orderMoneyFromLedger } from "./ledger.js";

function itemCode(row) {
  return row.status === "delivered" ? row.delivery_code : null;
}

export function publicItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    sku: row.sku,
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status,
    code: itemCode(row),
    supplier: row.supplier_used,
    last_error: row.last_error,
    delivered_at: row.delivered_at,
    refunded_at: row.refunded_at,
  };
}

export function publicOrder(row, items = null, money = null) {
  if (!row) return null;
  const orderItems = items || [];
  const deliveredItems = orderItems.filter((i) => i.status === "delivered");
  const single = orderItems.length <= 1;
  const topCode = single && row.status === "delivered" ? row.delivery_code || deliveredItems[0]?.delivery_code : null;
  return {
    id: row.id,
    sku: row.sku,
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status,
    code: topCode,
    supplier: single ? row.supplier_used : null,
    items: orderItems.map(publicItem),
    money: money || {
      paid: ["created", "payment_failed"].includes(row.status) ? 0 : Number(row.amount),
      delivered: deliveredItems.reduce((s, i) => s + Number(i.amount), 0),
      refunded: orderItems.filter((i) => i.status === "refunded").reduce((s, i) => s + Number(i.amount), 0),
      outstanding: 0,
    },
    created_at: row.created_at,
    updated_at: row.updated_at,
    paid_at: row.paid_at,
    delivered_at: row.delivered_at,
    last_error: row.last_error,
  };
}

function normalizeLines(body) {
  if (Array.isArray(body?.items) && body.items.length) {
    return body.items;
  }
  if (body?.sku) return [{ sku: body.sku, qty: 1 }];
  return null;
}

export async function createOrder(body) {
  const lines = normalizeLines(body);
  if (!lines) {
    const err = new Error("sku_or_items_required");
    err.status = 400;
    throw err;
  }

  const products = [];
  for (const line of lines) {
    if (!line?.sku) {
      const err = new Error("sku_required");
      err.status = 400;
      throw err;
    }
    const product = await getProduct(line.sku);
    if (!product) {
      const err = new Error("sku_not_found");
      err.status = 404;
      throw err;
    }
    const qty = Number(line.qty || 1);
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) {
      const err = new Error("invalid_qty");
      err.status = 400;
      throw err;
    }
    for (let i = 0; i < qty; i++) products.push(product);
  }
  if (products.length > 20) {
    const err = new Error("too_many_items");
    err.status = 400;
    throw err;
  }

  const orderId = body.id || `ord_${nanoid(12)}`;
  const amount = products.reduce((s, p) => s + Number(p.price), 0);
  const currency = products[0].currency;

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
      [orderId, products[0].sku, amount, currency, `req_${orderId}-L1-A`]
    );

    const itemRows = [];
    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      const itemId = `${orderId}-L${i + 1}`;
      await conn.execute(
        `INSERT INTO order_items (id, order_id, line_no, sku, amount, currency, status, request_id)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [itemId, orderId, i + 1, product.sku, product.price, product.currency, `req_${itemId}-A`]
      );
      itemRows.push({
        id: itemId,
        sku: product.sku,
        amount: Number(product.price),
        currency: product.currency,
        status: "pending",
        delivery_code: null,
        supplier_used: null,
        last_error: null,
        delivered_at: null,
        refunded_at: null,
      });
    }

    await appendEvent(conn, {
      orderId,
      eventType: "order.created",
      payload: {
        sku: products[0].sku,
        amount,
        currency,
        items: itemRows.map((it) => ({ id: it.id, sku: it.sku, amount: it.amount })),
      },
    });

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
    const [freshItems] = await conn.execute("SELECT * FROM order_items WHERE order_id = ? ORDER BY line_no", [orderId]);
    return { order: rows[0], items: freshItems, shouldFulfill };
  });

  logger.info({
    event: "order.created",
    order_id: orderId,
    sku: products[0].sku,
    items: products.length,
    amount,
  });

  if (result.shouldFulfill) {
    setImmediate(() => {
      fulfillOrder(orderId).catch((err) =>
        logger.error({ event: "fulfillment.async_error", order_id: orderId, err: err.message })
      );
    });
  }

  const money = await orderMoneyFromLedger(orderId);
  return publicOrder(result.order, result.items, money);
}

export async function getOrder(id) {
  const [rows] = await pool.execute("SELECT * FROM orders WHERE id = ?", [id]);
  if (!rows[0]) return null;
  const [items] = await pool.execute("SELECT * FROM order_items WHERE order_id = ? ORDER BY line_no", [id]);
  const money = await orderMoneyFromLedger(id);
  return publicOrder(rows[0], items, money);
}

export async function getOrderAt(id, at) {
  const [orderRows] = await pool.execute("SELECT * FROM orders WHERE id = ?", [id]);
  if (!orderRows[0]) return null;
  const [rows] = await pool.execute("SELECT * FROM order_events WHERE order_id = ? ORDER BY id ASC", [id]);
  if (!rows.length) {
    if (at && new Date(orderRows[0].created_at).getTime() > new Date(at).getTime()) return null;
    const current = await getOrder(id);
    return { at, ...current, from_events: false };
  }
  return { id, at, from_events: true, ...replayOrderEvents(rows, at) };
}
