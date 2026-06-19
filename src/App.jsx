import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  LayoutDashboard, Calculator, TrendingUp, Search, Image as ImageIcon,
  Plus, Trash2, Pencil, X, Check, ChevronDown, ChevronUp, ExternalLink,
  Package, ListChecks, AlertCircle, Calendar,
} from 'lucide-react';
import { useFirestoreStore } from './hooks/useFirestoreStore';
import { uid } from './lib/data';

// ---------- formatting ----------
const fmtWon = (n) => Math.round(Number(n) || 0).toLocaleString('ko-KR') + '원';
const fmtPct = (n) => (!isFinite(n) ? '-' : (Math.round(n * 10) / 10).toFixed(1) + '%');
const todayStr = () => new Date().toISOString().slice(0, 10);
const thisMonthKey = () => new Date().toISOString().slice(0, 7);
const monthKeyOf = (dateStr) => (dateStr || '').slice(0, 7);
const dayLabelOf = (dateStr) => (dateStr || '').slice(5);
const monthLabel = (key) => {
  if (!key) return '';
  const [y, m] = key.split('-');
  return `${y}년 ${Number(m)}월`;
};

function calcMargin({ sellPrice, supplyPrice, feeRate, shipping }) {
  const sp = Number(sellPrice) || 0;
  const cp = Number(supplyPrice) || 0;
  const fr = Number(feeRate) || 0;
  const sh = Number(shipping) || 0;
  const feeAmount = sp * (fr / 100);
  const profit = sp - cp - feeAmount - sh;
  const marginRate = sp > 0 ? (profit / sp) * 100 : 0;
  return { feeAmount, profit, marginRate };
}

// parse a copy-pasted spreadsheet block (TSV from Google Sheets, or CSV)
// expected columns (in order, header row optional):
// 카테고리, 상품명, 공급가, 배송비, 판매가, 수수료(%), 소싱처링크
function parsePastedTable(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return { rows: [], errors: ['내용이 비어있어요.'] };
  const delim = lines[0].includes('\t') ? '\t' : ',';
  const rows = [];
  const errors = [];
  const numCell = (s) => {
    if (s == null) return '';
    const cleaned = String(s).replace(/[₩%,\s]/g, '');
    if (cleaned === '' || cleaned === '-') return '';
    const v = parseFloat(cleaned);
    return isFinite(v) ? v : '';
  };
  lines.forEach((line, i) => {
    const cells = line.split(delim).map(c => c.trim());
    // skip header-ish rows
    if (i === 0 && (cells[1] || '').includes('상품') && !numCell(cells[2])) return;
    const [category, name, supplyPrice, shipping, sellPrice, fee, sourceUrl] = cells;
    if (!name) { return; }
    const sp = numCell(sellPrice);
    if (sp === '') { errors.push(`"${name}" 행: 판매가를 읽을 수 없어요.`); return; }
    rows.push({
      category: category || '미분류',
      name,
      supplyPrice: numCell(supplyPrice) || 0,
      shipping: numCell(shipping) || 0,
      sellPrice: sp,
      fee: numCell(fee) || 10.8,
      sourceUrl: sourceUrl || '',
    });
  });
  return { rows, errors };
}

// ---------- shared UI ----------
function StatCard({ label, value, sub, tone }) {
  return (
    <div style={{
      background: 'var(--paper)', border: '1px solid var(--ink-10)', borderRadius: 10,
      padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0,
    }}>
      <span style={{ fontSize: 12, color: 'var(--ink-60)', fontWeight: 500 }}>{label}</span>
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 22, fontWeight: 600, lineHeight: 1.15,
        color: tone === 'bad' ? 'var(--red)' : tone === 'good' ? 'var(--green)' : 'var(--ink-90)',
      }}>{value}</span>
      {sub && <span style={{ fontSize: 12, color: 'var(--ink-50)' }}>{sub}</span>}
    </div>
  );
}

function Field({ label, children, hint }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: 'var(--ink-70)', flex: 1, minWidth: 0 }}>
      <span style={{ fontWeight: 500 }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 11, color: 'var(--ink-40)' }}>{hint}</span>}
    </label>
  );
}

const inputStyle = {
  border: '1px solid var(--ink-15)', borderRadius: 7, padding: '8px 10px', fontSize: 14,
  background: '#fff', color: 'var(--ink-90)', width: '100%', boxSizing: 'border-box', fontFamily: 'inherit',
};
const btnPrimary = {
  background: 'var(--ink-90)', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 16px',
  fontSize: 14, fontWeight: 500, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
};
const btnGhost = {
  background: 'transparent', color: 'var(--ink-70)', border: '1px solid var(--ink-15)', borderRadius: 8,
  padding: '9px 14px', fontSize: 14, fontWeight: 500, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
};

function EmptyState({ icon: Icon, title, desc }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 20px', color: 'var(--ink-50)', border: '1px dashed var(--ink-15)', borderRadius: 12 }}>
      <Icon size={28} style={{ marginBottom: 10, opacity: 0.6 }} />
      <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--ink-70)', marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 13 }}>{desc}</div>
    </div>
  );
}

function Badge({ children, bg, color }) {
  return <span style={{ fontSize: 11, padding: '2px 7px', borderRadius: 5, fontWeight: 500, background: bg, color }}>{children}</span>;
}

// =========================================================
// shared aggregation: sales -> per-product / per-month / per-day
// =========================================================
function useAggregates(data) {
  return useMemo(() => {
    const productMap = new Map(data.products.map(p => [p.id, p]));

    const enrichedSales = data.sales.map(s => {
      const p = productMap.get(s.productId);
      if (!p) return { ...s, productName: '(삭제된 상품)', revenue: 0, profit: 0, category: '' };
      const m = calcMargin({ sellPrice: p.sellPrice, supplyPrice: p.supplyPrice, feeRate: p.fee, shipping: p.shipping });
      const qty = Number(s.qty) || 0;
      return {
        ...s, productName: p.name, category: p.category || '',
        revenue: (Number(p.sellPrice) || 0) * qty, profit: m.profit * qty,
      };
    });

    const byMonth = new Map();
    enrichedSales.forEach(s => {
      const mk = monthKeyOf(s.date);
      if (!mk) return;
      if (!byMonth.has(mk)) byMonth.set(mk, { revenue: 0, profit: 0, qty: 0 });
      const acc = byMonth.get(mk);
      acc.revenue += s.revenue; acc.profit += s.profit; acc.qty += Number(s.qty) || 0;
    });

    const byDay = new Map();
    enrichedSales.forEach(s => {
      if (!s.date) return;
      if (!byDay.has(s.date)) byDay.set(s.date, { revenue: 0, profit: 0, qty: 0 });
      const acc = byDay.get(s.date);
      acc.revenue += s.revenue; acc.profit += s.profit; acc.qty += Number(s.qty) || 0;
    });

    const byProduct = new Map();
    enrichedSales.forEach(s => {
      if (!byProduct.has(s.productId)) byProduct.set(s.productId, { revenue: 0, profit: 0, qty: 0 });
      const acc = byProduct.get(s.productId);
      acc.revenue += s.revenue; acc.profit += s.profit; acc.qty += Number(s.qty) || 0;
    });

    const totals = enrichedSales.reduce((acc, s) => ({
      revenue: acc.revenue + s.revenue, profit: acc.profit + s.profit, qty: acc.qty + (Number(s.qty) || 0),
    }), { revenue: 0, profit: 0, qty: 0 });

    return { enrichedSales, byMonth, byDay, byProduct, totals };
  }, [data]);
}

// =========================================================
// TAB: DASHBOARD
// =========================================================
function Dashboard({ data, setTab, agg }) {
  const monthKey = thisMonthKey();
  const monthStats = agg.byMonth.get(monthKey) || { revenue: 0, profit: 0, qty: 0 };
  const monthMarginRate = monthStats.revenue > 0 ? (monthStats.profit / monthStats.revenue) * 100 : 0;

  const recentDays = useMemo(() => {
    return Array.from(agg.byDay.entries()).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 7);
  }, [agg]);

  const lowMargin = useMemo(() => data.products.filter(p => calcMargin({
    sellPrice: p.sellPrice, supplyPrice: p.supplyPrice, feeRate: p.fee, shipping: p.shipping,
  }).marginRate < 10), [data.products]);

  const topProducts = useMemo(() => {
    return [...agg.byProduct.entries()]
      .map(([id, v]) => ({ id, ...v, product: data.products.find(p => p.id === id) }))
      .filter(x => x.product)
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 5);
  }, [agg, data.products]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
        <StatCard label="등록 상품 수" value={data.products.length + '개'} />
        <StatCard label="이번 달 매출" value={fmtWon(monthStats.revenue)} sub={monthStats.qty + '건 판매'} />
        <StatCard label="이번 달 순이익" value={fmtWon(monthStats.profit)} tone={monthStats.profit < 0 ? 'bad' : 'good'} />
        <StatCard label="이번 달 마진율" value={fmtPct(monthMarginRate)} tone={monthMarginRate < 10 ? 'bad' : undefined} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
        <StatCard label="전체 누적 매출" value={fmtWon(agg.totals.revenue)} />
        <StatCard label="전체 누적 순이익" value={fmtWon(agg.totals.profit)} tone={agg.totals.profit < 0 ? 'bad' : 'good'} />
        <StatCard label="전체 누적 판매" value={agg.totals.qty + '건'} />
      </div>

      {lowMargin.length > 0 && (
        <div style={{ background: 'var(--red-bg)', border: '1px solid var(--red-border)', borderRadius: 10, padding: '12px 14px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <AlertCircle size={18} color="var(--red)" style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 13, color: 'var(--ink-80)' }}>
            <span style={{ fontWeight: 500 }}>마진율 10% 미만 상품 {lowMargin.length}개</span> — {lowMargin.slice(0, 4).map(p => p.name).join(', ')}{lowMargin.length > 4 ? ' 외' : ''}
            <div style={{ marginTop: 4 }}>
              <button onClick={() => setTab('margin')} style={{ ...btnGhost, padding: '5px 10px', fontSize: 12, borderColor: 'var(--red-border)', color: 'var(--red)' }}>마진 계산기에서 확인</button>
            </div>
          </div>
        </div>
      )}

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
          <h3 style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-70)', margin: 0 }}>최근 7일 매출</h3>
          <button onClick={() => setTab('sales')} style={{ ...btnGhost, padding: '4px 10px', fontSize: 12 }}>판매 현황 전체보기</button>
        </div>
        {recentDays.length === 0 ? (
          <EmptyState icon={Calendar} title="판매 기록이 없어요" desc="판매 현황 탭에서 일별 판매를 입력해보세요." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {recentDays.map(([date, v]) => (
              <div key={date} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, padding: '8px 10px', background: '#fff', border: '1px solid var(--ink-10)', borderRadius: 8 }}>
                <span style={{ width: 56, color: 'var(--ink-50)', fontFamily: 'var(--mono)' }}>{dayLabelOf(date)}</span>
                <div style={{ flex: 1, height: 6, background: 'var(--ink-5)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', background: 'var(--ink-30)', width: `${Math.min(100, (v.revenue / (recentDays[0][1].revenue || 1)) * 100)}%` }} />
                </div>
                <span style={{ fontFamily: 'var(--mono)', minWidth: 90, textAlign: 'right' }}>{fmtWon(v.revenue)}</span>
                <span style={{ color: 'var(--ink-40)', minWidth: 44, textAlign: 'right' }}>{v.qty}건</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {topProducts.length > 0 && (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-70)', margin: '0 0 10px' }}>누적 순이익 상위 상품</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {topProducts.map(t => (
              <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '8px 10px', background: '#fff', border: '1px solid var(--ink-10)', borderRadius: 8 }}>
                <span style={{ color: 'var(--ink-90)' }}>{t.product.name}</span>
                <span style={{ fontFamily: 'var(--mono)', color: 'var(--green)' }}>{fmtWon(t.profit)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-70)', margin: '0 0 10px' }}>바로가기</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
          {[
            { tab: 'margin', icon: Calculator, label: '마진 계산기', desc: '상품 마진 계산' },
            { tab: 'sales', icon: TrendingUp, label: '판매 현황', desc: '일별 판매 입력' },
            { tab: 'sourcing', icon: Search, label: '상품 소싱', desc: '소싱 후보 관리' },
            { tab: 'image', icon: ImageIcon, label: '이미지 가이드', desc: '제작 체크리스트' },
          ].map(s => (
            <button key={s.tab} onClick={() => setTab(s.tab)} style={{ textAlign: 'left', border: '1px solid var(--ink-10)', background: '#fff', borderRadius: 10, padding: '14px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <s.icon size={18} color="var(--ink-60)" />
              <div>
                <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-90)' }}>{s.label}</div>
                <div style={{ fontSize: 12, color: 'var(--ink-50)' }}>{s.desc}</div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {data.products.length === 0 && (
        <EmptyState icon={Package} title="등록된 상품이 없어요" desc="마진 계산기에서 상품을 추가하면 여기에 요약이 표시돼요." />
      )}
    </div>
  );
}

// =========================================================
// TAB: MARGIN CALCULATOR
// =========================================================
function MarginCalculator({ data, setData }) {
  const blank = { name: '', category: data.categories[0] || '', supplyPrice: '', sellPrice: '', fee: '10.8', shipping: '3000', sourceUrl: '', status: '판매중' };
  const [form, setForm] = useState(blank);
  const [editingId, setEditingId] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [categoryFilter, setCategoryFilter] = useState('전체');
  const [newCategory, setNewCategory] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  const [importPreview, setImportPreview] = useState(null);

  const live = calcMargin({ sellPrice: form.sellPrice, supplyPrice: form.supplyPrice, feeRate: form.fee, shipping: form.shipping });

  function resetForm() { setForm(blank); setEditingId(null); }

  function submit(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    if (editingId) {
      setData({ ...data, products: data.products.map(p => p.id === editingId ? { ...p, ...form } : p) });
    } else {
      setData({ ...data, products: [...data.products, { id: uid(), ...form, createdAt: Date.now() }] });
    }
    resetForm();
  }

  function startEdit(p) {
    setForm({ name: p.name, category: p.category || data.categories[0] || '', supplyPrice: p.supplyPrice, sellPrice: p.sellPrice, fee: p.fee, shipping: p.shipping, sourceUrl: p.sourceUrl || '', status: p.status || '판매중' });
    setEditingId(p.id);
  }

  function remove(id) {
    setData({ ...data, products: data.products.filter(p => p.id !== id), sales: data.sales.filter(s => s.productId !== id) });
    if (editingId === id) resetForm();
  }

  function addCategory() {
    const v = newCategory.trim();
    if (!v || data.categories.includes(v)) return;
    setData({ ...data, categories: [...data.categories, v] });
    setForm(f => ({ ...f, category: v }));
    setNewCategory('');
  }

  function handlePreviewImport() {
    const { rows, errors } = parsePastedTable(importText);
    setImportPreview({ rows, errors });
  }

  function handleConfirmImport() {
    if (!importPreview || importPreview.rows.length === 0) return;
    const newCats = [...new Set(importPreview.rows.map(r => r.category))].filter(c => !data.categories.includes(c));
    const newProducts = importPreview.rows.map(r => ({
      id: uid(), name: r.name, category: r.category, supplyPrice: r.supplyPrice, sellPrice: r.sellPrice,
      fee: r.fee, shipping: r.shipping, sourceUrl: r.sourceUrl, status: '판매중', createdAt: Date.now(),
    }));
    setData({ ...data, products: [...data.products, ...newProducts], categories: [...data.categories, ...newCats] });
    setShowImport(false);
    setImportText('');
    setImportPreview(null);
  }

  const grouped = useMemo(() => {
    const filtered = categoryFilter === '전체' ? data.products : data.products.filter(p => (p.category || '미분류') === categoryFilter);
    const map = new Map();
    filtered.forEach(p => {
      const cat = p.category || '미분류';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat).push(p);
    });
    for (const arr of map.values()) arr.sort((a, b) => b.createdAt - a.createdAt);
    return map;
  }, [data.products, categoryFilter]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <button onClick={() => setShowImport(!showImport)} style={{ ...btnGhost, marginBottom: showImport ? 12 : 0 }}>
          <ListChecks size={15} />구글 시트에서 한 번에 가져오기
        </button>
        {showImport && (
          <div style={{ background: 'var(--paper)', border: '1px solid var(--ink-10)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13, color: 'var(--ink-60)' }}>
              구글 시트에서 <strong style={{ fontWeight: 500 }}>카테고리, 상품명, 공급가, 배송비, 판매가, 수수료(%), 소싱처링크</strong> 순서의 열을 복사해서 아래에 붙여넣으세요. 탭이나 쉼표로 구분된 표면 인식돼요.
            </div>
            <textarea
              style={{ ...inputStyle, minHeight: 120, fontFamily: 'var(--mono)', fontSize: 12, resize: 'vertical' }}
              value={importText}
              onChange={e => { setImportText(e.target.value); setImportPreview(null); }}
              placeholder="생활용품, 모던쿡 냉동밥 보관용기, 5000, 3000, 12900, 10.8, https://..."
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handlePreviewImport} style={btnGhost} disabled={!importText.trim()}>미리보기</button>
              {importPreview && importPreview.rows.length > 0 && (
                <button onClick={handleConfirmImport} style={btnPrimary}><Check size={15} />{importPreview.rows.length}개 상품 가져오기</button>
              )}
              <button onClick={() => { setShowImport(false); setImportText(''); setImportPreview(null); }} style={btnGhost}><X size={15} />닫기</button>
            </div>
            {importPreview && (
              <div style={{ fontSize: 12, color: 'var(--ink-60)' }}>
                {importPreview.rows.length > 0 && <div style={{ color: 'var(--green)', marginBottom: 4 }}>{importPreview.rows.length}개 행 인식됨 — {importPreview.rows.slice(0, 3).map(r => r.name).join(', ')}{importPreview.rows.length > 3 ? ' 외' : ''}</div>}
                {importPreview.errors.length > 0 && (
                  <div style={{ color: 'var(--red)' }}>{importPreview.errors.length}개 행을 건너뛰었어요: {importPreview.errors.slice(0, 3).join(' / ')}</div>
                )}
                {importPreview.rows.length === 0 && importPreview.errors.length === 0 && (
                  <div style={{ color: 'var(--red)' }}>인식된 행이 없어요. 열 순서를 확인해주세요.</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <form onSubmit={submit} style={{ background: 'var(--paper)', border: '1px solid var(--ink-10)', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-80)' }}>{editingId ? '상품 정보 수정' : '새 상품 마진 계산'}</div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Field label="상품명">
            <input style={inputStyle} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="예: 무선 이어폰 케이스" />
          </Field>
          <Field label="카테고리">
            <select style={inputStyle} value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
              {data.categories.map(c => <option key={c}>{c}</option>)}
            </select>
          </Field>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <Field label="새 카테고리 추가">
            <input style={inputStyle} value={newCategory} onChange={e => setNewCategory(e.target.value)} placeholder="예: 주방용품" />
          </Field>
          <button type="button" onClick={addCategory} style={{ ...btnGhost, padding: '8px 12px', height: 36 }}><Plus size={14} />추가</button>
        </div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Field label="공급가 (도매가)">
            <input style={inputStyle} type="number" min="0" value={form.supplyPrice} onChange={e => setForm({ ...form, supplyPrice: e.target.value })} placeholder="0" />
          </Field>
          <Field label="판매가">
            <input style={inputStyle} type="number" min="0" value={form.sellPrice} onChange={e => setForm({ ...form, sellPrice: e.target.value })} placeholder="0" />
          </Field>
        </div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Field label="쿠팡 판매 수수료 (%)" hint="카테고리별 평균 약 10.8%">
            <input style={inputStyle} type="number" min="0" step="0.1" value={form.fee} onChange={e => setForm({ ...form, fee: e.target.value })} />
          </Field>
          <Field label="배송비 / 기타 비용">
            <input style={inputStyle} type="number" min="0" value={form.shipping} onChange={e => setForm({ ...form, shipping: e.target.value })} placeholder="0" />
          </Field>
        </div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Field label="소싱처 링크 (선택)">
            <input style={inputStyle} value={form.sourceUrl} onChange={e => setForm({ ...form, sourceUrl: e.target.value })} placeholder="https://..." />
          </Field>
          <Field label="상태">
            <select style={inputStyle} value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>
              <option>판매중</option><option>품절</option><option>중단</option>
            </select>
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, background: '#fff', border: '1px solid var(--ink-10)', borderRadius: 10, padding: 14 }}>
          <StatCard label="수수료 금액" value={fmtWon(live.feeAmount)} />
          <StatCard label="개당 순이익" value={fmtWon(live.profit)} tone={live.profit < 0 ? 'bad' : 'good'} />
          <StatCard label="마진율" value={fmtPct(live.marginRate)} tone={live.marginRate < 10 ? 'bad' : 'good'} />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" style={btnPrimary}><Check size={15} />{editingId ? '수정 완료' : '상품 추가'}</button>
          {editingId && <button type="button" onClick={resetForm} style={btnGhost}><X size={15} />취소</button>}
        </div>
      </form>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
          <h3 style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-70)', margin: 0 }}>등록된 상품 ({data.products.length})</h3>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {['전체', ...data.categories].map(c => (
              <button key={c} onClick={() => setCategoryFilter(c)} style={{
                ...btnGhost, padding: '5px 11px', fontSize: 12,
                background: categoryFilter === c ? 'var(--ink-90)' : 'transparent',
                color: categoryFilter === c ? '#fff' : 'var(--ink-60)',
                borderColor: categoryFilter === c ? 'var(--ink-90)' : 'var(--ink-15)',
              }}>{c}</button>
            ))}
          </div>
        </div>

        {data.products.length === 0 ? (
          <EmptyState icon={Calculator} title="아직 계산한 상품이 없어요" desc="위 양식에 상품 정보를 입력하고 추가해보세요." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {[...grouped.entries()].map(([cat, items]) => (
              <div key={cat}>
                <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--ink-50)', marginBottom: 8 }}>{cat} ({items.length})</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {items.map(p => {
                    const m = calcMargin({ sellPrice: p.sellPrice, supplyPrice: p.supplyPrice, feeRate: p.fee, shipping: p.shipping });
                    const isOpen = expanded === p.id;
                    return (
                      <div key={p.id} style={{ border: '1px solid var(--ink-10)', borderRadius: 10, background: '#fff' }}>
                        <div onClick={() => setExpanded(isOpen ? null : p.id)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', cursor: 'pointer' }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-90)', display: 'flex', alignItems: 'center', gap: 8 }}>
                              {p.name}
                              <Badge bg={p.status === '판매중' ? 'var(--green-bg)' : 'var(--ink-5)'} color={p.status === '판매중' ? 'var(--green)' : 'var(--ink-50)'}>{p.status}</Badge>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--ink-50)', marginTop: 2 }}>판매가 {fmtWon(p.sellPrice)}</div>
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <div style={{ fontFamily: 'var(--mono)', fontSize: 15, fontWeight: 600, color: m.marginRate < 10 ? 'var(--red)' : 'var(--green)' }}>{fmtPct(m.marginRate)}</div>
                            <div style={{ fontSize: 11, color: 'var(--ink-40)' }}>{fmtWon(m.profit)}</div>
                          </div>
                          {isOpen ? <ChevronUp size={16} color="var(--ink-40)" /> : <ChevronDown size={16} color="var(--ink-40)" />}
                        </div>
                        {isOpen && (
                          <div style={{ padding: '0 14px 14px', borderTop: '1px solid var(--ink-10)' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(100px,1fr))', gap: 8, margin: '12px 0' }}>
                              <StatCard label="공급가" value={fmtWon(p.supplyPrice)} />
                              <StatCard label="수수료" value={fmtWon(m.feeAmount)} />
                              <StatCard label="배송/기타" value={fmtWon(p.shipping)} />
                            </div>
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                              <button onClick={() => startEdit(p)} style={btnGhost}><Pencil size={14} />수정</button>
                              <button onClick={() => remove(p.id)} style={{ ...btnGhost, color: 'var(--red)', borderColor: 'var(--red-border)' }}><Trash2 size={14} />삭제</button>
                              {p.sourceUrl && <a href={p.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ ...btnGhost, textDecoration: 'none' }}><ExternalLink size={14} />소싱처 열기</a>}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// =========================================================
// TAB: SALES (daily bulk entry -> monthly / category reports)
// =========================================================
function SalesTracker({ data, setData, agg }) {
  const [entryDate, setEntryDate] = useState(todayStr());
  const [dayQtys, setDayQtys] = useState({});
  const [viewMonth, setViewMonth] = useState(thisMonthKey());
  const [expandedDay, setExpandedDay] = useState(null);
  const [categoryFilter, setCategoryFilter] = useState('전체');

  const productsByCategory = useMemo(() => {
    const map = new Map();
    data.products.forEach(p => {
      const cat = p.category || '미분류';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat).push(p);
    });
    for (const arr of map.values()) arr.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ko'));
  }, [data.products]);

  useEffect(() => {
    const map = {};
    data.products.forEach(p => {
      const existing = data.sales.find(s => s.productId === p.id && s.date === entryDate);
      map[p.id] = existing ? String(existing.qty) : '';
    });
    setDayQtys(map);
  }, [entryDate, data.products, data.sales]);

  function saveDayEntry() {
    const otherSales = data.sales.filter(s => s.date !== entryDate);
    const newSales = data.products
      .filter(p => Number(dayQtys[p.id]) > 0)
      .map(p => {
        const existing = data.sales.find(s => s.productId === p.id && s.date === entryDate);
        return {
          id: existing?.id || uid(),
          productId: p.id,
          date: entryDate,
          qty: Number(dayQtys[p.id]),
          note: existing?.note || '',
        };
      });
    setData({ ...data, sales: [...otherSales, ...newSales] });
  }

  function remove(id) {
    setData({ ...data, sales: data.sales.filter(s => s.id !== id) });
  }

  const monthSales = useMemo(() => {
    return agg.enrichedSales
      .filter(s => monthKeyOf(s.date) === viewMonth)
      .filter(s => categoryFilter === '전체' || (s.category || '미분류') === categoryFilter)
      .sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.productName.localeCompare(b.productName, 'ko'));
  }, [agg, viewMonth, categoryFilter]);

  const dayRows = useMemo(() => {
    const map = new Map();
    monthSales.forEach(s => {
      if (!map.has(s.date)) map.set(s.date, { revenue: 0, profit: 0, qty: 0, products: 0 });
      const acc = map.get(s.date);
      acc.revenue += s.revenue; acc.profit += s.profit; acc.qty += Number(s.qty) || 0; acc.products += 1;
    });
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [monthSales]);

  const monthTotals = monthSales.reduce((acc, s) => ({
    revenue: acc.revenue + s.revenue, profit: acc.profit + s.profit, qty: acc.qty + (Number(s.qty) || 0),
  }), { revenue: 0, profit: 0, qty: 0 });

  const categoryMonthRows = useMemo(() => {
    const map = new Map();
    agg.enrichedSales
      .filter(s => monthKeyOf(s.date) === viewMonth)
      .forEach(s => {
        const cat = s.category || '미분류';
        if (!map.has(cat)) map.set(cat, { category: cat, qty: 0, revenue: 0, profit: 0, productIds: new Set() });
        const acc = map.get(cat);
        acc.qty += Number(s.qty) || 0;
        acc.revenue += s.revenue;
        acc.profit += s.profit;
        acc.productIds.add(s.productId);
      });
    return [...map.values()]
      .map(r => ({ ...r, productCount: r.productIds.size }))
      .sort((a, b) => b.revenue - a.revenue);
  }, [agg, viewMonth]);

  const productMonthRows = useMemo(() => {
    const map = new Map();
    monthSales.forEach(s => {
      if (!map.has(s.productId)) {
        map.set(s.productId, { productId: s.productId, productName: s.productName, category: s.category || '미분류', qty: 0, revenue: 0, profit: 0 });
      }
      const acc = map.get(s.productId);
      acc.qty += Number(s.qty) || 0;
      acc.revenue += s.revenue;
      acc.profit += s.profit;
    });
    return [...map.values()].sort((a, b) => b.revenue - a.revenue);
  }, [monthSales]);

  const availableMonths = useMemo(() => {
    const keys = new Set(agg.enrichedSales.map(s => monthKeyOf(s.date)).filter(Boolean));
    keys.add(thisMonthKey());
    return [...keys].sort().reverse();
  }, [agg]);

  const monthCategories = useMemo(() => {
    const cats = new Set(data.products.map(p => p.category || '미분류'));
    return ['전체', ...[...cats].sort((a, b) => a.localeCompare(b, 'ko'))];
  }, [data.products]);

  const maxDayRevenue = dayRows.reduce((mx, [, v]) => Math.max(mx, v.revenue), 1);
  const dayEntryCount = Object.values(dayQtys).filter(v => Number(v) > 0).length;
  const dayEntryTotal = data.products.reduce((sum, p) => sum + (Number(dayQtys[p.id]) || 0), 0);

  const thStyle = { padding: '8px 8px', color: 'var(--ink-50)', fontWeight: 500, whiteSpace: 'nowrap' };
  const tdStyle = { padding: '8px 8px' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {data.products.length === 0 ? (
        <EmptyState icon={TrendingUp} title="먼저 상품을 등록해주세요" desc="마진 계산기 탭에서 상품을 추가하면 판매 기록을 남길 수 있어요." />
      ) : (
        <div style={{ background: 'var(--paper)', border: '1px solid var(--ink-10)', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-80)' }}>일별 판매 입력</div>
            <div style={{ fontSize: 12, color: 'var(--ink-50)', marginTop: 4 }}>엑셀처럼 날짜를 고르고 상품별 판매 수량을 한 번에 입력하세요.</div>
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Field label="판매일">
              <input style={{ ...inputStyle, width: 160 }} type="date" value={entryDate} onChange={e => setEntryDate(e.target.value)} />
            </Field>
            <div style={{ fontSize: 12, color: 'var(--ink-50)', paddingBottom: 8 }}>
              입력 중: <strong style={{ color: 'var(--ink-70)' }}>{dayEntryCount}개 상품 · {dayEntryTotal}개 판매</strong>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {productsByCategory.map(([cat, items]) => (
              <div key={cat}>
                <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--ink-50)', marginBottom: 8 }}>{cat}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {items.map(p => (
                    <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: '#fff', border: '1px solid var(--ink-10)', borderRadius: 8 }}>
                      <span style={{ flex: 1, fontSize: 13, color: 'var(--ink-90)', minWidth: 0 }}>{p.name}</span>
                      <span style={{ fontSize: 12, color: 'var(--ink-40)', fontFamily: 'var(--mono)', whiteSpace: 'nowrap' }}>{fmtWon(p.sellPrice)}</span>
                      <input
                        style={{ ...inputStyle, width: 72, textAlign: 'right', fontFamily: 'var(--mono)' }}
                        type="number" min="0" placeholder="0"
                        value={dayQtys[p.id] ?? ''}
                        onChange={e => setDayQtys(q => ({ ...q, [p.id]: e.target.value }))}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div>
            <button type="button" onClick={saveDayEntry} style={btnPrimary}><Check size={15} />{entryDate} 판매 저장</button>
          </div>
        </div>
      )}

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
          <h3 style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-70)', margin: 0 }}>월별 현황</h3>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <select style={{ ...inputStyle, width: 'auto' }} value={viewMonth} onChange={e => { setViewMonth(e.target.value); setExpandedDay(null); }}>
              {availableMonths.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
            <select style={{ ...inputStyle, width: 'auto' }} value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}>
              {monthCategories.map(c => <option key={c} value={c}>{c === '전체' ? '전체 카테고리' : c}</option>)}
            </select>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 18 }}>
          <StatCard label="이 달 매출" value={fmtWon(monthTotals.revenue)} />
          <StatCard label="이 달 순이익" value={fmtWon(monthTotals.profit)} tone={monthTotals.profit < 0 ? 'bad' : 'good'} />
          <StatCard label="이 달 판매 수량" value={monthTotals.qty + '개'} />
        </div>

        <h4 style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink-60)', margin: '0 0 8px' }}>카테고리별 매출</h4>
        {categoryMonthRows.length === 0 ? (
          <EmptyState icon={Package} title="이 달 카테고리 매출이 없어요" desc="일별 판매를 입력하면 카테고리별로 합산돼요." />
        ) : (
          <div style={{ overflowX: 'auto', marginBottom: 20 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--ink-10)' }}>
                  {['카테고리', '판매 상품', '판매 수량', '매출', '순이익'].map(h => (
                    <th key={h} style={{ ...thStyle, textAlign: ['판매 수량', '매출', '순이익', '판매 상품'].includes(h) ? 'right' : 'left' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {categoryMonthRows.map(r => (
                  <tr key={r.category} style={{ borderBottom: '1px solid var(--ink-5)' }}>
                    <td style={{ ...tdStyle, color: 'var(--ink-90)', fontWeight: 500 }}>{r.category}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{r.productCount}개</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{r.qty}개</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtWon(r.revenue)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--mono)', color: r.profit < 0 ? 'var(--red)' : 'var(--green)' }}>{fmtWon(r.profit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h4 style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink-60)', margin: '0 0 8px' }}>상품별 매출</h4>
        {productMonthRows.length === 0 ? (
          <EmptyState icon={ListChecks} title="이 달 상품별 매출이 없어요" desc="일별 판매를 입력해보세요." />
        ) : (
          <div style={{ overflowX: 'auto', marginBottom: 20 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--ink-10)' }}>
                  {['카테고리', '상품', '판매 수량', '매출', '순이익'].map(h => (
                    <th key={h} style={{ ...thStyle, textAlign: ['판매 수량', '매출', '순이익'].includes(h) ? 'right' : 'left' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {productMonthRows.map(r => (
                  <tr key={r.productId} style={{ borderBottom: '1px solid var(--ink-5)' }}>
                    <td style={{ ...tdStyle, color: 'var(--ink-50)' }}>{r.category}</td>
                    <td style={{ ...tdStyle, color: 'var(--ink-90)' }}>{r.productName}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{r.qty}개</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtWon(r.revenue)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--mono)', color: r.profit < 0 ? 'var(--red)' : 'var(--green)' }}>{fmtWon(r.profit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h4 style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink-60)', margin: '0 0 8px' }}>일별 매출 ({dayRows.length}일)</h4>
        {dayRows.length === 0 ? (
          <EmptyState icon={Calendar} title="이 달 판매 기록이 없어요" desc="위에서 날짜별 판매 수량을 입력하면 일 매출로 합산돼요." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 20 }}>
            {dayRows.map(([date, v]) => {
              const isOpen = expandedDay === date;
              const dayDetails = monthSales.filter(s => s.date === date);
              return (
                <div key={date}>
                  <div
                    onClick={() => setExpandedDay(isOpen ? null : date)}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, padding: '8px 10px', background: '#fff', border: '1px solid var(--ink-10)', borderRadius: isOpen ? '8px 8px 0 0' : 8, cursor: 'pointer' }}
                  >
                    <span style={{ width: 50, color: 'var(--ink-50)', fontFamily: 'var(--mono)' }}>{dayLabelOf(date)}</span>
                    <div style={{ flex: 1, height: 6, background: 'var(--ink-5)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ height: '100%', background: 'var(--ink-30)', width: `${Math.min(100, (v.revenue / maxDayRevenue) * 100)}%` }} />
                    </div>
                    <span style={{ fontFamily: 'var(--mono)', minWidth: 90, textAlign: 'right' }}>{fmtWon(v.revenue)}</span>
                    <span style={{ fontFamily: 'var(--mono)', minWidth: 90, textAlign: 'right', color: v.profit < 0 ? 'var(--red)' : 'var(--green)' }}>{fmtWon(v.profit)}</span>
                    <span style={{ color: 'var(--ink-40)', minWidth: 48, textAlign: 'right' }}>{v.qty}개</span>
                    {isOpen ? <ChevronUp size={14} color="var(--ink-40)" /> : <ChevronDown size={14} color="var(--ink-40)" />}
                  </div>
                  {isOpen && (
                    <div style={{ border: '1px solid var(--ink-10)', borderTop: 'none', borderRadius: '0 0 8px 8px', background: 'var(--ink-5)', padding: '8px 10px' }}>
                      {dayDetails.map(s => (
                        <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, padding: '4px 0', color: 'var(--ink-70)' }}>
                          <span>{s.category ? `[${s.category}] ` : ''}{s.productName} × {s.qty}</span>
                          <span style={{ fontFamily: 'var(--mono)' }}>{fmtWon(s.revenue)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <h4 style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink-60)', margin: '0 0 8px' }}>판매 기록 상세 ({monthSales.length}건)</h4>
        {monthSales.length === 0 ? (
          <EmptyState icon={ListChecks} title="판매 기록이 없어요" desc="일별 판매 입력에서 수량을 저장해보세요." />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--ink-10)' }}>
                  {['날짜', '카테고리', '상품', '수량', '매출', '순이익', '메모', ''].map(h => (
                    <th key={h} style={{ ...thStyle, textAlign: ['매출', '순이익', '수량'].includes(h) ? 'right' : 'left' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {monthSales.map(r => (
                  <tr key={r.id} style={{ borderBottom: '1px solid var(--ink-5)' }}>
                    <td style={{ ...tdStyle, color: 'var(--ink-60)', whiteSpace: 'nowrap' }}>{r.date}</td>
                    <td style={{ ...tdStyle, color: 'var(--ink-50)' }}>{r.category || '미분류'}</td>
                    <td style={{ ...tdStyle, color: 'var(--ink-90)' }}>{r.productName}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{r.qty}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtWon(r.revenue)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--mono)', color: r.profit < 0 ? 'var(--red)' : 'var(--green)' }}>{fmtWon(r.profit)}</td>
                    <td style={{ ...tdStyle, color: 'var(--ink-50)' }}>{r.note}</td>
                    <td style={{ ...tdStyle }}>
                      <button onClick={() => remove(r.id)} aria-label="삭제" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-30)', display: 'flex' }}><Trash2 size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// =========================================================
// TAB: SOURCING
// =========================================================
const SOURCING_STATUSES = ['검토중', '소싱완료', '보류'];
const statusColor = {
  '검토중': { bg: 'var(--amber-bg)', text: 'var(--amber)' },
  '소싱완료': { bg: 'var(--green-bg)', text: 'var(--green)' },
  '보류': { bg: 'var(--ink-5)', text: 'var(--ink-50)' },
};

function Sourcing({ data, setData }) {
  const blank = { name: '', sourceUrl: '', supplyPrice: '', expectedSellPrice: '', note: '', status: '검토중' };
  const [form, setForm] = useState(blank);
  const [editingId, setEditingId] = useState(null);
  const [filter, setFilter] = useState('전체');

  function submit(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    if (editingId) setData({ ...data, sourcing: data.sourcing.map(s => s.id === editingId ? { ...s, ...form } : s) });
    else setData({ ...data, sourcing: [...data.sourcing, { id: uid(), ...form, createdAt: Date.now() }] });
    setForm(blank); setEditingId(null);
  }

  function startEdit(s) {
    setForm({ name: s.name, sourceUrl: s.sourceUrl || '', supplyPrice: s.supplyPrice, expectedSellPrice: s.expectedSellPrice, note: s.note || '', status: s.status });
    setEditingId(s.id);
  }

  function remove(id) {
    setData({ ...data, sourcing: data.sourcing.filter(s => s.id !== id) });
    if (editingId === id) { setForm(blank); setEditingId(null); }
  }

  function promote(s) {
    if (data.products.some(p => p.name === s.name)) return;
    const newProduct = { id: uid(), name: s.name, category: data.categories[0] || '', supplyPrice: s.supplyPrice, sellPrice: s.expectedSellPrice, fee: '10.8', shipping: '3000', sourceUrl: s.sourceUrl || '', status: '판매중', createdAt: Date.now() };
    setData({ ...data, products: [...data.products, newProduct], sourcing: data.sourcing.map(x => x.id === s.id ? { ...x, status: '소싱완료' } : x) });
  }

  const list = data.sourcing.filter(s => filter === '전체' || s.status === filter).sort((a, b) => b.createdAt - a.createdAt);
  const expectedMargin = (s) => calcMargin({ sellPrice: s.expectedSellPrice, supplyPrice: s.supplyPrice, feeRate: 10.8, shipping: 3000 });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <form onSubmit={submit} style={{ background: 'var(--paper)', border: '1px solid var(--ink-10)', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-80)' }}>{editingId ? '소싱 후보 수정' : '소싱 후보 추가'}</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Field label="상품명"><input style={inputStyle} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="후보 상품명" /></Field>
          <Field label="소싱처 링크"><input style={inputStyle} value={form.sourceUrl} onChange={e => setForm({ ...form, sourceUrl: e.target.value })} placeholder="https://..." /></Field>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Field label="예상 공급가"><input style={inputStyle} type="number" min="0" value={form.supplyPrice} onChange={e => setForm({ ...form, supplyPrice: e.target.value })} placeholder="0" /></Field>
          <Field label="예상 판매가"><input style={inputStyle} type="number" min="0" value={form.expectedSellPrice} onChange={e => setForm({ ...form, expectedSellPrice: e.target.value })} placeholder="0" /></Field>
          <Field label="검토 상태">
            <select style={inputStyle} value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>
              {SOURCING_STATUSES.map(s => <option key={s}>{s}</option>)}
            </select>
          </Field>
        </div>
        <Field label="메모"><input style={inputStyle} value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} placeholder="경쟁 강도, 시즌성, 리스크 등" /></Field>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" style={btnPrimary}><Check size={15} />{editingId ? '수정 완료' : '후보 추가'}</button>
          {editingId && <button type="button" onClick={() => { setForm(blank); setEditingId(null); }} style={btnGhost}><X size={15} />취소</button>}
        </div>
      </form>

      <div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          {['전체', ...SOURCING_STATUSES].map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{ ...btnGhost, padding: '6px 12px', fontSize: 12, background: filter === f ? 'var(--ink-90)' : 'transparent', color: filter === f ? '#fff' : 'var(--ink-60)', borderColor: filter === f ? 'var(--ink-90)' : 'var(--ink-15)' }}>{f}</button>
          ))}
        </div>

        {list.length === 0 ? (
          <EmptyState icon={Search} title="소싱 후보가 없어요" desc="검토 중인 상품을 추가해서 마진을 가늠해보세요." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {list.map(s => {
              const m = expectedMargin(s);
              const sc = statusColor[s.status];
              return (
                <div key={s.id} style={{ border: '1px solid var(--ink-10)', borderRadius: 10, background: '#fff', padding: '12px 14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-90)' }}>{s.name}</span>
                        <Badge bg={sc.bg} color={sc.text}>{s.status}</Badge>
                      </div>
                      {s.note && <div style={{ fontSize: 12, color: 'var(--ink-50)', marginTop: 4 }}>{s.note}</div>}
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 600, color: m.marginRate < 10 ? 'var(--red)' : 'var(--green)' }}>예상 {fmtPct(m.marginRate)}</div>
                      <div style={{ fontSize: 11, color: 'var(--ink-40)' }}>{fmtWon(s.supplyPrice)} → {fmtWon(s.expectedSellPrice)}</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                    {s.sourceUrl && <a href={s.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ ...btnGhost, padding: '5px 10px', fontSize: 12, textDecoration: 'none' }}><ExternalLink size={13} />소싱처</a>}
                    <button onClick={() => startEdit(s)} style={{ ...btnGhost, padding: '5px 10px', fontSize: 12 }}><Pencil size={13} />수정</button>
                    <button onClick={() => promote(s)} style={{ ...btnGhost, padding: '5px 10px', fontSize: 12, color: 'var(--green)', borderColor: 'var(--green-border)' }}><Check size={13} />상품으로 등록</button>
                    <button onClick={() => remove(s.id)} style={{ ...btnGhost, padding: '5px 10px', fontSize: 12, color: 'var(--red)', borderColor: 'var(--red-border)' }}><Trash2 size={13} />삭제</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// =========================================================
// TAB: IMAGE GUIDE
// =========================================================
const THUMB_CHECKLIST = [
  '1000x1000px 이상, 정사각형 비율', '상품이 화면의 70~80%를 채우도록 배치', '흰색 또는 깨끗한 단색 배경 권장',
  '텍스트는 핵심 셀링포인트 1~2개만 (가격, 할인율, 수량 등)', '워터마크·과도한 테두리 금지 (쿠팡 정책 위반 소지)', '실제 상품과 다른 합성·과장 이미지 금지',
];
const DETAIL_CHECKLIST = [
  '상단: 핵심 후킹 문구 + 대표 이미지', '상품의 사용 장면/실측 사이즈 표 포함', '소재, 원산지, 세탁방법 등 정보성 텍스트',
  '비교 표 (경쟁상품 대비 장점, 선택사항)', 'A/S, 교환/환불 정책 고지', '모바일에서 가로 폭 깨짐 없는지 확인 (보통 860px 폭 권장)',
];

function ChecklistCard({ title, items, storageKey, data, setData }) {
  const checked = data.checklists?.[storageKey] || {};
  function toggle(i) {
    setData({ ...data, checklists: { ...(data.checklists || {}), [storageKey]: { ...checked, [i]: !checked[i] } } });
  }
  const doneCount = items.filter((_, i) => checked[i]).length;
  return (
    <div style={{ background: '#fff', border: '1px solid var(--ink-10)', borderRadius: 12, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-90)' }}>{title}</span>
        <span style={{ fontSize: 12, color: 'var(--ink-40)' }}>{doneCount}/{items.length}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map((item, i) => (
          <label key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, color: checked[i] ? 'var(--ink-40)' : 'var(--ink-70)', cursor: 'pointer', textDecoration: checked[i] ? 'line-through' : 'none' }}>
            <input type="checkbox" checked={!!checked[i]} onChange={() => toggle(i)} style={{ marginTop: 2, flexShrink: 0 }} />
            <span>{item}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function ImageGuide({ data, setData }) {
  const [thumb, setThumb] = useState({ title: '', sub: '', bg: '#F4F1EA', accent: '#D85A30' });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
        <ChecklistCard title="썸네일 이미지 체크리스트" items={THUMB_CHECKLIST} storageKey="thumb" data={data} setData={setData} />
        <ChecklistCard title="상세페이지 체크리스트" items={DETAIL_CHECKLIST} storageKey="detail" data={data} setData={setData} />
      </div>

      <div style={{ background: 'var(--paper)', border: '1px solid var(--ink-10)', borderRadius: 12, padding: 18 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-80)', marginBottom: 4 }}>썸네일 카피 미리보기</div>
        <div style={{ fontSize: 12, color: 'var(--ink-50)', marginBottom: 14 }}>실제 이미지 합성 전, 문구와 색상 조합을 빠르게 가늠해보는 용도예요. 완성 이미지는 포토샵, 미리캔버스 등에서 제작해 업로드하세요.</div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: '1', minWidth: 220, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Field label="메인 문구"><input style={inputStyle} value={thumb.title} onChange={e => setThumb({ ...thumb, title: e.target.value })} placeholder="예: 하루 만에 완판" /></Field>
            <Field label="서브 문구"><input style={inputStyle} value={thumb.sub} onChange={e => setThumb({ ...thumb, sub: e.target.value })} placeholder="예: 무료배송 · 당일출고" /></Field>
            <div style={{ display: 'flex', gap: 10 }}>
              <Field label="배경색"><input type="color" style={{ ...inputStyle, padding: 2, height: 36 }} value={thumb.bg} onChange={e => setThumb({ ...thumb, bg: e.target.value })} /></Field>
              <Field label="강조색"><input type="color" style={{ ...inputStyle, padding: 2, height: 36 }} value={thumb.accent} onChange={e => setThumb({ ...thumb, accent: e.target.value })} /></Field>
            </div>
          </div>
          <div style={{ width: 220, height: 220, flexShrink: 0, borderRadius: 10, background: thumb.bg, border: '1px solid var(--ink-10)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 16, textAlign: 'center', gap: 8 }}>
            <div style={{ width: 70, height: 70, borderRadius: 8, background: '#fff', border: `2px solid ${thumb.accent}`, marginBottom: 6 }} />
            {thumb.title && <div style={{ fontSize: 17, fontWeight: 700, color: thumb.accent, lineHeight: 1.25 }}>{thumb.title}</div>}
            {thumb.sub && <div style={{ fontSize: 12, color: 'var(--ink-60)' }}>{thumb.sub}</div>}
            {!thumb.title && !thumb.sub && <div style={{ fontSize: 12, color: 'var(--ink-40)' }}>문구를 입력하면<br />여기 미리보기가 표시돼요</div>}
          </div>
        </div>
      </div>

      <div style={{ background: 'var(--amber-bg)', border: '1px solid var(--amber-border)', borderRadius: 10, padding: '12px 14px', fontSize: 13, color: 'var(--ink-80)', display: 'flex', gap: 10 }}>
        <AlertCircle size={16} color="var(--amber)" style={{ flexShrink: 0, marginTop: 2 }} />
        <span>실제 썸네일·상세페이지 이미지 파일 제작은 미리캔버스, 망고보드, 포토샵 등 외부 디자인 도구를 함께 쓰는 걸 추천해요. 이 페이지는 체크리스트와 문구 구상용이에요.</span>
      </div>
    </div>
  );
}

// =========================================================
// APP SHELL
// =========================================================
const TABS = [
  { key: 'dashboard', label: '대시보드', icon: LayoutDashboard },
  { key: 'margin', label: '마진 계산기', icon: Calculator },
  { key: 'sales', label: '판매 현황', icon: TrendingUp },
  { key: 'sourcing', label: '상품 소싱', icon: Search },
  { key: 'image', label: '이미지 가이드', icon: ImageIcon },
];

export default function App() {
  const store = useFirestoreStore();
  const { data, loaded, authError } = store;
  const [tab, setTab] = useState('dashboard');

  if (authError) {
    return (
      <div style={{ ...rootStyle, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300, padding: 20 }}>
        <style>{cssVars}</style>
        <div style={{ textAlign: 'center', maxWidth: 400 }}>
          <AlertCircle size={28} color="var(--red)" style={{ marginBottom: 12 }} />
          <div style={{ fontSize: 14, color: 'var(--ink-70)' }}>{authError}</div>
        </div>
      </div>
    );
  }

  if (!loaded || !data) {
    return (
      <div style={{ ...rootStyle, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}>
        <style>{cssVars}</style>
        <span style={{ color: 'var(--ink-50)', fontSize: 14 }}>불러오는 중...</span>
      </div>
    );
  }

  return <AppShell {...store} tab={tab} setTab={setTab} />;
}

function AppShell({ data, setData, tab, setTab, saveError, isAnonymous, signInWithGoogle, signOut }) {
  const agg = useAggregates(data);

  return (
    <div style={rootStyle}>
      <style>{cssVars}</style>
      <header style={{ borderBottom: '1px solid var(--ink-10)', padding: '18px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--ink-90)', letterSpacing: '-0.01em' }}>에이프릴커머스 관리 장부</div>
          <div style={{ fontSize: 12, color: 'var(--ink-50)' }}>April Commerce · 마진 · 판매 · 소싱 · 이미지</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {saveError && <div style={{ fontSize: 12, color: 'var(--red)', display: 'flex', alignItems: 'center', gap: 4 }}><AlertCircle size={14} />저장 실패</div>}
          {isAnonymous ? (
            <button type="button" onClick={signInWithGoogle} style={{ ...btnGhost, padding: '7px 12px', fontSize: 12 }}>Google로 로그인</button>
          ) : (
            <button type="button" onClick={signOut} style={{ ...btnGhost, padding: '7px 12px', fontSize: 12 }}>로그아웃</button>
          )}
        </div>
      </header>

      <nav style={{ display: 'flex', gap: 4, padding: '10px 16px', borderBottom: '1px solid var(--ink-10)', overflowX: 'auto' }}>
        {TABS.map(t => {
          const active = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, border: 'none', background: active ? 'var(--ink-90)' : 'transparent', color: active ? '#fff' : 'var(--ink-60)', fontSize: 13, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>
              <t.icon size={15} />{t.label}
            </button>
          );
        })}
      </nav>

      <main style={{ padding: '20px 20px 40px', maxWidth: 980, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
        {tab === 'dashboard' && <Dashboard data={data} setTab={setTab} agg={agg} />}
        {tab === 'margin' && <MarginCalculator data={data} setData={setData} />}
        {tab === 'sales' && <SalesTracker data={data} setData={setData} agg={agg} />}
        {tab === 'sourcing' && <Sourcing data={data} setData={setData} />}
        {tab === 'image' && <ImageGuide data={data} setData={setData} />}
      </main>
    </div>
  );
}

const rootStyle = {
  fontFamily: "'Pretendard', -apple-system, 'Apple SD Gothic Neo', sans-serif",
  background: 'var(--bg)', minHeight: '100vh', color: 'var(--ink-90)',
};

const cssVars = `
  :root {
    --bg: #FAF8F3;
    --paper: #F4F1EA;
    --ink-90: #2A2722;
    --ink-80: #3A3631;
    --ink-70: #4A4540;
    --ink-60: #5C5750;
    --ink-50: #7A746C;
    --ink-40: #948E85;
    --ink-30: #ACA69D;
    --ink-15: #DCD7CC;
    --ink-10: #E4DFD3;
    --ink-5: #EFEBE1;
    --mono: 'IBM Plex Mono', 'SF Mono', Menlo, monospace;
    --green: #2E6B3E;
    --green-bg: #E7F1E4;
    --green-border: #C3DEC0;
    --red: #B0392F;
    --red-bg: #FAEAE7;
    --red-border: #EFCAC3;
    --amber: #9C6B17;
    --amber-bg: #FBF0DC;
    --amber-border: #F0DBAE;
  }
  * { box-sizing: border-box; }
  input:focus, select:focus, textarea:focus { outline: none; border-color: var(--ink-40); box-shadow: 0 0 0 2px var(--ink-5); }
  button:hover { opacity: 0.85; }
  button:active { transform: scale(0.98); }
  table { font-variant-numeric: tabular-nums; }
  @media (max-width: 600px) { main { padding: 16px 12px 32px !important; } }
`;
