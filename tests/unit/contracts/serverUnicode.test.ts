import {
  isWellFormedUnicode,
  toWellFormedUnicode,
  wellFormedUTF16Prefix
} from '../../../server-unicode.mjs';

describe('server Unicode boundary helpers', () => {
  it('truncates by the legacy UTF-16 wire bound without splitting astral characters', () => {
    const cards = '🃏'.repeat(141);

    expect(cards).toHaveLength(282);
    expect(wellFormedUTF16Prefix(cards, 280)).toBe('🃏'.repeat(140));
    expect(isWellFormedUnicode(wellFormedUTF16Prefix(cards, 280))).toBe(true);
  });

  it.each([
    ['lone high surrogate', String.fromCharCode(0xd800)],
    ['lone low surrogate', String.fromCharCode(0xdc00)]
  ])('detects and canonicalizes a %s', (_label, malformed) => {
    expect(isWellFormedUnicode(malformed)).toBe(false);
    expect(toWellFormedUnicode(`before${malformed}after`)).toBe('before\ufffdafter');
    expect(wellFormedUTF16Prefix(`before${malformed}after`, 7)).toBe('before\ufffd');
  });

  it('keeps valid paired surrogates and rejects invalid prefix lengths', () => {
    expect(isWellFormedUnicode('🃏')).toBe(true);
    expect(toWellFormedUnicode('🃏')).toBe('🃏');
    expect(wellFormedUTF16Prefix(`A${'🃏'.repeat(20)}`, 24)).toBe(`A${'🃏'.repeat(11)}`);
    expect(wellFormedUTF16Prefix('value', -1)).toBe('');
    expect(wellFormedUTF16Prefix('value', 1.5)).toBe('');
  });
});
