import { pool } from "../db.js";

const STOREFRONT_SELECT = `
  SELECT sku, name, type, price, currency, image, stock
  FROM products
  WHERE in_stock = 1
  ORDER BY sku
`;

// TODO(explain): listStorefront — stock денормализован; LIMIT после clamp int (mysql2 prepared LIMIT капризен).
export async function listStorefront({ limit = 50, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const [items] = await pool.query(
    `${STOREFRONT_SELECT} LIMIT ${safeLimit} OFFSET ${safeOffset}`
  );
  const [[{ total }]] = await pool.query(
    "SELECT COUNT(*) AS total FROM products WHERE in_stock = 1"
  );
  return { items, total, limit: safeLimit, offset: safeOffset };
}

// TODO(explain): getProduct — PK lookup, без JOIN на ключи (stock уже на products).
export async function getProduct(sku) {
  const [rows] = await pool.execute(
    "SELECT sku, name, type, price, currency, image, stock FROM products WHERE sku = ?",
    [sku]
  );
  return rows[0] || null;
}

// TODO(explain): explainStorefront — при полном in_stock оптимизатор берёт PRIMARY+LIMIT; idx_vitrine для дыр в остатках.
export async function explainStorefront() {
  const [plan] = await pool.query(`EXPLAIN ${STOREFRONT_SELECT} LIMIT 50 OFFSET 0`);
  return {
    query: `${STOREFRONT_SELECT} LIMIT 50 OFFSET 0`.replace(/\s+/g, " ").trim(),
    plan,
    notes: [
      "in_stock — generated stored column (stock > 0), индекс idx_vitrine (in_stock, sku).",
      "При почти полном in_stock=1 оптимизатор часто берёт PRIMARY (sku) + LIMIT: 50 строк, Using where, без filesort.",
      "idx_vitrine нужен, когда доля нулевых остатков высока или OFFSET большой: ref по in_stock, order по sku.",
      "stock денормализован на products и обновляется в той же транзакции, что и выдача ключа.",
      "Под нагрузкой витрину читают с реплики; запись stock — только primary. Кэш sku→stock при необходимости.",
    ],
  };
}
