/**
 * OpenAPI 3 spec for Swagger UI (/docs).
 * TODO(explain): почему контракт описан статическим spec, а не swagger-jsdoc из комментариев —
 * меньше шума в бизнес-коде, контракт вебхука совпадает с заданием 1:1.
 */
export const openapi = {
  openapi: "3.0.3",
  info: {
    title: "Digital Goods Store API",
    version: "1.0.0",
    description:
      "Ядро магазина цифровых товаров: заказ → вебхук оплаты → exactly-once выдача ключа. " +
      "Эквайринг и поставщики — заглушки.",
  },
  servers: [{ url: "/", description: "Этот инстанс" }],
  tags: [
    { name: "orders", description: "Заказы" },
    { name: "payments", description: "Вебхук оплаты" },
    { name: "catalog", description: "Витрина" },
    { name: "ops", description: "Сверка и восстановление" },
  ],
  paths: {
    "/health": {
      get: {
        tags: ["ops"],
        summary: "Liveness",
        responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Health" } } } } },
      },
    },
    "/api/orders": {
      post: {
        tags: ["orders"],
        summary: "Создать заказ по SKU",
        description: "Опциональный `id` нужен для сценария «вебхук пришёл раньше заказа».",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateOrderRequest" },
              example: { sku: "STEAM-TOPUP-500" },
            },
          },
        },
        responses: {
          201: { description: "Заказ создан", content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } },
          400: { $ref: "#/components/responses/Error" },
          404: { description: "SKU не найден", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          409: { description: "Заказ с таким id уже есть", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/api/orders/{id}": {
      get: {
        tags: ["orders"],
        summary: "Получить заказ",
        description: "`code` отдаётся только в статусе `delivered`.",
        parameters: [{ $ref: "#/components/parameters/OrderId" }],
        responses: {
          200: { description: "Заказ", content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } },
          404: { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/api/orders/{id}/retry-delivery": {
      post: {
        tags: ["ops"],
        summary: "Повторная выдача",
        description: "Безопасный retry: тот же request_id, без задвоения кода.",
        parameters: [{ $ref: "#/components/parameters/OrderId" }],
        responses: {
          200: { description: "Результат попытки", content: { "application/json": { schema: { $ref: "#/components/schemas/RetryDeliveryResponse" } } } },
          404: { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/webhook/payment": {
      post: {
        tags: ["payments"],
        summary: "Вебхук оплаты",
        description:
          "Контракт из задания. Всегда 200 при валидном теле (платёжка ретраит 5xx). " +
          "Повтор того же event_id — duplicate. Вебхук до создания заказа — pending.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PaymentWebhook" },
              examples: {
                paid: {
                  value: {
                    event_id: "evt_a1b2c3",
                    order_id: "ord_00123",
                    status: "paid",
                    amount: 500,
                    currency: "RUB",
                    created_at: "2025-01-01T12:00:00Z",
                  },
                },
                failed: {
                  value: {
                    event_id: "evt_fail_1",
                    order_id: "ord_00123",
                    status: "failed",
                    amount: 500,
                    currency: "RUB",
                    created_at: "2025-01-01T12:00:00Z",
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Принято", content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookAck" } } } },
          400: { $ref: "#/components/responses/Error" },
          503: { description: "Не взяли lock — платёжка должна повторить" },
        },
      },
    },
    "/api/catalog": {
      get: {
        tags: ["catalog"],
        summary: "Витрина остатков",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 50, minimum: 1, maximum: 200 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0, minimum: 0 } },
        ],
        responses: {
          200: { description: "Страница витрины", content: { "application/json": { schema: { $ref: "#/components/schemas/CatalogPage" } } } },
        },
      },
    },
    "/api/catalog/explain": {
      get: {
        tags: ["catalog"],
        summary: "EXPLAIN горячего запроса витрины",
        responses: {
          200: { description: "План MySQL + комментарии к индексам" },
        },
      },
    },
    "/api/catalog/{sku}": {
      get: {
        tags: ["catalog"],
        summary: "Карточка SKU",
        parameters: [{ name: "sku", in: "path", required: true, schema: { type: "string" }, example: "STEAM-TOPUP-500" }],
        responses: {
          200: { description: "Товар", content: { "application/json": { schema: { $ref: "#/components/schemas/Product" } } } },
          404: { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/api/reconcile": {
      get: {
        tags: ["ops"],
        summary: "Сверка",
        description: "оплачен-не-выдан, выдан-не-оплачен, дубли ключей, баланс леджера.",
        responses: {
          200: { description: "Отчёт сверки", content: { "application/json": { schema: { $ref: "#/components/schemas/ReconcileReport" } } } },
        },
      },
    },
    "/api/admin/restock": {
      post: {
        tags: ["ops"],
        summary: "Пополнить пул ключей",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RestockRequest" },
              example: { sku: "EMPTY-STOCK", code: "REST-123" },
            },
          },
        },
        responses: {
          200: { description: "Ключ добавлен" },
          400: { $ref: "#/components/responses/Error" },
          409: { description: "Код уже существует" },
        },
      },
    },
  },
  components: {
    parameters: {
      OrderId: { name: "id", in: "path", required: true, schema: { type: "string" }, example: "ord_00123" },
    },
    responses: {
      Error: { description: "Ошибка", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      NotFound: { description: "Не найдено", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
    },
    schemas: {
      Health: { type: "object", properties: { ok: { type: "boolean" } } },
      Error: { type: "object", properties: { error: { type: "string" } } },
      CreateOrderRequest: {
        type: "object",
        required: ["sku"],
        properties: {
          sku: { type: "string", example: "STEAM-TOPUP-500" },
          id: { type: "string", description: "Опционально, для вебхука до create" },
        },
      },
      Order: {
        type: "object",
        properties: {
          id: { type: "string" },
          sku: { type: "string" },
          amount: { type: "number" },
          currency: { type: "string", example: "RUB" },
          status: {
            type: "string",
            enum: ["created", "paid", "delivering", "delivered", "payment_failed", "out_of_stock", "delivery_failed"],
          },
          code: { type: "string", nullable: true, description: "Только если status=delivered" },
          supplier: { type: "string", nullable: true, enum: ["A", "B"] },
          created_at: { type: "string" },
          updated_at: { type: "string" },
          paid_at: { type: "string", nullable: true },
          delivered_at: { type: "string", nullable: true },
          last_error: { type: "string", nullable: true },
        },
      },
      PaymentWebhook: {
        type: "object",
        required: ["event_id", "order_id", "status"],
        properties: {
          event_id: { type: "string", example: "evt_a1b2c3" },
          order_id: { type: "string", example: "ord_00123" },
          status: { type: "string", enum: ["paid", "failed"] },
          amount: { type: "number", example: 500 },
          currency: { type: "string", example: "RUB" },
          created_at: { type: "string", format: "date-time" },
        },
      },
      WebhookAck: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          duplicate: { type: "boolean" },
          pending: { type: "boolean", description: "Заказа ещё нет, событие сохранено" },
          applied: { type: "boolean" },
        },
      },
      Product: {
        type: "object",
        properties: {
          sku: { type: "string" },
          name: { type: "string" },
          type: { type: "string" },
          price: { type: "number" },
          currency: { type: "string" },
          image: { type: "string" },
          stock: { type: "integer" },
        },
      },
      CatalogPage: {
        type: "object",
        properties: {
          items: { type: "array", items: { $ref: "#/components/schemas/Product" } },
          total: { type: "integer" },
          limit: { type: "integer" },
          offset: { type: "integer" },
        },
      },
      RestockRequest: {
        type: "object",
        required: ["sku", "code"],
        properties: { sku: { type: "string" }, code: { type: "string" } },
      },
      RetryDeliveryResponse: {
        type: "object",
        properties: {
          result: { type: "object" },
          order: { $ref: "#/components/schemas/Order" },
        },
      },
      ReconcileReport: {
        type: "object",
        properties: {
          paid_not_delivered: { type: "array", items: { type: "object" } },
          delivered_not_paid: { type: "array", items: { type: "object" } },
          orphan_issued_keys: { type: "array", items: { type: "object" } },
          orders_with_multiple_codes: { type: "array", items: { type: "object" } },
          ledger: {
            type: "object",
            properties: {
              debit: { type: "number" },
              credit: { type: "number" },
              balanced: { type: "boolean" },
            },
          },
          ok: { type: "boolean" },
        },
      },
    },
  },
};
