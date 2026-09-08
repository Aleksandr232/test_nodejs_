export async function appendEvent(conn, { orderId, itemId = null, eventType, payload = {} }) {
  await conn.execute(
    `INSERT INTO order_events (order_id, item_id, event_type, payload) VALUES (?, ?, ?, ?)`,
    [orderId, itemId, eventType, JSON.stringify(payload)]
  );
}

export function replayOrderEvents(events, until = null) {
  let cut = Infinity;
  if (until) {
    const t = new Date(until).getTime();
    if (Number.isFinite(t)) cut = t;
  }
  const state = {
    status: null,
    amount: 0,
    currency: "RUB",
    sku: null,
    paid_at: null,
    items: new Map(),
    money: { paid: 0, delivered: 0, refunded: 0 },
  };

  for (const ev of events) {
    const ts = new Date(ev.created_at).getTime();
    if (ts > cut) break;
    const payload = typeof ev.payload === "string" ? JSON.parse(ev.payload) : ev.payload || {};

    if (ev.event_type === "order.created") {
      state.status = "created";
      state.amount = Number(payload.amount || 0);
      state.currency = payload.currency || "RUB";
      state.sku = payload.sku || null;
      for (const item of payload.items || []) {
        state.items.set(item.id, {
          id: item.id,
          sku: item.sku,
          amount: Number(item.amount),
          status: "pending",
          code: null,
          supplier: null,
        });
      }
    } else if (ev.event_type === "order.paid") {
      state.status = "paid";
      state.paid_at = ev.created_at;
      state.money.paid = Number(payload.amount || state.amount);
    } else if (ev.event_type === "order.status") {
      state.status = payload.status || state.status;
    } else if (ev.event_type === "item.delivered") {
      const item = state.items.get(ev.item_id) || { id: ev.item_id, sku: payload.sku, amount: Number(payload.amount || 0) };
      item.status = "delivered";
      item.code = payload.code || item.code;
      item.supplier = payload.supplier || item.supplier;
      state.items.set(ev.item_id, item);
      state.money.delivered += Number(payload.amount || item.amount || 0);
    } else if (ev.event_type === "item.refunded") {
      const item = state.items.get(ev.item_id) || { id: ev.item_id, sku: payload.sku, amount: Number(payload.amount || 0) };
      item.status = "refunded";
      item.code = null;
      state.items.set(ev.item_id, item);
      state.money.refunded += Number(payload.amount || item.amount || 0);
    } else if (ev.event_type === "item.status") {
      const item = state.items.get(ev.item_id) || { id: ev.item_id, sku: payload.sku, amount: Number(payload.amount || 0) };
      item.status = payload.status || item.status;
      item.last_error = payload.error || item.last_error;
      state.items.set(ev.item_id, item);
    }
  }

  state.money.outstanding = Math.round((state.money.paid - state.money.delivered - state.money.refunded) * 100) / 100;
  return {
    status: state.status,
    amount: state.amount,
    currency: state.currency,
    sku: state.sku,
    paid_at: state.paid_at,
    items: [...state.items.values()],
    money: state.money,
  };
}
