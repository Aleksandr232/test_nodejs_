import { pool } from "./db.js";
import { logger } from "./logger.js";

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS products (
    sku VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(32) NOT NULL,
    price DECIMAL(12,2) NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'RUB',
    image VARCHAR(255) NULL,
    stock INT UNSIGNED NOT NULL DEFAULT 0,
    in_stock TINYINT GENERATED ALWAYS AS (stock > 0) STORED,
    KEY idx_vitrine (in_stock, sku),
    KEY idx_type_stock (type, stock)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS inventory_keys (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    sku VARCHAR(64) NOT NULL,
    code VARCHAR(64) NOT NULL,
    status ENUM('available','issued') NOT NULL DEFAULT 'available',
    issued_to_order_id VARCHAR(64) NULL,
    issued_request_id VARCHAR(64) NULL,
    issued_by_supplier VARCHAR(8) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_code (code),
    KEY idx_sku_status (sku, status),
    KEY idx_order (issued_to_order_id)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS orders (
    id VARCHAR(64) PRIMARY KEY,
    sku VARCHAR(64) NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    currency CHAR(3) NOT NULL,
    status ENUM(
      'created','paid','delivering','delivered',
      'payment_failed','out_of_stock','delivery_failed',
      'partially_fulfilled','refunded'
    ) NOT NULL,
    delivery_code VARCHAR(64) NULL,
    supplier_used VARCHAR(8) NULL,
    request_id VARCHAR(64) NULL,
    fulfillment_attempts INT NOT NULL DEFAULT 0,
    next_retry_at DATETIME(3) NULL,
    lock_until DATETIME(3) NULL,
    last_error VARCHAR(255) NULL,
    UNIQUE KEY uk_delivery_code (delivery_code),
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    paid_at DATETIME(3) NULL,
    delivered_at DATETIME(3) NULL,
    KEY idx_status_retry (status, next_retry_at),
    KEY idx_sku (sku)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS payment_events (
    event_id VARCHAR(64) PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    currency CHAR(3) NOT NULL,
    payload JSON NOT NULL,
    processed TINYINT NOT NULL DEFAULT 0,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY idx_order_processed (order_id, processed)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS supplier_issues (
    request_id VARCHAR(64) PRIMARY KEY,
    supplier VARCHAR(8) NOT NULL,
    sku VARCHAR(64) NOT NULL,
    order_id VARCHAR(64) NOT NULL,
    code VARCHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY idx_code (code),
    KEY idx_order (order_id)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS ledger_entries (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL,
    item_id VARCHAR(64) NOT NULL DEFAULT '',
    event_type VARCHAR(16) NOT NULL DEFAULT 'legacy',
    account ENUM('cash','prepaid','revenue') NOT NULL,
    direction ENUM('debit','credit') NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_idempotent (order_id, item_id, event_type, account, direction),
    KEY idx_created (created_at),
    KEY idx_order (order_id)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS supplier_runtime (
    name VARCHAR(8) PRIMARY KEY,
    fail_rate DECIMAL(5,4) NOT NULL DEFAULT 0,
    timeout_rate DECIMAL(5,4) NOT NULL DEFAULT 0,
    force_mode VARCHAR(32) NOT NULL DEFAULT 'none',
    hang_ms INT NOT NULL DEFAULT 20000,
    fail_skus TEXT NULL,
    rate_limit_rpm INT NOT NULL DEFAULT 0,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS order_items (
    id VARCHAR(64) PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL,
    line_no INT NOT NULL,
    sku VARCHAR(64) NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    currency CHAR(3) NOT NULL,
    status ENUM('pending','delivering','delivered','refunded','out_of_stock','delivery_failed') NOT NULL DEFAULT 'pending',
    delivery_code VARCHAR(64) NULL,
    supplier_used VARCHAR(8) NULL,
    request_id VARCHAR(64) NULL,
    fulfillment_attempts INT NOT NULL DEFAULT 0,
    next_retry_at DATETIME(3) NULL,
    lock_until DATETIME(3) NULL,
    last_error VARCHAR(255) NULL,
    delivered_at DATETIME(3) NULL,
    refunded_at DATETIME(3) NULL,
    UNIQUE KEY uk_item_code (delivery_code),
    UNIQUE KEY uk_order_line (order_id, line_no),
    KEY idx_order (order_id),
    KEY idx_retry (status, next_retry_at, lock_until)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS claimed_codes (
    code VARCHAR(64) PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL,
    item_id VARCHAR(64) NOT NULL,
    request_id VARCHAR(64) NOT NULL,
    supplier VARCHAR(8) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_item (item_id),
    KEY idx_request (request_id),
    KEY idx_order (order_id)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS order_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL,
    item_id VARCHAR(64) NULL,
    event_type VARCHAR(48) NOT NULL,
    payload JSON NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY idx_order_time (order_id, created_at),
    KEY idx_time (created_at)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS supplier_call_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    supplier VARCHAR(8) NOT NULL,
    called_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY idx_sup_time (supplier, called_at)
  ) ENGINE=InnoDB`,
];

const IGNORE = new Set(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME", "ER_CANT_DROP_FIELD_OR_KEY", "ER_BAD_FIELD_ERROR"]);

async function execIgnore(sql) {
  try {
    await pool.query(sql);
  } catch (e) {
    if (IGNORE.has(e.code)) return;
    throw e;
  }
}

async function alterExisting() {
  await execIgnore(
    `ALTER TABLE orders MODIFY COLUMN status ENUM(
      'created','paid','delivering','delivered',
      'payment_failed','out_of_stock','delivery_failed',
      'partially_fulfilled','refunded'
    ) NOT NULL`
  );

  await execIgnore(`ALTER TABLE ledger_entries ADD COLUMN item_id VARCHAR(64) NOT NULL DEFAULT '' AFTER order_id`);
  await execIgnore(`ALTER TABLE ledger_entries ADD COLUMN event_type VARCHAR(16) NOT NULL DEFAULT 'legacy' AFTER item_id`);
  await execIgnore(`ALTER TABLE ledger_entries ADD KEY idx_created (created_at)`);
  await execIgnore(`ALTER TABLE ledger_entries ADD KEY idx_order (order_id)`);

  await pool.query(`
    UPDATE ledger_entries
    SET event_type = 'payment'
    WHERE event_type IN ('legacy','') AND (account = 'cash' OR (account = 'prepaid' AND direction = 'credit'))
  `);
  await pool.query(`
    UPDATE ledger_entries
    SET event_type = 'delivery'
    WHERE event_type IN ('legacy','') AND (account = 'revenue' OR (account = 'prepaid' AND direction = 'debit'))
  `);

  await execIgnore(`ALTER TABLE ledger_entries DROP INDEX uk_idempotent`);
  await execIgnore(
    `ALTER TABLE ledger_entries ADD UNIQUE KEY uk_idempotent (order_id, item_id, event_type, account, direction)`
  );

  await execIgnore(`ALTER TABLE supplier_runtime ADD COLUMN fail_skus TEXT NULL`);
  await execIgnore(`ALTER TABLE supplier_runtime ADD COLUMN rate_limit_rpm INT NOT NULL DEFAULT 0`);
  await execIgnore(`ALTER TABLE supplier_runtime MODIFY COLUMN force_mode VARCHAR(32) NOT NULL DEFAULT 'none'`);

  await execIgnore(`ALTER TABLE supplier_issues DROP INDEX uk_code`);
  await execIgnore(`ALTER TABLE supplier_issues ADD KEY idx_code (code)`);

  await pool.query(`
    INSERT IGNORE INTO order_items (
      id, order_id, line_no, sku, amount, currency, status,
      delivery_code, supplier_used, request_id, fulfillment_attempts,
      next_retry_at, lock_until, last_error, delivered_at
    )
    SELECT
      CONCAT(id, '-L1'),
      id,
      1,
      sku,
      amount,
      currency,
      CASE
        WHEN status = 'delivered' THEN 'delivered'
        WHEN status IN ('payment_failed','created') THEN 'pending'
        WHEN status IN ('partially_fulfilled','refunded') THEN 'pending'
        ELSE status
      END,
      delivery_code,
      supplier_used,
      request_id,
      fulfillment_attempts,
      next_retry_at,
      lock_until,
      last_error,
      delivered_at
    FROM orders
  `);

  await pool.query(`
    INSERT IGNORE INTO claimed_codes (code, order_id, item_id, request_id, supplier)
    SELECT delivery_code, order_id, id, COALESCE(request_id, id), COALESCE(supplier_used, 'A')
    FROM order_items
    WHERE delivery_code IS NOT NULL
  `);
}

export async function migrate() {
  for (const sql of STATEMENTS) {
    await pool.query(sql);
  }
  await alterExisting();
  logger.info({ event: "db.migrated" });
}
