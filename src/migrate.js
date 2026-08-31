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
      'payment_failed','out_of_stock','delivery_failed'
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
    UNIQUE KEY uk_code (code),
    KEY idx_order (order_id)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS ledger_entries (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL,
    account ENUM('cash','prepaid','revenue') NOT NULL,
    direction ENUM('debit','credit') NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_idempotent (order_id, account, direction)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS supplier_runtime (
    name VARCHAR(8) PRIMARY KEY,
    fail_rate DECIMAL(5,4) NOT NULL DEFAULT 0,
    timeout_rate DECIMAL(5,4) NOT NULL DEFAULT 0,
    force_mode VARCHAR(16) NOT NULL DEFAULT 'none',
    hang_ms INT NOT NULL DEFAULT 20000,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB`,
];

// TODO(explain): migrate — CREATE IF NOT EXISTS на старте проще docker volume; схема заточена под lock/уники, не под ORM.
export async function migrate() {
  for (const sql of STATEMENTS) {
    await pool.query(sql);
  }
  logger.info({ event: "db.migrated" });
}
