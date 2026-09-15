import {
  encodeSegment,
  decodeSegment,
  outgoingCompositeKey,
  parseOutgoingCompositeKey,
} from '../outgoingCompositeKey';

describe('Injective Composite Key Encoding & Decoding', () => {
  it('preserves standard alphanumeric and hyphen characters as-is', () => {
    expect(encodeSegment('company-a')).toBe('company-a');
    expect(encodeSegment('well-123')).toBe('well-123');
    expect(outgoingCompositeKey('company-a', 'well-123')).toBe('response_company-a__well-123');
  });

  it('escapes RTDB forbidden characters (. # $ / [ ]) reversibly', () => {
    const raw = 'well.#$[test]/1';
    const encoded = encodeSegment(raw);
    expect(encoded).not.toMatch(/[.#$\[\]/]/);
    expect(decodeSegment(encoded)).toBe(raw);
  });

  it('proves collision resistance between distinct raw IDs that would collide under simple character replacement', () => {
    // Under replace(/[.#$\[\]/]/g, '_'), 'a.b', 'a_b', 'a/b' all collapse to 'a_b'
    const encDot = encodeSegment('a.b');
    const encUnderscore = encodeSegment('a_b');
    const encSlash = encodeSegment('a/b');
    const encHyphen = encodeSegment('a-b');

    const set = new Set([encDot, encUnderscore, encSlash, encHyphen]);
    expect(set.size).toBe(4);
    expect(encDot).toBe('a~2eb');
    expect(encUnderscore).toBe('a~5fb');
    expect(encSlash).toBe('a~2fb');
    expect(encHyphen).toBe('a-b');

    expect(decodeSegment(encDot)).toBe('a.b');
    expect(decodeSegment(encUnderscore)).toBe('a_b');
    expect(decodeSegment(encSlash)).toBe('a/b');
    expect(decodeSegment(encHyphen)).toBe('a-b');
  });

  it('prevents delimiter collisions: __ inside segment does not break parsing', () => {
    const company = 'tenant__alpha';
    const well = 'well__beta';
    const key = outgoingCompositeKey(company, well);
    expect(key).toBe('response_tenant~5f~5falpha__well~5f~5fbeta');

    const parsed = parseOutgoingCompositeKey(key);
    expect(parsed).toEqual({ companyId: company, wellId: well });
  });

  it('handles Unicode characters byte-for-byte and reversibly', () => {
    const company = '公司-alpha';
    const well = '井#1-Café';
    const key = outgoingCompositeKey(company, well);
    expect(key).not.toMatch(/[.#$\[\]/]/);

    const parsed = parseOutgoingCompositeKey(key);
    expect(parsed).toEqual({ companyId: company, wellId: well });
  });

  it('accepts the exact largest possible RTDB child key (768 UTF-8 bytes)', () => {
    // Prefix 'response_' (9 bytes) + 'c' (1 byte) + '__' (2 bytes) = 12 bytes overhead.
    // 768 - 12 = 756 bytes for wellId.
    const company = 'c';
    const well = 'w'.repeat(756);
    const key = outgoingCompositeKey(company, well);
    expect(Buffer.byteLength(key, 'utf8')).toBe(768);
    expect(key.length).toBe(768);
    const parsed = parseOutgoingCompositeKey(key);
    expect(parsed).toEqual({ companyId: company, wellId: well });
  });

  it('fails closed when final composite key is exactly one byte beyond the limit (769 UTF-8 bytes)', () => {
    // 768 - 12 + 1 = 757 bytes for wellId -> 769 total bytes
    const company = 'c';
    const well = 'w'.repeat(757);
    expect(() => outgoingCompositeKey(company, well)).toThrow(
      /exceeds Firebase RTDB maximum key limit of 768 UTF-8 bytes \(actual: 769 bytes\)/
    );
  });

  it('fails closed for two long forbidden-character IDs that expand beyond 768 bytes', () => {
    // '#' expands to '~23' (3 bytes).
    // 128 '#' chars expand to 384 bytes each.
    // 'response_' (9) + 384 + '__' (2) + 384 = 779 bytes > 768.
    const longForbiddenCompany = '#'.repeat(128);
    const longForbiddenWell = '#'.repeat(128);
    expect(() => outgoingCompositeKey(longForbiddenCompany, longForbiddenWell)).toThrow(
      /exceeds Firebase RTDB maximum key limit of 768 UTF-8 bytes/
    );
  });

  it('handles multibyte Unicode and emoji safely, failing closed if expansion exceeds limit', () => {
    const emojiCompany = '🛢️-corp'; // multi-byte UTF-8 + variation selector
    const emojiWell = 'well-🌊-123';
    const key = outgoingCompositeKey(emojiCompany, emojiWell);
    expect(key).not.toMatch(/[.#$\[\]/]/);
    const parsed = parseOutgoingCompositeKey(key);
    expect(parsed).toEqual({ companyId: emojiCompany, wellId: emojiWell });

    // 128 4-byte characters expand to 128 * 4 * 3 = 1536 bytes -> must fail closed
    const hugeEmoji = '🛢'.repeat(128);
    expect(() => outgoingCompositeKey(hugeEmoji, 'well-1')).toThrow(
      /exceeds Firebase RTDB maximum key limit of 768 UTF-8 bytes/
    );
  });

  it('produces strictly deterministic repeat encoding across iterations', () => {
    const company = 'test-co-alpha';
    const well = 'well-beta-456';
    const first = outgoingCompositeKey(company, well);
    for (let i = 0; i < 100; i++) {
      expect(outgoingCompositeKey(company, well)).toBe(first);
    }
  });

  it('rejects empty or whitespace-only inputs', () => {
    expect(() => encodeSegment('')).toThrow(/non-empty/);
    expect(() => encodeSegment('   ')).toThrow(/non-empty/);
    expect(() => outgoingCompositeKey('', 'well-1')).toThrow();
    expect(() => outgoingCompositeKey('company-1', '')).toThrow();
  });
});
