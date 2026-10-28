// Fiyat hesaplama motoru — hem tarayıcıda hem sunucuda kullanılır.
//
// Temel formül (Excel ile aynı):
//   Hedef tutar = Maliyet × (1 + KDV%) × (1 + Kâr%)
//   Satış fiyatı = (Hedef tutar + Kargo + Hizmet bedeli) ÷ (1 − Komisyon%)
//
// Kargo baremi: fiyat hangi aralığa düşüyorsa o aralığın kargosu kesilir;
// son baremin üstünde ürünün kendi kargo tutarı kullanılır.
// Excel'den farkı: bulunan fiyat gerçekten o baremin içinde mi diye kontrol edilir.
// Hedef kârı sağlayan en düşük TUTARLI fiyat seçilir (Excel bazı durumlarda zarar ettiren fiyat veriyordu).

(function (root) {
  const DEFAULT_SETTINGS = {
    rounding: 'none',
    marketplaces: [
      { id: 'trendyol', name: 'Trendyol', active: true, mode: 'tiers', fee: 12, tiers: [{ max: 200, cargo: 47 }, { max: 350, cargo: 85 }] },
      { id: 'hepsiburada', name: 'Hepsiburada', active: true, mode: 'tiers', fee: 0, tiers: [{ max: 200, cargo: 53 }, { max: 400, cargo: 92 }] },
      { id: 'n11', name: 'N11', active: true, mode: 'tiers', fee: 5, tiers: [{ max: 150, cargo: 63 }, { max: 300, cargo: 100 }] },
      { id: 'amazon', name: 'Amazon', active: true, mode: 'tiers', fee: 0, tiers: [] },
      { id: 'pazarama', name: 'Pazarama', active: true, mode: 'tiers', fee: 11, tiers: [{ max: 150, cargo: 58 }, { max: 300, cargo: 95 }] },
      { id: 'ciceksepeti', name: 'Çiçeksepeti', active: true, mode: 'tiers', fee: 6.5, tiers: [] },
      { id: 'idefix', name: 'İdefix', active: true, mode: 'tiers', fee: 10, tiers: [{ max: 150, cargo: 33 }, { max: 250, cargo: 63 }] },
      { id: 'koctas', name: 'Koçtaş', active: true, mode: 'tiers', fee: 10, tiers: [{ max: 300, cargo: 72 }] },
      { id: 'eptt', name: 'ePTT', active: true, mode: 'tiers', fee: 6, tiers: [] },
      { id: 'temel', name: 'Temel (kargo paylı)', active: true, mode: 'shared', fee: 0, threshold: 400, tiers: [] },
    ],
  };

  function roundPrice(p, mode) {
    if (!Number.isFinite(p)) return p;
    if (mode === 'whole') return Math.ceil(p - 1e-9);
    if (mode === '90' || mode === '99') {
      const frac = mode === '90' ? 0.9 : 0.99;
      let r = Math.floor(p) + frac;
      if (r + 1e-9 < p) r += 1;
      return Math.round(r * 100) / 100;
    }
    return Math.round(p * 100) / 100;
  }

  // Belirli bir fiyatta hangi kargo kesilir
  function cargoAt(price, mp, productCargo) {
    if (mp.mode === 'shared') {
      const T = mp.threshold || 0;
      return T > 0 && price < T ? (price / T) * productCargo : productCargo;
    }
    for (const t of mp.tiers || []) if (price < t.max) return t.cargo;
    return productCargo;
  }

  function tierLabel(price, mp) {
    if (mp.mode === 'shared') {
      const T = mp.threshold || 0;
      return T > 0 && price < T ? `${T} ₺ altı – kargo paylı` : 'Desi kargosu';
    }
    let lo = 0;
    for (const t of mp.tiers || []) {
      if (price < t.max) return `${lo}–${t.max} ₺ baremi`;
      lo = t.max;
    }
    return (mp.tiers || []).length ? `${lo} ₺ üstü – desi kargosu` : 'Desi kargosu';
  }

  // Belirli bir fiyatın kırılımı
  function breakdown(price, product, mp, commission) {
    const fee = mp.fee || 0;
    const cargo = cargoAt(price, mp, product.cargo);
    const commissionTL = price * commission / 100;
    const kalan = price - commissionTL - cargo - fee;          // KDV dahil eline geçen
    const netExVat = kalan / (1 + product.vat / 100);           // Excel'deki kâr hesabı ile aynı
    const netProfit = netExVat - product.cost;
    return {
      price, cargo, fee, commission, commissionTL,
      vatTL: kalan - netExVat,
      netProfit,
      profitPct: product.cost > 0 ? (netProfit / product.cost) * 100 : 0,
      tier: tierLabel(price, mp),
    };
  }

  // Hedef kârı sağlayan en düşük fiyat
  function solvePrice(product, mp, commission) {
    const f = 1 - commission / 100;
    if (f <= 0) return NaN;
    const base = product.cost * (1 + product.vat / 100) * (1 + product.profit / 100);
    const fee = mp.fee || 0;

    if (mp.mode === 'shared') {
      const T = mp.threshold || 0;
      const D = product.cargo;
      if (T > 0) {
        const den = f - D / T;
        if (den > 0) {
          const p = (base + fee) / den;
          if (p < T) return p;
        }
      }
      const p = (base + D + fee) / f;
      return T > 0 ? Math.max(p, T) : p;
    }

    const ranges = [];
    let lo = 0;
    for (const t of mp.tiers || []) { ranges.push({ lo, hi: t.max, cargo: t.cargo }); lo = t.max; }
    ranges.push({ lo, hi: Infinity, cargo: product.cargo });

    let best = Infinity;
    for (const r of ranges) {
      let p = (base + r.cargo + fee) / f;
      if (p < r.lo) p = r.lo; // aralığın başında hedef kâr zaten aşılıyor
      if (p < r.hi && p < best) best = p;
    }
    return best;
  }

  function priceFor(product, mp, settings) {
    const ov = product.overrides && product.overrides[mp.id];
    const commission = ov && Number.isFinite(ov.commission) ? ov.commission : product.commission;
    const raw = solvePrice(product, mp, commission);
    if (!Number.isFinite(raw)) return { error: 'Komisyon %100 olamaz', commission };
    let price = roundPrice(raw, settings && settings.rounding);
    let b = breakdown(price, product, mp, commission);
    // Yuvarlama bareme takılıp kârı hedefin altına düşürdüyse bir sonraki yuvarlama adımına geç
    let guard = 0;
    while (b.profitPct + 1e-6 < product.profit && guard++ < 50 && settings && settings.rounding !== 'none') {
      price = roundPrice(price + 0.01, settings.rounding);
      b = breakdown(price, product, mp, commission);
    }
    b.overridden = !!(ov && Number.isFinite(ov.commission));
    return b;
  }

  // Excel'deki "kâr" sütunu ile aynı: (fiyat×(1−kom) − kargo − hizmet) ÷ (1+KDV) ÷ maliyet
  function excelMultiplier(b, product) {
    return (b.price * (1 - b.commission / 100) - b.cargo - b.fee) / (1 + product.vat / 100) / product.cost;
  }

  // ===================== Sürüm 2: kategori + desi =====================
  const MP_ORDER = ['site', 'n11', 'hepsiburada', 'trendyol', 'eptt', 'amazon', 'ciceksepeti', 'pazarama', 'koctas', 'idefix', 'passo'];
  const DESI = [2, 5, 10, 15, 20, 25, 30, 35, 40];
  // Satır renkleri (şerit rengi; zemin bundan açık ton olarak türetilir)
  const MP_COLORS = {
    site: '#2a9d8f', n11: '#7b52c7', hepsiburada: '#e2582b', trendyol: '#e8930c', eptt: '#c9a300', amazon: '#3b5b85',
    ciceksepeti: '#3d9b4f', pazarama: '#2f6fd6', koctas: '#c43c5a', idefix: '#b5489a', passo: '#9a6b3f',
  };
  // Hex rengi beyazla karıştırır (amount: 0 = renk, 1 = beyaz)
  function tint(hex, amount) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return '#ffffff';
    const n = parseInt(m[1], 16);
    const mix = (c) => Math.round(c + (255 - c) * amount).toString(16).padStart(2, '0');
    return '#' + mix(n >> 16) + mix((n >> 8) & 255) + mix(n & 255);
  }
  // Desi kargo tablosu (desi: [2,5,10,15,20,25,30,35,40]); null = o desi için kargo yok
  const DESI_TABLE = {
    site:        [140, 185, 185, 265, 265, 383, 383, 480, 480],
    n11:         [122, 169, 235, 302, 442, 565, 727, 943, 1158],
    hepsiburada: [100, 140, 195, 248, 320, 383, 458, 529, 600],
    trendyol:    [102, 140, 200, 254, 310, 373, 442, 562, 629],
    eptt:        [83, 90, 144, 157, 169, 174, 193, 287, 338],
    amazon:      [97, 122, 186, 228, 285, 338, 389, 389, 389],
    ciceksepeti: [135, 192, 245, 305, 502, 555, 695, 930, 1165],
    pazarama:    [122, 165, 224, 286, 413, 528, 678, 905, 1132],
    koctas:      [124, 170, 182, 222, 222, 375, 408, 428, 428],
    idefix:      [108, 137, 191, 250, 312, 365, 419, 658, 771],
    passo:       [100, 120, 165, 229, 275, 345, null, null, null],
  };
  const MP_BASE = {
    trendyol:    { name: 'Trendyol', fee: 12, mode: 'tiers', tiers: [{ max: 200, cargo: 47 }, { max: 350, cargo: 85 }] },
    hepsiburada: { name: 'Hepsiburada', fee: 0, mode: 'tiers', tiers: [{ max: 200, cargo: 53 }, { max: 400, cargo: 92 }] },
    n11:         { name: 'N11', fee: 5, mode: 'tiers', tiers: [{ max: 150, cargo: 63 }, { max: 300, cargo: 100 }] },
    amazon:      { name: 'Amazon', fee: 0, mode: 'tiers', tiers: [] },
    pazarama:    { name: 'Pazarama', fee: 11, mode: 'tiers', tiers: [{ max: 150, cargo: 58 }, { max: 300, cargo: 95 }] },
    ciceksepeti: { name: 'Çiçeksepeti', fee: 6.5, mode: 'tiers', tiers: [] },
    idefix:      { name: 'İdefix', fee: 10, mode: 'tiers', tiers: [{ max: 150, cargo: 33 }, { max: 250, cargo: 63 }] },
    koctas:      { name: 'Koçtaş', fee: 10, mode: 'tiers', tiers: [{ max: 300, cargo: 72 }] },
    eptt:        { name: 'ePTT', fee: 6, mode: 'tiers', tiers: [], costRule: { maxCost: 165, cargo: 25 } },
    passo:       { name: 'Passo', fee: 0, mode: 'tiers', tiers: [] },
    site:        { name: 'Site', fee: 0, mode: 'shared', threshold: 400, tiers: [] },
  };
  // Kategoriler: pazaryerleri ortak komisyonu (Site 7, Passo 10, Amazon 17 sabit); kâr: Çiçeksepeti 35, Passo 20, diğerleri 30
  const CATS = [
    ['ofis', 'Ofis-Kırtasiye-Hobi Malzemeleri', 19],
    ['oyuncak', 'Oyuncak-Fen ve Doğa Setleri-Bahçe Dış Mekan-Sınıf Donanımları', 20],
    ['canta', 'Çanta', 22],
    ['kitap', 'Kitap', 16],
  ];
  const catRates = (common) => Object.fromEntries(MP_ORDER.map((id) => [id, {
    commission: id === 'site' ? 7 : id === 'passo' ? 10 : id === 'amazon' ? 17 : common,
    profit: id === 'ciceksepeti' ? 35 : id === 'passo' ? 20 : 30,
  }]));
  const DEFAULT_SETTINGS_V2 = {
    version: 2,
    rounding: 'none',
    desi: DESI.slice(),
    marketplaces: MP_ORDER.map((id) => ({
      id, active: true, threshold: 0, baremMaxDesi: null, color: MP_COLORS[id], ...JSON.parse(JSON.stringify(MP_BASE[id])),
      desiCargo: Object.fromEntries(DESI.map((d, i) => [d, DESI_TABLE[id][i]])),
    })),
    rev: 7,
    categories: CATS.map(([id, name, c]) => ({ id, name, rates: catRates(c) })),
    campaign: { rates: catRates(19) },
  };

  // Seçilen desi için kargo: tam eşleşme yoksa bir üst desi kullanılır
  function desiCargo(mp, desi, desiList) {
    const list = (desiList || []).slice().sort((a, b) => a - b);
    const d = list.find((x) => x >= desi);
    if (d === undefined) return null;
    const v = mp.desiCargo ? mp.desiCargo[d] : null;
    return v === null || v === undefined || v === '' ? null : Number(v);
  }

  // input: { categoryId, desi, cost, vat, profits: {mpId: kâr%} (isteğe bağlı) }
  function computeAll(settings, input) {
    const cat = settings.categories.find((c) => c.id === input.categoryId) || settings.categories[0];
    return settings.marketplaces.filter((m) => m.active).map((mp) => {
      // input.rates verilirse (kampanya) kategori yerine onlar kullanılır
      const rate = (input.rates && input.rates[mp.id]) || (cat && cat.rates[mp.id]) || { commission: 0, profit: 0 };
      const profit = input.profits && Number.isFinite(input.profits[mp.id]) ? input.profits[mp.id] : rate.profit;
      let cargo = desiCargo(mp, input.desi, settings.desi);
      // Maliyet kuralı: maliyet belirli tutarın altındaysa desiden bağımsız sabit kargo (ör. ePTT 165 ₺ altı → 25 ₺)
      const cr = mp.costRule;
      const costRuleHit = !!(cr && cr.maxCost > 0 && input.cost > 0 && input.cost < cr.maxCost);
      if (costRuleHit) cargo = Number(cr.cargo) || 0;
      const row = { mp, commission: rate.commission, profit, defaultProfit: rate.profit, desiCargo: cargo };
      if (!(input.cost > 0)) return row;
      if (cargo === null) return { ...row, unavailable: true };
      const product = { cost: input.cost, vat: input.vat || 0, profit, cargo, commission: rate.commission };
      // Barem yalnızca belirli bir desiye kadar geçerliyse, üstünde her satışta desi kargosu kesilir
      const lim = Number(mp.baremMaxDesi);
      const noBarem = lim > 0 && input.desi > lim;
      const eff = noBarem ? { ...mp, mode: 'tiers', tiers: [] } : mp;
      const result = priceFor(product, eff, settings);
      if (noBarem) result.tier = `${lim} desi üstü – barem yok`;
      if (costRuleHit && result.cargo === cargo) result.tier = `Maliyet ${cr.maxCost} ₺ altı – sabit kargo`;
      return { ...row, result };
    });
  }

  const api = { MP_COLORS, tint, DEFAULT_SETTINGS, DEFAULT_SETTINGS_V2, priceFor, solvePrice, breakdown, roundPrice, excelMultiplier, computeAll, desiCargo };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Calc = api;
})(typeof window !== 'undefined' ? window : globalThis);
