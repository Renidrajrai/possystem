// End-to-end smoke test of the real API (94 checks). Needs: PostgreSQL migrated + seeded with SEED_DEMO=true,
// and the API running on PORT=4100 (see README > Testing). Usage: node scripts/e2e-smoke.mjs
// Run it against a THROWAWAY database: it creates orders, payments and shifts.
const BASE = 'http://localhost:4100/api/v1';
let passed = 0, failed = 0;
const ok = (cond, msg, extra) => { if (cond) { passed++; console.log('  ✓', msg); } else { failed++; console.log('  ✗ FAIL:', msg, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); } };

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}
const login = async (email, password = 'Demo-Pass-12345') => (await call('POST', '/auth/login', { body: { email, password } })).body?.token;
const uuid = () => crypto.randomUUID();

console.log('\n== Auth & permissions');
const owner = await login('owner@cafe.local', 'ChangeMe-Now-123');
const manager = await login('manager@cafe.local');
const cashier = await login('cashier@cafe.local');
const kitchen = await login('kitchen@cafe.local');
ok(owner && manager && cashier && kitchen, 'all four roles can log in');
ok((await call('POST', '/auth/login', { body: { email: 'owner@cafe.local', password: 'wrong-password' } })).status === 401, 'wrong password -> 401');
ok((await call('GET', '/orders')).status === 401, 'no token -> 401');
ok((await call('GET', '/orders', { token: kitchen })).status === 403, 'kitchen cannot list orders (403)');
ok((await call('GET', '/reports/daily', { token: cashier })).status === 403, 'cashier cannot view reports (403)');
const meRes = await call('GET', '/auth/me', { token: cashier });
ok(meRes.body.role.name === 'CASHIER' && meRes.body.permissions.includes('order.create'), '/auth/me returns role + permissions');

console.log('\n== Menu');
const menu = (await call('GET', '/menu', { token: cashier })).body;
const allItems = menu.flatMap((c) => c.items);
const capp = allItems.find((i) => i.name === 'Cappuccino');
const sandwich = allItems.find((i) => i.name === 'Club Sandwich');
const brownie = allItems.find((i) => i.name === 'Brownie');
ok(capp && capp.variants.length === 3 && capp.modifierGroups.length === 2, 'POS menu loads item with 3 variants + 2 modifier groups');
const large = capp.variants.find((v) => v.name === 'Large');
const milkG = capp.modifierGroups.find((g) => g.name === 'Milk Type');
const oat = milkG.options.find((o) => o.name === 'Oat milk');
const whole = milkG.options.find((o) => o.name === 'Whole milk');
const shot = capp.modifierGroups.find((g) => g.name === 'Extras').options.find((o) => o.name === 'Extra shot');

console.log('\n== Customers & membership by phone');
const c1 = await call('POST', '/customers', { token: cashier, body: { phone: '98123 45678', name: 'Sita' } });
ok(c1.status === 201 && c1.body.phone === '+9779812345678' && c1.body.membershipNumber === 'CAFE-000001', 'member created, phone normalised, membership CAFE-000001', c1.body);
const dup = await call('POST', '/customers', { token: cashier, body: { phone: '+977-9812345678' } });
ok(dup.status === 409, 'same phone in another format -> 409 (one member per phone)');
const look = await call('GET', '/customers/lookup?phone=9812345678', { token: cashier });
ok(look.status === 200 && look.body.membershipNumber === 'CAFE-000001', 'lookup by phone finds the member');
const c2 = await call('POST', '/customers', { token: cashier, body: { phone: '9841000000', name: 'Ram' } });
ok(c2.body.membershipNumber === 'CAFE-000002', 'next member gets CAFE-000002');
ok((await call('POST', '/customers', { token: cashier, body: { phone: 'abc' } })).status === 400, 'invalid phone -> 400');

console.log('\n== Shift + order creation');
ok((await call('POST', '/shifts/open', { token: cashier, body: { openingCash: 2000 } })).status === 201, 'cashier opens shift (opening cash 2000)');
ok((await call('POST', '/shifts/open', { token: cashier, body: { openingCash: 100 } })).status === 409, 'second open shift refused');
const tables = (await call('GET', '/tables', { token: cashier })).body;
const t1 = tables[0].tables.find((t) => t.name === 'T1');
const t2 = tables[0].tables.find((t) => t.name === 'T2');

ok((await call('POST', '/orders', { token: cashier, body: { orderType: 'DINE_IN', tableId: t1.id, items: [{ menuItemId: capp.id, variantId: large.id, quantity: 1 }] } })).status === 400, 'required milk group missing -> 400');
ok((await call('POST', '/orders', { token: cashier, body: { orderType: 'DINE_IN', items: [{ menuItemId: brownie.id, quantity: 1 }] } })).status === 400, 'dine-in without table -> 400');
ok((await call('POST', '/orders', { token: cashier, body: { orderType: 'TAKEAWAY', items: [{ menuItemId: capp.id, variantId: large.id, quantity: 1, modifiers: [{ optionId: whole.id }, { optionId: oat.id }] }] } })).status === 400, 'too many milk options -> 400');

const o1res = await call('POST', '/orders', { token: cashier, body: { orderType: 'DINE_IN', tableId: t1.id, customerPhone: '9812345678', guestCount: 2,
  items: [{ menuItemId: capp.id, variantId: large.id, quantity: 1, notes: 'extra hot', modifiers: [{ optionId: oat.id }, { optionId: shot.id }] }, { menuItemId: brownie.id, quantity: 2 }] } });
const o1 = o1res.body;
ok(o1res.status === 201 && o1.orderNumber === 'ORD-000001', 'order created ORD-000001', o1res.body);
ok(o1.items[0].unitPriceSnapshot === '370' && o1.items[1].lineTotal === '240' && o1.subtotal === '610', 'server priced items: 370 + 2x120 = 610', { u: o1.items[0].unitPriceSnapshot, s: o1.subtotal });
ok(o1.customer?.membershipNumber === 'CAFE-000001', 'order linked to member by phone');
ok((await call('GET', '/tables', { token: cashier })).body[0].tables.find((t) => t.name === 'T1').status === 'OCCUPIED', 'table T1 now OCCUPIED');

console.log('\n== Kitchen routing');
const sent = await call('POST', `/orders/${o1.id}/send-to-kitchen`, { token: cashier });
ok(sent.status === 201 && sent.body.length === 2, 'items split into 2 tickets (Coffee Bar + Bakery)', sent.body.map?.((t) => t.station?.name));
ok((await call('POST', `/orders/${o1.id}/send-to-kitchen`, { token: cashier })).status === 400, 'sending again with nothing new -> 400');
const add = await call('POST', `/orders/${o1.id}/items`, { token: cashier, body: { items: [{ menuItemId: sandwich.id, quantity: 1 }], sendToKitchen: true } });
ok(add.status === 201, 'add sandwich later and send');
const tickets = (await call('GET', '/kitchen/tickets', { token: kitchen })).body;
ok(tickets.length === 3 && tickets.some((t) => t.batchNumber === 2 && t.station.name === 'Kitchen'), 'late item became a NEW batch ticket; earlier tickets kept', tickets.map((t) => [t.ticketNumber, t.batchNumber, t.station.name]));
const coffeeTicket = tickets.find((t) => t.station.name === 'Coffee Bar');
ok((await call('PATCH', `/kitchen/tickets/${coffeeTicket.id}`, { token: cashier, body: { status: 'READY' } })).status === 403, 'cashier cannot update tickets');
ok((await call('PATCH', `/kitchen/tickets/${coffeeTicket.id}`, { token: kitchen, body: { status: 'PREPARING' } })).status === 200, 'kitchen: PREPARING');
ok((await call('PATCH', `/kitchen/tickets/${coffeeTicket.id}`, { token: kitchen, body: { status: 'READY' } })).status === 200, 'kitchen: READY (stock deducted)');
ok((await call('PATCH', `/kitchen/tickets/${coffeeTicket.id}`, { token: kitchen, body: { status: 'PREPARING' } })).status === 409, 'ticket cannot move backwards');
const inv = (await call('GET', '/inventory/items', { token: manager })).body;
ok(inv.find((i) => i.name === 'Coffee beans').currentQuantity === '4982' && inv.find((i) => i.name === 'Milk').currentQuantity === '19850', 'recipe consumed 18g beans + 150ml milk', inv.map((i) => [i.name, i.currentQuantity]));

console.log('\n== Discount, tax and checkout (all computed on the server)');
ok((await call('PATCH', `/orders/${o1.id}/discount`, { token: cashier, body: { type: 'PERCENTAGE', value: 50, reason: 'friend' } })).status === 403, 'cashier 50% discount over limit -> 403');
ok((await call('PATCH', `/orders/${o1.id}/discount`, { token: cashier, body: { type: 'PERCENTAGE', value: 5 } })).status === 400, 'discount without reason -> 400');
const tp = (await call('GET', '/settings/tax-profiles', { token: owner })).body.find((p) => p.name.startsWith('VAT'));
ok((await call('PUT', '/settings/business', { token: manager, body: { serviceChargePct: 10 } })).status === 403, 'manager cannot edit settings');
ok((await call('PUT', '/settings/business', { token: owner, body: { businessName: 'Test Café', serviceChargePct: 10, defaultTaxProfileId: tp.id } })).status === 200, 'owner sets VAT profile + 10% service charge');
const co = await call('POST', `/orders/${o1.id}/checkout`, { token: cashier, body: { discount: { type: 'PERCENTAGE', value: 5, reason: 'loyalty member' } } });
const bill = co.body;
// subtotal: 370 + 240 + 350 = 960 ; 5% = 48 ; net 912 ; service 91.2 ; base 1003.2 ; tax 130.416 -> 130.42 ; total 1133.62
ok(co.status === 201 && bill.subtotal === '960' && bill.discount === '48' && bill.serviceCharge === '91.2' && bill.tax === '130.42' && bill.totalDue === '1133.62', 'bill: 960 -48 +91.20 svc +130.42 VAT = 1133.62', bill);
const taxSum = bill.items.reduce((s, i) => s + Number(i.taxAmount), 0);
ok(Math.abs(taxSum - 130.42) < 0.001, 'line taxes add up exactly to bill tax', taxSum);
const again = await call('POST', `/orders/${o1.id}/checkout`, { token: cashier, body: {} });
ok(again.body.id === bill.id, 'checkout again returns the same bill (idempotent)');

console.log('\n== Payments: partial, idempotency, change, overpay, concurrency');
const methods = (await call('GET', '/settings/payment-methods', { token: cashier })).body;
const cash = methods.find((m) => m.name === 'Cash'); const qr = methods.find((m) => m.name === 'QR');
ok((await call('POST', `/bills/${bill.id}/payments`, { token: cashier, body: { paymentMethodId: cash.id, amount: 100 } })).status === 400, 'missing Idempotency-Key -> 400');
const k1 = uuid();
const p1 = await call('POST', `/bills/${bill.id}/payments`, { token: cashier, headers: { 'Idempotency-Key': k1 }, body: { paymentMethodId: cash.id, amount: 133.62, amountTendered: 200 } });
ok(p1.status === 201 && p1.body.changeDue === '66.38' && p1.body.bill.status === 'PARTIALLY_PAID', 'cash 133.62 (gave 200) -> change 66.38, bill PARTIALLY_PAID', p1.body);
const p1b = await call('POST', `/bills/${bill.id}/payments`, { token: cashier, headers: { 'Idempotency-Key': k1 }, body: { paymentMethodId: cash.id, amount: 133.62, amountTendered: 200 } });
ok(p1b.status === 200 && p1b.body.replayed === true && p1b.body.payment.id === p1.body.payment.id, 'same Idempotency-Key replays instead of double-charging');
ok((await call('POST', `/bills/${bill.id}/payments`, { token: cashier, headers: { 'Idempotency-Key': k1 }, body: { paymentMethodId: cash.id, amount: 5 } })).status === 409, 'same key with different amount -> 409');
ok((await call('POST', `/bills/${bill.id}/payments`, { token: cashier, headers: { 'Idempotency-Key': uuid() }, body: { paymentMethodId: qr.id, amount: 10 } })).status === 400, 'QR without reference -> 400');
ok((await call('POST', `/bills/${bill.id}/payments`, { token: cashier, headers: { 'Idempotency-Key': uuid() }, body: { paymentMethodId: qr.id, amount: 2000, providerReference: 'TXN-OVER' } })).status === 400, 'overpaying the balance -> 400');

// 6 simultaneous attempts to pay the remaining 1000 with QR, each with a different key and reference:
const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => call('POST', `/bills/${bill.id}/payments`, { token: cashier, headers: { 'Idempotency-Key': uuid() }, body: { paymentMethodId: qr.id, amount: 1000, providerReference: `TXN-RACE-${i}` } })));
const wins = burst.filter((r) => r.status === 201).length;
ok(wins === 1, 'concurrent attempts: exactly ONE succeeds, no over-payment', burst.map((r) => r.status));
const billAfter = (await call('GET', `/bills/${bill.id}`, { token: cashier })).body;
ok(billAfter.status === 'PAID' && billAfter.amountPaid === '1133.62', 'bill PAID, amountPaid 1133.62', { s: billAfter.status, p: billAfter.amountPaid });
// same key fired 5x concurrently on a fresh order is covered below
let ord = (await call('GET', `/orders/${o1.id}`, { token: cashier })).body;
ok(ord.paymentStatus === 'PAID', 'order paymentStatus PAID (fulfilment tracked separately)', ord.fulfilmentStatus);

console.log('\n== Serve everything -> order completes, table frees');
for (const t of (await call('GET', '/kitchen/tickets', { token: kitchen })).body) {
  await call('PATCH', `/kitchen/tickets/${t.id}`, { token: kitchen, body: { status: 'READY' } });
  await call('PATCH', `/kitchen/tickets/${t.id}`, { token: kitchen, body: { status: 'SERVED' } });
}
ord = (await call('GET', `/orders/${o1.id}`, { token: cashier })).body;
ok(ord.fulfilmentStatus === 'COMPLETED' && ord.closedAt, 'paid + served => COMPLETED', ord.fulfilmentStatus);
ok((await call('GET', '/tables', { token: cashier })).body[0].tables.find((t) => t.name === 'T1').status === 'AVAILABLE', 'table T1 AVAILABLE again');
ok((await call('POST', `/orders/${o1.id}/items`, { token: cashier, body: { items: [{ menuItemId: brownie.id, quantity: 1 }] } })).status === 409, 'cannot add items to a closed order');

console.log('\n== Receipt, refunds, shift reconciliation');
const rc = (await call('GET', `/bills/${bill.id}/receipt`, { token: cashier })).body;
ok(rc.bill.balance === '0' && rc.payments.length === 2 && rc.order.cashier === 'Demo Cashier' && rc.business.name === 'Test Café', 'receipt payload complete');
const payCash = p1.body.payment;
ok((await call('POST', `/payments/${payCash.id}/refunds`, { token: cashier, body: { amount: 10, reason: 'oops' } })).status === 403, 'cashier cannot refund');
ok((await call('POST', `/payments/${payCash.id}/refunds`, { token: manager, body: { amount: 10, reason: 'cold coffee' } })).status === 409, 'cash refund needs manager to have an open shift');
await call('POST', '/shifts/open', { token: manager, body: { openingCash: 500 } });
ok((await call('POST', `/payments/${payCash.id}/refunds`, { token: manager, body: { amount: 500, reason: 'too much' } })).status === 400, 'refund above payment -> 400');
ok((await call('POST', `/payments/${payCash.id}/refunds`, { token: manager, body: { amount: 33.62, reason: 'cold coffee' } })).status === 201, 'manager refunds 33.62 cash');
ord = (await call('GET', `/orders/${o1.id}`, { token: cashier })).body;
ok(ord.paymentStatus === 'PARTIALLY_REFUNDED', 'order PARTIALLY_REFUNDED');
ok((await call('POST', `/bills/${bill.id}/void`, { token: manager, body: { reason: 'mistake' } })).status === 409, 'paid bill cannot be voided');
const closeS = await call('POST', '/shifts/current/close', { token: cashier, body: { actualClosingCash: 2100 } });
// opening 2000 + cash sales 133.62 = 2133.62 expected; counted 2100 => -33.62
ok(closeS.status === 200 && closeS.body.cash.expectedClosing === '2133.62' && closeS.body.difference === '-33.62', 'shift close: expected 2133.62, counted 2100 => -33.62', closeS.body.cash);
const mclose = await call('POST', '/shifts/current/close', { token: manager, body: { actualClosingCash: 466.38 } });
ok(mclose.body.cash.expectedClosing === '466.38' && mclose.body.difference === '0', 'manager shift: 500 - 33.62 refund = 466.38 reconciles', mclose.body.cash);

console.log('\n== Cancel flow, merge, move table');
const oA = (await call('POST', '/orders', { token: cashier, body: { orderType: 'DINE_IN', tableId: t2.id, items: [{ menuItemId: brownie.id, quantity: 1 }] } })).body;
const oB = (await call('POST', '/orders', { token: cashier, body: { orderType: 'TAKEAWAY', items: [{ menuItemId: sandwich.id, quantity: 1 }] } })).body;
await call('POST', `/orders/${oB.id}/send-to-kitchen`, { token: cashier });
const oBnow = (await call('GET', `/orders/${oB.id}`, { token: cashier })).body;
ok((await call('POST', `/orders/${oB.id}/items/${oBnow.items[0].id}/cancel`, { token: cashier, body: { reason: 'customer left' } })).status === 403, 'cashier cannot cancel an item already sent to kitchen');
ok((await call('POST', `/orders/${oB.id}/items/${oBnow.items[0].id}/cancel`, { token: manager, body: { reason: 'customer left' } })).status === 200, 'manager cancels sent item');
const afterCancel = (await call('GET', `/orders/${oB.id}`, { token: manager })).body;
ok(afterCancel.subtotal === '0' && (await call('GET', '/kitchen/tickets', { token: kitchen })).body.every((t) => t.order.id !== oB.id), 'cancelled item leaves totals and the kitchen screen');
ok((await call('POST', `/orders/${oB.id}/cancel`, { token: manager, body: { reason: 'walked out' } })).status === 200, 'manager cancels the order');
const t3 = tables[0].tables.find((t) => t.name === 'T3');
ok((await call('POST', `/orders/${oA.id}/move-table`, { token: cashier, body: { tableId: t3.id } })).status === 200, 'order moved T2 -> T3');
const oC = (await call('POST', '/orders', { token: cashier, body: { orderType: 'DINE_IN', tableId: t2.id, items: [{ menuItemId: brownie.id, quantity: 2 }] } })).body;
const merged = await call('POST', `/orders/${oA.id}/merge`, { token: cashier, body: { sourceOrderId: oC.id } });
ok(merged.status === 200 && merged.body.items.length === 2 && merged.body.subtotal === '360', 'orders merged (items moved, totals recalculated)', merged.body.subtotal);
ok((await call('GET', `/orders/${oC.id}`, { token: cashier })).body.fulfilmentStatus === 'CANCELLED', 'source order closed as merged');

console.log('\n== Bill void / re-bill / zero-total');
await call('POST', '/shifts/open', { token: cashier, body: { openingCash: 0 } });
const b1 = (await call('POST', `/orders/${oA.id}/checkout`, { token: cashier, body: {} })).body;
await call('POST', `/orders/${oA.id}/items`, { token: cashier, body: { items: [{ menuItemId: brownie.id, quantity: 1 }] } });
const oldBill = (await call('GET', `/bills/${b1.id}`, { token: cashier })).body;
ok(oldBill.status === 'VOID', 'editing the order voids the stale unpaid bill (kept for audit)');
const b2 = (await call('POST', `/orders/${oA.id}/checkout`, { token: cashier, body: {} })).body;
ok(b2.id !== b1.id && b2.subtotal === '480', 're-checkout issues a fresh bill with new totals');
const free = (await call('POST', `/orders/${oA.id}/checkout`, { token: owner, body: { discount: { type: 'PERCENTAGE', value: 100, reason: 'owner comp' } } }));
ok(free.status === 201 && free.body.totalDue === '0' && free.body.status === 'PAID', '100% owner discount => bill auto-PAID at 0');

console.log('\n== Idempotency under concurrency (same key x5)');
const oD = (await call('POST', '/orders', { token: cashier, body: { orderType: 'TAKEAWAY', items: [{ menuItemId: brownie.id, quantity: 1 }] } })).body;
const bD = (await call('POST', `/orders/${oD.id}/checkout`, { token: cashier, body: {} })).body;
const sameKey = uuid();
const rs = await Promise.all(Array.from({ length: 5 }, () => call('POST', `/bills/${bD.id}/payments`, { token: cashier, headers: { 'Idempotency-Key': sameKey }, body: { paymentMethodId: cash.id, amount: 135.6, amountTendered: 140 } })));
const bDnow = (await call('GET', `/bills/${bD.id}`, { token: cashier })).body;
ok(bDnow.payments.length === 1 && rs.every((r) => [200, 201].includes(r.status)), '5 identical concurrent clicks => 1 payment, all get a success reply', rs.map((r) => r.status));
const ordD = await call('POST', `/orders/${oD.id}/complete`, { token: cashier });
ok(ordD.status === 200 && ordD.body.fulfilmentStatus === 'COMPLETED', 'counter hand-off completes a paid takeaway order');

console.log('\n== Reports & audit');
const daily = (await call('GET', '/reports/daily', { token: manager })).body;
ok(daily.sales.paidBills >= 3 && daily.payments.some((p) => p.method === 'Cash'), 'daily report has paid bills and payment methods', daily.sales);
ok(daily.sales.refunds === '33.62', 'daily report counts the refund', daily.sales.refunds);
const top = (await call('GET', '/reports/top-items', { token: manager })).body;
ok(top.length > 0 && top[0].quantity > 0, 'top items report works', top[0]);
ok((await call('GET', '/reports/sales?groupBy=day', { token: manager })).body.rows.length >= 1, 'sales trend (SQL, café-local days) works');
ok((await call('GET', '/reports/category-sales', { token: manager })).status === 200, 'category sales works');
const gm = (await call('GET', '/reports/gross-margin', { token: manager })).body;
ok(gm.rows.find((r) => r.name === 'Cappuccino')?.hasRecipe === true, 'gross-margin uses recipe costs');
ok((await call('GET', '/reports/shifts', { token: manager })).body.length >= 2, 'shift report lists shifts');
ok((await call('GET', '/reports/dashboard', { token: owner })).status === 200, 'dashboard works');
ok((await call('GET', '/reports/inventory', { token: manager })).status === 200, 'inventory report works');
const rec = (await call('GET', '/inventory/reconcile', { token: manager })).body;
ok(rec.ok === true, 'stock cache reconciles to the movement ledger', rec);
const audits = (await call('GET', '/audit-logs?pageSize=100', { token: owner })).body.data.map((a) => a.action);
for (const a of ['DISCOUNT_APPLIED', 'DISCOUNT_OVERRIDE', 'REFUND', 'BILL_VOID', 'SHIFT_CASH_DIFFERENCE', 'ORDER_ITEM_CANCELLED', 'ORDER_CANCELLED', 'ORDERS_MERGED']) {
  ok(audits.includes(a), `audit log has ${a}`);
}

console.log('\n== Purchasing & stock');
const sup = (await call('POST', '/inventory/suppliers', { token: manager, body: { name: 'Himalayan Beans' } })).body;
const beans = inv.find((i) => i.name === 'Coffee beans');
const po = (await call('POST', '/inventory/purchase-orders', { token: manager, body: { supplierId: sup.id, markOrdered: true, items: [{ inventoryItemId: beans.id, quantityOrdered: 1000, unitCost: 2 }] } })).body;
const rcv = await call('POST', `/inventory/purchase-orders/${po.id}/receive`, { token: manager, body: { items: [{ purchaseOrderItemId: po.items[0].id, quantityReceived: 1000 }] } });
ok(rcv.status === 200 && rcv.body.status === 'RECEIVED', 'purchase order received');
ok((await call('GET', '/inventory/items', { token: manager })).body.find((i) => i.name === 'Coffee beans').currentQuantity === '5982', 'beans stock = 4982 + 1000');
ok((await call('POST', `/inventory/items/${beans.id}/adjust`, { token: manager, body: { type: 'WASTAGE', quantity: 50, reason: 'spilled' } })).status === 201, 'wastage recorded');
ok((await call('GET', '/inventory/reconcile', { token: manager })).body.ok === true, 'ledger still reconciles after purchase + wastage');

console.log('\n== Static UI');
const ui = await fetch('http://localhost:4100/');
const uiHtml = await ui.text();
ok(ui.status === 200 && uiHtml.includes('Café POS') && uiHtml.includes('app.js'), 'GET / serves the POS page');
const missing = await fetch(BASE + '/does-not-exist');
const missingJson = await missing.json().catch(() => null);
ok(missing.status === 404 && missingJson?.error?.code === 'NOT_FOUND', 'unknown API route still returns the JSON 404');

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
