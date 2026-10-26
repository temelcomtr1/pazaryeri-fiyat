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
      return T > 0 && price < T ? `${T} ₺ altı – kargo paylı` : 'Kendi kargo';
    }
    let lo = 0;
    for (const t of mp.tiers || []) {
      if (price < t.max) return `${lo}–${t.max} ₺ baremi`;
      lo = t.max;
    }
    return (mp.tiers || []).length ? `${lo} ₺ üstü – kendi kargo` : 'Kendi kargo';
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

  const api = { DEFAULT_SETTINGS, priceFor, solvePrice, breakdown, roundPrice, excelMultiplier };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Calc = api;
})(typeof window !== 'undefined' ? window : globalThis);
