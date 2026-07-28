export function isWellFormedUnicode(value) {
  return typeof value === 'string' && value.isWellFormed();
}

export function toWellFormedUnicode(value) {
  return String(value ?? '').toWellFormed();
}

export function wellFormedUTF16Prefix(value, maximumCodeUnits) {
  if (!Number.isSafeInteger(maximumCodeUnits) || maximumCodeUnits < 0) return '';
  const input = toWellFormedUnicode(value);
  return input.slice(0, maximumCodeUnits).replace(/[\uD800-\uDBFF]$/u, '');
}
