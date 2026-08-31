import { pool } from "../db.js";

// TODO(explain): ledgerPayment — Dr cash / Cr prepaid; IGNORE+UNIQUE чтобы повтор вебхука не двоил деньги.
export async function ledgerPayment(conn, orderId, amount) {
  await conn.execute(
    `INSERT IGNORE INTO ledger_entries (order_id, account, direction, amount)
     VALUES (?, 'cash', 'debit', ?), (?, 'prepaid', 'credit', ?)`,
    [orderId, amount, orderId, amount]
  );
}

// TODO(explain): ledgerDelivery — Dr prepaid / Cr revenue; закрываем обязательство, не плодим cash.
export async function ledgerDelivery(conn, orderId, amount) {
  await conn.execute(
    `INSERT IGNORE INTO ledger_entries (order_id, account, direction, amount)
     VALUES (?, 'prepaid', 'debit', ?), (?, 'revenue', 'credit', ?)`,
    [orderId, amount, orderId, amount]
  );
}

// TODO(explain): ledgerBalance — инвариант SUM(debit)=SUM(credit); расхождение = баг денежного пути.
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
