import { describe, expect, it } from 'vitest';
import { evaluateFormula, evaluateFormulaStrict, formulaRefs, parseFormula, recordResolver, validateFormula } from './formula';

const ev = (src: string, values: Record<string, unknown> = {}) => evaluateFormula(src, { resolve: recordResolver(values), now: new Date('2026-03-10T15:00:00Z') });

describe('formula evaluator', () => {
  it('does arithmetic with precedence and parentheses', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('10 / 4')).toBe(2.5);
    expect(ev('10 % 4')).toBe(2);
    expect(ev('-2 * 3')).toBe(-6);
    expect(ev('-(2 + 3)')).toBe(-5);
    expect(ev('2 - -3')).toBe(5);
    expect(ev('1.5e2')).toBe(150);
  });

  it('returns null for division by zero and errors', () => {
    expect(ev('1 / 0')).toBeNull();
    expect(ev('5 % 0')).toBeNull();
    expect(ev('1 +')).toBeNull();
    expect(ev('{missing} + 1')).toBeNull();
  });

  it('compares values', () => {
    expect(ev('3 > 2')).toBe(true);
    expect(ev('3 <= 2')).toBe(false);
    expect(ev('2 = 2')).toBe(true);
    expect(ev('2 == 2')).toBe(true);
    expect(ev('2 != 2')).toBe(false);
    expect(ev('2 <> 3')).toBe(true);
    expect(ev('"a" < "b"')).toBe(true);
  });

  it('supports IF, ROUND, MIN, MAX, ABS, AND, OR, NOT', () => {
    expect(ev('IF(1 > 2, "yes", "no")')).toBe('no');
    expect(ev('if(TRUE, 1)')).toBe(1);
    expect(ev('IF(FALSE, 1)')).toBeNull();
    expect(ev('ROUND(2.345, 2)')).toBe(2.35);
    expect(ev('ROUND(2.5)')).toBe(3);
    expect(ev('MIN(3, 1, 2)')).toBe(1);
    expect(ev('MAX(3, 1, 2)')).toBe(3);
    expect(ev('ABS(-4)')).toBe(4);
    expect(ev('AND(1, TRUE, 2 > 1)')).toBe(true);
    expect(ev('OR(0, FALSE)')).toBe(false);
    expect(ev('NOT(0)')).toBe(true);
    expect(ev('1 < 2 && 2 < 3')).toBe(true);
    expect(ev('1 > 2 || 2 > 3')).toBe(false);
  });

  it('resolves field references case-insensitively, empty as 0', () => {
    expect(ev('{Price} * {Qty}', { price: 2.5, qty: 4 })).toBe(10);
    expect(ev('{Price} + {Discount}', { price: 10, discount: null })).toBe(10);
    expect(ev('{ Unit cost } * 2', { 'unit cost': 3 })).toBe(6);
    expect(ev('{tags}', { tags: ['a', 'b'] })).toBe(2);
  });

  it('computes DAYS between dates and uses built-ins', () => {
    const vals = { due_date: '2026-03-15T00:00:00.000Z', start_date: '2026-03-10T00:00:00.000Z', time_estimate: 90 };
    expect(ev('DAYS({due_date}, {start_date})', vals)).toBe(5);
    expect(ev('DAYS({start_date}, {due_date})', vals)).toBe(-5);
    expect(ev('DAYS({due_date}, {start_date})', { ...vals, due_date: null })).toBeNull();
    expect(ev('{time_estimate} / 60', vals)).toBe(1.5);
    expect(ev('DAYS({due_date}, TODAY())', vals)).toBe(5);
    expect(ev('{due_date} > {start_date}', vals)).toBe(true);
  });

  it('concatenates strings with &', () => {
    expect(ev('"Total: " & 5')).toBe('Total: 5');
  });

  it('rejects anything that is not the grammar (no code execution)', () => {
    expect(() => parseFormula('constructor.constructor("return 1")()')).toThrow();
    expect(() => parseFormula('alert(1)')).toThrow(/Unknown function/);
    expect(() => parseFormula('1; 2')).toThrow();
    expect(() => parseFormula('{a')).toThrow(/Missing/);
    expect(() => parseFormula('ABS(1, 2)')).toThrow(/ABS takes 1 argument/);
    expect(() => parseFormula('(((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((1)))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))')).toThrow(/deeply/);
    expect(() => parseFormula('1+'.repeat(1500) + '1')).toThrow(/too long/);
  });

  it('lists refs and validates against known fields', () => {
    expect(formulaRefs('{A} + {b} * {due_date}')).toEqual(['A', 'b']);
    expect(validateFormula('{A} + 1', ['a'])).toBeNull();
    expect(validateFormula('{X} + 1', ['a'])).toBe('Unknown field {X}');
    expect(validateFormula('1 +')).toMatch(/end of formula/);
  });

  it('strict mode surfaces errors', () => {
    expect(() => evaluateFormulaStrict('{nope}', { resolve: recordResolver({}) })).toThrow(/Unknown field/);
  });
});
