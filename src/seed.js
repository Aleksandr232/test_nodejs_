import { pool } from "./db.js";
import { logger } from "./logger.js";
import { CATALOG, KEY_POOL } from "./data/catalog.js";
import { config } from "./config.js";

// TODO(explain): extraProducts — 2500 SKU для этапа 5, не для красоты каталога.
function extraProducts(n) {
  const types = ["key", "topup", "giftcard", "subscription"];
  const out = [];
  for (let i = 1; i <= n; i++) {
    const sku = `GEN-${String(i).padStart(4, "0")}`;
    out.push({
      sku,
      name: `Generated item ${i}`,
      type: types[i % types.length],
      price: 100 + (i % 50) * 10,
      currency: "RUB",
      image: "assets/gen.png",
    });
  }
  return out;
}

// TODO(explain): insertInChunks — multi-row INSERT, иначе 2500 round-trip на старте.
async function insertInChunks(rows, buildSql) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { sql, values } = buildSql(chunk);
      await conn.query(sql, values);
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// TODO(explain): refreshProductStock — витрина читает products.stock, не COUNT(*) на каждый GET.
export async function refreshProductStock() {
  await pool.query(`
    UPDATE products p
    SET stock = (
      SELECT COUNT(*) FROM inventory_keys k
      WHERE k.sku = p.sku AND k.status = 'available'
    )
  `);
}

// TODO(explain): seed — INSERT IGNORE идемпотентен; EMPTY-STOCK без ключей для сценария 6;
// alias keyCnt, не keys (reserved word MySQL).
export async function seed() {
  const extras = extraProducts(config.catalogExtraSkus);
  const emptySku = {
    sku: "EMPTY-STOCK",
    name: "Empty stock (recovery test)",
    type: "key",
    price: 100,
    currency: "RUB",
    image: "assets/gen.png",
  };
  const allProducts = [...CATALOG.products, emptySku, ...extras];

  await insertInChunks(allProducts, (chunk) => ({
    sql: `INSERT IGNORE INTO products (sku, name, type, price, currency, image, stock) VALUES ${chunk
      .map(() => "(?,?,?,?,?,?,0)")
      .join(",")}`,
    values: chunk.flatMap((p) => [p.sku, p.name, p.type, p.price, p.currency, p.image]),
  }));

  const [[{ keyCnt }]] = await pool.query("SELECT COUNT(*) AS keyCnt FROM inventory_keys");
  if (keyCnt === 0) {
    const mainSkus = CATALOG.products.map((p) => p.sku);
    const keyRows = KEY_POOL.map((code, i) => ({
      sku: mainSkus[i % mainSkus.length],
      code,
    }));
    for (const p of extras) {
      keyRows.push({ sku: p.sku, code: `${p.sku}-K1` });
    }
    await insertInChunks(keyRows, (chunk) => ({
      sql: `INSERT IGNORE INTO inventory_keys (sku, code, status) VALUES ${chunk
        .map(() => "(?,?,'available')")
        .join(",")}`,
      values: chunk.flatMap((r) => [r.sku, r.code]),
    }));
    logger.info({ event: "seed.keys", count: keyRows.length });
  }

  await refreshProductStock();

  await pool.execute(
    `INSERT IGNORE INTO supplier_runtime (name, fail_rate, timeout_rate, force_mode, hang_ms)
     VALUES ('A', 0.20, 0.15, 'none', 20000), ('B', 0.08, 0.05, 'none', 20000)`
  );

  logger.info({ event: "seed.products", count: allProducts.length });
}

// TODO(explain): waitForCatalog — поставщики не сидят каталог сами, ждут app, иначе гонка пустого пула.
export async function waitForCatalog(attempts = 60) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const [[{ cnt }]] = await pool.query("SELECT COUNT(*) AS cnt FROM products");
      if (cnt > 0) return;
    } catch {
      /* tables may not exist yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("catalog_seed_timeout");
}
