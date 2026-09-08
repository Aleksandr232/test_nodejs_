import { pool } from "../db.js";

export async function ledgerPayment(conn, orderId, amount) {
  await conn.execute(
    `INSERT IGNORE INTO ledger_entries (order_id, item_id, event_type, account, direction, amount)
     VALUES (?, '', 'payment', 'cash', 'debit', ?), (?, '', 'payment', 'prepaid', 'credit', ?)`,
    [orderId, amount, orderId, amount]
  );
}

export async function ledgerDelivery(conn, orderId, itemId, amount) {
  await conn.execute(
    `INSERT IGNORE INTO ledger_entries (order_id, item_id, event_type, account, direction, amount)
     VALUES (?, ?, 'delivery', 'prepaid', 'debit', ?), (?, ?, 'delivery', 'revenue', 'credit', ?)`,
    [orderId, itemId, amount, orderId, itemId, amount]
  );
}

export async function ledgerRefund(conn, orderId, itemId, amount) {
  await conn.execute(
    `INSERT IGNORE INTO ledger_entries (order_id, item_id, event_type, account, direction, amount)
     VALUES (?, ?, 'refund', 'prepaid', 'debit', ?), (?, ?, 'refund', 'cash', 'credit', ?)`,
    [orderId, itemId, amount, orderId, itemId, amount]
  );
}

export async function ledgerBalance(conn = null) {
  const db = conn || pool;
  const [rows] = await db.query(`
    SELECT
      SUM(CASE WHEN direction = 'debit' THEN amount ELSE 0 END) AS debit,
      SUM(CASE WHEN direction = 'credit' THEN amount ELSE 0 END) AS credit
    FROM ledger_entries
  `);
  const debit = Number(rows[0]?.debit || 0);
  const credit = Number(rows[0]?.credit || 0);
  return {
    debit,
    credit,
    balanced: Math.abs(debit - credit) < 0.001,
  };
}

export async function ledgerSnapshot(at, conn = null) {
  const db = conn || pool;
  const [rows] = await db.query(
    `
    SELECT account, direction, SUM(amount) AS amount
    FROM ledger_entries
    WHERE created_at <= ?
    GROUP BY account, direction
  `,
    [at]
  );
  const accounts = { cash: 0, prepaid: 0, revenue: 0 };
  for (const row of rows) {
    const signed = row.direction === "debit" ? Number(row.amount) : -Number(row.amount);
    accounts[row.account] = (accounts[row.account] || 0) + signed;
  }
  const [[{ debit, credit }]] = await db.query(
    `
    SELECT
      COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount ELSE 0 END), 0) AS debit,
      COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount ELSE 0 END), 0) AS credit
    FROM ledger_entries
    WHERE created_at <= ?
  `,
    [at]
  );
  return {
    at,
    accounts,
    debit: Number(debit || 0),
    credit: Number(credit || 0),
    balanced: Math.abs(Number(debit || 0) - Number(credit || 0)) < 0.001,
  };
}

export async function orderMoneyFromLedger(orderId, conn = null) {
  const db = conn || pool;
  const [rows] = await db.execute(
    `
    SELECT event_type, account, direction, SUM(amount) AS amount
    FROM ledger_entries
    WHERE order_id = ?
    GROUP BY event_type, account, direction
  `,
    [orderId]
  );
  let paid = 0;
  let delivered = 0;
  let refunded = 0;
  for (const row of rows) {
    const amount = Number(row.amount);
    if (row.event_type === "payment" && row.account === "cash" && row.direction === "debit") paid += amount;
    if (row.event_type === "delivery" && row.account === "revenue" && row.direction === "credit") delivered += amount;
    if (row.event_type === "refund" && row.account === "cash" && row.direction === "credit") refunded += amount;
  }
  return {
    paid,
    delivered,
    refunded,
    outstanding: Math.round((paid - delivered - refunded) * 100) / 100,
  };
}
