/**
 * formula.js — the formula language of a salary structure. (TM/CF_HRMS_HIRING_SPEC.md §25.2.)
 *
 * PURE AND SAFE. A formula is read by a small tokenizer and a recursive-descent
 * parser into a tree, and the tree is walked. Nothing is ever handed to `eval`,
 * `Function` or a regular-expression replace-and-run: a formula can only do what
 * this file knows how to do, and anything else is a plain sentence back.
 *
 * WHAT A FORMULA MAY SAY
 *   numbers           40   1600   0.5          (no thousands commas: write 15000)
 *   percent           40%                       = 0.40
 *   of                40% of CTC                = 40% × CTC ("of" is a multiplication)
 *   + − × ÷           + - * /  and also × ÷ − as typed in Word
 *   parentheses       (BASIC + DA) * 12%
 *   min, max          min(BASIC, 15000)   max(a, b, c)   — two or more values
 *   round             round(x) to the rupee · round(x, 2) to paise · round(x, -2) to the hundred
 *   CTC               the MONTHLY cost to company (annual ÷ 12)
 *   CTC_ANNUAL        the annual cost to company
 *   PF_CEILING        the PF wage ceiling in force (statutory settings): min(BASIC, PF_CEILING)
 *   ESI_CEILING       the ESI coverage ceiling in force
 *   a component code  BASIC, HRA, DA … — the monthly amount of that line of the same structure
 *   balance           the whole formula, alone: what is left of CTC after every other line
 *                     that is part of CTC (earnings, employer contributions, reimbursements)
 *
 * Codes and names are not case sensitive. A formula is at most 300 characters.
 *
 * A STRUCTURE IS EVALUATED AS A WHOLE (`evaluateLines`): each line may use the
 * others, so the lines are ordered by what they use; a loop (BASIC uses HRA and
 * HRA uses BASIC) is named in words, with the path. An override (a fixed amount
 * for one person) replaces that line's formula, and the lines using it see the
 * override.
 */

export const MAX_FORMULA_LENGTH = 300;
const MAX_TOKENS = 200;
const MAX_DEPTH = 25;
export const FUNCTIONS = ['min', 'max', 'round'];
/** No line of a month is ₹1,000 crore or more: a formula that gives that is a mistake (and would not fit the database). */
export const MAX_LINE_AMOUNT = 1e10;
const TOO_LARGE = 'The formula gives an amount of ₹1,000 crore or more a month. Check it: a line of a salary is never that large.';
export const CTC = 'CTC';
export const CTC_ANNUAL = 'CTC_ANNUAL';
export const BALANCE = 'balance';
/** Names a formula may use besides component codes. PF_CEILING / ESI_CEILING come from the statutory settings of the day. */
export const VARIABLES = [CTC, CTC_ANNUAL, 'PF_CEILING', 'ESI_CEILING'];

export class FormulaError extends Error {
  constructor(message, { at = null } = {}) {
    super(message);
    this.name = 'FormulaError';
    this.at = at;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * Reading: text -> tokens -> tree
 * ══════════════════════════════════════════════════════════════════════════ */

const OPS = { '+': '+', '-': '-', '−': '-', '–': '-', '*': '*', '×': '*', '/': '/', '÷': '/' };

function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '.' && !/[0-9]/.test(text[i + 1] ?? '')) throw new FormulaError('“.” cannot be used in a formula, except as the decimal point of a number.', { at: i });
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < text.length && /[0-9.]/.test(text[j])) j += 1;
      const raw = text.slice(i, j);
      if (!/^(\d+(\.\d+)?|\.\d+)$/.test(raw)) throw new FormulaError(`“${raw}” is not a number.`, { at: i });
      tokens.push({ t: 'num', v: Number(raw), at: i });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j += 1;
      const word = text.slice(i, j);
      if (word.toLowerCase() === 'of') tokens.push({ t: 'op', v: '*', of: true, at: i });
      else tokens.push({ t: 'id', v: word, at: i });
      i = j;
      continue;
    }
    if (Object.hasOwn(OPS, ch)) { tokens.push({ t: 'op', v: OPS[ch], at: i }); i += 1; continue; }
    if (ch === '%') { tokens.push({ t: 'pct', at: i }); i += 1; continue; }
    if (ch === '(' || ch === ')' || ch === ',') { tokens.push({ t: ch, at: i }); i += 1; continue; }
    if (ch === '₹') { i += 1; continue; } // "₹1600" reads as 1600
    throw new FormulaError(`“${ch}” cannot be used in a formula. Use numbers, %, + − × ÷, brackets, min, max, round, CTC and component codes.`, { at: i });
  }
  if (tokens.length > MAX_TOKENS) throw new FormulaError('This formula is too long. Split it over two components.');
  return tokens;
}

/**
 * Parses a formula into a tree. Throws FormulaError in words.
 * Nodes: { k: 'num', v } · { k: 'ref', name } · { k: 'neg', a } · { k: 'pct', a }
 *        { k: 'bin', op, a, b } · { k: 'fn', name, args }
 */
export function parse(text) {
  const src = String(text ?? '').trim();
  if (!src) throw new FormulaError('The formula is empty. Type a number, a percentage of CTC or of another component, or “balance”.');
  if (src.length > MAX_FORMULA_LENGTH) throw new FormulaError(`A formula is at most ${MAX_FORMULA_LENGTH} characters.`);
  const tokens = tokenize(src);
  let p = 0;
  let depth = 0;
  const peek = () => tokens[p];
  const next = () => tokens[p++];
  const deeper = () => { depth += 1; if (depth > MAX_DEPTH) throw new FormulaError('This formula has too many brackets inside each other.'); };

  function primary() {
    const tok = next();
    if (!tok) throw new FormulaError('The formula stops too early: something is missing at the end.');
    if (tok.t === 'num') return { k: 'num', v: tok.v };
    if (tok.t === '(') {
      deeper();
      const e = expr();
      depth -= 1;
      if (peek()?.t !== ')') throw new FormulaError('A bracket is opened and not closed.');
      next();
      return e;
    }
    if (tok.t === 'id') {
      if (peek()?.t === '(') {
        const name = tok.v.toLowerCase();
        if (!FUNCTIONS.includes(name)) throw new FormulaError(`“${tok.v}” is not something a formula can use. A formula can use min, max and round.`);
        next();
        deeper();
        const args = [];
        if (peek()?.t !== ')') {
          args.push(expr());
          while (peek()?.t === ',') { next(); args.push(expr()); }
        }
        depth -= 1;
        if (peek()?.t !== ')') throw new FormulaError(`${name}( is opened and not closed.`);
        next();
        if ((name === 'min' || name === 'max') && args.length < 2) throw new FormulaError(`${name} needs two or more values, as in ${name}(BASIC, 15000).`);
        if (name === 'round' && (args.length < 1 || args.length > 2)) throw new FormulaError('round takes the value, and optionally the decimals: round(x) or round(x, 2).');
        return { k: 'fn', name, args };
      }
      if (tok.v.toLowerCase() === BALANCE) throw new FormulaError('“balance” is a whole formula on its own: what is left of CTC after the other lines. It cannot be part of a sum.');
      return { k: 'ref', name: tok.v.toUpperCase() };
    }
    if (tok.t === ')') throw new FormulaError('A bracket is closed that was never opened, or something is missing before it.');
    if (tok.t === ',') throw new FormulaError('A comma is only used between the values of min, max or round. Write numbers without commas: 15000, not 15,000.');
    if (tok.t === 'pct') throw new FormulaError('% comes after a number, as in 40%.');
    throw new FormulaError(`Something is missing before “${tok.of ? 'of' : tok.v}”.`);
  }

  function postfix() {
    let node = primary();
    while (peek()?.t === 'pct') { next(); node = { k: 'pct', a: node }; }
    return node;
  }

  function unary() {
    const tok = peek();
    if (tok?.t === 'op' && (tok.v === '-' || tok.v === '+') && !tok.of) {
      next();
      deeper();
      const a = unary();
      depth -= 1;
      return tok.v === '-' ? { k: 'neg', a } : a;
    }
    return postfix();
  }

  function term() {
    let node = unary();
    while (peek()?.t === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = next().v;
      node = { k: 'bin', op, a: node, b: unary() };
    }
    return node;
  }

  function expr() {
    let node = term();
    while (peek()?.t === 'op' && (peek().v === '+' || peek().v === '-') && !peek().of) {
      const op = next().v;
      node = { k: 'bin', op, a: node, b: term() };
    }
    return node;
  }

  if (src.toLowerCase() === BALANCE) return { k: 'balance' };
  const tree = expr();
  if (p < tokens.length) {
    const tok = tokens[p];
    if (tok.t === ')') throw new FormulaError('A bracket is closed that was never opened.');
    if (tok.t === ',') throw new FormulaError('A comma is only used between the values of min, max or round. Write numbers without commas: 15000, not 15,000.');
    if (tok.t === 'num' || tok.t === 'id' || tok.t === '(') throw new FormulaError(`An operator is missing before “${tok.t === 'num' ? tok.v : tok.t === 'id' ? tok.v : '('}”: write + − × ÷ or “of” between two values.`);
    throw new FormulaError('The formula has something extra at the end.');
  }
  return tree;
}

/** The names a tree uses (upper case), in order of first use. */
export function refsOf(tree) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (n.k === 'ref') { if (!out.includes(n.name)) out.push(n.name); return; }
    if (n.k === 'neg' || n.k === 'pct') walk(n.a);
    else if (n.k === 'bin') { walk(n.a); walk(n.b); } else if (n.k === 'fn') n.args.forEach(walk);
  };
  walk(tree);
  return out;
}

const roundTo = (x, digits = 0) => {
  const f = 10 ** digits;
  // Half away from zero, on the decimal the person sees (12.345 -> 12.35), not on the float.
  const v = Math.round((Math.abs(x) * f) + 1e-9) / f;
  return x < 0 ? -v : v;
};
export const money = (x) => roundTo(Number(x) || 0, 2);
export const rupee = (x) => roundTo(Number(x) || 0, 0);

/** Walks a tree. `values` maps an upper-case name to a number. Throws FormulaError in words. */
export function evaluate(tree, values = {}) {
  const ev = (n) => {
    switch (n.k) {
      case 'num': return n.v;
      case 'ref': {
        if (!Object.hasOwn(values, n.name)) throw new FormulaError(VARIABLES.includes(n.name) ? `${n.name} is not known here: the statutory settings give no value for that day.` : `${n.name} is not a component of this structure, nor CTC.`);
        return Number(values[n.name]) || 0;
      }
      case 'neg': return -ev(n.a);
      case 'pct': return ev(n.a) / 100;
      case 'bin': {
        const a = ev(n.a);
        const b = ev(n.b);
        if (n.op === '+') return a + b;
        if (n.op === '-') return a - b;
        if (n.op === '*') return a * b;
        if (b === 0) throw new FormulaError('The formula divides by zero.');
        return a / b;
      }
      case 'fn': {
        const xs = n.args.map(ev);
        if (n.name === 'min') return Math.min(...xs);
        if (n.name === 'max') return Math.max(...xs);
        const digits = xs.length > 1 ? xs[1] : 0;
        if (!Number.isInteger(digits) || digits < -5 || digits > 4) throw new FormulaError('round’s second value is the decimals, a whole number from -5 to 4: round(x, 2) to paise, round(x, -2) to the hundred.');
        return roundTo(xs[0], digits);
      }
      case 'balance': throw new FormulaError('“balance” is worked out from the other lines, not on its own.');
      default: throw new FormulaError('This formula cannot be read.');
    }
  };
  const v = ev(tree);
  if (!Number.isFinite(v)) throw new FormulaError('The formula does not give a number.');
  if (Math.abs(v) >= MAX_LINE_AMOUNT) throw new FormulaError(TOO_LARGE);
  return v;
}

/** Parse + evaluate in one go, for a quick sum: evaluateText('40% of CTC', { CTC: 50000 }) = 20000. */
export const evaluateText = (text, values = {}) => evaluate(parse(text), values);

/* ══════════════════════════════════════════════════════════════════════════
 * A whole structure
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Checks a structure's formulas, without numbers: each parses, uses only known
 * names, at most one balance, no loop. -> { problems: string[], order: code[] }
 *
 * @param lines [{ code, name, formula, inCtc }]   inCtc: counts toward CTC (balance takes it away)
 */
export function checkLines(lines) {
  const problems = [];
  const byCode = new Map();
  for (const l of lines) {
    const code = String(l.code ?? '').toUpperCase();
    if (byCode.has(code)) problems.push(`${l.name ?? code} is in the structure twice. Keep one line for it.`);
    byCode.set(code, l);
  }
  const trees = new Map();
  const deps = new Map();
  const balances = [];
  for (const l of lines) {
    const code = String(l.code).toUpperCase();
    try {
      const tree = parse(l.formula);
      trees.set(code, tree);
      if (tree.k === 'balance') {
        balances.push(code);
        if (!l.inCtc) problems.push(`${l.name ?? code}: “balance” is for a line that is part of CTC (an earning, an employer contribution or a reimbursement), not a deduction.`);
        deps.set(code, lines.filter((o) => o.inCtc && String(o.code).toUpperCase() !== code).map((o) => String(o.code).toUpperCase()));
        continue;
      }
      const refs = refsOf(tree);
      for (const r of refs) {
        if (VARIABLES.includes(r)) continue;
        if (!byCode.has(r)) problems.push(`${l.name ?? code}: ${r} is not a line of this structure. A formula can use CTC, CTC_ANNUAL, PF_CEILING, ESI_CEILING and the codes of the other lines (${[...byCode.keys()].filter((k) => k !== code).join(', ') || 'none yet'}).`);
      }
      deps.set(code, refs.filter((r) => byCode.has(r)));
    } catch (e) {
      if (!(e instanceof FormulaError)) throw e;
      problems.push(`${l.name ?? code}: ${e.message}`);
      deps.set(code, []);
    }
  }
  if (balances.length > 1) problems.push(`Only one line can be the balance; ${balances.join(' and ')} both are.`);

  // Order by what each line uses; a loop is named with its path.
  const order = [];
  const state = new Map(); // 1 = visiting, 2 = done
  const loops = [];
  const visit = (code, path) => {
    if (state.get(code) === 2) return;
    if (state.get(code) === 1) {
      const from = path.indexOf(code);
      loops.push([...path.slice(from), code]);
      return;
    }
    state.set(code, 1);
    for (const d of deps.get(code) ?? []) visit(d, [...path, code]);
    state.set(code, 2);
    order.push(code);
  };
  for (const code of byCode.keys()) visit(code, []);
  const seen = new Set();
  for (const loop of loops) {
    const key = [...loop.slice(0, -1)].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const named = loop.map((c) => c);
    const viaBalance = loop.some((c) => trees.get(c)?.k === 'balance');
    problems.push(`These lines depend on each other in a loop: ${named.join(' → ')}.${viaBalance ? ' The balance line uses every other line of CTC, so no line may use it.' : ' Change one of them so it does not use the other.'}`);
  }
  return { problems, order, trees };
}

/**
 * Evaluates a structure for one CTC. Every line's monthly amount is rounded to
 * the rupee; the balance line takes what is left, so the lines of CTC add up to
 * the monthly CTC exactly (to the paise).
 *
 * @param lines      [{ code, name, formula, inCtc }]
 * @param annualCtc  number
 * @param overrides  { CODE: monthly amount } — replaces that line's formula
 * @param vars       { PF_CEILING, ESI_CEILING } of the day
 * @returns {{ ok, problems, warnings, monthlyCtc, amounts: { CODE: number }, lines: [{ code, name, formula, amount, overridden, basis }] }}
 */
export function evaluateLines(lines, annualCtc, overrides = {}, vars = {}) {
  const { problems, order, trees } = checkLines(lines);
  const monthlyCtc = money(Number(annualCtc) / 12);
  const result = { ok: false, problems, warnings: [], monthlyCtc, amounts: {}, lines: [] };
  if (!Number.isFinite(Number(annualCtc)) || Number(annualCtc) < 0) {
    problems.push('The CTC must be a number of rupees, zero or more.');
  }
  if (problems.length) return result;
  const over = Object.fromEntries(Object.entries(overrides ?? {}).map(([k, v]) => [String(k).toUpperCase(), v]));
  const values = { ...Object.fromEntries(Object.entries(vars ?? {}).filter(([k, v]) => VARIABLES.includes(k) && v != null)), [CTC]: monthlyCtc, [CTC_ANNUAL]: Number(annualCtc) };
  const byCode = new Map(lines.map((l) => [String(l.code).toUpperCase(), l]));
  for (const code of order) {
    const l = byCode.get(code);
    const tree = trees.get(code);
    if (over[code] != null && over[code] !== '') {
      values[code] = money(over[code]);
      if (!(Math.abs(values[code]) < MAX_LINE_AMOUNT)) { problems.push(`${l.name ?? code}: the amount set for this person is ₹1,000 crore or more a month. Check it.`); values[code] = 0; }
      continue;
    }
    try {
      if (tree.k === 'balance') {
        const others = lines.filter((o) => o.inCtc && String(o.code).toUpperCase() !== code).reduce((s, o) => s + (values[String(o.code).toUpperCase()] ?? 0), 0);
        values[code] = money(monthlyCtc - others);
        if (!(Math.abs(values[code]) < MAX_LINE_AMOUNT)) throw new FormulaError(TOO_LARGE);
        if (values[code] < 0) result.warnings.push(`The other lines add up to more than the monthly CTC: ${l.name ?? code} would be ${values[code].toLocaleString('en-IN')}. Raise the CTC or lower another line.`);
      } else {
        values[code] = rupee(evaluate(tree, values));
      }
    } catch (e) {
      if (!(e instanceof FormulaError)) throw e;
      problems.push(`${l.name ?? code}: ${e.message}`);
      values[code] = 0;
    }
  }
  if (problems.length) return result;
  result.ok = true;
  result.amounts = Object.fromEntries(lines.map((l) => [String(l.code).toUpperCase(), values[String(l.code).toUpperCase()]]));
  result.lines = lines.map((l) => {
    const code = String(l.code).toUpperCase();
    const overridden = over[code] != null && over[code] !== '';
    return { code, name: l.name, formula: l.formula, amount: values[code], overridden, inCtc: Boolean(l.inCtc) };
  });
  // CTC lines in sum, for the screen: what the structure gives back against what was asked.
  const inCtc = lines.filter((l) => l.inCtc).reduce((s, l) => s + values[String(l.code).toUpperCase()], 0);
  result.ctcLinesTotal = money(inCtc);
  if (!lines.some((l) => trees.get(String(l.code).toUpperCase())?.k === 'balance') && Math.abs(inCtc - monthlyCtc) >= 1) {
    result.warnings.push(`The lines of CTC add up to ${money(inCtc).toLocaleString('en-IN')} a month, not the ${monthlyCtc.toLocaleString('en-IN')} of the CTC. Make one line “balance” to take up the difference.`);
  }
  return result;
}

export default { parse, evaluate, evaluateText, refsOf, checkLines, evaluateLines, money, rupee, FormulaError, FUNCTIONS, MAX_FORMULA_LENGTH };
