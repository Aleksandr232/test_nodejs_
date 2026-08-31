import pino from "pino";
import { config } from "./config.js";

// TODO(explain): logger — JSON для сверки платежей; redact code/delivery_code, ключ не в stdout.
export const logger = pino({
  level: config.logLevel,
  base: { service: process.env.SUPPLIER_NAME ? `supplier-${process.env.SUPPLIER_NAME}` : "api" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ["code", "delivery_code", "req.body.code"],
    censor: "***",
  },
});
