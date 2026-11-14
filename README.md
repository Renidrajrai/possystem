# Café POS – API + Web UI

Node.js + Express + TypeScript API on PostgreSQL (Prisma), plus a dependency-free plain-JS POS screen
served from `public/`. It implements the backend of the
*Café POS System – Product & Technical Blueprint*: staff/roles, menu with variants & modifiers, tables,
orders, kitchen tickets (KOT), billing, payments, refunds, shifts/cash drawer, inventory & recipes,
suppliers/purchasing, reports, audit log, live kitchen updates (Socket.IO) and **phone-based membership**.

## Quick start

```bash
npm install
cp .env.example .env            # then edit JWT_SECRET, SEED_ADMIN_* (see below)
docker compose up -d            # PostgreSQL 16 (or point DATABASE_URL at your own server)
npx prisma migrate deploy       # applies prisma/migrations (creates all 39 tables)
npx prisma generate
npm run db:seed                 # roles, permissions, payment methods, stations, settings, owner account
npm run dev                     # API + UI: http://localhost:4000/   (health: /health)
```

Set `SEED_DEMO=true` before seeding to also get demo staff (`manager@`, `cashier@`, `kitchen@cafe.local`,
password `Demo-Pass-12345`), a floor with 5 tables and a small sample menu with recipes.
**Never use demo data or the default passwords in production.**

Generate a secret: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

| Script | What it does |
|---|---|
| `npm run dev` | Dev server with reload |
| `npm run build` / `npm start` | Compile to `dist/` and run it |
| `npm run typecheck` | TypeScript check |
| `npm test` | 31 unit tests (pricing, totals/tax maths, phone/membership, kitchen state rules) |
| `npm run test:e2e` | 94-check end-to-end run against a live API + DB (see Testing) |
| `npm run prisma:studio` | Browse the database |

## Web UI

`public/` holds a plain HTML/CSS/JS client (`index.html`, `app.js`, `style.css`) served by Express on the
same origin as the API — no build step, no dev proxy, no CORS setup. Open `http://localhost:<PORT>/` after
`npm run dev` (or `npm run build && npm start`) and log in with any seeded account.

| Screen | Needs | What it does |
|---|---|---|
| New order | `order.create` + `menu.view` | menu with variants/modifiers (min/max/required enforced), dine-in/takeaway/delivery, member by phone, send to kitchen |
| Orders | `order.view` | active tabs, add items, checkout, discount (per permission), payment, complete, cancel |
| Kitchen | `kitchen.view` | ticket board, valid next statuses, cancel with reason, 8 s auto-refresh |
| Bills | `bill.checkout` or `report.view` | bill search, receipt, void (unpaid), refunds |
| Shift | `shift.manage` | open/close own drawer, expected vs actual cash, cash totals |
| Customers | `customer.view` | search, profile, spend stats and recent orders |

Navigation is built from the permissions returned by `GET /auth/me`; every action is still authorised by
the API (hiding a button is not authorization). The UI keeps payments safe to retry with an
`Idempotency-Key` per attempt. `public/` is **not** copied into `dist/`, so run `npm start` from the repo
root; if you package only `dist/`, copy `public/` next to it.

## Membership by phone number

* `customers.phone` is **unique** and stored normalised to E.164 (`98123 45678`, `+977-9812345678`,
  `009779812345678` all become `+9779812345678`), so one real phone = one member.
* `membershipNumber` (e.g. `CAFE-000123`, prefix via `MEMBERSHIP_PREFIX`) is built from a database-assigned
  sequence in the same transaction as the insert, so it is unique, never reused and never changes (even if the phone changes).
* At the counter: `GET /customers/lookup?phone=98xxxxxxxx`, or just send `customerPhone` (+ optional `customerName`)
  when creating an order: the member is found, or registered on the spot.
* Search members by phone, name or membership number: `GET /customers?q=...`.

## Conventions

* Base path `/api/v1`. JSON in/out. Auth: `Authorization: Bearer <token>` from `POST /auth/login`.
* **Money is returned as strings** (`"1133.62"`) to avoid float errors. Never parse with `parseFloat` for maths.
* Errors always look like `{ "error": { "code": "...", "message": "...", "details": ... } }`. Raw DB errors are never exposed.
* Lists are paginated: `?page=1&pageSize=20` → `{ data, meta: { page, pageSize, total, totalPages } }`.
* Dates in query strings are café-local days `YYYY-MM-DD`; timestamps are stored/returned in UTC.
* Payments require an `Idempotency-Key` header (a UUID generated per payment attempt).

## Roles

| Role | Can |
|---|---|
| OWNER | everything (staff, settings, tax, reports, refunds) |
| MANAGER | operations, discount override, cancel sent items, refunds, voids, stock, suppliers, reports |
| CASHIER | orders, customers, checkout, payments, own shift, discounts up to the configured limit (default 10%) |
| KITCHEN | view/update kitchen tickets only; no order, payment or report access |

Roles → permissions live in `src/config/permissions.ts` and are re-synced by `npm run db:seed`.
Permissions are enforced on the server for every protected route (hiding a button is not authorization).

## API reference

Auth, staff
* `POST /auth/login` · `GET /auth/me` · `POST /auth/change-password`
* `GET /staff/roles` · `GET|POST /staff/users` · `PATCH /staff/users/:id` · `POST /staff/users/:id/reset-password`
* `GET /audit-logs` (filters: userId, action, entityType, entityId, from, to)

Customers
* `GET /customers?q=` · `GET /customers/lookup?phone=` · `POST /customers` · `GET|PATCH /customers/:id`

Menu
* `GET /menu` (POS payload: categories → items → variants → modifier groups → options)
* `GET|POST /categories` · `PATCH|DELETE /categories/:id` (delete = archive)
* `GET /menu/items` · `GET|PATCH|DELETE /menu/items/:id` · `POST /menu/items` · `PATCH /menu/items/:id/availability`
* `POST /menu/items/:id/variants` · `PATCH /menu/items/:id/variants/:variantId` · `PUT /menu/items/:id/modifier-groups`
* `GET|POST /modifiers/groups` · `PATCH /modifiers/groups/:id` · `POST /modifiers/groups/:id/options` · `PATCH /modifiers/groups/:id/options/:optionId`

Tables
* `GET /tables` (floors → tables → active orders) · `POST /tables/floors` · `PATCH /tables/floors/:id` · `POST /tables` · `PATCH /tables/:id`

Orders
* `POST /orders` · `GET /orders` · `GET /orders/active` · `GET /orders/:id`
* `POST /orders/:id/items` · `PATCH /orders/:id/items/:itemId` · `POST /orders/:id/items/:itemId/cancel`
* `POST /orders/:id/send-to-kitchen` · `PATCH /orders/:id/discount`
* `POST /orders/:id/move-table` · `POST /orders/:id/merge` · `POST /orders/:id/cancel` · `POST /orders/:id/complete`

Kitchen
* `GET /kitchen/tickets` (`?stationId=&status=`) · `GET /kitchen/tickets/:id` · `PATCH /kitchen/tickets/:id` `{status, reason?}`

Billing & payments
* `POST /orders/:id/checkout` `{ discount? }` → bill · `GET /bills` · `GET /bills/:id` · `GET /bills/:id/receipt`
* `POST /bills/:id/void` · `POST /bills/:id/adjustments` (credit/debit notes)
* `POST /bills/:id/payments` (header `Idempotency-Key`) · `POST /payments/:id/refunds`

Shifts
* `POST /shifts/open` · `GET /shifts/current` · `POST /shifts/current/cash-movements` · `POST /shifts/current/close` · `GET /shifts` · `GET /shifts/:id`

Reports (`report.view`)
* `/reports/dashboard` · `/reports/daily?date=` · `/reports/sales?from&to&groupBy=day|month` · `/reports/top-items`
* `/reports/category-sales` · `/reports/payments` · `/reports/shifts` · `/reports/inventory` · `/reports/wastage` · `/reports/gross-margin`

Inventory & purchasing
* `GET|POST /inventory/items` · `PATCH /inventory/items/:id` · `POST /inventory/items/:id/adjust` (WASTAGE | RETURN | COUNT)
* `GET /inventory/movements` · `GET /inventory/reconcile` · `GET /inventory/recipes` · `PUT /inventory/recipes` · `DELETE /inventory/recipes/:id`
* `GET|POST /inventory/suppliers` · `PATCH /inventory/suppliers/:id`
* `GET|POST /inventory/purchase-orders` · `POST /inventory/purchase-orders/:id/{mark-ordered|receive|cancel}`

Settings
* `GET|PUT /settings/business` · `GET|POST /settings/tax-profiles` · `PATCH /settings/tax-profiles/:id` · `POST /settings/tax-profiles/:id/rates`
* `GET|POST /settings/payment-methods` · `PATCH /settings/payment-methods/:id` · `GET|POST /settings/kitchen-stations` · `PATCH …/:id`

### Typical cashier flow

```
POST /auth/login
POST /shifts/open                    { openingCash: 2000 }
GET  /menu
GET  /customers/lookup?phone=98…     (optional)
POST /orders                         { orderType:"DINE_IN", tableId, customerPhone, items:[{menuItemId, variantId, quantity, modifiers:[{optionId}]}], sendToKitchen:true }
POST /orders/:id/checkout            { discount?: {type:"PERCENTAGE", value:5, reason:"member"} }   → bill with server-calculated totals
POST /bills/:billId/payments         header Idempotency-Key: <uuid>  { paymentMethodId, amount, amountTendered? , providerReference? }
GET  /bills/:billId/receipt
POST /shifts/current/close           { actualClosingCash }
```

## Live updates (Socket.IO)

Connect to the server origin with `io(url, { auth: { token } })`. Rooms are joined automatically by permission:
`kitchen` (all tickets), `station:<id>` (emit `station:join` with an id to subscribe), `pos`.
Events: `ticket:new`, `ticket:updated`, `order:updated`, `table:updated`, `menu:updated`.
Clients should treat events as "refetch this" signals; the REST API remains the source of truth.

## How the business rules are enforced

* **Totals are server-only.** Prices, variants, modifier prices, min/max/required groups, availability, discount,
  service charge and tax are recomputed from the database on every order change and at checkout.
  `subtotal − discount + service charge (dine-in) ± tax`, rounded half-up to 2 decimals; per-line tax is allocated so lines sum exactly to the bill.
* **Snapshots.** `order_items`, `order_item_modifiers` and `bill_items` store names, prices, tax rate and amount at the time of sale.
* **Separate statuses.** `fulfilmentStatus` (kitchen/service) and `paymentStatus` are independent. An order becomes `COMPLETED` once it is both paid and served.
* **Payments.** Row-locked per bill, idempotent by `Idempotency-Key`, can never exceed the balance; split payments across methods work. Cash needs an open shift and records change and a drawer movement.
* **Bills are never edited.** Changing an order with an unpaid bill voids that bill (kept for the audit trail) and a new one is issued at the next checkout. Paid bills are corrected with refunds and credit/debit notes; there are no hard deletes of financial data.
* **Kitchen.** One ticket per station per batch; items added later create a new batch. Tickets move forward only; cancelling needs a reason and is audited.
* **Stock.** Deducted from the recipe when a ticket line is `READY` (completion), reversed if cancelled afterwards, idempotent per ticket line. `current_quantity` is a cache that must equal the movement ledger (`GET /inventory/reconcile` checks this). Stock may go negative rather than blocking service; the inventory report flags it.
* **Discounts.** Up to `maxCashierDiscountPercent` (default 10) with `discount.apply`; above it needs `discount.override`. A reason is mandatory; overrides are audited.
* **Shift cash.** `expected = opening + cash sales + cash in − payouts − petty cash − cash drops − cash refunds`; the difference is stored and audited.
* **Audit log** records logins failures, price edits, discounts, voids, refunds, cancellations, merges, stock adjustments, cash differences, user changes and settings changes.

## Nepal tax / invoicing (engineering note, not legal advice)

Tax is **data, not code**: `tax_profiles` / `tax_rates` plus `business_settings`. The seed creates a "No tax" profile and a
"VAT (standard rate)" profile (13%) **but sets neither as the default**: no tax is charged until the owner picks one via
`PUT /settings/business { "defaultTaxProfileId": … }`. Whether VAT applies to this café, and whether a custom POS may issue
official tax invoices (IRD approval / e-invoice / CBMS requirements), must be confirmed with the IRD or an accountant first.
`pricesIncludeTax` supports tax-inclusive menu prices. Service charge is currently included in the taxable base; confirm that treatment.
Until compliance is confirmed, use `/bills/:id/receipt` as an internal receipt, not a tax invoice.

## Testing

* `npm test`: unit tests for the pure logic (no database needed).
* `npm run test:e2e`: against a **throwaway** database:
  ```bash
  # .env: DATABASE_URL=<throwaway db>, SEED_DEMO=true, SEED_ADMIN_EMAIL=owner@cafe.local,
  #       SEED_ADMIN_PASSWORD=ChangeMe-Now-123, PORT=4100
  npx prisma migrate deploy && npm run db:seed && npm run dev   # terminal 1
  npm run test:e2e                                               # terminal 2
  ```
  It walks the whole workflow (login → member by phone → shift → order → kitchen → discount/tax → checkout → split/idempotent/concurrent payments → refund → shift close → merge/cancel → reports → purchasing) and checks permissions, rounding, stock ledger and audit entries.

## Project layout

```
prisma/            schema.prisma, migrations/, seed.ts
public/            plain-JS POS UI (index.html, app.js, style.css) served by Express
src/config/        env validation, Prisma client, permission catalogue
src/middleware/    auth + permission guards, zod validation, error handler
src/modules/       auth users audit customers settings menu tables orders kitchen billing shifts reports inventory
src/realtime/      Socket.IO
src/utils/         money (Decimal), phone, numbering sequences, audit, time zone helpers
tests/             unit tests      scripts/e2e-smoke.mjs   end-to-end checks
```

Each module has `*.routes.ts` (endpoints + zod schemas) and, where there is real business logic, `*.service.ts`.

## Before going live / known limits

* **Gateway payments (eSewa, Khalti, bank QR APIs):** payments here are *manually recorded* by the cashier (cash, QR/card slip with a mandatory reference). Do not mark an online payment successful from a button press; add provider verification/callback first (the `PENDING`/`FAILED` statuses and unique `providerReference` are already in the schema).
* **Receipt/KOT printing and cash-drawer kick** are hardware-specific and not included (the API returns print-ready receipt and ticket data).
* **Offline mode** is not implemented (needs a local queue, client request IDs and sync).
* Auth is a single access token (default 12h); add refresh tokens / PIN login if you want shorter sessions. Login is rate-limited.
* Run behind HTTPS, set a strong `JWT_SECRET`, restrict `CORS_ORIGINS`, back up PostgreSQL and test restores.
* Ordering numbers are global sequences (`ORD-000001`, `INV-000001`, `KOT-00001`); a daily-reset scheme would be a small change in `src/utils/sequence.ts`.
