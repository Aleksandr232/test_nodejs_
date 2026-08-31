# Ядро магазина цифровых товаров

Backend для площадки вроде GGSel: заказ по SKU → вебхук оплаты → автоматическая выдача кода.

Стек: **Node.js 20 + Express + MySQL 8 + Docker Compose**. Реального эквайринга и поставщиков нет — всё на заглушках.



## Запуск

Нужны Docker Desktop и Node.js 20+ (Node только для прогона тестов с хоста).

```bash
docker compose up --build
```

API: http://localhost:3000  
Swagger: http://localhost:3000/docs  
Поставщик A: http://localhost:3001  
Поставщик B: http://localhost:3002  
MySQL с хоста: `127.0.0.1:3307` (логин `store` / `store`, БД `store`)

Первый старт поднимает ~2500 SKU и пул ключей.

### Ручной сценарий

```bash
# создать заказ
curl -s -X POST http://localhost:3000/api/orders -H "Content-Type: application/json" -d "{\"sku\":\"STEAM-TOPUP-500\"}"

# эмуляция оплаты (подставьте id и amount из ответа)
curl -s -X POST http://localhost:3000/webhook/payment -H "Content-Type: application/json" -d "{\"event_id\":\"evt_1\",\"order_id\":\"ord_xxx\",\"status\":\"paid\",\"amount\":500,\"currency\":\"RUB\",\"created_at\":\"2025-01-01T12:00:00Z\"}"

# статус и код
curl -s http://localhost:3000/api/orders/ord_xxx
```

Полезные эндпоинты:

| Метод | Путь | Назначение |
| --- | --- | --- |
| GET | `/docs` | Swagger UI |
| GET | `/openapi.json` | OpenAPI spec |
| POST | `/api/orders` | Создать заказ `{ sku, id? }` |
| GET | `/api/orders/:id` | Заказ; `code` только в `delivered` |
| POST | `/webhook/payment` | Вебхук оплаты (контракт из задания) |
| GET | `/api/catalog` | Витрина остатков |
| GET | `/api/catalog/explain` | EXPLAIN горячего запроса |
| GET | `/api/reconcile` | Сверка и баланс леджера |
| POST | `/api/orders/:id/retry-delivery` | Ручной повтор выдачи |
| POST | `/api/admin/restock` | Пополнить ключ `{ sku, code }` |

## Как прогнать приёмку (гонки, таймаут, fallback)

Тот же скрипт эмулирует оплату и гоняет состязательные сценарии:

```bash
npm install
node scripts/acceptance.mjs
```

Он проверяет все 6 критериев:

1. **50 параллельных вебхуков `paid`** по одному заказу → один код, один факт выдачи
2. **Повтор с тем же `event_id`** → `duplicate: true`, заказ не меняется
3. **Вебхук раньше заказа** и **failed после paid** — оба корректны
4. **Таймаут поставщика A**, который уже выдал код: повтор с тем же `request_id`, **без fallback на B**, без второй выдачи
5. **A недоступен (5xx)** → fallback на B, код ровно один
6. **Пустой остаток** → `out_of_stock`, после restock заказ доходит до `delivered`, процесс не падает

Скрипт сам переключает заглушки через `POST /admin/config` (`force_mode`: `ok` / `fail` / `timeout`).

Точечно:

```bash
# A всегда 5xx, B всегда ок — смотреть fallback
curl -s -X POST http://localhost:3001/admin/config -H "Content-Type: application/json" -d "{\"force_mode\":\"fail\"}"
curl -s -X POST http://localhost:3002/admin/config -H "Content-Type: application/json" -d "{\"force_mode\":\"ok\"}"

# ловушка таймаута: A выделяет ключ и зависает
curl -s -X POST http://localhost:3001/admin/config -H "Content-Type: application/json" -d "{\"force_mode\":\"timeout\",\"hang_ms\":15000}"
```

## Ключевые решения

**Exactly-once оплаты.** `payment_events.event_id` — PK (повтор вебхука — no-op). Все мутации заказа сериализуются через `GET_LOCK(ord:{id})` + `SELECT … FOR UPDATE`. Переход `created → paid` делается одним `UPDATE … WHERE status='created'`. 50 параллельных вебхуков выстраиваются в очередь по замку; выдачу запускает только победитель.

**Вебхук раньше заказа.** Событие пишется в `payment_events` с `processed=0`. Создание заказа берёт тот же lock, находит необработанные события и применяет их. Обратный порядок (`failed` после `paid`/`delivered`) игнорируется.

**Ловушка таймаута.** `request_id` стабилен на заказ+поставщика (`req_{orderId}-A`). Заглушка **сначала выделяет ключ и коммитит**, потом может зависнуть. Повтор с тем же id возвращает тот же код и не висит. Таймаут **не считается отказом** и **не включает fallback** — иначе получим два кода. Fallback A→B только на явный 4xx/5xx без аллокации.

**Идемпотентность выдачи.** `supplier_issues.request_id` PK, `inventory_keys.code` UNIQUE, `orders.delivery_code` UNIQUE. Повторный `UPDATE … WHERE delivery_code IS NULL` не затрёт финальный заказ.

**Очередь.** Отдельный брокер не нужен для объёма тестового ядра: `setImmediate` после оплаты + воркер раз в 3 с дожимает `paid` / `delivering` / `out_of_stock` / `delivery_failed` по `next_retry_at`.

**Леджер.** Двойная запись: оплата `Dr cash / Cr prepaid`, выдача `Dr prepaid / Cr revenue`. Идемпотентность `UNIQUE(order_id, account, direction)`. Сверка: `GET /api/reconcile`.

**Витрина (этап 5).** `stock` денормализован на `products`, generated `in_stock AS (stock > 0)` + индекс `idx_vitrine (in_stock, sku)`. При почти полном наличии оптимизатор берёт `PRIMARY(sku) + LIMIT` (~50 rows, Using where). `idx_vitrine` срабатывает, когда много нулевых остатков или большой OFFSET. План: `GET /api/catalog/explain`.


