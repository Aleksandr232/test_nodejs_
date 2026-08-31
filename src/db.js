import mysql from "mysql2/promise";
import { config } from "./config.js";
import { logger } from "./logger.js";

export const pool = mysql.createPool(config.mysql);

// TODO(explain): waitForMysql — healthcheck ≠ «accepts connections»; без ретрая флапает boot.
export async function waitForMysql(attempts = 40) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const conn = await pool.getConnection();
      await conn.ping();
      conn.release();
      logger.info({ event: "db.ready", attempt: i });
      return;
    } catch (err) {
      lastErr = err;
      logger.warn({ event: "db.wait", attempt: i, err: err.message });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}

/**
 * Serialize all money/delivery mutations per order.
 * GET_LOCK is released before the connection returns to the pool.
 * TODO(explain): withOrderLock — GET_LOCK нужен, когда строки заказа ещё нет (вебхук до INSERT);
 * FOR UPDATE один не закрывает эту гонку. Отпустить lock до release() в пул.
 */
export async function withOrderLock(orderId, fn) {
  const conn = await pool.getConnection();
  const lockName = `ord:${orderId}`.slice(0, 64);
  try {
    const [lockRows] = await conn.query("SELECT GET_LOCK(?, 10) AS acquired", [lockName]);
    if (!lockRows[0]?.acquired) {
      const err = new Error("order_lock_timeout");
      err.status = 503;
      throw err;
    }
    await conn.beginTransaction();
    try {
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  } finally {
    try {
      await conn.query("SELECT RELEASE_LOCK(?)", [lockName]);
    } catch {
      /* ignore */
    }
    conn.release();
  }
}
