/**
 * Safe formula evaluator for formula custom fields. No eval / Function: a small tokenizer,
 * a recursive-descent parser to an AST, and a tree-walking interpreter.
 *
 * Syntax
 *   numbers 1, 2.5 · strings "text" · TRUE / FALSE
 *   + - * / %  (unary -), parentheses, comparisons = == != <> < <= > >=, & (string concat)
 *   field refs {Field name} (case-insensitive) and built-ins {due_date} {start_date} {time_estimate}
 *   functions IF(c, a, b) ROUND(x[, digits]) MIN(...) MAX(...) ABS(x) DAYS(end, start)
 *             AND(...) OR(...) NOT(x) TODAY()
 *
 * Empty values (null) count as 0 in arithmetic. Division by zero, or any runtime error, yields null.
 * Dates are ISO strings (or epoch ms numbers); DAYS returns whole/fractional days between them.
 */

export type FormulaValue = number | string | boolean | null;

export class FormulaError extends Error {}

type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'ref'; name: string }
  | { k: 'neg'; e: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'call'; fn: string; args: Node[] };

type Tok = { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'ref'; v: string } | { t: 'id'; v: string } | { t: 'op'; v: string };

export const FORMULA_BUILTINS = ['due_date', 'start_date', 'time_estimate'] as const;
export const FORMULA_FUNCTIONS = ['IF', 'ROUND', 'MIN', 'MAX', 'ABS', 'DAYS', 'AND', 'OR', 'NOT', 'TODAY'] as const;
const MAX_LEN = 2000;
const MAX_DEPTH = 64;
const DAY_MS = 86_400_000;

function tokenize(src: string): Tok[] {
  if (src.length > MAX_LEN) throw new FormulaError('Formula is too long');
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new FormulaError(`Unexpected "${c}"`);
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) j++;
        s += src[j++];
      }
      if (j >= src.length) throw new FormulaError('Unterminated string');
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (c === '{') {
      const j = src.indexOf('}', i);
      if (j < 0) throw new FormulaError('Missing "}" after field reference');
      const name = src.slice(i + 1, j).trim();
      if (!name) throw new FormulaError('Empty field reference');
      out.push({ t: 'ref', v: name });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0].toUpperCase() });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '!=', '<>', '==', '&&', '||'].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/%()<>=,&'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    throw new FormulaError(`Unexpected "${c}"`);
  }
  return out;
}

/** Parse a formula to an AST; throws FormulaError with a readable message. */
export function parseFormula(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  let depth = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new FormulaError(`Expected "${v}"`);
    p++;
  };
  const enter = () => { if (++depth > MAX_DEPTH) throw new FormulaError('Formula is nested too deeply'); };

  const binary = (ops: string[], next: () => Node) => (): Node => {
    let a = next();
    while (peek()?.t === 'op' && ops.includes(peek()!.v as string)) {
      const op = (toks[p++] as { v: string }).v;
      a = { k: 'bin', op, a, b: next() };
    }
    return a;
  };
  const primary = (): Node => {
    const t = toks[p++];
    if (!t) throw new FormulaError('Unexpected end of formula');
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 'ref') return { k: 'ref', name: t.v };
    if (t.t === 'id') {
      if (t.v === 'TRUE' || t.v === 'FALSE') return { k: 'bool', v: t.v === 'TRUE' };
      if (!(FORMULA_FUNCTIONS as readonly string[]).includes(t.v)) throw new FormulaError(`Unknown function ${t.v}`);
      expect('(');
      const args: Node[] = [];
      enter();
      if (!isOp(')')) {
        args.push(expr());
        while (isOp(',')) { p++; args.push(expr()); }
      }
      depth--;
      expect(')');
      checkArity(t.v, args.length);
      return { k: 'call', fn: t.v, args };
    }
    if (t.v === '(') {
      enter();
      const e = expr();
      depth--;
      expect(')');
      return e;
    }
    if (t.v === '-') { enter(); const e = primary(); depth--; return { k: 'neg', e }; }
    if (t.v === '+') return primary();
    throw new FormulaError(`Unexpected "${t.v}"`);
  };
  const mul = binary(['*', '/', '%'], primary);
  const add = binary(['+', '-', '&'], mul);
  const cmp = binary(['<', '<=', '>', '>=', '=', '==', '!=', '<>'], add);
  const and = binary(['&&'], cmp);
  const expr: () => Node = binary(['||'], and);

  const root = expr();
  if (p < toks.length) throw new FormulaError(`Unexpected "${(toks[p] as { v: unknown }).v}"`);
  return root;
}

function checkArity(fn: string, n: number) {
  const ranges: Record<string, [number, number]> = {
    IF: [2, 3], ROUND: [1, 2], MIN: [1, 100], MAX: [1, 100], ABS: [1, 1], DAYS: [2, 2],
    AND: [1, 100], OR: [1, 100], NOT: [1, 1], TODAY: [0, 0],
  };
  const [lo, hi] = ranges[fn];
  if (n < lo || n > hi) throw new FormulaError(lo === hi ? `${fn} takes ${lo} argument${lo === 1 ? '' : 's'}` : `${fn} takes ${lo}–${hi} arguments`);
}

/** Field names referenced by `{…}` (excluding built-ins), as written. */
export function formulaRefs(src: string): string[] {
  const out = new Set<string>();
  const walk = (n: Node) => {
    if (n.k === 'ref') { if (!(FORMULA_BUILTINS as readonly string[]).includes(n.name.toLowerCase())) out.add(n.name); }
    else if (n.k === 'neg') walk(n.e);
    else if (n.k === 'bin') { walk(n.a); walk(n.b); }
    else if (n.k === 'call') n.args.forEach(walk);
  };
  walk(parseFormula(src));
  return [...out];
}

/**
 * Validate a formula. `knownFields` (names) enables "unknown field" checks.
 * Returns an error message, or null when valid.
 */
export function validateFormula(src: string, knownFields?: string[]): string | null {
  try {
    const refs = formulaRefs(src);
    if (knownFields) {
      const known = new Set(knownFields.map((f) => f.toLowerCase()));
      const missing = refs.find((r) => !known.has(r.toLowerCase()));
      if (missing) return `Unknown field {${missing}}`;
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Invalid formula';
  }
}

export interface FormulaContext {
  /** Resolve `{name}` (already lower-cased); return undefined for an unknown name. */
  resolve: (name: string) => unknown;
  now?: Date;
}

const toNum = (v: unknown): number => {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
    const d = Date.parse(v);
    if (!Number.isNaN(d)) return d;
  }
  throw new FormulaError('Not a number');
};
const toDateMs = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    const d = Date.parse(v);
    return Number.isNaN(d) ? null : d;
  }
  return null;
};
const truthy = (v: unknown) => !(v == null || v === false || v === 0 || v === '');
const norm = (v: unknown): FormulaValue => {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.length;
  return null;
};

function evalNode(n: Node, ctx: FormulaContext): FormulaValue {
  switch (n.k) {
    case 'num': case 'str': case 'bool': return n.v;
    case 'ref': {
      const v = ctx.resolve(n.name.toLowerCase());
      if (v === undefined) throw new FormulaError(`Unknown field {${n.name}}`);
      return norm(v);
    }
    case 'neg': return -toNum(evalNode(n.e, ctx));
    case 'bin': {
      if (n.op === '&&') return truthy(evalNode(n.a, ctx)) && truthy(evalNode(n.b, ctx));
      if (n.op === '||') return truthy(evalNode(n.a, ctx)) || truthy(evalNode(n.b, ctx));
      const a = evalNode(n.a, ctx);
      const b = evalNode(n.b, ctx);
      switch (n.op) {
        case '+': return toNum(a) + toNum(b);
        case '-': return toNum(a) - toNum(b);
        case '*': return toNum(a) * toNum(b);
        case '/': { const d = toNum(b); return d === 0 ? null : toNum(a) / d; }
        case '%': { const d = toNum(b); return d === 0 ? null : toNum(a) % d; }
        case '&': return `${a ?? ''}${b ?? ''}`;
        case '=': case '==': return compare(a, b) === 0;
        case '!=': case '<>': return compare(a, b) !== 0;
        case '<': return compare(a, b) < 0;
        case '<=': return compare(a, b) <= 0;
        case '>': return compare(a, b) > 0;
        case '>=': return compare(a, b) >= 0;
      }
      throw new FormulaError(`Unknown operator ${n.op}`);
    }
    case 'call': {
      const args = n.args;
      const ev = (i: number) => evalNode(args[i], ctx);
      switch (n.fn) {
        case 'IF': return truthy(ev(0)) ? ev(1) : args.length > 2 ? ev(2) : null;
        case 'ROUND': {
          const digits = args.length > 1 ? Math.max(0, Math.min(10, Math.trunc(toNum(ev(1))))) : 0;
          const f = 10 ** digits;
          return Math.round(toNum(ev(0)) * f) / f;
        }
        case 'MIN': return Math.min(...args.map((_, i) => toNum(ev(i))));
        case 'MAX': return Math.max(...args.map((_, i) => toNum(ev(i))));
        case 'ABS': return Math.abs(toNum(ev(0)));
        case 'DAYS': {
          const a = toDateMs(ev(0));
          const b = toDateMs(ev(1));
          if (a == null || b == null) return null;
          return Math.round(((a - b) / DAY_MS) * 100) / 100;
        }
        case 'AND': return args.every((_, i) => truthy(ev(i)));
        case 'OR': return args.some((_, i) => truthy(ev(i)));
        case 'NOT': return !truthy(ev(0));
        case 'TODAY': {
          const d = new Date(ctx.now ?? Date.now());
          d.setUTCHours(0, 0, 0, 0);
          return d.toISOString();
        }
      }
      throw new FormulaError(`Unknown function ${n.fn}`);
    }
  }
}

function compare(a: FormulaValue, b: FormulaValue): number {
  if (typeof a === 'string' && typeof b === 'string') {
    const da = Date.parse(a);
    const db = Date.parse(b);
    if (!Number.isNaN(da) && !Number.isNaN(db) && /\d{4}-\d{2}-\d{2}/.test(a) && /\d{4}-\d{2}-\d{2}/.test(b)) return da - db;
    return a.localeCompare(b);
  }
  if (a == null && b == null) return 0;
  try {
    return toNum(a) - toNum(b);
  } catch {
    return String(a ?? '').localeCompare(String(b ?? ''));
  }
}

/** Parse + evaluate. Returns null on any error (bad syntax, unknown field, type error). */
export function evaluateFormula(src: string, ctx: FormulaContext): FormulaValue {
  try {
    return evalNode(parseFormula(src), ctx);
  } catch {
    return null;
  }
}

/** Like evaluateFormula but throws FormulaError (for previews / validation with sample data). */
export function evaluateFormulaStrict(src: string, ctx: FormulaContext): FormulaValue {
  return evalNode(parseFormula(src), ctx);
}

/** Convenience: resolver over a plain record of name → value (names matched case-insensitively). */
export function recordResolver(values: Record<string, unknown>): FormulaContext['resolve'] {
  const m = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  return (name) => (m.has(name) ? (m.get(name) ?? null) : undefined);
}
