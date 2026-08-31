import { pool } from "../db.js";
import { logger } from "../logger.js";
import { fulfillOrder } from "./fulfillment.js";

// TODO(explain): restock — восстановление out_of_stock без ручного SQL; UNIQUE code не даст вставить дубль.
export async function restock({ sku, code }) {
  if (!sku || !code) {
    const err = new Error("sku_and_code_required");
    err.status = 400;
    throw err;
  }
  try {
    await pool.execute(
      `INSERT INTO inventory_keys (sku, code, status) VALUES (?, ?, 'available')`,
      [sku, code]
    );
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") {
      const err = new Error("code_exists");
      err.status = 409;
      throw err;
    }
    throw e;
  }
  await pool.execute(`UPDATE products SET stock = stock + 1 WHERE sku = ?`, [sku]);
  logger.info({ event: "inventory.restock", sku, code: "***" });
  return { ok: true, sku };
}

// TODO(explain): retryDelivery — тот же fulfillOrder, не отдельный «ручной» путь (иначе разъедутся гарантии).
export async function retryDelivery(orderId) {
  const result = await fulfillOrder(orderId);
  return result;
}
