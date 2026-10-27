// Küçük, bağımlılıksız Excel (.xlsx) okuyucu/yazıcı
//   XLSX.read(arrayBuffer)  -> Promise<Array<Array<any>>>  (ilk sayfanın satırları)
//   XLSX.write(rows, opts)  -> Blob                        (tek sayfalık .xlsx)
// Okuma için tarayıcının DecompressionStream('deflate-raw') desteği kullanılır.
(function (root) {
  'use strict';

  // ---------------- ZIP okuma ----------------
  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzip(buf) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Dosya geçerli bir Excel (.xlsx) dosyası değil');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const files = {};
    const dec = new TextDecoder();
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true);
      const elen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      files[name] = { method, csize, off };
      p += 46 + nlen + elen + clen;
    }
    return {
      has: (name) => !!files[name],
      async text(name) {
        const f = files[name];
        if (!f) return null;
        const lnl = dv.getUint16(f.off + 26, true);
        const lel = dv.getUint16(f.off + 28, true);
        const start = f.off + 30 + lnl + lel;
        const data = u8.subarray(start, start + f.csize);
        const raw = f.method === 0 ? data : f.method === 8 ? await inflateRaw(data) : null;
        if (!raw) throw new Error('Desteklenmeyen sıkıştırma');
        return dec.decode(raw);
      },
    };
  }

  const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const byTag = (node, tag) => Array.from(node.getElementsByTagNameNS('*', tag));
  const colIndex = (ref) => {
    const m = /^([A-Z]+)/.exec(ref || ''); if (!m) return -1;
    let n = 0; for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const textOf = (node) => byTag(node, 't').map((t) => t.textContent).join('');

  async function read(buf) {
    const z = await unzip(buf);
    // İlk sayfanın yolunu bul
    let sheetPath = 'xl/worksheets/sheet1.xml';
    const wb = await z.text('xl/workbook.xml');
    const rels = await z.text('xl/_rels/workbook.xml.rels');
    if (wb && rels) {
      const first = byTag(xml(wb), 'sheet')[0];
      const rid = first && (first.getAttribute('r:id') || first.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
      const rel = byTag(xml(rels), 'Relationship').find((r) => r.getAttribute('Id') === rid);
      if (rel) {
        const t = rel.getAttribute('Target');
        sheetPath = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
      }
    }
    const sst = await z.text('xl/sharedStrings.xml');
    const shared = sst ? byTag(xml(sst), 'si').map(textOf) : [];
    const sheet = await z.text(sheetPath);
    if (!sheet) throw new Error('Excel dosyasında sayfa bulunamadı');
    const rows = [];
    for (const r of byTag(xml(sheet), 'row')) {
      const ri = Number(r.getAttribute('r')) - 1;
      const row = [];
      let ci = 0;
      for (const c of byTag(r, 'c')) {
        const ref = c.getAttribute('r');
        if (ref) ci = colIndex(ref);
        const t = c.getAttribute('t');
        const v = byTag(c, 'v')[0];
        let val = null;
        if (t === 's') val = v ? shared[Number(v.textContent)] : '';
        else if (t === 'inlineStr') val = textOf(c);
        else if (t === 'str' || t === 'e') val = v ? v.textContent : '';
        else if (t === 'b') val = v ? v.textContent === '1' : null;
        else if (v) { const n = Number(v.textContent); val = Number.isFinite(n) ? n : v.textContent; }
        row[ci] = val;
        ci++;
      }
      rows[ri >= 0 ? ri : rows.length] = row;
    }
    return Array.from(rows, (r) => r || []);
  }

  // ---------------- ZIP yazma (sıkıştırmasız) ----------------
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

  function zip(entries) {
    const enc = new TextEncoder();
    const parts = []; const central = []; let offset = 0;
    for (const [name, content] of entries) {
      const nb = enc.encode(name); const data = enc.encode(content); const crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
      h.setUint16(8, 0, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true);
      h.setUint32(22, data.length, true); h.setUint16(26, nb.length, true);
      parts.push(new Uint8Array(h.buffer), nb, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, nb.length, true); c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), nb);
      offset += 30 + nb.length + data.length;
    }
    const csize = central.reduce((s, p) => s + p.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true);
    e.setUint32(12, csize, true); e.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  const escX = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  const colName = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

  // rows: dizi dizisi. İlk satır başlık kabul edilir (kalın, sabitlenmiş).
  // opts: { sheetName, widths: [sayı], money: Set(sütun indeksleri) }
  function write(rows, opts = {}) {
    const money = opts.money || new Set();
    // Başlık hücreleri için sütuna özel dolgu renkleri (stil 3, 4, …)
    const fillColors = [];
    const headStyle = (opts.headerFills || []).map((hex) => {
      if (!hex || !/^#?[0-9a-f]{6}$/i.test(hex)) return 1;
      const h = hex.replace('#', '').toUpperCase();
      let k = fillColors.indexOf(h); if (k < 0) { fillColors.push(h); k = fillColors.length - 1; }
      return 3 + k;
    });
    const body = rows.map((row, ri) => {
      const cells = row.map((v, ci) => {
        if (v === null || v === undefined || v === '') return '';
        const ref = colName(ci) + (ri + 1);
        if (ri === 0) return `<c r="${ref}" t="inlineStr" s="${headStyle[ci] || 1}"><is><t>${escX(v)}</t></is></c>`;
        if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${money.has(ci) ? ' s="2"' : ''}><v>${v}</v></c>`;
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escX(v)}</t></is></c>`;
      }).join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    }).join('');
    const widths = (opts.widths || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${widths ? `<cols>${widths}</cols>` : ''}<sheetData>${body}</sheetData>${rows.length > 1 && rows[0].length ? `<autoFilter ref="A1:${colName(rows[0].length - 1)}${rows.length}"/>` : ''}</worksheet>`;
    const name = escX((opts.sheetName || 'Sayfa1').slice(0, 31));
    return zip([
      ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
      ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
      ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets>${rows.length > 1 && rows[0].length ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${name.replace(/'/g, "''")}'!$A$1:$${colName(rows[0].length - 1)}$${rows.length}</definedName></definedNames>` : ''}</workbook>`],
      ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
      ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="${3 + fillColors.length}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE5EFE9"/><bgColor indexed="64"/></patternFill></fill>${fillColors.map((c) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${c}"/><bgColor indexed="64"/></patternFill></fill>`).join('')}</fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${3 + fillColors.length}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>${fillColors.map((_, k) => `<xf numFmtId="0" fontId="1" fillId="${3 + k}" borderId="0" xfId="0" applyFont="1" applyFill="1"/>`).join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
      ['xl/worksheets/sheet1.xml', sheet],
    ]);
  }

  // ---------------- CSV okuma ----------------
  function readCsv(text) {
    text = text.replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    const sep = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : (firstLine.includes('\t') ? '\t' : ',');
    const rows = []; let row = []; let cur = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === sep) { row.push(cur); cur = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  root.XLSX = { read, write, readCsv };
})(typeof window !== 'undefined' ? window : globalThis);
