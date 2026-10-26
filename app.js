'use strict';
// Pazaryeri Fiyatlandırma — GitHub Pages + Supabase sürümü
const APP_VERSION = 5;

// Beklenmeyen bir hata olursa boş ekran yerine açıklama göster
function showFatal(msg) {
  if (document.getElementById('fatal')) return;
  const d = document.createElement('div');
  d.id = 'fatal';
  d.style.cssText = 'max-width:560px;margin:60px auto;padding:20px 24px;background:#fbe9e6;color:#7a1f18;border-radius:10px;font:15px/1.5 system-ui,sans-serif';
  d.innerHTML = '<b>Sayfa yüklenirken bir sorun oluştu.</b><br>Genellikle GitHub\'a yüklenen dosyalardan biri eksik ya da eski olduğunda görülür. ' +
    '<b>index.html, app.js, calc.js, style.css</b> dosyalarının dördünü birlikte yükleyip sayfayı Ctrl+F5 ile yenileyin.' +
    '<br><br><small style="opacity:.7">Teknik ayrıntı: ' + String(msg).replace(/[<>&]/g, '') + '</small>';
  document.body.prepend(d);
}
window.addEventListener('error', (e) => showFatal(e.message));
window.addEventListener('unhandledrejection', (e) => showFatal(e.reason && e.reason.message ? e.reason.message : e.reason));
if (document.body.dataset.version !== String(APP_VERSION)) {
  showFatal('index.html sürümü app.js ile uyuşmuyor');
  throw new Error('Sürüm uyuşmazlığı');
}
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

const state = { me: null, settings: null, users: [] };

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

// ================= Sekmeler =================
function showView(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  if (name === 'users') loadUsers();
  if (name === 'settings') renderSettings();
  if (name === 'calc') renderCalc();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
$('#logout').addEventListener('click', logout);

// Eski ayar biçimi (sürüm 1) veritabanında duruyorsa yeni varsayılanlar kullanılır
function normalizeSettings(s) {
  const def = Calc.DEFAULT_SETTINGS_V2;
  if (!s || s.version !== 2 || !Array.isArray(s.categories) || !s.categories.length) return structuredClone(def);
  // Kategori listesi güncellendiyse (rev) yeni kategoriler alınır
  const rev = s.rev || 1;
  if (rev < 2) s.categories = structuredClone(def.categories);
  if (rev < 3) { // Amazon 35 ve 40 desi = 30 desi fiyatı
    const amz = s.marketplaces.find((m) => m.id === 'amazon');
    if (amz && amz.desiCargo) for (const d of [35, 40]) if (amz.desiCargo[d] == null || amz.desiCargo[d] === '') amz.desiCargo[d] = amz.desiCargo[30];
  }
  if (rev < 4) { // ePTT: maliyet 165 ₺ altı → 25 ₺ kargo
    const ptt = s.marketplaces.find((m) => m.id === 'eptt');
    if (ptt && !ptt.costRule) ptt.costRule = { maxCost: 165, cargo: 25 };
  }
  s.rev = def.rev;
  return s;
}

// ================= Fiyat hesapla =================
const calc = { profits: {} }; // kullanıcının elle değiştirdiği kâr oranları
const PREF_KEY = 'pf-calc-prefs';
function loadPrefs() { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch { return {}; } }
function savePrefs() {
  try { localStorage.setItem(PREF_KEY, JSON.stringify({ cat: $('#c-cat').value, desi: $('#c-desi').value })); } catch { /* yok say */ }
}

function fillCalcSelectors() {
  const s = state.settings; const prefs = loadPrefs();
  const curCat = $('#c-cat').value || prefs.cat;
  const curDesi = $('#c-desi').value || prefs.desi;
  $('#c-cat').innerHTML = s.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  if (s.categories.some((c) => c.id === curCat)) $('#c-cat').value = curCat;
  const ds = s.desi.slice().sort((a, b) => a - b);
  $('#c-desi').innerHTML = ds.map((d) => `<option value="${d}">${fmtIn(d)} desi</option>`).join('');
  if (ds.includes(Number(curDesi))) $('#c-desi').value = curDesi;
}

function renderCalc() {
  const s = state.settings;
  const input = {
    categoryId: $('#c-cat').value,
    desi: Number($('#c-desi').value),
    cost: parseNum($('#c-cost').value),
    vat: parseNum($('#c-vat').value) || 0,
    profits: calc.profits,
  };
  const rows = Calc.computeAll(s, input);
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.mp : null;
  $('#ctable tbody').innerHTML = rows.map((r) => {
    const changed = Number.isFinite(calc.profits[r.mp.id]) && calc.profits[r.mp.id] !== r.defaultProfit;
    const profitIn = `<input class="profit-in${changed ? ' changed' : ''}" data-mp="${esc(r.mp.id)}" inputmode="decimal" value="${fmtIn(r.profit)}" title="Varsayılan: %${pctf.format(r.defaultProfit)}">`;
    const head = `<td class="name"><b>${esc(r.mp.name)}</b></td>`;
    if (r.unavailable) {
      return `<tr class="na">${head}<td class="num">%${pctf.format(r.commission)}</td><td colspan="2">Bu desi için kargo tanımlı değil</td><td>${profitIn}</td><td></td><td class="num">—</td></tr>`;
    }
    const b = r.result;
    if (!b) {
      return `<tr>${head}<td class="num">%${pctf.format(r.commission)}</td><td class="num">${r.desiCargo !== null ? money(r.desiCargo) : '—'}<span class="sub2">desi kargosu</span></td><td class="num">${money(r.mp.fee || 0)}</td><td>${profitIn}</td><td></td><td class="num">—</td></tr>`;
    }
    if (b.error) return `<tr>${head}<td colspan="6">${esc(b.error)}</td></tr>`;
    const extra = Math.abs(b.profitPct - r.profit) > 0.5
      ? `<span class="sub2" style="color:var(--warn)">%${pctf.format(b.profitPct)} gerçekleşen</span>` : '';
    return `<tr>${head}
      <td class="num">%${pctf.format(r.commission)}<span class="sub2">${money(b.commissionTL)}</span></td>
      <td class="num">${money(b.cargo)}<span class="sub2">${esc(b.tier)}</span></td>
      <td class="num">${money(b.fee)}</td>
      <td>${profitIn}</td>
      <td class="num${b.netProfit < 0 ? ' neg' : ''}">${money(b.netProfit)}${extra}</td>
      <td class="num price-cell" data-price="${b.price.toFixed(2)}" title="Kopyalamak için tıklayın">${money(b.price)} ₺</td>
    </tr>`;
  }).join('');
  if (focused) {
    const el = $(`#ctable input[data-mp="${focused}"]`);
    if (el) { el.focus(); const v = el.value; el.value = ''; el.value = v; }
  }
}

$('#c-cost').addEventListener('input', renderCalc);
$('#c-vat').addEventListener('input', renderCalc);
$('#c-cat').addEventListener('change', () => { calc.profits = {}; $('#c-allprofit').value = ''; savePrefs(); renderCalc(); });
$('#c-desi').addEventListener('change', () => { savePrefs(); renderCalc(); });
$('#c-allprofit').addEventListener('input', (e) => {
  const v = parseNum(e.target.value);
  calc.profits = {};
  if (Number.isFinite(v)) state.settings.marketplaces.forEach((m) => (calc.profits[m.id] = v));
  renderCalc();
});
$('#c-reset').addEventListener('click', () => { calc.profits = {}; $('#c-allprofit').value = ''; renderCalc(); });
$('#ctable').addEventListener('input', (e) => {
  if (!e.target.classList.contains('profit-in')) return;
  const v = parseNum(e.target.value);
  if (Number.isFinite(v)) calc.profits[e.target.dataset.mp] = v; else delete calc.profits[e.target.dataset.mp];
  renderCalc();
});
$('#ctable').addEventListener('click', async (e) => {
  const td = e.target.closest('.price-cell'); if (!td) return;
  const txt = td.dataset.price.replace('.', ',');
  try { await navigator.clipboard.writeText(txt); toast(`${txt} kopyalandı`); } catch { toast(txt); }
});

// ================= Ayarlar (yönetici) =================
let draft = null;
const mpName = (id) => (draft.marketplaces.find((m) => m.id === id) || {}).name || id;
const numIn = (v) => (v === null || v === undefined || v === '' ? '' : fmtIn(Number(v)));

$$('.subtab').forEach((b) => b.addEventListener('click', () => {
  $$('.subtab').forEach((x) => x.classList.toggle('active', x === b));
  $$('.sub-view').forEach((v) => v.classList.toggle('active', v.id === 'sub-' + b.dataset.sub));
}));

function renderSettings() {
  draft = draft || structuredClone(state.settings);
  $('#rounding').value = draft.rounding || 'none';
  renderCats(); renderDesi(); renderMps();
}

function renderCats() {
  const mps = draft.marketplaces;
  $('#sub-cats').innerHTML = draft.categories.map((c, ci) => `
    <div class="card cat-card" data-ci="${ci}">
      <header>
        <input data-cat-name value="${esc(c.name)}" placeholder="Kategori adı">
        <div class="spacer"></div>
        <button class="btn small danger" data-del-cat ${draft.categories.length < 2 ? 'disabled' : ''}>Kategoriyi sil</button>
      </header>
      <div class="table-wrap" style="max-height:none">
        <table class="grid edit-grid">
          <thead><tr><th class="name">Pazaryeri</th><th>Komisyon %</th><th>Varsayılan kâr %</th></tr></thead>
          <tbody>${mps.map((m) => {
            const r = c.rates[m.id] || { commission: 0, profit: 0 };
            return `<tr><td class="name">${esc(m.name)}${m.active ? '' : ' <span class="hint">(pasif)</span>'}</td>
              <td><input data-rate="${esc(m.id)}" data-k="commission" inputmode="decimal" value="${numIn(r.commission)}"></td>
              <td><input data-rate="${esc(m.id)}" data-k="profit" inputmode="decimal" value="${numIn(r.profit)}"></td></tr>`;
          }).join('')}</tbody>
        </table>
      </div>
    </div>`).join('') + `<button class="btn" id="cat-add">+ Kategori ekle</button>`;
}
$('#sub-cats').addEventListener('input', (e) => {
  const card = e.target.closest('[data-ci]'); if (!card) return;
  const c = draft.categories[card.dataset.ci];
  if (e.target.matches('[data-cat-name]')) c.name = e.target.value;
  else if (e.target.dataset.rate) {
    const id = e.target.dataset.rate;
    c.rates[id] = c.rates[id] || { commission: 0, profit: 0 };
    c.rates[id][e.target.dataset.k] = parseNum(e.target.value) || 0;
  }
});
$('#sub-cats').addEventListener('click', (e) => {
  if (e.target.id === 'cat-add') {
    const base = draft.categories[0];
    draft.categories.push({ id: 'cat' + Date.now().toString(36), name: 'Yeni kategori', rates: structuredClone(base ? base.rates : {}) });
    renderCats();
    $$('#sub-cats [data-cat-name]').pop().select();
  } else if (e.target.matches('[data-del-cat]')) {
    const ci = Number(e.target.closest('[data-ci]').dataset.ci);
    if (confirm(`“${draft.categories[ci].name}” kategorisi silinsin mi?`)) { draft.categories.splice(ci, 1); renderCats(); }
  }
});

function renderDesi() {
  const ds = draft.desi.slice().sort((a, b) => a - b);
  const mps = draft.marketplaces;
  $('#sub-desi').innerHTML = `
    <p class="hint" style="margin-top:0">Barem üstü satışlarda kesilen kargo. Boş bırakılan hücre: o desi için kargo yok (pazaryeri o desideki ürünlerde “tanımlı değil” görünür).</p>
    <div class="card table-wrap">
      <table class="grid edit-grid">
        <thead><tr><th class="name" style="min-width:110px">Desi (en fazla)</th>${mps.map((m) => `<th>${esc(m.name)}</th>`).join('')}<th></th></tr></thead>
        <tbody>${ds.map((d) => `<tr data-d="${d}">
          <td class="name"><input data-desi-val value="${d}" inputmode="decimal" style="width:64px"></td>
          ${mps.map((m) => `<td><input data-dc="${esc(m.id)}" inputmode="decimal" value="${numIn(m.desiCargo ? m.desiCargo[d] : '')}"></td>`).join('')}
          <td><button class="btn small" data-del-desi title="Satırı sil">×</button></td></tr>`).join('')}</tbody>
      </table>
    </div>
    <button class="btn" id="desi-add" style="margin-top:12px">+ Desi satırı ekle</button>`;
}
$('#sub-desi').addEventListener('change', (e) => {
  const tr = e.target.closest('tr[data-d]'); if (!tr) return;
  const d = Number(tr.dataset.d);
  if (e.target.matches('[data-desi-val]')) {
    const nd = parseNum(e.target.value);
    if (!(nd > 0) || (nd !== d && draft.desi.includes(nd))) { toast('Geçersiz ya da tekrar eden desi', true); return renderDesi(); }
    draft.desi = draft.desi.map((x) => (x === d ? nd : x));
    draft.marketplaces.forEach((m) => { m.desiCargo = m.desiCargo || {}; m.desiCargo[nd] = m.desiCargo[d]; if (nd !== d) delete m.desiCargo[d]; });
    renderDesi();
  } else if (e.target.dataset.dc) {
    const m = draft.marketplaces.find((x) => x.id === e.target.dataset.dc);
    const v = parseNum(e.target.value);
    m.desiCargo = m.desiCargo || {};
    m.desiCargo[d] = Number.isFinite(v) ? v : null;
  }
});
$('#sub-desi').addEventListener('click', (e) => {
  if (e.target.id === 'desi-add') {
    const nd = Math.max(0, ...draft.desi) + 5;
    draft.desi.push(nd); draft.marketplaces.forEach((m) => { m.desiCargo = m.desiCargo || {}; m.desiCargo[nd] = null; });
    renderDesi();
  } else if (e.target.matches('[data-del-desi]')) {
    if (draft.desi.length < 2) return;
    const d = Number(e.target.closest('tr').dataset.d);
    draft.desi = draft.desi.filter((x) => x !== d);
    draft.marketplaces.forEach((m) => m.desiCargo && delete m.desiCargo[d]);
    renderDesi();
  }
});

function renderMps() {
  $('#sub-mps').innerHTML = `<div class="mp-settings">${draft.marketplaces.map((m, i) => `
    <div class="card mp-set" data-i="${i}">
      <label class="field">Pazaryeri adı<input data-k="name" value="${esc(m.name)}"></label>
      <label class="field">Hizmet bedeli (₺)<input data-k="fee" inputmode="decimal" value="${numIn(m.fee)}"></label>
      <label class="field">Kargo modeli
        <select data-k="mode"><option value="tiers"${m.mode !== 'shared' ? ' selected' : ''}>Baremli</option><option value="shared"${m.mode === 'shared' ? ' selected' : ''}>Paylı</option></select>
      </label>
      <div>
        ${m.mode === 'shared' ? `
          <label class="field" style="max-width:200px">Eşik tutar (₺)<input data-k="threshold" inputmode="decimal" value="${numIn(m.threshold)}"></label>
          <p class="hint">Eşiğin altında desi kargosunun fiyat ÷ eşik kadarı kesilir; üstünde tamamı.</p>` : `
          <div class="tiers">
            <span class="hint">Barem kargoları (bu tutarın altındaki satışlarda kesilen kargo)</span>
            ${(m.tiers || []).map((t, j) => `<div class="tier-row">
              <input data-tier="${j}" data-tk="max" inputmode="decimal" value="${numIn(t.max)}"> ₺ altı →
              <input data-tier="${j}" data-tk="cargo" inputmode="decimal" value="${numIn(t.cargo)}"> ₺ kargo
              <button class="btn small" data-del-tier="${j}" title="Baremi sil">×</button></div>`).join('')}
            <div class="tier-row"><button class="btn small" data-add-tier>+ Barem</button>
              <span class="hint">Üstünde: desi kargosu</span></div>
          </div>`}
        <div class="tier-row" style="margin-top:10px">Maliyet
          <input data-cr="maxCost" inputmode="decimal" placeholder="—" value="${numIn(m.costRule && m.costRule.maxCost)}"> ₺ altındaysa kargo
          <input data-cr="cargo" inputmode="decimal" placeholder="—" value="${numIn(m.costRule && m.costRule.cargo)}"> ₺
          <span class="hint">(desiden bağımsız; boş = kural yok)</span></div>
        <label class="field" style="max-width:260px; margin-top:10px">Barem en fazla kaç desiye kadar geçerli
          <input data-k="baremMaxDesi" inputmode="decimal" placeholder="Sınırsız" value="${numIn(m.baremMaxDesi)}"></label>
      </div>
      <div style="display:flex; flex-direction:column; gap:8px; align-items:end">
        <label class="toggle"><input type="checkbox" data-k="active"${m.active ? ' checked' : ''}> Aktif</label>
      </div>
    </div>`).join('')}</div>
    <button class="btn" id="mp-add" style="margin-top:12px">+ Pazaryeri ekle</button>`;
}
$('#sub-mps').addEventListener('input', (e) => {
  const card = e.target.closest('[data-i]'); if (!card) return;
  const m = draft.marketplaces[card.dataset.i];
  const el = e.target;
  if (el.dataset.k === 'active') m.active = el.checked;
  else if (el.dataset.k === 'name') m.name = el.value;
  else if (el.dataset.k === 'mode') { m.mode = el.value; if (m.mode === 'shared' && !m.threshold) m.threshold = 400; renderMps(); }
  else if (el.dataset.cr) {
    m.costRule = m.costRule || { maxCost: 0, cargo: 0 };
    const v = parseNum(el.value); m.costRule[el.dataset.cr] = Number.isFinite(v) ? v : 0;
    if (!(m.costRule.maxCost > 0)) m.costRule = m.costRule.cargo ? m.costRule : null;
  }
  else if (el.dataset.k === 'baremMaxDesi') { const v = parseNum(el.value); m.baremMaxDesi = v > 0 ? v : null; }
  else if (el.dataset.k) m[el.dataset.k] = parseNum(el.value) || 0;
  else if (el.dataset.tier !== undefined) m.tiers[el.dataset.tier][el.dataset.tk] = parseNum(el.value) || 0;
});
$('#sub-mps').addEventListener('change', (e) => { if (e.target.type === 'checkbox' || e.target.tagName === 'SELECT') e.target.dispatchEvent(new Event('input', { bubbles: true })); });
$('#sub-mps').addEventListener('click', (e) => {
  if (e.target.id === 'mp-add') {
    const id = 'mp' + Date.now().toString(36);
    draft.marketplaces.push({ id, name: 'Yeni pazaryeri', active: true, mode: 'tiers', fee: 0, tiers: [], threshold: 0, baremMaxDesi: null,
      desiCargo: Object.fromEntries(draft.desi.map((d) => [d, null])) });
    draft.categories.forEach((c) => (c.rates[id] = { commission: 0, profit: 30 }));
    renderSettings(); return;
  }
  const card = e.target.closest('[data-i]'); if (!card) return;
  const m = draft.marketplaces[card.dataset.i];
  if (e.target.matches('[data-add-tier]')) {
    const last = m.tiers[m.tiers.length - 1];
    m.tiers.push({ max: last ? last.max + 100 : 150, cargo: last ? last.cargo : 50 }); renderMps();
  } else if (e.target.dataset.delTier !== undefined) {
    m.tiers.splice(Number(e.target.dataset.delTier), 1); renderMps();
  }
});
$('#rounding').addEventListener('change', (e) => { draft.rounding = e.target.value; });

function cleanDraft(d) {
  const s = structuredClone(d);
  s.version = 2;
  s.desi = [...new Set(s.desi.map(Number).filter((x) => x > 0))].sort((a, b) => a - b);
  s.marketplaces.forEach((m) => {
    m.tiers = (m.tiers || []).filter((t) => t.max > 0 && t.cargo >= 0).sort((a, b) => a.max - b.max);
    m.name = String(m.name || '').trim() || m.id;
  });
  s.categories.forEach((c) => {
    c.name = String(c.name || '').trim() || 'Kategori';
    for (const r of Object.values(c.rates)) if (!(r.commission >= 0 && r.commission < 100)) throw new Error(`${c.name}: komisyon 0–99 arasında olmalı`);
  });
  return s;
}
$('#settings-save').addEventListener('click', async () => {
  try {
    const s = cleanDraft(draft);
    state.settings = normalizeSettings(await data.saveSettings(s));
    draft = null; renderSettings(); fillCalcSelectors(); toast('Ayarlar kaydedildi');
  } catch (e) { toast(trErr(e), true); }
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
  state.settings = normalizeSettings(await data.settings());
  $('#who').textContent = me.name;
  $('#acc-sub').textContent = `${me.name} · ${me.email} · ${me.role === 'admin' ? 'Yönetici' : 'Kullanıcı'}`;
  adminTabs = adminTabs || $$('.admin-only');
  adminTabs.forEach((el) => (el.hidden = me.role !== 'admin'));
  $('#auth').hidden = true; $('#app').hidden = false;
  fillCalcSelectors();
  showView('calc');
  setTimeout(() => $('#c-cost').focus(), 50);
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
