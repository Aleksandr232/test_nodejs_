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

function parseFailSkus(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return String(raw)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
}

async function getRuntime() {
  const [rows] = await pool.execute("SELECT * FROM supplier_runtime WHERE name = ?", [name]);
  if (rows[0]) {
    return {
      fail_rate: Number(rows[0].fail_rate),
      timeout_rate: Number(rows[0].timeout_rate),
      force_mode: rows[0].force_mode || "none",
      hang_ms: Number(rows[0].hang_ms || process.env.HANG_MS || 20000),
      fail_skus: parseFailSkus(rows[0].fail_skus),
      rate_limit_rpm: Number(rows[0].rate_limit_rpm || 0),
    };
  }
  return {
    fail_rate: Number(process.env.FAIL_RATE || 0),
    timeout_rate: Number(process.env.TIMEOUT_RATE || 0),
    force_mode: process.env.FORCE_MODE || "none",
    hang_ms: Number(process.env.HANG_MS || 20000),
    fail_skus: [],
    rate_limit_rpm: 0,
  };
}

function pickChaos(runtime, sku) {
  if (runtime.fail_skus.includes(sku)) return "fail";
  if (runtime.force_mode && runtime.force_mode !== "none") return runtime.force_mode;
  const r = Math.random();
  if (r < runtime.fail_rate) return "fail";
  if (r < runtime.fail_rate + runtime.timeout_rate) return "timeout";
  return "ok";
}

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

async function allowRpm(runtime) {
  const rpm = Number(runtime.rate_limit_rpm || 0);
  if (rpm <= 0) return true;
  const conn = await pool.getConnection();
  const lockName = `rpm:${name}`.slice(0, 64);
  try {
    await conn.query("SELECT GET_LOCK(?, 5) AS acquired", [lockName]);
    const [[{ cnt }]] = await conn.execute(
      `SELECT COUNT(*) AS cnt FROM supplier_call_log
       WHERE supplier = ? AND called_at > DATE_SUB(NOW(3), INTERVAL 60 SECOND)`,
      [name]
    );
    if (Number(cnt) >= rpm) return false;
    await conn.execute("INSERT INTO supplier_call_log (supplier) VALUES (?)", [name]);
    return true;
  } finally {
    try {
      await conn.query("SELECT RELEASE_LOCK(?)", [lockName]);
    } catch {
      /* ignore */
    }
    conn.release();
  }
}

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

async function allocateDuplicate(requestId, sku, orderId) {
  return withRequestLock(requestId, async (conn) => {
    const [existing] = await conn.execute(
      "SELECT * FROM supplier_issues WHERE request_id = ? FOR UPDATE",
      [requestId]
    );
    if (existing[0]) {
      return { existing: true, code: existing[0].code, request_id: requestId };
    }

    const [stolen] = await conn.execute(
      `SELECT code FROM supplier_issues WHERE supplier = ? AND request_id <> ? LIMIT 1`,
      [name, requestId]
    );
    if (!stolen[0]) {
      return { fallbackAllocate: true };
    }

    await conn.execute(
      `INSERT INTO supplier_issues (request_id, supplier, sku, order_id, code)
       VALUES (?, ?, ?, ?, ?)`,
      [requestId, name, sku, orderId, stolen[0].code]
    );
    return { existing: false, code: stolen[0].code, request_id: requestId, duplicate: true };
  });
}

async function main() {
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
    const fail_skus = req.body.fail_skus ? JSON.stringify(req.body.fail_skus) : null;
    const rate_limit_rpm = req.body.rate_limit_rpm ?? 0;
    await pool.execute(
      `INSERT INTO supplier_runtime (name, fail_rate, timeout_rate, force_mode, hang_ms, fail_skus, rate_limit_rpm)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         fail_rate = VALUES(fail_rate),
         timeout_rate = VALUES(timeout_rate),
         force_mode = VALUES(force_mode),
         hang_ms = VALUES(hang_ms),
         fail_skus = VALUES(fail_skus),
         rate_limit_rpm = VALUES(rate_limit_rpm)`,
      [name, fail_rate, timeout_rate, force_mode, hang_ms, fail_skus, rate_limit_rpm]
    );
    logger.info({ event: "supplier.config", supplier: name, fail_rate, timeout_rate, force_mode, rate_limit_rpm, fail_skus });
    res.json({ ok: true, name, fail_rate, timeout_rate, force_mode, hang_ms, fail_skus: req.body.fail_skus || [], rate_limit_rpm });
  });

  app.get("/admin/issues", async (req, res) => {
    const orderId = req.query.order_id;
    const sql = orderId
      ? ["SELECT * FROM supplier_issues WHERE order_id = ?", [orderId]]
      : ["SELECT * FROM supplier_issues WHERE supplier = ? ORDER BY created_at DESC LIMIT 100", [name]];
    const [rows] = await pool.execute(sql[0], sql[1]);
    res.json({ issues: rows });
  });

  app.get("/issue/:request_id", async (req, res) => {
    const [rows] = await pool.execute("SELECT request_id, supplier, sku, order_id, code FROM supplier_issues WHERE request_id = ?", [
      req.params.request_id,
    ]);
    if (!rows[0]) return res.status(404).json({ status: "error", reason: "not_found" });
    res.json({ status: "ok", ...rows[0] });
  });

  app.post("/issue", async (req, res) => {
    const { request_id, sku, order_id } = req.body || {};
    if (!request_id || !sku || !order_id) {
      return res.status(400).json({ status: "error", reason: "invalid_request" });
    }

    try {
      const [already] = await pool.execute("SELECT code FROM supplier_issues WHERE request_id = ?", [request_id]);
      if (already[0]) {
        logger.info({ event: "supplier.idempotent_hit", supplier: name, request_id, order_id });
        return res.json({ status: "ok", request_id, code: already[0].code });
      }

      const runtime = await getRuntime();
      if (!(await allowRpm(runtime))) {
        logger.warn({ event: "supplier.rate_limited", supplier: name, request_id, rpm: runtime.rate_limit_rpm });
        return res.status(429).json({ status: "error", reason: "rate_limited" });
      }

      const chaos = pickChaos(runtime, sku);

      if (chaos === "fail") {
        logger.info({ event: "supplier.forced_fail", supplier: name, request_id, order_id, sku });
        return res.status(503).json({ status: "error", reason: "unavailable" });
      }
      if (chaos === "out_of_stock") {
        return res.status(409).json({ status: "error", reason: "out_of_stock" });
      }

      let issued;
      if (chaos === "duplicate_code") {
        issued = await allocateDuplicate(request_id, sku, order_id);
        if (issued.fallbackAllocate) {
          issued = await getOrAllocate(request_id, sku, order_id);
        }
      } else {
        issued = await getOrAllocate(request_id, sku, order_id);
      }

      if (issued.outOfStock) {
        logger.info({ event: "supplier.out_of_stock", supplier: name, request_id, sku, order_id });
        return res.status(409).json({ status: "error", reason: "out_of_stock" });
      }

      if (chaos === "lie_error") {
        logger.warn({ event: "supplier.lie_error", supplier: name, request_id, order_id, note: "allocated_but_http_error" });
        return res.status(503).json({ status: "error", reason: "unavailable" });
      }

      if (chaos === "wrong_code") {
        const fake = `WRONG-${request_id.slice(-8)}`;
        logger.warn({ event: "supplier.wrong_code", supplier: name, request_id, order_id });
        return res.json({ status: "ok", request_id, code: fake });
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
