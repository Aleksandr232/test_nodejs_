import express from "express";
import { pool } from "../db.js";
import { waitForMysql } from "../db.js";
import { migrate } from "../migrate.js";
import { waitForCatalog } from "../seed.js";
import { logger } from "../logger.js";

const name = (process.env.SUPPLIER_NAME || "A").slice(0, 8);
const port = Number(process.env.PORT || 3001);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// TODO(explain): getRuntime — хаос в БД, не в env: тесты переключают force_mode без рестарта контейнера.
async function getRuntime() {
  const [rows] = await pool.execute("SELECT * FROM supplier_runtime WHERE name = ?", [name]);
  if (rows[0]) {
    return {
      fail_rate: Number(rows[0].fail_rate),
      timeout_rate: Number(rows[0].timeout_rate),
      force_mode: rows[0].force_mode || "none",
      hang_ms: Number(rows[0].hang_ms || process.env.HANG_MS || 20000),
    };
  }
  return {
    fail_rate: Number(process.env.FAIL_RATE || 0),
    timeout_rate: Number(process.env.TIMEOUT_RATE || 0),
    force_mode: process.env.FORCE_MODE || "none",
    hang_ms: Number(process.env.HANG_MS || 20000),
  };
}

// TODO(explain): pickChaos — fail до аллокации, timeout после; иначе fallback после timeout выдаст второй ключ.
function pickChaos(runtime) {
  if (runtime.force_mode && runtime.force_mode !== "none") return runtime.force_mode;
  const r = Math.random();
  if (r < runtime.fail_rate) return "fail";
  if (r < runtime.fail_rate + runtime.timeout_rate) return "timeout";
  return "ok";
}

// TODO(explain): withRequestLock — параллельный retry того же request_id не должен взять два ключа.
async function withRequestLock(requestId, fn) {
  const conn = await pool.getConnection();
  const lockName = `req:${requestId}`.slice(0, 64);
  try {
    const [lockRows] = await conn.query("SELECT GET_LOCK(?, 10) AS acquired", [lockName]);
    if (!lockRows[0]?.acquired) {
      const err = new Error("lock_timeout");
      err.status = 503;
      throw err;
    }
    await conn.beginTransaction();
    try {
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (e) {
      await conn.rollback();
      throw e;
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

// TODO(explain): getOrAllocate — сначала ищем request_id, потом ключ FOR UPDATE; UNIQUE code + декремент stock в той же tx.
async function getOrAllocate(requestId, sku, orderId) {
  return withRequestLock(requestId, async (conn) => {
    const [existing] = await conn.execute(
      "SELECT * FROM supplier_issues WHERE request_id = ? FOR UPDATE",
      [requestId]
    );
    if (existing[0]) {
      return { existing: true, code: existing[0].code, request_id: requestId };
    }

    const [keys] = await conn.execute(
      `SELECT id, code FROM inventory_keys
       WHERE sku = ? AND status = 'available'
       ORDER BY id
       LIMIT 1
       FOR UPDATE`,
      [sku]
    );
    if (!keys[0]) {
      return { existing: false, outOfStock: true };
    }

    const [upd] = await conn.execute(
      `UPDATE inventory_keys
       SET status = 'issued',
           issued_to_order_id = ?,
           issued_request_id = ?,
           issued_by_supplier = ?
       WHERE id = ? AND status = 'available'`,
      [orderId, requestId, name, keys[0].id]
    );
    if (upd.affectedRows === 0) {
      return { existing: false, outOfStock: true };
    }

    await conn.execute(
      `INSERT INTO supplier_issues (request_id, supplier, sku, order_id, code)
       VALUES (?, ?, ?, ?, ?)`,
      [requestId, name, sku, orderId, keys[0].code]
    );
    await conn.execute(
      `UPDATE products SET stock = IF(stock > 0, stock - 1, 0) WHERE sku = ?`,
      [sku]
    );

    return { existing: false, code: keys[0].code, request_id: requestId };
  });
}

async function main() {
  // TODO(explain): supplier main — waitForCatalog, не свой seed; иначе два контейнера дерут пул.
  await waitForMysql();
  await migrate();
  await waitForCatalog();

  await pool.execute(
    `INSERT INTO supplier_runtime (name, fail_rate, timeout_rate, force_mode, hang_ms)
     VALUES (?, ?, ?, 'none', ?)
     ON DUPLICATE KEY UPDATE fail_rate = VALUES(fail_rate), timeout_rate = VALUES(timeout_rate), hang_ms = VALUES(hang_ms)`,
    [name, Number(process.env.FAIL_RATE || 0), Number(process.env.TIMEOUT_RATE || 0), Number(process.env.HANG_MS || 20000)]
  );

  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true, supplier: name }));

  app.post("/admin/config", async (req, res) => {
    const fail_rate = req.body.fail_rate ?? 0;
    const timeout_rate = req.body.timeout_rate ?? 0;
    const force_mode = req.body.force_mode || "none";
    const hang_ms = req.body.hang_ms ?? Number(process.env.HANG_MS || 20000);
    await pool.execute(
      `INSERT INTO supplier_runtime (name, fail_rate, timeout_rate, force_mode, hang_ms)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         fail_rate = VALUES(fail_rate),
         timeout_rate = VALUES(timeout_rate),
         force_mode = VALUES(force_mode),
         hang_ms = VALUES(hang_ms)`,
      [name, fail_rate, timeout_rate, force_mode, hang_ms]
    );
    logger.info({ event: "supplier.config", supplier: name, fail_rate, timeout_rate, force_mode });
    res.json({ ok: true, name, fail_rate, timeout_rate, force_mode, hang_ms });
  });

  app.get("/admin/issues", async (req, res) => {
    const orderId = req.query.order_id;
    const sql = orderId
      ? ["SELECT * FROM supplier_issues WHERE order_id = ?", [orderId]]
      : ["SELECT * FROM supplier_issues WHERE supplier = ? ORDER BY created_at DESC LIMIT 100", [name]];
    const [rows] = await pool.execute(sql[0], sql[1]);
    res.json({ issues: rows });
  });

  /**
   * Timeout trap: allocate the key FIRST, then optionally hang.
   * Retry with the same request_id returns the same code and does not hang.
   * TODO(explain): POST /issue — fail без аллокации; timeout после commit; idempotent hit без hang.
   */
  app.post("/issue", async (req, res) => {
    const { request_id, sku, order_id } = req.body || {};
    if (!request_id || !sku || !order_id) {
      return res.status(400).json({ status: "error", reason: "invalid_request" });
    }

    try {
      const [already] = await pool.execute(
        "SELECT code FROM supplier_issues WHERE request_id = ?",
        [request_id]
      );
      if (already[0]) {
        logger.info({ event: "supplier.idempotent_hit", supplier: name, request_id, order_id });
        return res.json({ status: "ok", request_id, code: already[0].code });
      }

      const runtime = await getRuntime();
      const chaos = pickChaos(runtime);

      if (chaos === "fail") {
        logger.info({ event: "supplier.forced_fail", supplier: name, request_id, order_id });
        return res.status(503).json({ status: "error", reason: "unavailable" });
      }
      if (chaos === "out_of_stock") {
        return res.status(409).json({ status: "error", reason: "out_of_stock" });
      }

      const issued = await getOrAllocate(request_id, sku, order_id);
      if (issued.outOfStock) {
        logger.info({ event: "supplier.out_of_stock", supplier: name, request_id, sku, order_id });
        return res.status(409).json({ status: "error", reason: "out_of_stock" });
      }

      if (chaos === "timeout") {
        logger.warn({
          event: "supplier.hang_after_allocate",
          supplier: name,
          request_id,
          order_id,
          hang_ms: runtime.hang_ms,
        });
        await sleep(runtime.hang_ms);
        if (!res.headersSent && !req.destroyed) {
          return res.json({ status: "ok", request_id, code: issued.code });
        }
        return;
      }

      return res.json({ status: "ok", request_id, code: issued.code });
    } catch (err) {
      logger.error({ event: "supplier.issue_error", err: err.message, request_id });
      if (!res.headersSent) {
        res.status(err.status || 500).json({ status: "error", reason: err.message });
      }
    }
  });

  app.listen(port, "0.0.0.0", () => {
    logger.info({ event: "supplier.listen", supplier: name, port });
  });
}

main().catch((err) => {
  logger.error({ event: "supplier.fatal", err: err.message });
  process.exit(1);
});
