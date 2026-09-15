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

  it('enforces length limit of 128 characters on raw segments', () => {
    const exact = 'x'.repeat(128);
    expect(decodeSegment(encodeSegment(exact))).toBe(exact);

    const over = 'x'.repeat(129);
    expect(() => encodeSegment(over)).toThrow(/maximum supported length/);
  });

  it('rejects empty or whitespace-only inputs', () => {
    expect(() => encodeSegment('')).toThrow(/non-empty/);
    expect(() => encodeSegment('   ')).toThrow(/non-empty/);
    expect(() => outgoingCompositeKey('', 'well-1')).toThrow();
    expect(() => outgoingCompositeKey('company-1', '')).toThrow();
  });
});
