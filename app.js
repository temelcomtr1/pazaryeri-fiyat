'use strict';
// Pazaryeri Fiyatlandırma — GitHub Pages + Supabase sürümü
const APP_VERSION = 10;

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
  [/email rate limit|over_email_send_rate_limit/i, 'Şu an e-posta gönderilemiyor: Supabase ücretsiz planın saatlik e-posta sınırı doldu. Bir saat sonra tekrar deneyin ya da yöneticinizden hesabınızı Supabase panelinden açmasını isteyin.'],
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
  if (name === 'camp') { fillCampSelectors(); renderCamp(); setTimeout(() => $('#k-cost').focus(), 30); }
  if (name === 'bulk') { fillBulkSelectors(); renderBulk(); }
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
  if (rev < 7 || !s.campaign || !s.campaign.rates) { // Kampanya varsayılanları
    s.campaign = s.campaign && s.campaign.rates ? s.campaign : { rates: structuredClone(def.campaign.rates) };
    for (const m of s.marketplaces) if (!s.campaign.rates[m.id]) s.campaign.rates[m.id] = { commission: 0, profit: 30 };
  }
  if (rev < 6) { // Pazaryeri satır renkleri
    const extra = ['#5a7d9a', '#8a6fb0', '#6b8e23', '#b07a3c', '#4a8f8a'];
    s.marketplaces.forEach((m, i) => { if (!m.color) m.color = Calc.MP_COLORS[m.id] || extra[i % extra.length]; });
  }
  if (rev < 5) { // İstenen pazaryeri sırası
    const order = def.marketplaces.map((m) => m.id);
    const pos = (m) => { const i = order.indexOf(m.id); return i < 0 ? 999 : i; };
    s.marketplaces = s.marketplaces.map((m, i) => [m, i]).sort((a, b) => pos(a[0]) - pos(b[0]) || a[1] - b[1]).map(([m]) => m);
  }
  s.rev = def.rev;
  return s;
}

// Pazaryeri renkleri: şerit, satır zemini, üzerine gelince biraz daha koyu zemin
function mpStyle(mp) {
  const c = mp.color || '#8a948f';
  return `style="--mp:${c};--mp-bg:${Calc.tint(c, 0.9)};--mp-bg2:${Calc.tint(c, 0.82)}"`;
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
    const head = `<td class="name"><span class="mp-dot"></span><b>${esc(r.mp.name)}</b></td>`;
    const rs = mpStyle(r.mp);
    if (r.unavailable) {
      return `<tr class="na" ${rs}>${head}<td class="num">%${pctf.format(r.commission)}</td><td colspan="2">Bu desi için kargo tanımlı değil</td><td>${profitIn}</td><td></td><td class="num">—</td></tr>`;
    }
    const b = r.result;
    if (!b) {
      return `<tr ${rs}>${head}<td class="num">%${pctf.format(r.commission)}</td><td class="num">${r.desiCargo !== null ? money(r.desiCargo) : '—'}<span class="sub2">desi kargosu</span></td><td class="num">${money(r.mp.fee || 0)}</td><td>${profitIn}</td><td></td><td class="num">—</td></tr>`;
    }
    if (b.error) return `<tr ${rs}>${head}<td colspan="6">${esc(b.error)}</td></tr>`;
    const extra = Math.abs(b.profitPct - r.profit) > 0.5
      ? `<span class="sub2" style="color:var(--warn)">%${pctf.format(b.profitPct)} gerçekleşen</span>` : '';
    return `<tr ${rs}>${head}
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

// ================= Kampanya =================
const CAMP_KEY = 'pf-camp';
const camp = (() => { try { return JSON.parse(localStorage.getItem(CAMP_KEY) || 'null') || { rates: {} }; } catch { return { rates: {} }; } })();
camp.rates = camp.rates || {};
function saveCamp() { try { localStorage.setItem(CAMP_KEY, JSON.stringify({ rates: camp.rates, desi: $('#k-desi').value })); } catch { /* yok say */ } }
// Varsayılan kampanya oranı + kullanıcının değiştirdiği değerler
function campRates() {
  const def = (state.settings.campaign && state.settings.campaign.rates) || {};
  const out = {};
  for (const m of state.settings.marketplaces) {
    const d = def[m.id] || { commission: 0, profit: 0 };
    const o = camp.rates[m.id] || {};
    out[m.id] = {
      commission: Number.isFinite(o.commission) ? o.commission : d.commission,
      profit: Number.isFinite(o.profit) ? o.profit : d.profit,
      defCommission: d.commission, defProfit: d.profit,
    };
  }
  return out;
}
function fillCampSelectors() {
  const ds = state.settings.desi.slice().sort((a, b) => a - b);
  const cur = $('#k-desi').value || (() => { try { return (JSON.parse(localStorage.getItem(CAMP_KEY) || '{}') || {}).desi; } catch { return null; } })();
  $('#k-desi').innerHTML = ds.map((d) => `<option value="${d}">${fmtIn(d)} desi</option>`).join('');
  if (ds.includes(Number(cur))) $('#k-desi').value = cur;
}
function renderCamp() {
  const s = state.settings;
  const rates = campRates();
  const rows = Calc.computeAll(s, {
    desi: Number($('#k-desi').value), cost: parseNum($('#k-cost').value), vat: parseNum($('#k-vat').value) || 0, rates,
  });
  const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('#ktable')
    ? [document.activeElement.dataset.mp, document.activeElement.dataset.k] : null;
  $('#ktable tbody').innerHTML = rows.map((r) => {
    const rt = rates[r.mp.id];
    const inp = (k, v, def) => `<input class="profit-in${v !== def ? ' changed' : ''}" data-mp="${esc(r.mp.id)}" data-k="${k}" inputmode="decimal" value="${fmtIn(v)}" title="Varsayılan: %${pctf.format(def)}">`;
    const commIn = inp('commission', rt.commission, rt.defCommission);
    const profitIn = inp('profit', rt.profit, rt.defProfit);
    const head = `<td class="name"><span class="mp-dot"></span><b>${esc(r.mp.name)}</b></td>`;
    const rs = mpStyle(r.mp);
    if (r.unavailable) return `<tr class="na" ${rs}>${head}<td>${commIn}</td><td colspan="2">Bu desi için kargo tanımlı değil</td><td>${profitIn}</td><td></td><td class="num">—</td></tr>`;
    const b = r.result;
    if (!b) return `<tr ${rs}>${head}<td>${commIn}</td><td class="num">${r.desiCargo !== null ? money(r.desiCargo) : '—'}<span class="sub2">desi kargosu</span></td><td class="num">${money(r.mp.fee || 0)}</td><td>${profitIn}</td><td></td><td class="num">—</td></tr>`;
    if (b.error) return `<tr ${rs}>${head}<td>${commIn}</td><td colspan="5">${esc(b.error)}</td></tr>`;
    const extra = Math.abs(b.profitPct - r.profit) > 0.5 ? `<span class="sub2" style="color:var(--warn)">%${pctf.format(b.profitPct)} gerçekleşen</span>` : '';
    return `<tr ${rs}>${head}
      <td>${commIn}<span class="sub2">${money(b.commissionTL)}</span></td>
      <td class="num">${money(b.cargo)}<span class="sub2">${esc(b.tier)}</span></td>
      <td class="num">${money(b.fee)}</td>
      <td>${profitIn}</td>
      <td class="num${b.netProfit < 0 ? ' neg' : ''}">${money(b.netProfit)}${extra}</td>
      <td class="num price-cell" data-price="${b.price.toFixed(2)}" title="Kopyalamak için tıklayın">${money(b.price)} ₺</td>
    </tr>`;
  }).join('');
  if (focused && focused[0]) {
    const el = $(`#ktable input[data-mp="${focused[0]}"][data-k="${focused[1]}"]`);
    if (el) { el.focus(); const v = el.value; el.value = ''; el.value = v; }
  }
}
['#k-cost', '#k-vat'].forEach((id) => $(id).addEventListener('input', renderCamp));
$('#k-desi').addEventListener('change', () => { saveCamp(); renderCamp(); });
function setAllCamp(k, v) {
  for (const m of state.settings.marketplaces) {
    camp.rates[m.id] = camp.rates[m.id] || {};
    if (Number.isFinite(v)) camp.rates[m.id][k] = v; else delete camp.rates[m.id][k];
  }
  saveCamp(); renderCamp();
}
$('#k-allcomm').addEventListener('input', (e) => setAllCamp('commission', parseNum(e.target.value)));
$('#k-allprofit').addEventListener('input', (e) => setAllCamp('profit', parseNum(e.target.value)));
$('#k-reset').addEventListener('click', () => {
  camp.rates = {}; $('#k-allcomm').value = ''; $('#k-allprofit').value = ''; saveCamp(); renderCamp();
});
$('#ktable').addEventListener('input', (e) => {
  const el = e.target; if (!el.classList.contains('profit-in')) return;
  const v = parseNum(el.value);
  camp.rates[el.dataset.mp] = camp.rates[el.dataset.mp] || {};
  if (Number.isFinite(v) && (el.dataset.k !== 'commission' || v < 100)) camp.rates[el.dataset.mp][el.dataset.k] = v;
  else delete camp.rates[el.dataset.mp][el.dataset.k];
  saveCamp(); renderCamp();
});
$('#ktable').addEventListener('click', async (e) => {
  const td = e.target.closest('.price-cell'); if (!td) return;
  const txt = td.dataset.price.replace('.', ',');
  try { await navigator.clipboard.writeText(txt); toast(`${txt} kopyalandı`); } catch { toast(txt); }
});

// ================= Toplu hesapla =================
const trNorm = (s) => String(s ?? '').toLocaleLowerCase('tr')
  .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c').replace(/â/g, 'a')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const HEADER_KEYS = [
  ['sku', ['stok kodu', 'stok kod', 'stok', 'sku', 'barkod', 'urun kodu', 'kod', 'model kodu']],
  ['name', ['urun adi', 'urun', 'urun ismi', 'ad', 'adi', 'isim', 'aciklama']],
  ['category', ['kategori', 'kategori adi', 'grup']],
  ['desi', ['desi']],
  ['cost', ['maliyet', 'alis', 'alis fiyati', 'maliyet tl', 'birim maliyet']],
  ['profit', ['kar', 'kar orani', 'kar yuzde', 'kar %']],
  ['vat', ['kdv', 'kdv orani']],
];
const bulk = { rows: null, fileName: '' };

function fillBulkSelectors() {
  const s = state.settings;
  const prevC = $('#b-defcat').value; const prevD = $('#b-defdesi').value;
  $('#b-defcat').innerHTML = '<option value="">— Hata olarak işaretle —</option>' +
    s.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  $('#b-defdesi').innerHTML = '<option value="">— Hata olarak işaretle —</option>' +
    s.desi.slice().sort((a, b) => a - b).map((d) => `<option value="${d}">${fmtIn(d)} desi</option>`).join('');
  $('#b-defcat').value = prevC; $('#b-defdesi').value = prevD || String(Math.min(...s.desi));
  $('#b-catlist').innerHTML = 'Kategori sütununa adın tamamı, ilk kelimesi ya da sıra numarası yazılabilir: ' +
    s.categories.map((c, i) => `<b>${i + 1}</b> = ${esc(c.name)}`).join(' · ');
}

function matchCategory(v) {
  const cats = state.settings.categories;
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).trim());
  if (Number.isInteger(n) && n >= 1 && n <= cats.length) return cats[n - 1];
  const q = trNorm(v);
  const exact = cats.filter((c) => trNorm(c.name) === q || trNorm(c.id) === q);
  if (exact.length === 1) return exact[0];
  const part = cats.filter((c) => trNorm(c.name).startsWith(q) || c.name.split(/[-–\/,]/).some((seg) => trNorm(seg) === q));
  if (part.length === 1) return part[0];
  const loose = cats.filter((c) => trNorm(c.name).includes(q) || q.includes(trNorm(c.name)));
  return loose.length === 1 ? loose[0] : undefined; // undefined = bulunamadı/belirsiz
}

function mapHeaders(header) {
  const map = {};
  header.forEach((h, i) => {
    const k = trNorm(h);
    if (!k) return;
    for (const [key, names] of HEADER_KEYS) {
      if (map[key] === undefined && names.includes(k)) { map[key] = i; return; }
    }
  });
  // "kâr" başlığı tek başına "kar" olur; "kar %" gibi varyasyonlar için ek kontrol
  header.forEach((h, i) => { const k = trNorm(h); if (map.profit === undefined && /^kar\b/.test(k)) map.profit = i; });
  return map;
}

async function loadBulkFile(file) {
  if (!file) return;
  try {
    let rows;
    if (/\.csv$/i.test(file.name)) rows = XLSX.readCsv(await file.text());
    else rows = await XLSX.read(await file.arrayBuffer());
    rows = rows.filter((r) => r && r.some((v) => v !== null && v !== undefined && String(v).trim() !== ''));
    if (rows.length < 2) throw new Error('Dosyada başlık satırı ve en az bir ürün olmalı');
    // Başlık satırını bul (ilk 10 satırda "maliyet" geçen satır)
    let hi = rows.slice(0, 10).findIndex((r) => r.some((v) => ['maliyet', 'alis', 'alis fiyati', 'birim maliyet', 'maliyet tl'].includes(trNorm(v))));
    if (hi < 0) throw new Error('“Maliyet” başlıklı sütun bulunamadı. Şablondaki başlıkları kullanın.');
    const map = mapHeaders(rows[hi]);
    bulk.map = map; bulk.header = rows[hi]; bulk.rows = rows.slice(hi + 1); bulk.fileName = file.name.replace(/\.(xlsx|csv)$/i, '');
    renderBulk();
  } catch (e) {
    bulk.rows = null; $('#b-result').hidden = true;
    toast(e.message || 'Dosya okunamadı', true);
  }
}

function computeBulk() {
  const s = state.settings; const map = bulk.map;
  const mps = s.marketplaces.filter((m) => m.active);
  const defCat = s.categories.find((c) => c.id === $('#b-defcat').value) || null;
  const defDesi = parseNum($('#b-defdesi').value);
  const maxDesi = Math.max(...s.desi);
  const get = (r, k) => (map[k] === undefined ? null : r[map[k]]);
  const blank = (v) => v === null || v === undefined || String(v).trim() === '';
  return bulk.rows.map((r) => {
    const out = { sku: get(r, 'sku') ?? '', name: get(r, 'name') ?? '', notes: [], prices: {}, profits: {} };
    const cost = typeof get(r, 'cost') === 'number' ? get(r, 'cost') : parseNum(get(r, 'cost'));
    const rawCat = get(r, 'category');
    const useCamp = $('#b-camp').checked;
    let cat = useCamp ? { id: 'kampanya', name: 'Kampanya' } : (blank(rawCat) ? defCat : matchCategory(rawCat));
    if (!cat) out.notes.push(blank(rawCat) ? 'Kategori boş' : `Kategori bulunamadı: “${rawCat}”`);
    const rawDesi = get(r, 'desi');
    const desi = blank(rawDesi) ? defDesi : (typeof rawDesi === 'number' ? rawDesi : parseNum(rawDesi));
    if (!(desi > 0)) out.notes.push(blank(rawDesi) ? 'Desi boş' : `Desi okunamadı: “${rawDesi}”`);
    else if (desi > maxDesi) out.notes.push(`Desi ${maxDesi}'tan büyük`);
    if (!(cost > 0)) out.notes.push(blank(get(r, 'cost')) ? 'Maliyet boş' : 'Maliyet geçersiz');
    const rawProfit = get(r, 'profit');
    const profitAll = blank(rawProfit) ? NaN : (typeof rawProfit === 'number' ? rawProfit : parseNum(rawProfit));
    const rawVat = get(r, 'vat');
    const vat = blank(rawVat) ? 0 : (typeof rawVat === 'number' ? rawVat : parseNum(rawVat)) || 0;
    out.cost = cost; out.desi = desi; out.cat = cat; out.vat = vat;
    out.profit = Number.isFinite(profitAll) ? profitAll : null;
    if (out.notes.length) { out.error = true; return out; }
    const profits = Number.isFinite(profitAll) ? Object.fromEntries(mps.map((m) => [m.id, profitAll])) : {};
    const res = Calc.computeAll(s, { categoryId: cat.id, desi, cost, vat, profits, rates: useCamp ? campRates() : undefined });
    const missing = [];
    for (const x of res) {
      if (x.unavailable || !x.result || x.result.error) { missing.push(x.mp.name); continue; }
      out.prices[x.mp.id] = Math.round(x.result.price * 100) / 100;
      out.profits[x.mp.id] = Math.round(x.result.netProfit * 100) / 100;
    }
    if (missing.length) out.notes.push(`Bu desi için kargo yok: ${missing.join(', ')}`);
    return out;
  });
}

function renderBulk() {
  if (!bulk.rows) return;
  const s = state.settings; const mps = s.marketplaces.filter((m) => m.active);
  const res = computeBulk(); bulk.result = res;
  const errs = res.filter((r) => r.error).length;
  const warn = res.filter((r) => !r.error && r.notes.length).length;
  const missingCols = ['cost', 'category', 'desi'].filter((k) => bulk.map[k] === undefined)
    .map((k) => ({ cost: 'Maliyet', category: 'Kategori', desi: 'Desi' }[k]));
  $('#b-summary').innerHTML = `<span class="bulk-stat"><b>${res.length.toLocaleString('tr-TR')}</b> ürün</span>
    <span class="bulk-stat" style="color:var(--good)"><b>${(res.length - errs).toLocaleString('tr-TR')}</b> hesaplandı</span>
    ${errs ? `<span class="bulk-stat" style="color:var(--bad)"><b>${errs.toLocaleString('tr-TR')}</b> hatalı</span>` : ''}
    ${warn ? `<span class="bulk-stat" style="color:var(--warn)"><b>${warn.toLocaleString('tr-TR')}</b> uyarılı</span>` : ''}
    ${missingCols.length ? `<div class="hint" style="color:var(--warn)">Dosyada bulunamayan sütun: ${missingCols.join(', ')}${missingCols.includes('Maliyet') ? '' : ' — boş kabul edildi, yukarıdaki varsayılanlar kullanılıyor'}</div>` : ''}`;
  const preview = res.filter((r) => r.error).slice(0, 10).concat(res.filter((r) => !r.error).slice(0, 20));
  $('#b-preview').innerHTML = `<thead><tr><th class="name">Ürün</th><th>Kategori</th><th>Desi</th><th>Maliyet</th>${mps.map((m) => `<th>${esc(m.name)}</th>`).join('')}<th style="text-align:left">Not</th></tr></thead>
    <tbody>${preview.map((r) => `<tr>
      <td class="name">${esc(r.name || r.sku || '—')}${r.sku && r.name ? `<br><span class="sku">${esc(r.sku)}</span>` : ''}</td>
      <td style="text-align:left">${r.cat ? esc(r.cat.name.split('-')[0]) : '—'}</td>
      <td class="num">${Number.isFinite(r.desi) ? fmtIn(r.desi) : '—'}</td>
      <td class="num">${money(r.cost)}</td>
      ${mps.map((m) => `<td class="num">${r.prices[m.id] !== undefined ? money(r.prices[m.id]) : '—'}</td>`).join('')}
      <td class="${r.notes.length ? 'err' : ''}">${esc(r.notes.join(' · '))}</td></tr>`).join('')}</tbody>`;
  $('#b-result').hidden = false;
  $('#b-download').textContent = `Excel olarak indir (${res.length.toLocaleString('tr-TR')} ürün)`;
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

$('#b-download').addEventListener('click', () => {
  const s = state.settings; const mps = s.marketplaces.filter((m) => m.active);
  const withProfit = $('#b-profitcols').checked;
  const head = ['Stok Kodu', 'Ürün Adı', 'Kategori', 'Desi', 'Maliyet', 'Kâr % (girilen)', ...mps.map((m) => `${m.name} Fiyat`)];
  if (withProfit) head.push(...mps.map((m) => `${m.name} Net Kâr`));
  head.push('Not');
  const moneyCols = new Set(); [4, ...mps.map((_, i) => 6 + i), ...(withProfit ? mps.map((_, i) => 6 + mps.length + i) : [])].forEach((i) => moneyCols.add(i));
  const rows = [head, ...bulk.result.map((r) => {
    const row = [r.sku, r.name, r.cat ? r.cat.name : '', Number.isFinite(r.desi) ? r.desi : '', Number.isFinite(r.cost) ? r.cost : '', r.profit ?? '',
      ...mps.map((m) => r.prices[m.id] ?? '')];
    if (withProfit) row.push(...mps.map((m) => r.profits[m.id] ?? ''));
    row.push(r.notes.join(' · '));
    return row;
  })];
  const widths = [16, 40, 28, 7, 11, 10, ...mps.map(() => 13), ...(withProfit ? mps.map(() => 13) : []), 40];
  const date = new Date().toISOString().slice(0, 10);
  const headerFills = head.map(() => null);
  mps.forEach((m, i) => {
    headerFills[6 + i] = Calc.tint(m.color || '#8a948f', 0.75);
    if (withProfit) headerFills[6 + mps.length + i] = Calc.tint(m.color || '#8a948f', 0.85);
  });
  downloadBlob(XLSX.write(rows, { sheetName: 'Fiyatlar', widths, money: moneyCols, headerFills }), `${bulk.fileName || 'urunler'}-fiyatlar-${date}.xlsx`);
});

$('#b-template').addEventListener('click', () => {
  const c = state.settings.categories;
  const rows = [
    ['Stok Kodu', 'Ürün Adı', 'Kategori', 'Desi', 'Maliyet', 'Kâr %', 'KDV %'],
    ['ORNEK-001', 'Örnek ürün (bu satırları silin)', c[0] ? c[0].name : '', 2, 107.1, '', ''],
    ['ORNEK-002', 'Kâr oranı elle verilen ürün', c[1] ? 2 : 1, 5, 250, 25, ''],
  ];
  downloadBlob(XLSX.write(rows, { sheetName: 'Ürünler', widths: [16, 40, 30, 7, 11, 8, 8], money: new Set([4]) }), 'toplu-hesap-sablonu.xlsx');
});

$('#b-file').addEventListener('change', (e) => { loadBulkFile(e.target.files[0]); e.target.value = ''; });
const drop = $('#b-drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => loadBulkFile(e.dataTransfer.files[0]));
['#b-defcat', '#b-defdesi', '#b-camp'].forEach((id) => $(id).addEventListener('change', renderBulk));

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
  renderCats(); renderCampSettings(); renderDesi(); renderMps();
}

function renderCampSettings() {
  const mps = draft.marketplaces;
  const rates = draft.campaign.rates;
  $('#sub-camp').innerHTML = `
    <p class="hint" style="margin-top:0">Kampanya sayfası bu oranlarla açılır. Personel sayfada değiştirebilir; “Varsayılanlara dön” bu değerlere geri getirir.</p>
    <div class="card cat-card">
      <div class="table-wrap" style="max-height:none">
        <table class="grid edit-grid">
          <thead><tr><th class="name">Pazaryeri</th><th>Kampanya komisyonu %</th><th>Kampanya kârı %</th></tr></thead>
          <tbody>${mps.map((m) => {
            const r = rates[m.id] || { commission: 0, profit: 0 };
            return `<tr ${mpStyle(m)} class="mp-row"><td class="name"><span class="mp-dot"></span>${esc(m.name)}${m.active ? '' : ' <span class="hint">(pasif)</span>'}</td>
              <td><input data-crate="${esc(m.id)}" data-k="commission" inputmode="decimal" value="${numIn(r.commission)}"></td>
              <td><input data-crate="${esc(m.id)}" data-k="profit" inputmode="decimal" value="${numIn(r.profit)}"></td></tr>`;
          }).join('')}</tbody>
        </table>
      </div>
    </div>`;
}
$('#sub-camp').addEventListener('input', (e) => {
  const id = e.target.dataset.crate; if (!id) return;
  const r = draft.campaign.rates;
  r[id] = r[id] || { commission: 0, profit: 0 };
  r[id][e.target.dataset.k] = parseNum(e.target.value) || 0;
});

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
            return `<tr ${mpStyle(m)} class="mp-row"><td class="name"><span class="mp-dot"></span>${esc(m.name)}${m.active ? '' : ' <span class="hint">(pasif)</span>'}</td>
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
        <thead><tr><th class="name" style="min-width:110px">Desi (en fazla)</th>${mps.map((m) => `<th ${mpStyle(m)} class="mp-th">${esc(m.name)}</th>`).join('')}<th></th></tr></thead>
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
    <div class="card mp-set" data-i="${i}" ${mpStyle(m)}>
      <div style="display:grid; gap:10px">
      <label class="field">Pazaryeri adı<input data-k="name" value="${esc(m.name)}"></label>
      <label class="field">Satır rengi<span class="color-row"><input type="color" data-k="color" value="${esc(m.color || '#8a948f')}"><span class="color-prev">Örnek satır</span></span></label>
      </div>
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
        <div class="move-btns">
          <button class="btn small" data-move="-1" title="Yukarı taşı" ${i === 0 ? 'disabled' : ''}>▲</button>
          <button class="btn small" data-move="1" title="Aşağı taşı" ${i === draft.marketplaces.length - 1 ? 'disabled' : ''}>▼</button>
        </div>
        <span class="hint">Sıra: ${i + 1}</span>
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
  else if (el.dataset.k === 'color') { m.color = el.value; const card = el.closest('.mp-set'); card.setAttribute('style', mpStyle(m).slice(7, -1)); }
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
  const mv = e.target.closest('[data-move]');
  if (mv) {
    const i = Number(mv.closest('[data-i]').dataset.i); const j = i + Number(mv.dataset.move);
    const list = draft.marketplaces;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    renderSettings();
    const btn = $(`#sub-mps [data-i="${j}"] [data-move="${mv.dataset.move}"]`);
    (btn && !btn.disabled ? btn : $(`#sub-mps [data-i="${j}"]`)).scrollIntoView({ block: 'center' });
    if (btn && !btn.disabled) btn.focus();
    return;
  }
  if (e.target.id === 'mp-add') {
    const id = 'mp' + Date.now().toString(36);
    draft.marketplaces.push({ id, name: 'Yeni pazaryeri', active: true, mode: 'tiers', fee: 0, tiers: [], threshold: 0, baremMaxDesi: null,
      desiCargo: Object.fromEntries(draft.desi.map((d) => [d, null])) });
    draft.categories.forEach((c) => (c.rates[id] = { commission: 0, profit: 30 }));
    draft.campaign.rates[id] = { commission: 0, profit: 30 };
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
  for (const r of Object.values(s.campaign.rates)) if (!(r.commission >= 0 && r.commission < 100)) throw new Error('Kampanya: komisyon 0–99 arasında olmalı');
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
      <button class="btn small" data-act="name">Adı düzenle</button>
      <button class="btn small" data-act="pw">Parola sıfırlama e-postası</button>
    </td></tr>`).join('');
}
$('#utable').addEventListener('click', async (e) => {
  const act = e.target.dataset.act; if (!act) return;
  const u = state.users.find((x) => x.id === e.target.closest('tr').dataset.uid);
  try {
    if (act === 'active') await data.updateUser(u.id, { active: !u.active });
    else if (act === 'role') await data.updateUser(u.id, { role: u.role === 'admin' ? 'user' : 'admin' });
    else if (act === 'name') {
      const name = prompt(`${u.email} için ad soyad:`, u.name);
      if (name === null || !name.trim() || name.trim() === u.name) return;
      await data.updateUser(u.id, { name: name.trim() });
      if (u.id === state.me.id) { state.me.name = name.trim(); $('#who').textContent = state.me.name; }
      toast('Ad güncellendi');
    }
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
