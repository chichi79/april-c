export const DEFAULT_CATEGORIES = ['생활용품', '우산', '레저', '모자', '잡화', '시즌상품'];

export function emptyData() {
  return {
    products: [],
    sales: [],
    sourcing: [],
    categories: DEFAULT_CATEGORIES,
    checklists: {},
  };
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function normalizeData(raw) {
  if (!raw) return emptyData();
  return {
    ...emptyData(),
    ...raw,
    categories: raw.categories?.length ? raw.categories : DEFAULT_CATEGORIES,
  };
}
