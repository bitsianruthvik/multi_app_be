/**
 * formulaEngine.js — a small, safe arithmetic language for calculated specs.
 *
 * No eval, no Function(): an expression is tokenised, parsed into a tree, and
 * the tree is walked with a lookup for names. Anything outside the grammar is a
 * parse error when the formula is saved, not a surprise when a value is needed.
 *
 *   comparison := additive (( '<' | '<=' | '>' | '>=' | '=' | '==' | '!=' | '<>' ) additive)?
 *   additive   := term (( '+' | '-' ) term)*
 *   term       := unary (( '*' | '/' | '%' ) unary)*
 *   unary      := ( '-' | '+' ) unary | power
 *   power      := primary ( '^' unary )?
 *   primary    := NUMBER | NAME | NAME '(' args ')' | '(' comparison ')'
 *
 * NAME is a specification code (THICKNESS) or a dotted path. `children.WEIGHT`
 * is a roll-up term: it reads one BOM child at a time, and may only appear
 * inside a roll-up function —
 *   SUM(e)    Σ over the BOM lines of  line quantity × e(child)
 *   COUNT()   Σ line quantity — the number of child pieces
 *   COUNT(e)  Σ line quantity over the lines whose child has every value e reads
 *   AVG(e)    SUM(e) ÷ COUNT() — a per-piece average
 * Line quantity is per ONE parent, so a roll-up is per parent piece: a girder's
 * weight, not the order's. For SUM and AVG, a child without a value makes the
 * whole roll-up wait — a silent partial sum would read as a real weight.
 *
 * `item.X` and `machine.X` make a TIMING formula: minutes for a machine working
 * on an item — "item.CUT_LENGTH / machine.CUTTING_SPEED". One formula then gives
 * each machine its own time from its own specs.
 */

export class FormulaError extends Error {
  constructor(message, position = null) {
    super(position == null ? message : `${message} (at character ${position + 1})`);
    this.position = position;
  }
}

const FUNCTIONS = {
  MIN: { min: 1, max: Infinity, fn: (...a) => Math.min(...a) },
  MAX: { min: 1, max: Infinity, fn: (...a) => Math.max(...a) },
  ABS: { min: 1, max: 1, fn: Math.abs },
  SQRT: { min: 1, max: 1, fn: Math.sqrt },
  CEIL: { min: 1, max: 1, fn: Math.ceil },
  FLOOR: { min: 1, max: 1, fn: Math.floor },
  ROUND: { min: 1, max: 2, fn: (x, d = 0) => { const f = 10 ** Math.trunc(d); return Math.round(x * f) / f; } },
  IF: { min: 3, max: 3, lazy: true },
};
const ROLLUP_FUNCTIONS = new Set(['SUM', 'COUNT', 'AVG']);
const COMPARISONS = new Set(['<', '<=', '>', '>=', '=', '==', '!=', '<>']);

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) { tokens.push({ t: 'num', v: Number(num[0]), p: i }); i += num[0].length; continue; }
    const name = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i));
    if (name) { tokens.push({ t: 'name', v: name[0], p: i }); i += name[0].length; continue; }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '==', '!=', '<>'].includes(two)) { tokens.push({ t: 'op', v: two, p: i }); i += 2; continue; }
    if ('+-*/%^(),<>='.includes(ch)) { tokens.push({ t: 'op', v: ch, p: i }); i++; continue; }
    throw new FormulaError(`Unexpected "${ch}"`, i);
  }
  tokens.push({ t: 'end', p: src.length });
  return tokens;
}

function parseTokens(tokens) {
  let k = 0;
  const peek = () => tokens[k];
  const take = () => tokens[k++];
  const isOp = (v) => peek().t === 'op' && peek().v === v;
  const expect = (v) => {
    if (!isOp(v)) throw new FormulaError(`Expected "${v}"`, peek().p);
    return take();
  };

  function primary() {
    const tok = peek();
    if (tok.t === 'num') { take(); return { type: 'num', value: tok.v }; }
    if (tok.t === 'name') {
      take();
      if (isOp('(')) {
        take();
        const args = [];
        if (!isOp(')')) {
          args.push(comparison());
          while (isOp(',')) { take(); args.push(comparison()); }
        }
        expect(')');
        const fname = tok.v.toUpperCase();
        if (!FUNCTIONS[fname] && !ROLLUP_FUNCTIONS.has(fname)) throw new FormulaError(`Unknown function ${tok.v}`, tok.p);
        const spec = FUNCTIONS[fname];
        if (spec && (args.length < spec.min || args.length > spec.max)) {
          throw new FormulaError(`${fname} takes ${spec.min === spec.max ? spec.min : `${spec.min}+`} argument(s)`, tok.p);
        }
        return { type: 'call', name: fname, args };
      }
      return { type: 'ref', name: tok.v };
    }
    if (isOp('(')) { take(); const e = comparison(); expect(')'); return e; }
    throw new FormulaError(tok.t === 'end' ? 'The formula ends too early' : `Unexpected "${tok.v}"`, tok.p);
  }
  function power() {
    const base = primary();
    if (isOp('^')) { take(); return { type: 'bin', op: '^', left: base, right: unary() }; }
    return base;
  }
  function unary() {
    if (isOp('-')) { take(); return { type: 'neg', arg: unary() }; }
    if (isOp('+')) { take(); return unary(); }
    return power();
  }
  function term() {
    let left = unary();
    while (isOp('*') || isOp('/') || isOp('%')) { const op = take().v; left = { type: 'bin', op, left, right: unary() }; }
    return left;
  }
  function additive() {
    let left = term();
    while (isOp('+') || isOp('-')) { const op = take().v; left = { type: 'bin', op, left, right: term() }; }
    return left;
  }
  function comparison() {
    const left = additive();
    if (peek().t === 'op' && COMPARISONS.has(peek().v)) {
      const op = take().v;
      return { type: 'bin', op, left, right: additive() };
    }
    return left;
  }

  const ast = comparison();
  if (peek().t !== 'end') throw new FormulaError(`Unexpected "${peek().v}"`, peek().p);
  return ast;
}

function walk(ast, visit) {
  visit(ast);
  if (ast.type === 'bin') { walk(ast.left, visit); walk(ast.right, visit); }
  if (ast.type === 'neg') walk(ast.arg, visit);
  if (ast.type === 'call') ast.args.forEach((a) => walk(a, visit));
}

/**
 * Parses an expression. Returns { ast, references, rollupTerms, usesRollup,
 * itemRefs, machineRefs, usesContext, kind }:
 *   references   — plain names (spec codes) the formula reads from the same record
 *   rollupTerms  — names read from BOM children (children.X -> X)
 *   itemRefs     — item.X: the item being worked on (timing formulas)
 *   machineRefs  — machine.X: the machine doing it (timing formulas)
 *   kind         — 'value' (plain names or none), 'rollup' or 'timing'
 * A formula is one kind or another: in one that reads item. or machine. values
 * every name needs its prefix, and none can also roll up BOM children.
 */
export function parseFormula(expression) {
  if (typeof expression !== 'string' || !expression.trim()) throw new FormulaError('The formula is empty');
  const ast = parseTokens(tokenize(expression));
  const references = new Set();
  const rollupTerms = new Set();
  const itemRefs = new Set();
  const machineRefs = new Set();
  let usesRollupFunction = false;
  walk(ast, (n) => {
    if (n.type === 'ref') {
      const m = /^(children|item|machine)\.([A-Za-z_][A-Za-z0-9_]*)$/i.exec(n.name);
      if (m) ({ children: rollupTerms, item: itemRefs, machine: machineRefs }[m[1].toLowerCase()]).add(m[2].toUpperCase());
      else if (n.name.includes('.')) throw new FormulaError(`"${n.name}" is not a name this formula can read`);
      else references.add(n.name.toUpperCase());
    }
    if (n.type === 'call' && ROLLUP_FUNCTIONS.has(n.name)) usesRollupFunction = true;
  });
  checkRollupPlacement(ast, false);
  const usesRollup = usesRollupFunction || rollupTerms.size > 0;
  const usesContext = itemRefs.size > 0 || machineRefs.size > 0;
  if (usesContext && usesRollup) throw new FormulaError('A timing formula (item. / machine.) cannot also roll up BOM children');
  if (usesContext && references.size) {
    throw new FormulaError(`${[...references][0]} needs a prefix — in a formula that reads item. or machine. values, say item.${[...references][0]} or machine.${[...references][0]}`);
  }
  return {
    ast,
    references: [...references],
    rollupTerms: [...rollupTerms],
    usesRollup,
    itemRefs: [...itemRefs],
    machineRefs: [...machineRefs],
    usesContext,
    kind: usesRollup ? 'rollup' : usesContext ? 'timing' : 'value',
  };
}

const CONTEXT_REF = /^(item|machine)\.([A-Za-z_][A-Za-z0-9_]*)$/i;

const CHILD_REF = /^children\.([A-Za-z_][A-Za-z0-9_]*)$/i;
const childTerm = (name) => CHILD_REF.exec(name)?.[1].toUpperCase() ?? null;

/**
 * children.X only means something inside SUM / COUNT / AVG, one level deep —
 * outside one there is no single child to read it from. Checked when the
 * formula is saved, so the mistake is caught then and not when a value is due.
 */
function checkRollupPlacement(n, inside) {
  if (n.type === 'ref' && childTerm(n.name) && !inside) {
    throw new FormulaError(`${n.name} reads one BOM child at a time — put it inside SUM, COUNT or AVG`);
  }
  if (n.type === 'call' && ROLLUP_FUNCTIONS.has(n.name)) {
    if (inside) throw new FormulaError(`${n.name} cannot sit inside another roll-up`);
    const allowed = n.name === 'COUNT' ? [0, 1] : [1];
    if (!allowed.includes(n.args.length)) {
      throw new FormulaError(n.name === 'COUNT' ? 'COUNT takes nothing, or one expression' : `${n.name} takes one expression`);
    }
    n.args.forEach((a) => checkRollupPlacement(a, true));
    return;
  }
  if (n.type === 'bin') { checkRollupPlacement(n.left, inside); checkRollupPlacement(n.right, inside); }
  if (n.type === 'neg') checkRollupPlacement(n.arg, inside);
  if (n.type === 'call') n.args.forEach((a) => checkRollupPlacement(a, inside));
}

/** The children.X terms one expression reads. */
function termsIn(ast) {
  const terms = new Set();
  walk(ast, (n) => { if (n.type === 'ref') { const t = childTerm(n.name); if (t) terms.add(t); } });
  return [...terms];
}

const hasValue = (v) => v !== null && v !== undefined && !Number.isNaN(v);

/**
 * Evaluates a parsed formula. `lookup(code)` returns a number or null for the
 * record's own values. A roll-up also needs `children`: one entry per BOM line,
 * `{ label, quantity, get(code) }`, where get reads that child's own value.
 *
 * A timing formula needs `context`: `{ item(code), machine(code) }`, reading
 * the item being worked on and the machine doing it.
 *
 * Returns { value }, or { value: null, missing: [...] } when an input has no
 * value yet (a child's is reported as "LABEL · CODE", a timing input as
 * "item · CODE" / "machine · CODE"), or { value: null, error } for arithmetic
 * that has no answer.
 */
export function evaluateFormula(parsed, lookup, children = null, context = null) {
  if (parsed.usesRollup && !children) return { value: null, error: 'Roll-up terms are evaluated from BOM lines.' };
  if (parsed.usesContext && !context) return { value: null, error: 'item. and machine. values are read when a machine works on an item.' };
  const missing = parsed.references.filter((code) => !hasValue(lookup(code)));
  if (parsed.usesContext) {
    for (const code of parsed.itemRefs ?? []) if (!hasValue(context.item(code))) missing.push(`item · ${code}`);
    for (const code of parsed.machineRefs ?? []) if (!hasValue(context.machine(code))) missing.push(`machine · ${code}`);
  }
  if (parsed.usesRollup) {
    walk(parsed.ast, (n) => {
      if (n.type !== 'call' || !ROLLUP_FUNCTIONS.has(n.name) || n.name === 'COUNT' || !n.args.length) return;
      const terms = termsIn(n.args[0]);
      for (const child of children) {
        for (const t of terms) if (!hasValue(child.get(t))) missing.push(`${child.label} · ${t}`);
      }
    });
  }
  if (missing.length) return { value: null, missing: [...new Set(missing)] };

  const bool = (x) => (x ? 1 : 0);
  function rollup(n) {
    const arg = n.args[0];
    if (n.name === 'COUNT') {
      if (!arg) return children.reduce((t, ch) => t + ch.quantity, 0);
      const terms = termsIn(arg);
      return children.filter((ch) => terms.every((t) => hasValue(ch.get(t)))).reduce((t, ch) => t + ch.quantity, 0);
    }
    const sum = children.reduce((t, ch) => t + ch.quantity * ev(arg, ch), 0);
    if (n.name === 'SUM') return sum;
    const pieces = children.reduce((t, ch) => t + ch.quantity, 0);
    if (!pieces) throw new FormulaError('There are no child pieces to average');
    return sum / pieces;
  }
  function ev(n, child = null) {
    switch (n.type) {
      case 'num': return n.value;
      case 'ref': {
        const t = childTerm(n.name);
        if (t) return Number(child.get(t));
        const cx = CONTEXT_REF.exec(n.name);
        if (cx) return Number(context[cx[1].toLowerCase()](cx[2].toUpperCase()));
        return Number(lookup(n.name.toUpperCase()));
      }
      case 'neg': return -ev(n.arg, child);
      case 'call': {
        if (ROLLUP_FUNCTIONS.has(n.name)) return rollup(n);
        if (n.name === 'IF') return ev(n.args[0], child) ? ev(n.args[1], child) : ev(n.args[2], child);
        return FUNCTIONS[n.name].fn(...n.args.map((a) => ev(a, child)));
      }
      case 'bin': {
        const a = ev(n.left, child);
        const b = ev(n.right, child);
        switch (n.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/': if (b === 0) throw new FormulaError('Division by zero'); return a / b;
          case '%': if (b === 0) throw new FormulaError('Division by zero'); return a % b;
          case '^': return a ** b;
          case '<': return bool(a < b);
          case '<=': return bool(a <= b);
          case '>': return bool(a > b);
          case '>=': return bool(a >= b);
          case '=': case '==': return bool(a === b);
          case '!=': case '<>': return bool(a !== b);
          default: throw new FormulaError(`Unknown operator ${n.op}`);
        }
      }
      default: throw new FormulaError('Unknown expression');
    }
  }
  try {
    const value = ev(parsed.ast);
    if (!Number.isFinite(value)) return { value: null, error: 'The result is not a finite number.' };
    return { value: Number(value.toFixed(6)) };
  } catch (e) {
    return { value: null, error: e.message };
  }
}
