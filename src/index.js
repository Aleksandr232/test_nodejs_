import { createApp } from "./app.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { waitForMysql, pool } from "./db.js";
import { migrate } from "./migrate.js";
import { seed } from "./seed.js";
import { startRecoveryWorker } from "./services/fulfillment.js";

async function main() {
  // TODO(explain): main — migrate+seed в процессе, без отдельного job; воркер рядом с API для тестового ядра.
  await waitForMysql();
  await migrate();
  await seed();

  const app = createApp();
  startRecoveryWorker();

  const server = app.listen(config.port, "0.0.0.0", () => {
    logger.info({ event: "api.listen", port: config.port });
  });

  const shutdown = async () => {
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  logger.error({ event: "api.fatal", err: err.message, stack: err.stack });
  process.exit(1);
});
