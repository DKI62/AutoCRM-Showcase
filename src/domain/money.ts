export const moneyFields: ReadonlySet<string> = new Set(['listing_price', 'buyout_price', 'market_price', 'prep_cost', 'purchase_price']);

// Accept only unambiguous whole rubles. A legacy value such as "1.950" stays text.
export function rubleDigits(value: string) {
  const amount = value.trim().replace(/[ \u00a0\u202f]*₽$/, '');
  return /^(?:\d+|\d{1,3}(?:[ \u00a0\u202f]\d{3})+)$/.test(amount)
    ? amount.replace(/[ \u00a0\u202f]/g, '').replace(/^0+(?=\d)/, '')
    : null;
}

export function formatRubles(value: string) {
  const digits = rubleDigits(value);
  return digits === null ? value : digits.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f') + '\u00a0₽';
}

export const isAmbiguousRubles = (value: string) => /^\d+(?:[.,]\d+)+\s*₽?$/.test(value.trim());

export const displayRubles = (value: string) => isAmbiguousRubles(value) ? `${value} · уточнить сумму` : formatRubles(value);
