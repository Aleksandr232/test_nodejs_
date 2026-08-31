/**
 * Acceptance scenarios from the assignment.
 * Requires the stack: docker compose up --build
 *
 *   node scripts/acceptance.mjs
 */

const API = process.env.API_URL || "http://127.0.0.1:3000";
const SUP_A = process.env.SUPPLIER_A_URL || "http://127.0.0.1:3001";
const SUP_B = process.env.SUPPLIER_B_URL || "http://127.0.0.1:3002";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function waitHealth(url, label) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  throw new Error(`${label} is not healthy: ${url}`);
}

async function configure(url, body) {
  const r = await req("POST", `${url}/admin/config`, body);
  if (r.status !== 200) throw new Error(`config failed ${url}: ${JSON.stringify(r.json)}`);
}

async function createOrder(sku, id) {
  const r = await req("POST", `${API}/api/orders`, { sku, id });
  if (r.status !== 201) throw new Error(`create order: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

async function getOrder(id) {
  const r = await req("GET", `${API}/api/orders/${id}`);
  return r.json;
}

async function pay(order, { eventId, status = "paid", amount } = {}) {
  return req("POST", `${API}/webhook/payment`, {
    event_id: eventId || `evt_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    order_id: order.id,
    status,
    amount: amount ?? order.amount,
    currency: order.currency || "RUB",
    created_at: new Date().toISOString(),
  });
}

async function waitOrder(id, predicate, timeoutMs = 25000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await getOrder(id);
    if (predicate(last)) return last;
    await sleep(200);
  }
  throw new Error(`timeout waiting for order ${id}: ${JSON.stringify(last)}`);
}

async function issues(orderId) {
  // Both suppliers share MySQL; query once.
  const a = await req("GET", `${SUP_A}/admin/issues?order_id=${encodeURIComponent(orderId)}`);
  const rows = a.json.issues || [];
  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(row.request_id)) return false;
    seen.add(row.request_id);
    return true;
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function scenario(name, fn) {
  process.stdout.write(`\n▶ ${name}\n`);
  await fn();
  process.stdout.write(`  OK\n`);
}

async function resetSuppliers(a, b) {
  await configure(SUP_A, a);
  await configure(SUP_B, b);
}

async function main() {
  console.log("Waiting for stack...");
  await waitHealth(API, "api");
  await waitHealth(SUP_A, "supplier-a");
  await waitHealth(SUP_B, "supplier-b");

  await scenario("1) 50 parallel paid webhooks → exactly one delivery", async () => {
    await resetSuppliers(
      { fail_rate: 0, timeout_rate: 0, force_mode: "ok" },
      { fail_rate: 0, timeout_rate: 0, force_mode: "ok" }
    );
    const order = await createOrder("STEAM-TOPUP-500");
    const payloads = Array.from({ length: 50 }, (_, i) =>
      pay(order, { eventId: `evt_race_${order.id}_${i}` })
    );
    const results = await Promise.all(payloads);
    assert(
      results.every((r) => r.status === 200),
      "all webhooks must be 200"
    );
    const delivered = await waitOrder(order.id, (o) => o.status === "delivered");
    assert(delivered.code, "code must be present");
    const issued = await issues(order.id);
    const uniqueCodes = new Set(issued.map((x) => x.code));
    assert(uniqueCodes.size === 1, `expected 1 code, got ${uniqueCodes.size}: ${[...uniqueCodes]}`);
    const again = await getOrder(order.id);
    assert(again.code === delivered.code, "code must be stable");
  });

  await scenario("2) duplicate event_id is a no-op", async () => {
    await resetSuppliers(
      { fail_rate: 0, timeout_rate: 0, force_mode: "ok" },
      { fail_rate: 0, timeout_rate: 0, force_mode: "ok" }
    );
    const order = await createOrder("STEAM-TOPUP-1000");
    const eventId = `evt_dup_${order.id}`;
    const first = await pay(order, { eventId });
    const second = await pay(order, { eventId });
    assert(first.status === 200 && second.status === 200, "both 200");
    assert(second.json.duplicate === true, "second must be marked duplicate");
    const delivered = await waitOrder(order.id, (o) => o.status === "delivered");
    const extra = await pay(order, { eventId });
    assert(extra.json.duplicate === true, "replay after delivery is duplicate");
    const after = await getOrder(order.id);
    assert(after.status === "delivered" && after.code === delivered.code, "unchanged");
    const issued = await issues(order.id);
    assert(new Set(issued.map((x) => x.code)).size === 1, "still one code");
  });

  await scenario("3a) webhook before order is applied on create", async () => {
    await resetSuppliers(
      { fail_rate: 0, timeout_rate: 0, force_mode: "ok" },
      { fail_rate: 0, timeout_rate: 0, force_mode: "ok" }
    );
    const id = `ord_early_${Date.now()}`;
    const hook = await req("POST", `${API}/webhook/payment`, {
      event_id: `evt_early_${id}`,
      order_id: id,
      status: "paid",
      amount: 1290,
      currency: "RUB",
      created_at: new Date().toISOString(),
    });
    assert(hook.status === 200 && hook.json.pending === true, "pending until order exists");
    const order = await createOrder("KEY-CS2-PRIME", id);
    assert(order.id === id, "client-supplied id");
    const delivered = await waitOrder(id, (o) => o.status === "delivered");
    assert(delivered.code, "delivered from early webhook");
  });

  await scenario("3b) failed webhook after paid is ignored", async () => {
    const order = await createOrder("SUB-SPOTIFY-1M");
    await pay(order);
    const delivered = await waitOrder(order.id, (o) => o.status === "delivered");
    const failed = await pay(order, { eventId: `evt_late_fail_${order.id}`, status: "failed" });
    assert(failed.status === 200, "failed webhook accepted");
    const after = await getOrder(order.id);
    assert(after.status === "delivered" && after.code === delivered.code, "paid/delivered wins");
  });

  await scenario("4) timeout trap: same request_id, no double issue", async () => {
    await resetSuppliers(
      { fail_rate: 0, timeout_rate: 0, force_mode: "timeout", hang_ms: 15000 },
      { fail_rate: 0, timeout_rate: 0, force_mode: "ok" }
    );
    const order = await createOrder("KEY-GTA5");
    await pay(order);
    const delivered = await waitOrder(order.id, (o) => o.status === "delivered", 40000);
    assert(delivered.supplier === "A", `must stay on A after timeout, got ${delivered.supplier}`);
    const issued = await issues(order.id);
    const fromA = issued.filter((x) => x.supplier === "A");
    const fromB = issued.filter((x) => x.supplier === "B");
    assert(fromA.length === 1, `A must issue exactly once, got ${fromA.length}`);
    assert(fromB.length === 0, "must not fallback to B after timeout");
    assert(delivered.code === fromA[0].code, "order code matches allocated code");
  });

  await scenario("5) supplier A down → fallback B, one delivery", async () => {
    await resetSuppliers(
      { fail_rate: 0, timeout_rate: 0, force_mode: "fail" },
      { fail_rate: 0, timeout_rate: 0, force_mode: "ok" }
    );
    const order = await createOrder("GIFT-PSN-1000");
    await pay(order);
    const delivered = await waitOrder(order.id, (o) => o.status === "delivered");
    assert(delivered.supplier === "B", `expected B, got ${delivered.supplier}`);
    const issued = await issues(order.id);
    assert(issued.filter((x) => x.supplier === "A").length === 0, "A must not allocate on fail");
    assert(issued.filter((x) => x.supplier === "B").length === 1, "B issues once");
  });

  await scenario("6) empty stock is recoverable, no crash", async () => {
    await resetSuppliers(
      { fail_rate: 0, timeout_rate: 0, force_mode: "ok" },
      { fail_rate: 0, timeout_rate: 0, force_mode: "ok" }
    );
    const order = await createOrder("EMPTY-STOCK");
    await pay(order);
    const empty = await waitOrder(
      order.id,
      (o) => o.status === "out_of_stock" || o.status === "delivery_failed"
    );
    assert(empty.status === "out_of_stock" || empty.status === "delivery_failed", "recoverable");
    assert(!empty.code, "no code yet");

    const code = `REST-${Date.now()}`;
    const stock = await req("POST", `${API}/api/admin/restock`, { sku: "EMPTY-STOCK", code });
    assert(stock.status === 200, "restock ok");
    await req("POST", `${API}/api/orders/${order.id}/retry-delivery`);
    const delivered = await waitOrder(order.id, (o) => o.status === "delivered");
    assert(delivered.code === code, "restocked key delivered");
  });

  const rec = await req("GET", `${API}/api/reconcile`);
  assert(rec.json.ledger.balanced, "ledger must balance");
  assert(rec.json.delivered_not_paid.length === 0, "no delivered-without-payment");
  assert(rec.json.orders_with_multiple_codes.length === 0, "no double issue per order");

  const explain = await req("GET", `${API}/api/catalog/explain`);
  console.log("\nStorefront EXPLAIN:");
  console.log(JSON.stringify(explain.json.plan, null, 2));

  await resetSuppliers(
    { fail_rate: 0.2, timeout_rate: 0.15, force_mode: "none" },
    { fail_rate: 0.08, timeout_rate: 0.05, force_mode: "none" }
  );

  console.log("\nAll acceptance checks passed.");
}

main().catch((err) => {
  console.error("\nFAILED:", err.message);
  process.exit(1);
});
