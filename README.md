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

## Как воспроизвести частичный сбой заказа и поведение при недобросовестном поставщике

Автоматом: сценарии 7–11 в `node scripts/acceptance.mjs`. Ниже — вручную. Подставьте `ORD_ID` и `amount` из ответа create.

### Частичный сбой заказа

Один заказ, два товара. Steam выдаётся, Tarkov падает на A и B. Выданное остаётся, за невыданное — возврат.

```bash
curl -s -X POST http://localhost:3001/admin/config -H "Content-Type: application/json" -d "{\"force_mode\":\"ok\",\"fail_skus\":[\"KEY-EFT\"]}"
curl -s -X POST http://localhost:3002/admin/config -H "Content-Type: application/json" -d "{\"force_mode\":\"ok\",\"fail_skus\":[\"KEY-EFT\"]}"

curl -s -X POST http://localhost:3000/api/orders -H "Content-Type: application/json" -d "{\"items\":[{\"sku\":\"STEAM-TOPUP-2500\"},{\"sku\":\"KEY-EFT\"}]}"

curl -s -X POST http://localhost:3000/webhook/payment -H "Content-Type: application/json" -d "{\"event_id\":\"evt_partial_1\",\"order_id\":\"ORD_ID\",\"status\":\"paid\",\"amount\":5990,\"currency\":\"RUB\",\"created_at\":\"2026-01-01T12:00:00Z\"}"

curl -s http://localhost:3000/api/orders/ORD_ID
```

Ожидание: `partially_fulfilled`; Steam `delivered` с кодом; EFT `refunded` без кода; `money.paid = 5990`, `delivered = 2500`, `refunded = 3490`, `outstanding = 0`.

Повтор вебхука или `POST /api/orders/ORD_ID/retry-delivery` не выдаёт второй код и не делает второй возврат.

### Недобросовестный поставщик

Телу HTTP не верим. Код берём только по стабильному `request_id` и только если его ещё никто не занял (`claimed_codes`).

**Врал ошибкой** — ключ выдал, ответил 503. Покупатель всё равно получает этот код, fallback на B нет.

```bash
curl -s -X POST http://localhost:3001/admin/config -H "Content-Type: application/json" -d "{\"force_mode\":\"lie_error\"}"
curl -s -X POST http://localhost:3002/admin/config -H "Content-Type: application/json" -d "{\"force_mode\":\"ok\"}"

curl -s -X POST http://localhost:3000/api/orders -H "Content-Type: application/json" -d "{\"sku\":\"SUB-YT-3M\"}"
# webhook paid на amount из ответа
curl -s http://localhost:3000/api/orders/ORD_ID
curl -s "http://localhost:3001/admin/issues?order_id=ORD_ID"
```

Ожидание: `delivered`, `supplier: A`, у A ровно одна выдача, у B пусто. Повтор выдачи — тот же код.

**Отдал чужой код.** Сначала обычный заказ, потом A присылает уже занятый ключ.

```bash
curl -s -X POST http://localhost:3001/admin/config -H "Content-Type: application/json" -d "{\"force_mode\":\"ok\"}"
# заказ SUB-DISCORD-1M → оплата → запомнить code

curl -s -X POST http://localhost:3001/admin/config -H "Content-Type: application/json" -d "{\"force_mode\":\"duplicate_code\"}"
# заказ SUB-SPOTIFY-1M → оплата
```

Ожидание: у второго заказа другой код (A отвергли, выдал B). Один код не сидит в двух заказах.

**Подменил код в JSON** — в теле `WRONG-…`, в allocate другой.

```bash
curl -s -X POST http://localhost:3001/admin/config -H "Content-Type: application/json" -d "{\"force_mode\":\"wrong_code\"}"
# заказ GIFT-PSN-1000 → оплата
```

Ожидание: покупатель получает код из allocate, не `WRONG-…`.

**Падение после выдачи** (массово): A выделяет ключ и зависает. Таймаут ≠ отказ, на B не уходим.

```bash
curl -s -X POST http://localhost:3001/admin/config -H "Content-Type: application/json" -d "{\"force_mode\":\"timeout\",\"hang_ms\":20000}"
curl -s -X POST http://localhost:3002/admin/config -H "Content-Type: application/json" -d "{\"force_mode\":\"ok\"}"

curl -s -X POST http://localhost:3000/api/orders -H "Content-Type: application/json" -d "{\"items\":[{\"sku\":\"GIFT-XBOX-1500\"},{\"sku\":\"GIFT-ROBLOX-800\"},{\"sku\":\"SUB-DISCORD-1M\"},{\"sku\":\"KEY-CS2-PRIME\"}]}"
# webhook paid на amount из ответа
```

Ожидание: все 4 позиции `delivered` с A, коды разные, B молчит. Retry ничего не двоит.

## Как проверить, что деньги сходятся

Инвариант: **оплачено = выдано + возвращено**. В терминале заказа `money.outstanding === 0`.

По одному заказу:

```bash
curl -s http://localhost:3000/api/orders/ORD_ID
```

- полный успех: `paid == delivered`, `refunded == 0`, `outstanding == 0`
- частичный сбой (Steam + EFT): `paid == 5990`, `delivered == 2500`, `refunded == 3490`, `outstanding == 0`
- полный возврат: `paid == refunded`, `delivered == 0`

Повтор оплаты и `POST /api/orders/ORD_ID/retry-delivery` эти суммы не меняют.

По всей системе:

```bash
curl -s http://localhost:3000/api/reconcile
```

Сходится, если `ok: true`, `ledger.balanced: true`, `money_mismatch: []`, `delivered_not_paid: []`.

`paid_not_delivered` может быть непустым — это ещё не дожатые `paid` / `out_of_stock`, не дыра в деньгах.

Двойная запись, повтор — no-op (`INSERT IGNORE`): оплата Dr cash / Cr prepaid, выдача Dr prepaid / Cr revenue, возврат Dr prepaid / Cr cash.

Снимок на дату: `GET /api/money/at?at=2026-09-08T12:00:00Z` — тоже `balanced: true`.

## Ключевые решения этапа 2

**Позиции, не «заказ = один ключ». ** Выдача и возврат идут по `order_items`. Терминал заказа: `delivered` / `partially_fulfilled` / `refunded`. Невыданное возвращается в cash, выданное остаётся у покупателя.

**Ответу поставщика не верим.** Тело HTTP — подсказка. Источник истины: строка в `supplier_issues` по стабильному `request_id` (тот же контракт, что status API поставщика). Код принимаем только после `INSERT INTO claimed_codes` (PK по коду). Чужой/повторный код отвергаем и не отдаём второму покупателю; если A соврал — fallback на B с **другим** request_id.

**Падение после выдачи.** Таймаут ≠ отказ и ≠ fallback. После abort смотрим allocate; если ключ уже есть — забираем. Рестарт дожимает воркер раз в 3 с, тот же `request_id`.

**Очередь и RPM.** Поставщик сам режет `rate_limit_rpm` (429). Оплаченные позиции ждут `next_retry_at`, неоплаченные в выдачу не попадают. Прогресс: `GET /api/queue`.

**История только append.** `order_events` + леджер без UPDATE задним числом. `GET /api/orders/:id/at?at=` и `GET /api/money/at?at=`.
