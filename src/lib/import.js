import { uid } from './data';

function numCell(s) {
  if (s == null) return '';
  const cleaned = String(s).replace(/[₩%,\s개건]/g, '');
  if (cleaned === '' || cleaned === '-') return '';
  const v = parseFloat(cleaned);
  return isFinite(v) ? v : '';
}

function detectDelim(line) {
  if (line.includes('\t')) return '\t';
  if (line.includes('|')) return '|';
  return ',';
}

function normName(s) {
  return String(s || '').trim().toLowerCase();
}

/** Excel/시트 날짜 → YYYY-MM-DD */
export function normalizeDate(raw, defaultYear) {
  if (raw == null || raw === '') return '';
  const s = String(raw).trim();
  if (!s) return '';

  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    return fmtDate(y, m, d);
  }
  if (/^\d{4}[./]\d{1,2}[./]\d{1,2}$/.test(s)) {
    const parts = s.split(/[./]/).map(Number);
    return fmtDate(parts[0], parts[1], parts[2]);
  }
  if (/^\d{1,2}[./-]\d{1,2}$/.test(s)) {
    const year = defaultYear || new Date().getFullYear();
    const parts = s.split(/[./-]/).map(Number);
    return fmtDate(year, parts[0], parts[1]);
  }
  if (/^\d{1,2}월\s*\d{1,2}일?$/.test(s)) {
    const year = defaultYear || new Date().getFullYear();
    const m = parseInt(s.match(/(\d{1,2})월/)[1], 10);
    const d = parseInt(s.match(/(\d{1,2})일?/)[1], 10);
    return fmtDate(year, m, d);
  }
  const n = Number(s);
  if (isFinite(n) && n > 30000 && n < 60000) {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const dt = new Date(epoch.getTime() + n * 86400000);
    return fmtDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  return '';
}

function fmtDate(y, m, d) {
  if (!y || !m || !d) return '';
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function isHeaderRow(cells) {
  const joined = cells.join(' ').toLowerCase();
  return /날짜|date|상품|product|수량|qty|카테고리/.test(joined) && !numCell(cells[0]);
}

function colIndex(headers, keywords) {
  const lower = headers.map(h => String(h || '').toLowerCase());
  for (let i = 0; i < lower.length; i++) {
    if (keywords.some(k => lower[i].includes(k))) return i;
  }
  return -1;
}

// 카테고리, 상품명, 공급가, 배송비, 판매가, 수수료(%), 소싱처링크
export function parseProductTable(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return { rows: [], errors: ['내용이 비어있어요.'] };
  const delim = detectDelim(lines[0]);
  const rows = [];
  const errors = [];
  lines.forEach((line, i) => {
    const cells = line.split(delim).map(c => c.trim());
    if (i === 0 && (cells[1] || '').includes('상품') && !numCell(cells[2])) return;
    const [category, name, supplyPrice, shipping, sellPrice, fee, sourceUrl] = cells;
    if (!name) return;
    const sp = numCell(sellPrice);
    if (sp === '') { errors.push(`"${name}" 행: 판매가를 읽을 수 없어요.`); return; }
    rows.push({
      category: category || '미분류',
      name: name.trim(),
      supplyPrice: numCell(supplyPrice) || 0,
      shipping: numCell(shipping) || 0,
      sellPrice: sp,
      fee: numCell(fee) || 10.8,
      sourceUrl: sourceUrl || '',
    });
  });
  return { rows, errors };
}

/** 목록 형식: 날짜, [카테고리], 상품명, 수량 */
export function parseSalesList(text, defaultYear) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return { rows: [], errors: ['내용이 비어있어요.'] };
  const delim = detectDelim(lines[0]);
  const allCells = lines.map(l => l.split(delim).map(c => c.trim()));
  let start = 0;
  let dateIdx = 0;
  let categoryIdx = -1;
  let nameIdx = 1;
  let qtyIdx = 2;

  if (isHeaderRow(allCells[0])) {
    const h = allCells[0];
    dateIdx = colIndex(h, ['날짜', 'date']);
    categoryIdx = colIndex(h, ['카테고리', 'category']);
    nameIdx = colIndex(h, ['상품명', '상품', 'product']);
    qtyIdx = colIndex(h, ['수량', 'qty', '판매']);
    if (dateIdx < 0) dateIdx = 0;
    if (nameIdx < 0) nameIdx = categoryIdx >= 0 ? 2 : 1;
    if (qtyIdx < 0) qtyIdx = nameIdx + 1;
    start = 1;
  }

  const rows = [];
  const errors = [];
  for (let i = start; i < allCells.length; i++) {
    const cells = allCells[i];
    const date = normalizeDate(cells[dateIdx], defaultYear);
    const name = (cells[nameIdx] || '').trim();
    const qty = numCell(cells[qtyIdx]);
    if (!name) continue;
    if (!date) { errors.push(`${i + 1}행: 날짜를 읽을 수 없어요 (${cells[dateIdx]})`); continue; }
    if (qty === '' || qty <= 0) continue;
    rows.push({
      date,
      category: categoryIdx >= 0 ? (cells[categoryIdx] || '').trim() : '',
      productName: name,
      qty,
    });
  }
  return { rows, errors };
}

/** 피벗 형식: 1행=상품명, 1열=날짜 */
export function parseSalesMatrix(text, defaultYear) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return { rows: [], errors: ['헤더와 데이터 행이 필요해요.'] };
  const delim = detectDelim(lines[0]);
  const grid = lines.map(l => l.split(delim).map(c => c.trim()));
  const header = grid[0];
  let nameStart = 0;
  if (header[0] && /날짜|date/i.test(header[0])) nameStart = 1;
  const productNames = header.slice(nameStart).map(n => n.trim()).filter(Boolean);
  if (productNames.length === 0) return { rows: [], errors: ['상품명 헤더를 찾을 수 없어요.'] };

  const rows = [];
  const errors = [];
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r];
    const date = normalizeDate(cells[0], defaultYear);
    if (!date) {
      if (cells[0]) errors.push(`${r + 1}행: 날짜를 읽을 수 없어요 (${cells[0]})`);
      continue;
    }
    productNames.forEach((name, i) => {
      const qty = numCell(cells[nameStart + i]);
      if (qty !== '' && qty > 0) rows.push({ date, category: '', productName: name, qty });
    });
  }
  return { rows, errors };
}

export function buildProductMap(products) {
  const map = new Map();
  products.forEach(p => {
    map.set(normName(p.name), p);
    map.set(normName(`${p.category || ''}::${p.name}`), p);
  });
  return map;
}

function resolveProduct(map, row) {
  if (row.category) {
    const p = map.get(normName(`${row.category}::${row.productName}`));
    if (p) return p;
  }
  return map.get(normName(row.productName));
}

export function applyProductImport(data, importRows, mode = 'skip') {
  let products = [...data.products];
  let categories = [...data.categories];
  let added = 0;
  let skipped = 0;
  let updated = 0;

  importRows.forEach(row => {
    const idx = products.findIndex(p => normName(p.name) === normName(row.name));
    if (idx >= 0) {
      if (mode === 'update') {
        products[idx] = { ...products[idx], ...row };
        updated++;
      } else skipped++;
      return;
    }
    if (!categories.includes(row.category)) categories.push(row.category);
    products.push({
      id: uid(), name: row.name, category: row.category,
      supplyPrice: row.supplyPrice, sellPrice: row.sellPrice,
      fee: row.fee, shipping: row.shipping, sourceUrl: row.sourceUrl,
      status: '판매중', createdAt: Date.now(),
    });
    added++;
  });

  return { products, categories, added, skipped, updated };
}

export function previewSalesImport(salesRows, products) {
  const map = buildProductMap(products);
  const matched = [];
  const unmatched = new Set();

  salesRows.forEach(row => {
    const p = resolveProduct(map, row);
    if (!p) unmatched.add(row.productName);
    else matched.push({ ...row, productId: p.id });
  });

  const dates = matched.map(r => r.date).sort();
  return {
    matched,
    unmatched: [...unmatched],
    totalQty: matched.reduce((s, r) => s + r.qty, 0),
    dateRange: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
  };
}

/** mode: 'merge' = 같은 날짜·상품 수량 합산, 'replace' = 가져온 날짜 덮어쓰기 */
export function applySalesImport(data, salesRows, products, mode = 'merge') {
  const preview = previewSalesImport(salesRows, products);
  if (preview.matched.length === 0) {
    return { data, ...preview, imported: 0 };
  }

  let sales = [...data.sales];
  const importedDates = new Set(preview.matched.map(r => r.date));

  if (mode === 'replace') {
    sales = sales.filter(s => !importedDates.has(s.date));
  }

  preview.matched.forEach(row => {
    const idx = sales.findIndex(s => s.productId === row.productId && s.date === row.date);
    if (idx >= 0) {
      const nextQty = mode === 'merge' ? (Number(sales[idx].qty) || 0) + row.qty : row.qty;
      sales[idx] = { ...sales[idx], qty: nextQty };
    } else {
      sales.push({ id: uid(), productId: row.productId, date: row.date, qty: row.qty, note: '' });
    }
  });

  return { data: { ...data, sales }, ...preview, imported: preview.matched.length };
}
