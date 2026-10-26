'use strict';
// Pazaryeri Fiyatlandırma — GitHub Pages + Supabase sürümü
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tl = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctf = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 });
const money = (n) => (Number.isFinite(n) ? tl.format(n) : '—');
const parseNum = (v) => {
  if (v === null || v === undefined) return NaN;
  let s = String(v).trim().replace(/[₺%\s]/g, '');
  if (!s) return NaN;
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,56
  else s = s.replace(',', '.');
  return Number(s);
};
const fmtIn = (n) => (Number.isFinite(n) ? String(n).replace('.', ',') : '');

const state = { me: null, settings: null, products: [], users: [], editing: null };

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = 'toast'), 3000);
}

const activeMps = () => state.settings.marketplaces.filter((m) => m.active);
const priceFor = (p, mp) => Calc.priceFor(p, mp, state.settings);

function pctClass(b, target) {
  if (b.profitPct < target - 0.05) return 'bad';
  if (b.profitPct > target + 5) return 'high';
  return 'good';
}

// ================= Supabase veri katmanı =================
const CFG = window.APP_CONFIG || {};
const configured = CFG.SUPABASE_URL && !CFG.SUPABASE_URL.includes('BURAYA') && CFG.SUPABASE_ANON_KEY && !CFG.SUPABASE_ANON_KEY.includes('BURAYA');
const sb = configured ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;
const PAGE_URL = location.origin + location.pathname;

const ERR_TR = [
  [/Invalid login credentials/i, 'E-posta veya parola hatalı'],
  [/Email not confirmed/i, 'E-posta adresiniz henüz onaylanmamış. Gelen kutunuzdaki onay bağlantısına tıklayın.'],
  [/User already registered/i, 'Bu e-posta ile zaten bir hesap var'],
  [/Password should be at least/i, 'Parola en az 8 karakter olmalı'],
  [/rate limit|too many/i, 'Çok fazla deneme yapıldı, biraz sonra tekrar deneyin'],
  [/New password should be different/i, 'Yeni parola eskisinden farklı olmalı'],
  [/row-level security|permission denied/i, 'Bu işlem için yetkiniz yok'],
  [/En az bir aktif yönetici/i, 'En az bir aktif yönetici kalmalı'],
  [/Failed to fetch|NetworkError/i, 'Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edin.'],
];
const trErr = (e) => {
  const m = (e && (e.message || e.error_description)) || String(e);
  for (const [re, tr] of ERR_TR) if (re.test(m)) return tr;
  return m;
};
const must = ({ data, error }) => { if (error) throw new Error(trErr(error)); return data; };
const normProduct = (p) => ({
  ...p, cost: Number(p.cost), vat: Number(p.vat), profit: Number(p.profit), cargo: Number(p.cargo),
  commission: Number(p.commission), overrides: p.overrides || {},
});
const productCols = (d) => ({
  name: d.name, sku: d.sku || '', cost: d.cost, vat: d.vat || 0, profit: d.profit || 0,
  cargo: d.cargo || 0, commission: d.commission || 0, overrides: d.overrides || {},
});
function checkProduct(d) {
  if (!d.name) throw new Error('Ürün adı gerekli');
  if (!(d.cost > 0)) throw new Error('Maliyet 0\'dan büyük olmalı');
  for (const k of ['vat', 'profit', 'cargo', 'commission']) if (!Number.isFinite(d[k]) || d[k] < 0) throw new Error('Sayısal alanlar geçersiz');
  if (d.commission >= 100) throw new Error('Komisyon %100\'den küçük olmalı');
}

const data = {
  async profile() {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return null;
    return must(await sb.from('profiles').select('*').eq('id', user.id).maybeSingle());
  },
  async settings() {
    return must(await sb.from('settings').select('value').eq('key', 'pricing').single()).value;
  },
  async saveSettings(s) {
    const rows = must(await sb.from('settings').update({ value: s }).eq('key', 'pricing').select('value'));
    if (!rows.length) throw new Error('Bu işlem için yetkiniz yok');
    return rows[0].value;
  },
  async products() {
    const all = []; const page = 1000;
    for (let from = 0; ; from += page) {
      const rows = must(await sb.from('products').select('*').order('name').range(from, from + page - 1));
      all.push(...rows);
      if (rows.length < page) break;
    }
    return all.map(normProduct).sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  },
  async addProduct(d) {
    checkProduct(d);
    return normProduct(must(await sb.from('products').insert(productCols(d)).select().single()));
  },
  async updateProduct(id, d) {
    checkProduct(d);
    return normProduct(must(await sb.from('products').update(productCols(d)).eq('id', id).select().single()));
  },
  async deleteProduct(id) { must(await sb.from('products').delete().eq('id', id)); },
  async bulkAdd(items) {
    items.forEach(checkProduct);
    for (let i = 0; i < items.length; i += 500) must(await sb.from('products').insert(items.slice(i, i + 500).map(productCols)));
    return items.length;
  },
  async users() { return must(await sb.from('profiles').select('*').order('created_at')); },
  async updateUser(id, patch) {
    const rows = must(await sb.from('profiles').update(patch).eq('id', id).select());
    if (!rows.length) throw new Error('Bu işlem için yetkiniz yok');
  },
};

// ================= Giriş ekranları =================
function showAuth(formId) {
  $('#app').hidden = true; $('#auth').hidden = false;
  $$('#auth .auth-form').forEach((f) => (f.hidden = f.id !== formId));
  $$('#auth .err-msg').forEach((e) => (e.textContent = ''));
  const first = $(`#${formId} input`); if (first) setTimeout(() => first.focus(), 30);
}
function showMsg(text) { $('#msg-text').textContent = text; showAuth('f-msg'); }
$$('[data-go]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); showAuth(a.dataset.go); }));

function authSubmit(id, fn) {
  const form = $('#' + id);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button.primary'); btn.disabled = true;
    form.querySelector('.err-msg').textContent = '';
    try { await fn(Object.fromEntries(new FormData(form))); }
    catch (err) { form.querySelector('.err-msg').textContent = trErr(err); }
    finally { btn.disabled = false; }
  });
}
authSubmit('f-login', async ({ email, password }) => {
  must(await sb.auth.signInWithPassword({ email: email.trim(), password }));
  await boot();
});
authSubmit('f-signup', async ({ name, email, password }) => {
  if (password.length < 8) throw new Error('Parola en az 8 karakter olmalı');
  const res = must(await sb.auth.signUp({
    email: email.trim(), password, options: { data: { name: name.trim() }, emailRedirectTo: PAGE_URL },
  }));
  if (res.session) return boot();
  showMsg(`${email.trim()} adresine bir onay e-postası gönderildi. E-postadaki bağlantıya tıkladıktan sonra yönetici onayıyla giriş yapabilirsiniz.`);
});
authSubmit('f-forgot', async ({ email }) => {
  must(await sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: PAGE_URL }));
  showMsg('Bu e-postaya kayıtlı bir hesap varsa parola yenileme bağlantısı gönderildi. Gelen kutunuzu (ve gereksiz klasörünü) kontrol edin.');
});
authSubmit('f-newpass', async ({ password }) => {
  if (password.length < 8) throw new Error('Parola en az 8 karakter olmalı');
  must(await sb.auth.updateUser({ password }));
  history.replaceState(null, '', PAGE_URL);
  toast('Parolanız güncellendi');
  await boot();
});
async function logout() { await sb.auth.signOut(); state.me = null; showAuth('f-login'); }
$('#pending-logout').addEventListener('click', logout);

// ---------------- Sekmeler ----------------
function showView(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  if (name === 'users') loadUsers();
  if (name === 'settings') renderSettings();
  if (name === 'quick') renderQuick();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
$('#logout').addEventListener('click', logout);

// ---------------- Ürünler ----------------
function renderProducts() {
  const mps = activeMps();
  const q = $('#search').value.trim().toLocaleLowerCase('tr');
  const list = state.products.filter((p) => !q || p.name.toLocaleLowerCase('tr').includes(q) || (p.sku || '').toLocaleLowerCase('tr').includes(q));

  $('#ptable thead').innerHTML = `<tr>
    <th class="name">Ürün</th><th>Maliyet</th><th>KDV</th><th>Kâr</th><th>Kargo</th><th>Kom.</th>
    ${mps.map((m, i) => `<th class="group${i === 0 ? ' sep' : ''}">${esc(m.name)}</th>`).join('')}
  </tr>`;
  $('#ptable tbody').innerHTML = list.map((p) => `<tr data-id="${p.id}">
    <td class="name" title="${esc(p.name)}">${esc(p.name)}${p.sku ? `<br><span class="sku">${esc(p.sku)}</span>` : ''}</td>
    <td class="num input-col">${money(p.cost)}</td>
    <td class="num input-col">%${pctf.format(p.vat)}</td>
    <td class="num input-col">%${pctf.format(p.profit)}</td>
    <td class="num input-col">${money(p.cargo)}</td>
    <td class="num input-col">%${pctf.format(p.commission)}</td>
    ${mps.map((m, i) => {
      const b = priceFor(p, m);
      if (b.error) return `<td class="${i === 0 ? 'sep' : ''}">—</td>`;
      return `<td class="${i === 0 ? 'sep' : ''}" title="${esc(b.tier)}"><span class="price">${money(b.price)}</span>
        <span class="pct ${pctClass(b, p.profit)}">%${pctf.format(b.profitPct)} kâr${b.overridden ? ' <span class="ov">●</span>' : ''}</span></td>`;
    }).join('')}
  </tr>`).join('');
  $('#pempty').hidden = state.products.length > 0;
  $('#count').textContent = state.products.length ? `${list.length} / ${state.products.length} ürün` : '';
}
$('#search').addEventListener('input', renderProducts);
$('#ptable tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) openProduct(state.products.find((p) => p.id === Number(tr.dataset.id)));
});

// ---------------- Ürün çekmecesi ----------------
function openDrawer(id) { $('#backdrop').classList.add('open'); $(id).classList.add('open'); }
function closeDrawers() { $('#backdrop').classList.remove('open'); $$('.drawer').forEach((d) => d.classList.remove('open')); }
$('#backdrop').addEventListener('click', closeDrawers);
$$('[data-close]').forEach((b) => b.addEventListener('click', closeDrawers));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawers(); });

function formProduct() {
  const f = $('#pform');
  const val = (n) => parseNum(f.elements[n].value);
  const overrides = {};
  $$('#d-breakdown input[data-mp]').forEach((i) => {
    const c = parseNum(i.value);
    if (Number.isFinite(c)) overrides[i.dataset.mp] = { commission: c };
  });
  return {
    name: f.elements.name.value.trim(), sku: f.elements.sku.value.trim(),
    cost: val('cost'), vat: val('vat') || 0, profit: val('profit') || 0, cargo: val('cargo') || 0, commission: val('commission') || 0,
    overrides,
  };
}

function renderBreakdown(keepInputs) {
  const p = formProduct();
  const ok = p.cost > 0;
  const mps = activeMps();
  const prevOv = keepInputs ? p.overrides : (state.editing?.overrides || {});
  const rows = mps.map((m) => {
    const prod = { ...p, overrides: prevOv };
    const b = ok ? priceFor(prod, m) : null;
    const ov = prevOv[m.id]?.commission;
    return `<tr>
      <td>${esc(m.name)}<br><span class="hint">${b && !b.error ? esc(b.tier) : ''}</span></td>
      <td><input data-mp="${esc(m.id)}" inputmode="decimal" placeholder="${pctf.format(p.commission || 0)}" value="${ov !== undefined ? fmtIn(ov) : ''}"></td>
      <td class="num">${b && !b.error ? money(b.commissionTL) : '—'}</td>
      <td class="num">${b && !b.error ? money(b.cargo + b.fee) : '—'}</td>
      <td class="num">${b && !b.error ? `<span class="pct ${pctClass(b, p.profit)}">${money(b.netProfit)}<br>%${pctf.format(b.profitPct)}</span>` : '—'}</td>
      <td class="num"><b>${b && !b.error ? money(b.price) : '—'}</b></td>
    </tr>`;
  }).join('');
  $('#d-breakdown').innerHTML = `<thead><tr><th>Pazaryeri</th><th>Kom. %</th><th>Komisyon</th><th>Kargo+Hizmet</th><th>Net kâr</th><th>Satış fiyatı</th></tr></thead><tbody>${rows}</tbody>`;
}

function openProduct(p) {
  state.editing = p || null;
  const f = $('#pform');
  const d = p || { name: '', sku: '', cost: '', vat: 0, profit: 30, cargo: 83, commission: 19 };
  for (const k of ['name', 'sku']) f.elements[k].value = d[k] || '';
  for (const k of ['cost', 'vat', 'profit', 'cargo', 'commission']) f.elements[k].value = d[k] === '' ? '' : fmtIn(d[k]);
  $('#d-title').textContent = p ? 'Ürünü düzenle' : 'Yeni ürün';
  $('#d-delete').hidden = !p;
  $('#d-meta').textContent = p ? `Son güncelleyen: ${p.updated_by || '—'} · ${new Date(p.updated_at).toLocaleString('tr-TR')}` : '';
  renderBreakdown(false);
  openDrawer('#drawer');
  setTimeout(() => f.elements[p ? 'cost' : 'name'].focus(), 50);
}
$('#pform').addEventListener('input', () => renderBreakdown(true));
$('#d-breakdown').addEventListener('change', () => renderBreakdown(true));
$('#pform').addEventListener('submit', (e) => { e.preventDefault(); $('#d-save').click(); });
$('#btn-add').addEventListener('click', () => openProduct(null));

$('#d-save').addEventListener('click', async () => {
  const pdata = formProduct();
  try {
    if (state.editing) {
      const saved = await data.updateProduct(state.editing.id, pdata);
      state.products = state.products.map((p) => (p.id === saved.id ? saved : p));
    } else {
      const saved = await data.addProduct(pdata);
      state.products.push(saved);
      state.products.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
    }
    closeDrawers(); renderProducts(); toast('Kaydedildi');
  } catch (e) { toast(e.message, true); }
});
$('#d-delete').addEventListener('click', async () => {
  if (!state.editing || !confirm(`“${state.editing.name}” silinsin mi?`)) return;
  try {
    await data.deleteProduct(state.editing.id);
    state.products = state.products.filter((p) => p.id !== state.editing.id);
    closeDrawers(); renderProducts(); toast('Silindi');
  } catch (e) { toast(e.message, true); }
});

// ---------------- Excel'den yapıştır ----------------
let pasteRows = [];
$('#btn-paste').addEventListener('click', () => { $('#paste-text').value = ''; parsePaste(); openDrawer('#paste-drawer'); });
function parsePaste() {
  const lines = $('#paste-text').value.split(/\r?\n/).filter((l) => l.trim());
  pasteRows = []; const bad = [];
  lines.forEach((l, i) => {
    const c = l.split('\t');
    const row = { name: (c[0] || '').trim(), cost: parseNum(c[1]), vat: parseNum(c[2]) || 0, profit: parseNum(c[3]) || 0,
      cargo: parseNum(c[4]) || 0, commission: parseNum(c[5]) || 0, sku: (c[6] || '').trim() };
    if (row.name && row.cost > 0) pasteRows.push(row);
    else if (!(i === 0 && !Number.isFinite(row.cost))) bad.push(i + 1); // başlık satırını sessizce atla
  });
  $('#paste-preview').innerHTML = pasteRows.length
    ? `<b>${pasteRows.length}</b> ürün içe aktarılmaya hazır.${bad.length ? ` <span style="color:var(--bad)">Okunamayan satırlar: ${bad.join(', ')}</span>` : ''}`
    : (bad.length ? `<span style="color:var(--bad)">Satırlar okunamadı. Sütun sırasını kontrol edin.</span>` : '');
  $('#paste-save').disabled = !pasteRows.length;
}
$('#paste-text').addEventListener('input', parsePaste);
$('#paste-save').addEventListener('click', async () => {
  try {
    const added = await data.bulkAdd(pasteRows);
    state.products = await data.products();
    closeDrawers(); renderProducts(); toast(`${added} ürün eklendi`);
  } catch (e) { toast(e.message, true); }
});

// ---------------- Excel'e aktar ----------------
$('#btn-export').addEventListener('click', () => {
  const mps = activeMps();
  const n = (x) => (Number.isFinite(x) ? x.toFixed(2).replace('.', ',') : '');
  const cell = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const head = ['Ürün', 'Stok kodu', 'Maliyet', 'KDV %', 'Kâr %', 'Kargo', 'Komisyon %', ...mps.flatMap((m) => [m.name + ' fiyat', m.name + ' kâr %'])];
  const lines = [head.map(cell).join(';')];
  for (const p of state.products) {
    const vals = [p.name, p.sku, n(p.cost), n(p.vat), n(p.profit), n(p.cargo), n(p.commission)];
    for (const m of mps) { const b = priceFor(p, m); vals.push(n(b.price), n(b.profitPct)); }
    lines.push(vals.map(cell).join(';'));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pazaryeri-fiyatlar-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
});

// ---------------- Hızlı hesap ----------------
function quickProduct() {
  const f = $('#qform');
  const v = (n) => parseNum(f.elements[n].value) || 0;
  return { cost: v('cost'), vat: v('vat'), profit: v('profit'), cargo: v('cargo'), commission: v('commission'), overrides: {} };
}
function renderQuick() {
  const p = quickProduct();
  if (!(p.cost > 0)) { $('#qcards').innerHTML = ''; return; }
  $('#qcards').innerHTML = activeMps().map((m) => {
    const b = priceFor(p, m);
    if (b.error) return `<div class="card mp-card"><h3>${esc(m.name)}</h3><p>${esc(b.error)}</p></div>`;
    return `<div class="card mp-card">
      <h3>${esc(m.name)} <span class="pct ${pctClass(b, p.profit)}">%${pctf.format(b.profitPct)} kâr</span></h3>
      <div class="big num">${money(b.price)} ₺</div>
      <div class="tier">${esc(b.tier)}</div>
      <dl>
        <dt>Komisyon (%${pctf.format(b.commission)})</dt><dd>−${money(b.commissionTL)}</dd>
        <dt>Kargo</dt><dd>−${money(b.cargo)}</dd>
        <dt>Hizmet bedeli</dt><dd>−${money(b.fee)}</dd>
        ${p.vat ? `<dt>KDV</dt><dd>−${money(b.vatTL)}</dd>` : ''}
        <dt>Maliyet</dt><dd>−${money(p.cost)}</dd>
        <div class="divider"></div>
        <dt>Net kâr</dt><dd class="total${b.netProfit < 0 ? ' neg' : ''}">${money(b.netProfit)} ₺</dd>
      </dl>
    </div>`;
  }).join('');
}
$('#qform').addEventListener('input', renderQuick);
$('#q-save').addEventListener('click', () => {
  const p = quickProduct();
  openProduct(null);
  const f = $('#pform');
  for (const k of ['cost', 'vat', 'profit', 'cargo', 'commission']) f.elements[k].value = fmtIn(p[k]);
  renderBreakdown(true);
  f.elements.name.focus();
});

// ---------------- Ayarlar ----------------
let draft = null;
function renderSettings() {
  draft = draft || structuredClone(state.settings);
  $('#rounding').value = draft.rounding || 'none';
  $('#mp-list').innerHTML = draft.marketplaces.map((m, i) => `
    <div class="card mp-set" data-i="${i}">
      <label class="field">Pazaryeri adı<input data-k="name" value="${esc(m.name)}"></label>
      <label class="field">Hizmet bedeli (₺)<input data-k="fee" inputmode="decimal" value="${fmtIn(m.fee)}"></label>
      <label class="field">Kargo modeli
        <select data-k="mode"><option value="tiers"${m.mode !== 'shared' ? ' selected' : ''}>Baremli</option><option value="shared"${m.mode === 'shared' ? ' selected' : ''}>Paylı</option></select>
      </label>
      <div>
        ${m.mode === 'shared' ? `
          <label class="field" style="max-width:200px">Eşik tutar (₺)<input data-k="threshold" inputmode="decimal" value="${fmtIn(m.threshold)}"></label>
          <p class="hint">Eşiğin altında kargo, fiyat ÷ eşik oranında kesilir; üstünde ürünün kendi kargosu.</p>` : `
          <div class="tiers">
            <span class="hint">Kargo baremleri (bu tutarın altındaki satışlarda kesilen kargo)</span>
            ${(m.tiers || []).map((t, j) => `<div class="tier-row">
              <input data-tier="${j}" data-tk="max" inputmode="decimal" value="${fmtIn(t.max)}"> ₺ altı →
              <input data-tier="${j}" data-tk="cargo" inputmode="decimal" value="${fmtIn(t.cargo)}"> ₺ kargo
              <button class="btn small" data-del-tier="${j}" title="Baremi sil">×</button></div>`).join('')}
            <div class="tier-row"><button class="btn small" data-add-tier>+ Barem</button>
              <span class="hint">Üstünde: ürünün kendi kargosu</span></div>
          </div>`}
      </div>
      <div style="display:flex; flex-direction:column; gap:8px; align-items:end">
        <label class="toggle"><input type="checkbox" data-k="active"${m.active ? ' checked' : ''}> Aktif</label>
        <button class="btn small danger" data-del-mp>Kaldır</button>
      </div>
    </div>`).join('');
}
$('#mp-list').addEventListener('input', (e) => {
  const card = e.target.closest('[data-i]'); if (!card) return;
  const m = draft.marketplaces[card.dataset.i];
  const el = e.target;
  if (el.dataset.k === 'active') m.active = el.checked;
  else if (el.dataset.k === 'name') m.name = el.value;
  else if (el.dataset.k === 'mode') { m.mode = el.value; if (m.mode === 'shared' && !m.threshold) m.threshold = 400; renderSettings(); }
  else if (el.dataset.k) m[el.dataset.k] = parseNum(el.value) || 0;
  else if (el.dataset.tier !== undefined) m.tiers[el.dataset.tier][el.dataset.tk] = parseNum(el.value) || 0;
});
$('#mp-list').addEventListener('change', (e) => { if (e.target.type === 'checkbox' || e.target.tagName === 'SELECT') e.target.dispatchEvent(new Event('input', { bubbles: true })); });
$('#mp-list').addEventListener('click', (e) => {
  const card = e.target.closest('[data-i]'); if (!card) return;
  const m = draft.marketplaces[card.dataset.i];
  if (e.target.matches('[data-add-tier]')) {
    const last = m.tiers[m.tiers.length - 1];
    m.tiers.push({ max: last ? last.max + 100 : 150, cargo: last ? last.cargo : 50 }); renderSettings();
  } else if (e.target.dataset.delTier !== undefined) {
    m.tiers.splice(Number(e.target.dataset.delTier), 1); renderSettings();
  } else if (e.target.matches('[data-del-mp]')) {
    if (confirm(`${m.name} kaldırılsın mı? (Geçici gizlemek için “Aktif” kutusunu kaldırmanız yeterli.)`)) {
      draft.marketplaces.splice(Number(card.dataset.i), 1); renderSettings();
    }
  }
});
$('#rounding').addEventListener('change', (e) => { draft.rounding = e.target.value; });
$('#mp-add').addEventListener('click', () => {
  draft.marketplaces.push({ id: 'mp' + Date.now().toString(36), name: 'Yeni pazaryeri', active: true, mode: 'tiers', fee: 0, tiers: [] });
  renderSettings();
  $$('#mp-list [data-k=name]').pop().focus();
});
$('#settings-save').addEventListener('click', async () => {
  try {
    state.settings = await data.saveSettings(draft);
    draft = null; renderSettings(); renderProducts(); toast('Ayarlar kaydedildi');
  } catch (e) { toast(e.message, true); }
});


// ---------------- Kullanıcılar ----------------
async function loadUsers() {
  try { state.users = await data.users(); } catch (e) { return toast(e.message, true); }
  $('#utable tbody').innerHTML = state.users.map((u) => `<tr data-uid="${u.id}" style="cursor:default">
    <td class="name">${esc(u.name)}${u.id === state.me.id ? ' <span class="hint">(siz)</span>' : ''}</td>
    <td style="text-align:left">${esc(u.email)}</td>
    <td style="text-align:left"><span class="badge ${u.role === 'admin' ? 'admin' : ''}">${u.role === 'admin' ? 'Yönetici' : 'Kullanıcı'}</span></td>
    <td style="text-align:left"><span class="badge ${u.active ? '' : 'off'}">${u.active ? 'Aktif' : 'Onay bekliyor / pasif'}</span></td>
    <td>
      <button class="btn small${u.active ? '' : ' primary'}" data-act="active">${u.active ? 'Pasifleştir' : 'Onayla / aktifleştir'}</button>
      <button class="btn small" data-act="role">${u.role === 'admin' ? 'Kullanıcı yap' : 'Yönetici yap'}</button>
      <button class="btn small" data-act="pw">Parola sıfırlama e-postası</button>
    </td></tr>`).join('');
}
$('#utable').addEventListener('click', async (e) => {
  const act = e.target.dataset.act; if (!act) return;
  const u = state.users.find((x) => x.id === e.target.closest('tr').dataset.uid);
  try {
    if (act === 'active') await data.updateUser(u.id, { active: !u.active });
    else if (act === 'role') await data.updateUser(u.id, { role: u.role === 'admin' ? 'user' : 'admin' });
    else if (act === 'pw') {
      if (!confirm(`${u.email} adresine parola yenileme bağlantısı gönderilsin mi?`)) return;
      must(await sb.auth.resetPasswordForEmail(u.email, { redirectTo: PAGE_URL }));
      toast('E-posta gönderildi');
    }
    loadUsers();
  } catch (err) { toast(trErr(err), true); }
});

// ---------------- Hesabım ----------------
$('#pwform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const next = new FormData(e.target).get('next');
  try {
    if (next.length < 8) throw new Error('Parola en az 8 karakter olmalı');
    must(await sb.auth.updateUser({ password: next }));
    e.target.reset(); toast('Parolanız değiştirildi');
  } catch (err) { toast(trErr(err), true); }
});

// ---------------- Başlangıç ----------------
let adminTabs = null;
async function boot() {
  const me = await data.profile();
  if (!me) return showAuth('f-login');
  if (!me.active) {
    $('#pending-text').textContent = `${me.email} hesabı yönetici onayı bekliyor. Onaylandığında bu sayfayı yenileyip girebilirsiniz.`;
    return showAuth('f-pending');
  }
  state.me = me;
  [state.settings, state.products] = await Promise.all([data.settings(), data.products()]);
  $('#who').textContent = me.name;
  $('#acc-sub').textContent = `${me.name} · ${me.email} · ${me.role === 'admin' ? 'Yönetici' : 'Kullanıcı'}`;
  adminTabs = adminTabs || $$('.admin-only');
  adminTabs.forEach((el) => (el.hidden = me.role !== 'admin'));
  $('#auth').hidden = true; $('#app').hidden = false;
  showView('products');
  renderProducts();
}

(async function init() {
  if (!sb) return showAuth('f-config');
  const recovering = /type=recovery/.test(location.hash);
  sb.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') showAuth('f-newpass');
    if (event === 'SIGNED_OUT') { $('#app').hidden = true; }
  });
  const { data: { session } } = await sb.auth.getSession();
  if (recovering) return showAuth('f-newpass');
  if (/type=signup/.test(location.hash)) history.replaceState(null, '', PAGE_URL);
  if (!session) return showAuth('f-login');
  try { await boot(); } catch (e) { toast(trErr(e), true); showAuth('f-login'); }
})();
