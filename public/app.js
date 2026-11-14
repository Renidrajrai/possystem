// Plain-JS POS client for the Café POS API. Served by Express from /public, so all calls are same-origin.
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
const fmt = v => { const n = Number(v); return Number.isFinite(n) ? n.toFixed(2) : String(v ?? ''); };
const when = d => (d ? new Date(d).toLocaleString() : '');
const num = (v, label = 'value') => { if (v === '' || v == null) throw new Error(`Enter ${label}`); const n = Number(v); if (!Number.isFinite(n)) throw new Error(`Enter a valid ${label}`); return n; };

const KITCHEN_FLOW = ['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED'];

let token = localStorage.getItem('tok');
let user = null, perms = new Set();
let menu = [], tables = [], methods = [], cart = [], cat = 0, view = '', timer = null;
let order = { type: 'DINE_IN', tableId: '', phone: '', name: '' };
let addToOrder = null;

const has = c => perms.has(c);
const hasAny = (...c) => c.some(has);

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const r = await fetch('/api/v1' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && token) logout();
    const err = new Error(j.error?.message || r.statusText || `HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return j;
}

function toast(m, err) { const t = $('#toast'); t.textContent = m; t.className = err ? 'err' : ''; t.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => { t.style.display = 'none'; }, 3500); }
const guard = f => async (...a) => { try { await f(...a); } catch (e) { toast(e.message, true); } };

/* ---------- auth / layout ---------- */
const NAV = [
  ['pos', 'New order', () => has('order.create') && has('menu.view')],
  ['orders', 'Orders', () => has('order.view')],
  ['kitchen', 'Kitchen', () => has('kitchen.view')],
  ['bills', 'Bills', () => hasAny('bill.checkout', 'report.view')],
  ['shift', 'Shift', () => has('shift.manage')],
  ['customers', 'Customers', () => has('customer.view')],
];

function loginView() {
  $('#top').hidden = true;
  $('#main').innerHTML = `<form class="card login" id="loginForm">
    <h2>☕ Café POS</h2>
    <p class="muted">Sign in to open the counter</p>
    <label>Email
      <input id="em" name="email" type="email" autocomplete="username" required autofocus placeholder="you@cafe.local">
    </label>
    <label>Password
      <span class="pw"><input id="pw" name="password" type="password" autocomplete="current-password" required placeholder="Your password"><button type="button" class="alt" id="togglePw">Show</button></span>
    </label>
    <p id="loginErr" class="err" hidden></p>
    <button id="go" class="ok" type="submit">Sign in</button>
  </form>`;
  const showErr = m => { const el = $('#loginErr'); el.textContent = m; el.hidden = false; };
  $('#togglePw').onclick = () => {
    const p = $('#pw'), show = p.type === 'password';
    p.type = show ? 'text' : 'password';
    $('#togglePw').textContent = show ? 'Hide' : 'Show';
    p.focus();
  };
  $('#loginForm').onsubmit = async e => {
    e.preventDefault();
    $('#loginErr').hidden = true;
    const email = $('#em').value.trim(), password = $('#pw').value.trim();
    if (!email || !password) return showErr('Enter your email and password.');
    const btn = $('#go');
    btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      const r = await api('/auth/login', { method: 'POST', body: { email, password } });
      if (!r.token) throw new Error('Login response had no token');
      token = r.token; localStorage.setItem('tok', token);
      await start();
    } catch (ex) {
      showErr(ex.status === 401 ? 'Wrong email or password.' : ex.message || 'Could not sign in.');
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  };
}

function logout() {
  token = null; user = null; perms = new Set(); cart = []; addToOrder = null;
  localStorage.removeItem('tok'); clearInterval(timer); timer = null;
  loginView();
}

async function start() {
  try { user = await api('/auth/me'); }
  catch (e) { if (!token) return; toast(e.message, true); return loginView(); }
  perms = new Set(user.permissions || []);
  renderNav();
  const jobs = [];
  if (has('order.create') && has('menu.view')) jobs.push(loadMenu());
  if (has('table.view')) jobs.push(loadTables());
  if (hasAny('bill.checkout', 'payment.create')) jobs.push(loadMethods());
  await Promise.allSettled(jobs);
  go(defaultView());
}

function renderNav() {
  const nav = $('#nav');
  nav.innerHTML = '';
  for (const [v, label, ok] of NAV) if (ok()) {
    const b = document.createElement('button');
    b.dataset.v = v; b.textContent = label; nav.appendChild(b);
  }
  $('#who').textContent = `${user.name || user.email} (${user.role?.name || ''})`;
  $('#top').hidden = false;
}

function defaultView() { const v = NAV.find(([,, ok]) => ok()); return v ? v[0] : null; }

const VIEWS = { pos: posView, orders: ordersView, kitchen: kitchenView, bills: billsView, shift: shiftView, customers: customersView };

function go(v) {
  if (!v) { $('#main').innerHTML = '<div class="card"><h3>No screens available</h3><p>This account has no POS permissions.</p></div>'; return; }
  view = v; clearInterval(timer); timer = null;
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  VIEWS[v]();
}

function refreshCurrent() { const f = { orders: ordersView, bills: billsView, shift: shiftView, kitchen: kitchenView }[view]; if (f) f(); }

async function loadMenu() { try { menu = await api('/menu'); } catch (e) { menu = []; toast(e.message, true); } }
async function loadTables() { try { const floors = await api('/tables'); tables = floors.flatMap(f => (f.tables || []).map(t => ({ ...t, floor: f.name }))); } catch (e) { tables = []; toast(e.message, true); } }
async function loadMethods() { try { methods = await api('/settings/payment-methods'); } catch (e) { methods = []; toast(e.message, true); } }

/* ---------- new order / add items ---------- */
function itemPrice(it) {
  const vs = it.variants || [];
  if (vs.length) return 'from ' + fmt(Math.min(...vs.map(v => Number(v.price))));
  return fmt(it.basePrice);
}

function posView() {
  const c = menu[cat] || { items: [] };
  const approx = cart.reduce((s, l) => s + l.unit * l.qty, 0);
  const adding = addToOrder;
  $('#main').innerHTML = `<div class="pos"><div>
    ${adding ? `<div class="card banner">Adding items to ${esc(adding.orderNumber)} <button class="alt" id="stopAdd">Stop</button></div>` : ''}
    <div class="cats">${menu.map((m, i) => `<button class="alt ${i === cat ? 'on' : ''}" data-c="${i}">${esc(m.name)}</button>`).join('')}</div>
    <div class="grid">${(c.items || []).map((it, i) => `<button class="item ${it.isAvailable === false ? 'off' : ''}" data-i="${i}">${esc(it.name)}<small>${esc(itemPrice(it))}</small></button>`).join('') || '<p>No items</p>'}</div></div>
   <div class="card" id="cart"><h3>${adding ? 'Add to order' : 'Current order'}</h3>
    ${adding ? '' : `<div class="row"><select id="ot">${['DINE_IN', 'TAKEAWAY', 'DELIVERY'].map(t => `<option ${t === order.type ? 'selected' : ''}>${t}</option>`).join('')}</select>
      ${order.type === 'DINE_IN' ? `<select id="tb"><option value="">Choose table…</option>${tables.map(t => `<option value="${t.id}" ${String(t.id) === String(order.tableId) ? 'selected' : ''} ${t.status === 'OUT_OF_SERVICE' ? 'disabled' : ''}>${esc((t.floor ? t.floor + ' · ' : '') + t.name)}${t.status === 'OCCUPIED' ? ' (occupied)' : ''}${t.status === 'OUT_OF_SERVICE' ? ' (out of service)' : ''}</option>`).join('')}</select>` : ''}</div>
     <div class="row"><input id="ph" placeholder="Member phone (optional)" value="${esc(order.phone)}"><input id="cn" placeholder="Name (new member)" value="${esc(order.name)}"></div>`}
    ${cart.map((l, i) => `<div class="line"><div>${esc(l.name)}<small>${esc(l.desc)}</small></div><div class="qty"><button class="alt" data-m="${i}">−</button> ${l.qty} <button class="alt" data-p="${i}">+</button></div></div>`).join('') || '<p>Cart is empty</p>'}
    <p><small>Approx. ${fmt(approx)} — final totals, tax and discounts are calculated by the server.</small></p>
    <div class="row"><button id="send" class="ok">${adding ? 'Add items & send to kitchen' : 'Place order & send to kitchen'}</button><button id="clr" class="alt">Clear</button></div></div></div>`;

  $('.cats').onclick = e => { if (e.target.dataset.c) { cat = +e.target.dataset.c; posView(); } };
  $('.grid').onclick = e => { const b = e.target.closest('[data-i]'); if (b) openItem(c.items[+b.dataset.i]); };
  $('#cart').onclick = e => { const d = e.target.dataset; if (d.m) { cart[+d.m].qty--; cart = cart.filter(l => l.qty > 0); posView(); } if (d.p) { cart[+d.p].qty++; posView(); } };
  if (!adding) {
    const keep = () => { order = { type: $('#ot').value, tableId: $('#tb')?.value || '', phone: $('#ph').value, name: $('#cn').value }; };
    $('#ot').onchange = () => { keep(); posView(); };
    ['#tb', '#ph', '#cn'].forEach(s => { const el = $(s); if (el) el.onchange = keep; });
  }
  if ($('#stopAdd')) $('#stopAdd').onclick = () => { addToOrder = null; go('orders'); };
  $('#clr').onclick = () => { cart = []; posView(); };
  $('#send').onclick = guard(async () => {
    if (!cart.length) throw new Error('Cart is empty');
    const items = cart.map(l => ({ menuItemId: l.itemId, ...(l.variantId ? { variantId: l.variantId } : {}), quantity: l.qty, ...(l.mods.length ? { modifiers: l.mods } : {}) }));
    if (addToOrder) {
      await api(`/orders/${addToOrder.id}/items`, { method: 'POST', body: { items, sendToKitchen: true } });
      toast('Items added'); cart = []; addToOrder = null; go('orders');
      return;
    }
    const body = { orderType: order.type, items, sendToKitchen: true };
    if (order.type === 'DINE_IN') { if (!order.tableId) throw new Error('Choose a table for dine-in orders'); body.tableId = Number(order.tableId); }
    if (order.phone.trim()) { body.customerPhone = order.phone.trim(); if (order.name.trim()) body.customerName = order.name.trim(); }
    const r = await api('/orders', { method: 'POST', body });
    toast('Order placed ' + r.orderNumber); cart = []; order = { type: order.type, tableId: '', phone: '', name: '' }; posView();
  });
}

function openItem(it) {
  if (it.isAvailable === false) return toast('Item unavailable', true);
  const vs = it.variants || [], gs = it.modifierGroups || [];
  if (!vs.length && !gs.length) return addLine(it, null, []);
  const d = $('#dlg');
  d.innerHTML = `<form method="dialog" id="itemForm"><h3>${esc(it.name)}</h3>
    ${vs.length ? `<p><b>Size / variant</b></p>${vs.map((v, i) => `<div><label><input type="radio" name="variant" value="${i}" ${i === 0 ? 'checked' : ''}> ${esc(v.name)} — ${fmt(v.price)}</label></div>`).join('')}` : ''}
    ${gs.map(g => {
      const min = Math.max(g.minSelections || 0, g.isRequired ? 1 : 0), max = g.maxSelections || 0;
      const type = max === 1 && min > 0 ? 'radio' : 'checkbox';
      return `<div class="mo-group" data-min="${min}" data-max="${max}" data-name="${esc(g.name)}"><p><b>${esc(g.name)}</b> <small>${g.isRequired ? 'required' : ''}${max ? ' (max ' + max + ')' : ''}</small></p>
        ${(g.options || []).map(o => `<div><label><input type="${type}" class="mo" name="g${g.id}" value="${o.id}" data-price="${o.additionalPrice ?? 0}" data-name="${esc(o.name)}"> ${esc(o.name)}${Number(o.additionalPrice) ? ' +' + fmt(o.additionalPrice) : ''}</label></div>`).join('')}</div>`;
    }).join('')}
    <div class="row"><button value="add" class="ok">Add</button><button value="x" class="alt">Cancel</button></div></form>`;
  if (!d.open) d.showModal();
  $('#itemForm', d).onsubmit = e => {
    if (e.submitter?.value !== 'add') return;
    e.preventDefault();
    try {
      const chosen = [];
      for (const g of d.querySelectorAll('.mo-group')) {
        const picked = [...g.querySelectorAll('.mo:checked')];
        const min = Number(g.dataset.min), max = Number(g.dataset.max) || 99;
        if (picked.length < min) throw new Error(`Choose at least ${min} for ${g.dataset.name}`);
        if (picked.length > max) throw new Error(`Choose at most ${max} for ${g.dataset.name}`);
        for (const p of picked) chosen.push({ optionId: Number(p.value), name: p.dataset.name, price: Number(p.dataset.price) });
      }
      const vi = d.querySelector('input[name=variant]:checked');
      if (vs.length && !vi) throw new Error('Choose a size/variant');
      addLine(it, vi ? vs[Number(vi.value)] : null, chosen);
    } catch (err) { toast(err.message, true); }
  };
}

function addLine(it, v, mods) {
  const base = Number(v ? v.price : it.basePrice) || 0;
  const unit = base + mods.reduce((s, m) => s + (Number(m.price) || 0), 0);
  cart.push({ itemId: it.id, variantId: v?.id, name: it.name, desc: [v?.name, ...mods.map(m => m.name)].filter(Boolean).join(', '), unit, qty: 1, mods: mods.map(m => ({ optionId: m.optionId })) });
  $('#dlg').close();
  posView();
}

/* ---------- orders ---------- */
let activeOrders = [];

function ordersView() {
  $('#main').innerHTML = `<div class="card"><h3>Active orders <button class="alt" id="rf">Refresh</button></h3><div id="ol">Loading…</div></div>`;
  const load = guard(async () => {
    activeOrders = await api('/orders/active');
    $('#ol').innerHTML = activeOrders.length ? `<table><tr><th>Order</th><th>Table</th><th>Type</th><th>Status</th><th>Total</th><th></th></tr>${activeOrders.map((o, i) => `<tr><td>${esc(o.orderNumber)}</td><td>${esc(o.table?.name || '')}</td><td>${esc(o.orderType)}</td><td><span class="tag">${esc(o.fulfilmentStatus)}</span> <span class="tag">${esc(o.paymentStatus)}</span></td><td>${fmt(o.totalAmount)}</td><td>
      ${has('order.update') && o.paymentStatus === 'UNPAID' ? `<button class="alt" data-add="${i}">Add items</button>` : ''}
      ${has('bill.checkout') && ['UNPAID', 'PARTIALLY_PAID'].includes(o.paymentStatus) ? `<button data-bill="${i}">Checkout &amp; pay</button>` : ''}
      ${has('order.update') && o.paymentStatus === 'PAID' ? `<button class="ok" data-done="${i}">Complete</button>` : ''}
      ${has('order.cancel') ? `<button class="bad" data-cx="${i}">Cancel</button>` : ''}
    </td></tr>`).join('')}</table>` : '<p>No active orders.</p>';
  });
  $('#rf').onclick = load;
  $('#ol').onclick = guard(async e => {
    const d = e.target.dataset;
    if (d.add) { const o = activeOrders[+d.add]; addToOrder = { id: o.id, orderNumber: o.orderNumber }; go('pos'); }
    if (d.bill) openBill(activeOrders[+d.bill].id);
    if (d.done) { await api(`/orders/${activeOrders[+d.done].id}/complete`, { method: 'POST' }); toast('Order completed'); await load(); }
    if (d.cx) {
      const reason = prompt('Reason for cancelling this order?');
      if (reason === null) return;
      if (reason.trim().length < 3) return toast('A reason of at least 3 characters is required', true);
      await api(`/orders/${activeOrders[+d.cx].id}/cancel`, { method: 'POST', body: { reason: reason.trim() } });
      toast('Order cancelled'); await load();
    }
  });
  load();
}

async function openBill(orderId) { renderBill(await api(`/orders/${orderId}/checkout`, { method: 'POST', body: {} }), orderId); }

async function openBillById(billId) {
  const bill = await api('/bills/' + billId);
  renderBill(bill, bill.orderId);
}

function renderBill(bill, orderId) {
  const payments = bill.payments || [];
  const paid = payments.filter(p => p.status === 'SUCCESS').reduce((s, p) => s + Number(p.amount), 0);
  const total = Number(bill.totalDue);
  const balance = Math.max(0, total - paid);
  const open = bill.status === 'ISSUED' || bill.status === 'PARTIALLY_PAID';
  const canDiscount = hasAny('discount.apply', 'discount.override') && paid === 0 && open;
  const canPay = has('payment.create') && open && balance > 0.005;
  const canVoid = has('bill.void') && paid === 0 && open;
  const canRefund = has('payment.refund');
  const d = $('#dlg');
  d.innerHTML = `<h3>Bill ${esc(bill.billNumber)} <span class="tag">${esc(bill.status)}</span></h3>
    <table>
      <tr><td>Subtotal</td><td class="right">${fmt(bill.subtotal)}</td></tr>
      <tr><td>Discount</td><td class="right">${fmt(bill.discount)}</td></tr>
      <tr><td>Service charge</td><td class="right">${fmt(bill.serviceCharge)}</td></tr>
      <tr><td>Tax</td><td class="right">${fmt(bill.tax)}</td></tr>
      <tr><th>Total</th><th class="right">${fmt(bill.totalDue)}</th></tr>
      <tr><td>Paid</td><td class="right">${fmt(paid)}</td></tr>
      <tr><th>Balance</th><th class="right">${fmt(balance)}</th></tr>
    </table>
    ${payments.length ? `<h3>Payments</h3><table>${payments.map(p => {
      const refunded = (p.refunds || []).reduce((s, r) => s + Number(r.amount), 0);
      const max = Number(p.amount) - refunded;
      return `<tr><td>${esc(p.paymentMethod?.name || '')} <span class="tag">${esc(p.status)}</span>${refunded ? ` <small>refunded ${fmt(refunded)}</small>` : ''}${canRefund && p.status === 'SUCCESS' && max > 0.005 ? ` <button class="alt" data-refund="${p.id}" data-max="${max}">Refund</button>` : ''}</td><td class="right">${fmt(p.amount)}</td></tr>`;
    }).join('')}</table>` : ''}
    ${canDiscount ? `<h3>Discount</h3>
      <div class="row"><select id="dType"><option value="NONE">No discount</option><option value="FIXED">Fixed amount</option><option value="PERCENTAGE">Percent</option></select><input id="dValue" placeholder="Value" inputmode="decimal"></div>
      <div class="row"><input id="dReason" placeholder="Reason (required for a discount)"></div>
      <div class="row"><button id="dApply" class="alt">Apply discount</button></div>` : ''}
    ${canPay ? `<h3>Record payment</h3>
      <div class="row"><select id="pm">${methods.map(m => `<option value="${m.id}">${esc(m.name)}${m.isCash ? ' (cash)' : ''}</option>`).join('')}</select></div>
      <div class="row"><input id="am" value="${balance.toFixed(2)}" inputmode="decimal" placeholder="Amount"><input id="tn" inputmode="decimal" placeholder="Cash tendered (optional)"></div>
      <div class="row"><input id="rf" placeholder="Reference (required for some methods)"></div>
      <div class="row"><button id="payBtn" class="ok">Record payment</button></div>` : ''}
    <div class="row">
      ${has('bill.checkout') ? `<button id="rcptBtn" class="alt">Receipt</button>` : ''}
      ${canVoid ? `<button id="voidBtn" class="bad">Void bill</button>` : ''}
      <button id="closeBtn" class="alt">Close</button>
    </div>`;
  if (!d.open) d.showModal();

  $('#closeBtn', d).onclick = () => d.close();
  if ($('#rcptBtn', d)) $('#rcptBtn', d).onclick = guard(async () => renderReceipt(await api(`/bills/${bill.id}/receipt`)));
  if (canVoid) $('#voidBtn', d).onclick = guard(async () => {
    const reason = prompt('Reason for voiding this bill?');
    if (reason === null) return;
    if (reason.trim().length < 3) return toast('A reason of at least 3 characters is required', true);
    await api(`/bills/${bill.id}/void`, { method: 'POST', body: { reason: reason.trim() } });
    toast('Bill voided'); d.close(); refreshCurrent();
  });
  if (canDiscount) $('#dApply', d).onclick = guard(async () => {
    const type = $('#dType', d).value, reason = $('#dReason', d).value.trim(), value = $('#dValue', d).value;
    if (type !== 'NONE' && reason.length < 3) throw new Error('A reason of at least 3 characters is required');
    const body = type === 'NONE' ? { type: 'NONE' } : { type, value: num(value, 'discount value'), reason };
    await api(`/orders/${orderId}/discount`, { method: 'PATCH', body });
    renderBill(await api(`/orders/${orderId}/checkout`, { method: 'POST', body: {} }), orderId);
  });
  if (canPay) $('#payBtn', d).onclick = guard(async () => {
    const btn = $('#payBtn', d); btn.disabled = true;
    try {
      const m = methods.find(x => String(x.id) === $('#pm', d).value);
      const ref = $('#rf', d).value.trim(), tn = $('#tn', d).value.trim();
      if (m?.requiresReference && ref.length < 2) throw new Error(`${m.name} requires a reference`);
      const body = { paymentMethodId: num($('#pm', d).value, 'payment method'), amount: num($('#am', d).value, 'amount') };
      if (tn) body.amountTendered = num(tn, 'tendered amount');
      if (ref) body.providerReference = ref;
      await api(`/bills/${bill.id}/payments`, { method: 'POST', body, headers: { 'Idempotency-Key': uuid() } });
      toast('Payment recorded');
      renderReceipt(await api(`/bills/${bill.id}/receipt`));
    } finally { btn.disabled = false; }
  });
  if (canRefund) d.querySelectorAll('[data-refund]').forEach(b => b.onclick = guard(async () => {
    const max = Number(b.dataset.max);
    const amount = prompt(`Refund amount (max ${fmt(max)})`, max.toFixed(2));
    if (amount === null) return;
    const reason = prompt('Reason for the refund?');
    if (reason === null) return;
    if (reason.trim().length < 3) return toast('A reason of at least 3 characters is required', true);
    await api(`/payments/${b.dataset.refund}/refunds`, { method: 'POST', body: { amount: num(amount, 'refund amount'), reason: reason.trim() } });
    toast('Refund recorded');
    renderBill(await api(`/bills/${bill.id}`), orderId);
  }));
}

function renderReceipt(rc) {
  const b = rc.business, bill = rc.bill, d = $('#dlg');
  d.innerHTML = `<div id="receipt">
    <h3>${esc(b.name)}</h3>
    <p><small>${esc([b.address, b.phone].filter(Boolean).join(' · '))}</small></p>
    <p>Bill ${esc(bill.billNumber)} · ${esc(when(bill.issuedAt))}<br>
      Order ${esc(rc.order.orderNumber)}${rc.order.table ? ' · Table ' + esc(rc.order.table) : ''} · ${esc(rc.order.orderType)}<br>
      Cashier ${esc(rc.order.cashier)}${rc.customer?.name ? ' · ' + esc(rc.customer.name) : ''}</p>
    <table>${(rc.items || []).map(i => `<tr><td>${esc(i.quantity)}× ${esc(i.descriptionSnapshot)}</td><td class="right">${fmt(i.lineTotal)}</td></tr>`).join('')}</table>
    <table>
      <tr><td>Subtotal</td><td class="right">${fmt(bill.subtotal)}</td></tr>
      ${Number(bill.discount) ? `<tr><td>Discount</td><td class="right">-${fmt(bill.discount)}</td></tr>` : ''}
      ${Number(bill.serviceCharge) ? `<tr><td>Service charge</td><td class="right">${fmt(bill.serviceCharge)}</td></tr>` : ''}
      <tr><td>Tax</td><td class="right">${fmt(bill.tax)}</td></tr>
      <tr><th>Total</th><th class="right">${fmt(bill.totalDue)}</th></tr>
      <tr><td>Paid</td><td class="right">${fmt(bill.amountPaid)}</td></tr>
      ${(rc.payments || []).map(p => `<tr><td>${esc(p.method)}${p.reference ? ' · ' + esc(p.reference) : ''}</td><td class="right">${fmt(p.amount)}</td></tr>`).join('')}
    </table>
    ${b.footer ? `<p><small>${esc(b.footer)}</small></p>` : ''}
  </div>
  <div class="row"><button id="doPrint" class="ok">Print</button><button id="doClose" class="alt">Done</button></div>`;
  if (!d.open) d.showModal();
  $('#doPrint', d).onclick = () => window.print();
  $('#doClose', d).onclick = () => { d.close(); refreshCurrent(); };
}

/* ---------- bills ---------- */
function billsView() {
  $('#main').innerHTML = `<div class="card"><h3>Bills</h3>
    <div class="row"><select id="bStatus"><option value="">All statuses</option><option>ISSUED</option><option>PARTIALLY_PAID</option><option>PAID</option><option>VOID</option></select>
      <input id="bDate" type="date"><input id="bq" placeholder="Bill number"></div>
    <div class="row"><button id="bSearch">Search</button></div>
    <div id="bl">Loading…</div></div>`;
  const load = guard(async () => {
    const qs = new URLSearchParams({ pageSize: '50' });
    if ($('#bStatus').value) qs.set('status', $('#bStatus').value);
    if ($('#bDate').value) qs.set('date', $('#bDate').value);
    if ($('#bq').value.trim()) qs.set('q', $('#bq').value.trim());
    const r = await api('/bills?' + qs);
    $('#bl').innerHTML = r.data.length ? `<table><tr><th>Bill</th><th>Order</th><th>Type</th><th>Status</th><th>Total</th><th>Issued</th><th></th></tr>${r.data.map(b => `<tr><td>${esc(b.billNumber)}</td><td>${esc(b.order?.orderNumber || '')}</td><td>${esc(b.order?.orderType || '')}</td><td><span class="tag">${esc(b.status)}</span></td><td>${fmt(b.totalDue)}</td><td>${esc(when(b.issuedAt))}</td><td>
      ${has('bill.checkout') ? `<button class="alt" data-receipt="${b.id}">Receipt</button> <button data-open="${b.id}">Open</button>` : ''}
    </td></tr>`).join('')}</table><p><small>${r.meta.total} bill(s)</small></p>` : '<p>No bills.</p>';
  });
  $('#bSearch').onclick = load;
  $('#bl').onclick = guard(async e => {
    const d = e.target.dataset;
    if (d.receipt) renderReceipt(await api(`/bills/${d.receipt}/receipt`));
    if (d.open) await openBillById(Number(d.open));
  });
  load();
}

/* ---------- kitchen ---------- */
function nextStatuses(status) {
  const i = KITCHEN_FLOW.indexOf(status);
  if (status === 'SERVED' || status === 'CANCELLED' || i < 0) return [];
  return [...KITCHEN_FLOW.slice(i + 1), 'CANCELLED'];
}

function kitchenView() {
  const load = guard(async () => {
    const ts = await api('/kitchen/tickets');
    const canUpdate = has('kitchen.update');
    $('#main').innerHTML = `<h3>Kitchen tickets <small>(auto-refresh)</small></h3>` + (ts.map(t => `<div class="card tk">
      <b>${esc(t.ticketNumber)}</b> <span class="tag">${esc(t.status)}</span>
      <div><small>${esc(t.station?.name || '')} · ${esc(t.order?.orderNumber || '')}${t.order?.table ? ' · ' + esc(t.order.table.name) : ''}${t.order?.orderType ? ' · ' + esc(t.order.orderType) : ''}</small></div>
      ${(t.items || []).map(i => { const oi = i.orderItem || {}; return `<div class="line"><span>${esc(i.quantity)}× ${esc(oi.itemNameSnapshot || '')}${oi.variantNameSnapshot ? ' (' + esc(oi.variantNameSnapshot) + ')' : ''}
        ${(oi.modifiers || []).length ? '<small>' + oi.modifiers.map(m => esc((m.quantity > 1 ? m.quantity + '× ' : '') + m.modifierNameSnapshot)).join(', ') + '</small>' : ''}
        ${oi.notes ? '<small>Note: ' + esc(oi.notes) + '</small>' : ''}</span></div>`; }).join('')}
      ${canUpdate ? `<div class="row">${nextStatuses(t.status).map(s => `<button class="alt" data-t="${t.id}" data-s="${s}">${s === 'CANCELLED' ? 'Cancel' : s}</button>`).join('')}</div>` : ''}
    </div>`).join('') || '<p>No tickets.</p>');
  });
  load();
  timer = setInterval(() => { if (view === 'kitchen') load(); }, 8000);
  $('#main').onclick = guard(async e => {
    const d = e.target.dataset;
    if (!d.t) return;
    const body = { status: d.s };
    if (d.s === 'CANCELLED') {
      const reason = prompt('Reason for cancelling this ticket?');
      if (reason === null) return;
      if (reason.trim().length < 3) return toast('A reason of at least 3 characters is required', true);
      body.reason = reason.trim();
    }
    await api('/kitchen/tickets/' + d.t, { method: 'PATCH', body });
    await load();
  });
}

/* ---------- shift ---------- */
function shiftView() {
  $('#main').innerHTML = '<div id="sh">Loading…</div>';
  const load = guard(async () => {
    let s = null;
    try { s = await api('/shifts/current'); } catch (e) { if (e.status !== 404) throw e; }
    if (!s) {
      $('#sh').innerHTML = `<div class="card"><h3>No open shift</h3>
        <div class="row"><input id="oc" placeholder="Opening cash" inputmode="decimal"></div>
        <div class="row"><input id="on" placeholder="Notes (optional)"></div>
        <div class="row"><button id="op" class="ok">Open shift</button></div></div>`;
      $('#op').onclick = guard(async () => {
        const notes = $('#on').value.trim();
        await api('/shifts/open', { method: 'POST', body: { openingCash: num($('#oc').value || '0', 'opening cash'), ...(notes ? { notes } : {}) } });
        toast('Shift opened'); load();
      });
      return;
    }
    const sh = s.shift, c = s.cash;
    $('#sh').innerHTML = `<div class="card"><h3>Shift open <small>since ${esc(when(sh.openedAt))}</small></h3>
      <table>
        <tr><td>Opening cash</td><td class="right">${fmt(c.opening)}</td></tr>
        <tr><td>Cash sales</td><td class="right">${fmt(c.cashSales)}</td></tr>
        <tr><td>Cash in</td><td class="right">${fmt(c.cashIn)}</td></tr>
        <tr><td>Payouts</td><td class="right">-${fmt(c.payouts)}</td></tr>
        <tr><td>Petty cash</td><td class="right">-${fmt(c.pettyCash)}</td></tr>
        <tr><td>Cash drops</td><td class="right">-${fmt(c.cashDrops)}</td></tr>
        <tr><td>Refunds</td><td class="right">-${fmt(c.refunds)}</td></tr>
        <tr><th>Expected closing</th><th class="right">${fmt(c.expectedClosing)}</th></tr>
        <tr><td>Orders</td><td class="right">${s.orders}</td></tr>
      </table>
      ${s.paymentsByMethod.length ? `<h3>Payments by method</h3><table>${s.paymentsByMethod.map(m => `<tr><td>${esc(m.method)}</td><td class="right">${m.count}×</td><td class="right">${fmt(m.amount)}</td></tr>`).join('')}</table>` : ''}
      <h3>Close shift</h3>
      <div class="row"><input id="cc" placeholder="Actual closing cash" inputmode="decimal"></div>
      <div class="row"><input id="cn" placeholder="Notes (optional)"></div>
      <div class="row"><button id="cl" class="bad">Close shift</button></div></div>`;
    $('#cl').onclick = guard(async () => {
      const notes = $('#cn').value.trim();
      const r = await api('/shifts/current/close', { method: 'POST', body: { actualClosingCash: num($('#cc').value, 'closing cash'), ...(notes ? { notes } : {}) } });
      $('#sh').innerHTML = `<div class="card"><h3>Shift closed</h3>
        <table><tr><td>Expected</td><td class="right">${fmt(r.cash.expectedClosing)}</td></tr>
        <tr><td>Actual</td><td class="right">${fmt(r.shift.actualClosingCash)}</td></tr>
        <tr><th>Difference</th><th class="right">${fmt(r.difference)}</th></tr></table></div>`;
      toast('Shift closed');
    });
  });
  load();
}

/* ---------- customers ---------- */
function customersView() {
  $('#main').innerHTML = `<div class="card"><h3>Customers</h3>
    <div class="row"><input id="cq" placeholder="Phone, name or membership no."><button id="cs">Search</button></div>
    <div id="cl">Enter a search term.</div></div>`;
  const load = guard(async () => {
    const r = await api('/customers?pageSize=50&q=' + encodeURIComponent($('#cq').value.trim()));
    $('#cl').innerHTML = r.data.length ? `<table><tr><th>Member</th><th>Name</th><th>Phone</th><th>Joined</th></tr>${r.data.map(c => `<tr class="click" data-id="${c.id}"><td>${esc(c.membershipNumber)}</td><td>${esc(c.name || '')}</td><td>${esc(c.phone)}</td><td>${esc(when(c.joinedAt))}</td></tr>`).join('')}</table><p><small>${r.meta.total} customer(s)</small></p>` : '<p>No match.</p>';
  });
  $('#cs').onclick = load;
  $('#cq').onkeydown = e => e.key === 'Enter' && load();
  $('#cl').onclick = guard(async e => {
    const row = e.target.closest('[data-id]');
    if (row) await showCustomer(Number(row.dataset.id));
  });
}

async function showCustomer(id) {
  const c = await api('/customers/' + id);
  const d = $('#dlg');
  d.innerHTML = `<h3>${esc(c.name || 'Customer')} <span class="tag">${esc(c.membershipNumber)}</span></h3>
    <p>${esc(c.phone)}${c.email ? ' · ' + esc(c.email) : ''}</p>
    <p>${c.stats.paidOrders} paid order(s) · spent ${fmt(c.stats.totalSpent)}</p>
    <h3>Recent orders</h3>
    ${c.recentOrders?.length ? `<table>${c.recentOrders.map(o => `<tr><td>${esc(o.orderNumber)}</td><td>${esc(o.orderType)}</td><td class="right">${fmt(o.totalAmount)}</td><td><span class="tag">${esc(o.fulfilmentStatus)}</span></td></tr>`).join('')}</table>` : '<p>No orders.</p>'}
    <div class="row"><button id="cClose" class="alt">Close</button></div>`;
  if (!d.open) d.showModal();
  $('#cClose', d).onclick = () => d.close();
}

/* ---------- boot ---------- */
$('#nav').onclick = e => { if (e.target.dataset.v) go(e.target.dataset.v); };
$('#out').onclick = logout;
token ? start() : loginView();
