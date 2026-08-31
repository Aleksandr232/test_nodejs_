// TODO(explain): config — timeout 2.5s vs hang 20s: клиент обязан уметь отличить hang от 5xx.
export const config = {
  port: Number(process.env.PORT || 3000),
  mysql: {
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "store",
    password: process.env.MYSQL_PASSWORD || "store",
    database: process.env.MYSQL_DATABASE || "store",
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_POOL || 20),
    decimalNumbers: true,
    namedPlaceholders: false,
  },
  suppliers: {
    A: process.env.SUPPLIER_A_URL || "http://127.0.0.1:3001",
    B: process.env.SUPPLIER_B_URL || "http://127.0.0.1:3002",
    timeoutMs: Number(process.env.SUPPLIER_TIMEOUT_MS || 2500),
    retries: Number(process.env.SUPPLIER_RETRIES || 3),
  },
  logLevel: process.env.LOG_LEVEL || "info",
  catalogExtraSkus: Number(process.env.CATALOG_EXTRA_SKUS || 2500),
};
