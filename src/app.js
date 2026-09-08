import express from "express";
import swaggerUi from "swagger-ui-express";
import pinoHttp from "pino-http";
import { logger } from "./logger.js";
import { openapi } from "./openapi.js";
import { createOrder, getOrder, getOrderAt } from "./services/orders.js";
import { handlePaymentWebhook } from "./services/payments.js";
import { listStorefront, getProduct, explainStorefront } from "./services/catalog.js";
import { reconcile, moneyAt } from "./services/reconcile.js";
import { restock, retryDelivery } from "./services/admin.js";
import { queueStats } from "./services/fulfillment.js";

// TODO(explain): createApp — тонкий HTTP-слой, деньги/выдача живут в services.
// Swagger статическим spec, чтобы контракт вебхука не разъехался с комментариями в коде.
export function createApp() {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (req) => req.url === "/health" || req.url.startsWith("/docs") || req.url === "/openapi.json",
      },
      serializers: {
        req: (req) => ({ method: req.method, url: req.url }),
      },
    })
  );

  app.get("/openapi.json", (_req, res) => res.json(openapi));
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapi, { explorer: true }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // TODO(explain): POST /api/orders — 201; бизнес-логика в createOrder, тут только валидация sku.
  app.post("/api/orders", async (req, res, next) => {
    try {
      if (!req.body?.sku && !Array.isArray(req.body?.items)) {
        return res.status(400).json({ error: "sku_or_items_required" });
      }
      const order = await createOrder(req.body || {});
      res.status(201).json(order);
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/orders/:id", async (req, res, next) => {
    try {
      const order = await getOrder(req.params.id);
      if (!order) return res.status(404).json({ error: "not_found" });
      res.json(order);
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/orders/:id/at", async (req, res, next) => {
    try {
      const at = req.query.at || new Date().toISOString();
      const order = await getOrderAt(req.params.id, at);
      if (!order) return res.status(404).json({ error: "not_found" });
      res.json(order);
    } catch (e) {
      next(e);
    }
  });

  // TODO(explain): POST /webhook/payment — 200 на duplicate/pending; 503 только lock (платёжка ретраит).
  app.post("/webhook/payment", async (req, res, next) => {
    try {
      const result = await handlePaymentWebhook(req.body);
      res.status(200).json({
        ok: true,
        duplicate: Boolean(result.duplicate),
        pending: Boolean(result.pending),
        applied: Boolean(result.applied),
      });
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.message });
      next(e);
    }
  });

  app.get("/api/catalog", async (req, res, next) => {
    try {
      const data = await listStorefront({
        limit: req.query.limit,
        offset: req.query.offset,
      });
      res.json(data);
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/catalog/explain", async (_req, res, next) => {
    try {
      res.json(await explainStorefront());
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/catalog/:sku", async (req, res, next) => {
    try {
      const product = await getProduct(req.params.sku);
      if (!product) return res.status(404).json({ error: "not_found" });
      res.json(product);
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/reconcile", async (_req, res, next) => {
    try {
      res.json(await reconcile());
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/queue", async (_req, res, next) => {
    try {
      res.json(await queueStats());
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/money/at", async (req, res, next) => {
    try {
      const at = req.query.at || new Date().toISOString();
      res.json(await moneyAt(at));
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/admin/restock", async (req, res, next) => {
    try {
      res.json(await restock(req.body || {}));
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/orders/:id/retry-delivery", async (req, res, next) => {
    try {
      const order = await getOrder(req.params.id);
      if (!order) return res.status(404).json({ error: "not_found" });
      const result = await retryDelivery(req.params.id);
      const fresh = await getOrder(req.params.id);
      res.json({ result, order: fresh });
    } catch (e) {
      next(e);
    }
  });

  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) logger.error({ event: "http.error", err: err.message, stack: err.stack });
    res.status(status).json({ error: err.message || "internal_error" });
  });

  return app;
}
