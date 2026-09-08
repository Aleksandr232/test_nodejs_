# Ядро магазина цифровых товаров

Backend для площадки вроде GGSel. Этап 1: заказ → оплата → exactly-once выдача.  
Этап 2: **мультипозиционный заказ**, **частичный возврат**, **поставщик которому нельзя верить**, очередь с RPM и точка-in-time.

Стек: **Node.js 20 + Express + MySQL 8 + Docker Compose**. Эквайринг и поставщики — заглушки.



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

### Ручной сценарий (как в этапе 1)

```bash
curl -s -X POST http://localhost:3000/api/orders -H "Content-Type: application/json" -d "{\"sku\":\"STEAM-TOPUP-500\"}"

curl -s -X POST http://localhost:3000/webhook/payment -H "Content-Type: application/json" -d "{\"event_id\":\"evt_1\",\"order_id\":\"ord_xxx\",\"status\":\"paid\",\"amount\":500,\"currency\":\"RUB\",\"created_at\":\"2025-01-01T12:00:00Z\"}"

curl -s http://localhost:3000/api/orders/ord_xxx
```

Мультипозиционный заказ:

```bash
curl -s -X POST http://localhost:3000/api/orders -H "Content-Type: application/json" -d "{\"items\":[{\"sku\":\"STEAM-TOPUP-500\"},{\"sku\":\"KEY-GTA5\"}]}"
```

Полезные эндпоинты:

| Метод | Путь | Назначение |
| --- | --- | --- |
| GET | `/docs` | Swagger UI |
| POST | `/api/orders` | `{ sku }` или `{ items: [{ sku, qty }] }` |
| GET | `/api/orders/:id` | Заказ, позиции, `money` (paid/delivered/refunded) |
| GET | `/api/orders/:id/at?at=` | Состояние заказа на момент времени |
| POST | `/webhook/payment` | Вебхук оплаты |
| GET | `/api/reconcile` | Сверка, в том числе `money_mismatch` |
| GET | `/api/queue` | Очередь выдачи и RPM поставщиков |
| GET | `/api/money/at?at=` | Снимок леджера на дату |
| POST | `/api/orders/:id/retry-delivery` | Идемпотентный повтор |

## Приёмка

```bash
npm install
node scripts/acceptance.mjs
```

Этап 1 (гонки, таймаут, fallback) плюс этап 2:

7. Частичный заказ: один SKU выдан, второй нет → возврат только за невыданное, `paid = delivered + refunded`
8. Поставщик **врёт ошибкой** (`lie_error`: ключ выдал, HTTP 503) → код всё равно один, без fallback
9. Поставщик **отдаёт чужой код** (`duplicate_code`) → второй заказ этот код не получает
10. **Массовая выдача + падение поставщика**: 4 позиции, A зависает после allocate → все 4 доезжают по `request_id`, без второй выдачи и без B
11. Поставщик **подменяет код в теле** (`wrong_code`) → покупатель получает код из allocate, не из JSON
12. Всплеск + RPM лимит поставщика → заказы в очереди, ничего не теряется
13. Точка-in-time по `order_events` / леджеру

### Как воспроизвести сложные кейсы вручную

**Частичный сбой заказа**

```bash
curl -s -X POST http://localhost:3001/admin/config -H "Content-Type: application/json" -d "{\"force_mode\":\"ok\",\"fail_skus\":[\"KEY-EFT\"]}"
curl -s -X POST http://localhost:3002/admin/config -H "Content-Type: application/json" -d "{\"force_mode\":\"ok\",\"fail_skus\":[\"KEY-EFT\"]}"
# заказ из STEAM-TOPUP-2500 + KEY-EFT → оплата → partially_fulfilled
```

**Недобросовестный поставщик**

```bash
# выдал, но ответил 503
curl -s -X POST http://localhost:3001/admin/config -H "Content-Type: application/json" -d "{\"force_mode\":\"lie_error\"}"

# отдать код из чужого заказа
curl -s -X POST http://localhost:3001/admin/config -H "Content-Type: application/json" -d "{\"force_mode\":\"duplicate_code\"}"

# ловушка таймаута (allocate, потом hang) — массовый заказ из нескольких sku
curl -s -X POST http://localhost:3001/admin/config -H "Content-Type: application/json" -d "{\"force_mode\":\"timeout\",\"hang_ms\":20000}"
```

**Деньги сходятся**

```bash
curl -s http://localhost:3000/api/reconcile
# ok=true, ledger.balanced, money_mismatch=[]
# у заказа: money.outstanding === 0  ⇔  paid = delivered + refunded
```

Повтор оплаты, retry-delivery и рестарт в середине выдачи не создают второй код и второй возврат: `claimed_codes.code` UNIQUE, леджер `INSERT IGNORE` по `(order_id, item_id, event_type, account, direction)`, поставщику всегда тот же `request_id`.

## Ключевые решения этапа 2

**Позиции, не «заказ = один ключ». ** Выдача и возврат идут по `order_items`. Терминал заказа: `delivered` / `partially_fulfilled` / `refunded`. Невыданное возвращается в cash, выданное остаётся у покупателя.

**Ответу поставщика не верим.** Тело HTTP — подсказка. Источник истины: строка в `supplier_issues` по стабильному `request_id` (тот же контракт, что status API поставщика). Код принимаем только после `INSERT INTO claimed_codes` (PK по коду). Чужой/повторный код отвергаем и не отдаём второму покупателю; если A соврал — fallback на B с **другим** request_id.

**Падение после выдачи.** Таймаут ≠ отказ и ≠ fallback. После abort смотрим allocate; если ключ уже есть — забираем. Рестарт дожимает воркер раз в 3 с, тот же `request_id`.

**Очередь и RPM.** Поставщик сам режет `rate_limit_rpm` (429). Оплаченные позиции ждут `next_retry_at`, неоплаченные в выдачу не попадают. Прогресс: `GET /api/queue`.

**История только append.** `order_events` + леджер без UPDATE задним числом. `GET /api/orders/:id/at?at=` и `GET /api/money/at?at=`.
