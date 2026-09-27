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
 *
 * `LOOKUP(t, x)` and `LOOKUP(t, x, y)` read a TABLE specification — a chart,
 * e.g. cutting speed by plate thickness. `t` names the table (a plain code, or
 * item.X / machine.X exactly like any other reference) and must be a bare name
 * in that position; everywhere else a table specification is a check error; see
 * "CUT_SPEED is a table" in formulaService.checkFormula. Reading outside the
 * chart's range, or a cell the chart marks null, is not an error — the FORMULA'S
 * result is simply missing, with the reason, same as any other unmeasured input
 * (MissingValueError, caught in evaluateFormula).
 */

export class FormulaError extends Error {
  constructor(message, position = null) {
    super(position == null ? message : `${message} (at character ${position + 1})`);
    this.position = position;
  }
}

/** A LOOKUP that fell outside the chart, or landed on a null cell — reported as `missing`, never as `error`, because it is a data gap, not a formula mistake. */
export class MissingValueError extends FormulaError {
  constructor(reason) { super(reason); this.isMissing = true; }
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
const LOOKUP_FN = 'LOOKUP';
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
        if (!FUNCTIONS[fname] && !ROLLUP_FUNCTIONS.has(fname) && fname !== LOOKUP_FN) throw new FormulaError(`Unknown function ${tok.v}`, tok.p);
        const spec = FUNCTIONS[fname];
        if (spec && (args.length < spec.min || args.length > spec.max)) {
          throw new FormulaError(`${fname} takes ${spec.min === spec.max ? spec.min : `${spec.min}+`} argument(s)`, tok.p);
        }
        // LOOKUP's own shape (2 or 3 args, a table name first) is checked once
        // the whole tree exists — checkLookupUsage, below — so it can name the
        // table in its message.
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
 * Walks the tree collecting plain references (specs of the same record),
 * item./machine. refs (timing context) and children.X (roll-up terms) — the
 * same job walk() does for every other purpose below, except a LOOKUP's own
 * first argument is pulled into `lookupRefs` instead of the ordinary sets: it
 * names a TABLE, not a number, so it must never also count as "this formula
 * reads CUT_SPEED as a number" (that read happens through LOOKUP, nowhere else).
 * LOOKUP's other argument(s) — the value(s) to look up — are read normally, so
 * `LOOKUP(machine.CUT_SPEED, item.THICKNESS)` still records item.THICKNESS as
 * an ordinary timing reference.
 */
function collectRefs(ast, sets) {
  if (ast.type === 'ref') {
    const m = /^(children|item|machine)\.([A-Za-z_][A-Za-z0-9_]*)$/i.exec(ast.name);
    if (m) ({ children: sets.rollupTerms, item: sets.itemRefs, machine: sets.machineRefs }[m[1].toLowerCase()]).add(m[2].toUpperCase());
    else if (ast.name.includes('.')) throw new FormulaError(`"${ast.name}" is not a name this formula can read`);
    else sets.references.add(ast.name.toUpperCase());
    return;
  }
  if (ast.type === 'bin') { collectRefs(ast.left, sets); collectRefs(ast.right, sets); return; }
  if (ast.type === 'neg') { collectRefs(ast.arg, sets); return; }
  if (ast.type === 'call') {
    if (ast.name === LOOKUP_FN) {
      const t = ast.args[0];
      if (!t || t.type !== 'ref') {
        throw new FormulaError('LOOKUP\'s first argument names a table specification, e.g. LOOKUP(machine.CUT_SPEED, item.THICKNESS)');
      }
      if (ast.args.length < 2 || ast.args.length > 3) {
        throw new FormulaError('LOOKUP takes a table and one value to look up (or two, for a table with two axes)');
      }
      const cx = /^(item|machine)\.([A-Za-z_][A-Za-z0-9_]*)$/i.exec(t.name);
      if (cx) sets.lookupRefs.push({ role: cx[1].toLowerCase(), code: cx[2].toUpperCase(), arity: ast.args.length });
      else if (t.name.includes('.')) throw new FormulaError(`"${t.name}" is not a name this formula can read`);
      else sets.lookupRefs.push({ role: 'plain', code: t.name.toUpperCase(), arity: ast.args.length });
      for (let i = 1; i < ast.args.length; i++) collectRefs(ast.args[i], sets);
      return;
    }
    if (ROLLUP_FUNCTIONS.has(ast.name)) sets.usesRollupFunction = true;
    ast.args.forEach((a) => collectRefs(a, sets));
  }
}

/**
 * Parses an expression. Returns { ast, references, rollupTerms, usesRollup,
 * itemRefs, machineRefs, lookupRefs, usesContext, kind }:
 *   references   — plain names (spec codes) the formula reads from the same record
 *   rollupTerms  — names read from BOM children (children.X -> X)
 *   itemRefs     — item.X: the item being worked on (timing formulas)
 *   machineRefs  — machine.X: the machine doing it (timing formulas)
 *   lookupRefs   — [{ role: 'plain'|'item'|'machine', code, arity }], one per
 *                  LOOKUP call's first argument — the TABLE it reads, never
 *                  double-counted in references/itemRefs/machineRefs
 *   kind         — 'value' (plain names or none), 'rollup' or 'timing'
 * A formula is one kind or another: in one that reads item. or machine. values
 * every name needs its prefix, and none can also roll up BOM children.
 */
export function parseFormula(expression) {
  if (typeof expression !== 'string' || !expression.trim()) throw new FormulaError('The formula is empty');
  const ast = parseTokens(tokenize(expression));
  const sets = { references: new Set(), rollupTerms: new Set(), itemRefs: new Set(), machineRefs: new Set(), lookupRefs: [], usesRollupFunction: false };
  collectRefs(ast, sets);
  checkRollupPlacement(ast, false);
  const { references, rollupTerms, itemRefs, machineRefs, lookupRefs, usesRollupFunction } = sets;
  const usesRollup = usesRollupFunction || rollupTerms.size > 0;
  // A LOOKUP on item.X / machine.X makes this a timing formula even when that
  // is the ONLY item./machine. name in it (e.g. LOOKUP(machine.CUT_SPEED, 12)).
  const usesContext = itemRefs.size > 0 || machineRefs.size > 0 || lookupRefs.some((r) => r.role === 'item' || r.role === 'machine');
  if (usesContext && usesRollup) throw new FormulaError('A timing formula (item. / machine.) cannot also roll up BOM children');
  if (usesContext && references.size) {
    throw new FormulaError(`${[...references][0]} needs a prefix — in a formula that reads item. or machine. values, say item.${[...references][0]} or machine.${[...references][0]}`);
  }
  if (usesContext) {
    const bare = lookupRefs.find((r) => r.role === 'plain');
    if (bare) {
      throw new FormulaError(`${bare.code} needs a prefix — in a formula that reads item. or machine. values, say LOOKUP(item.${bare.code}, …) or LOOKUP(machine.${bare.code}, …)`);
    }
  }
  return {
    ast,
    references: [...references],
    rollupTerms: [...rollupTerms],
    usesRollup,
    itemRefs: [...itemRefs],
    machineRefs: [...machineRefs],
    lookupRefs,
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
/**
 * `table` is a resolved table value: { mode, axes, x, v } (one axis) or
 * { mode, axes, x, y, v } (two). Returns { value } or { missingReason } in
 * words — never invents a rate the chart does not give (contract: outside the
 * chart's range, or a null cell, is a missing value, not an error).
 */
function lookupTableValue(table, x, y) {
  const EPS = 1e-9;
  const xs = table.x;
  if (!Array.isArray(xs) || !xs.length) return { missingReason: 'has no chart rows yet' };
  const unit0 = table.axes?.[0]?.unit ? ` ${table.axes[0].unit}` : '';
  if (x < xs[0] - EPS) return { missingReason: `${x}${unit0} is below the chart's range, which starts at ${xs[0]}${unit0}` };
  if (x > xs[xs.length - 1] + EPS) return { missingReason: `${x}${unit0} is above the chart's range, which ends at ${xs[xs.length - 1]}${unit0}` };
  const linear = table.mode === 'linear';

  // Where x sits: an exact row (i0 === i1, t = 0), or bracketed between two
  // (i0 below, i1 above). step_up reads row i1 regardless of t — the first row
  // AT OR ABOVE x is exactly what an exact match or a bracket's upper end is.
  const bracket = (arr, v) => {
    const exact = arr.findIndex((a) => Math.abs(a - v) < EPS);
    if (exact >= 0) return { i0: exact, i1: exact, t: 0 };
    let i0 = 0;
    while (i0 < arr.length - 1 && arr[i0 + 1] < v) i0++;
    const i1 = i0 + 1;
    return { i0, i1, t: (v - arr[i0]) / (arr[i1] - arr[i0]) };
  };

  const twoD = Array.isArray(table.y) && table.y.length > 0;
  if (!twoD) {
    const { i0, i1, t } = bracket(xs, x);
    if (!linear) {
      const v = table.v[i1];
      return v == null ? { missingReason: `has no rate at ${xs[i1]}${unit0} — the chart marks it blank` } : { value: v };
    }
    const v0 = table.v[i0];
    const v1 = table.v[i1];
    if (v0 == null || v1 == null) return { missingReason: `has no rate at one end of the rows around ${x}${unit0} — the chart marks it blank` };
    return { value: v0 + (v1 - v0) * t };
  }

  const ys = table.y;
  const unit1 = table.axes?.[1]?.unit ? ` ${table.axes[1].unit}` : '';
  if (y == null || !Number.isFinite(y)) return { missingReason: 'needs a second value to look up — it has two axes' };
  if (y < ys[0] - EPS) return { missingReason: `${y}${unit1} is below the chart's range, which starts at ${ys[0]}${unit1}` };
  if (y > ys[ys.length - 1] + EPS) return { missingReason: `${y}${unit1} is above the chart's range, which ends at ${ys[ys.length - 1]}${unit1}` };
  const bx = bracket(xs, x);
  const by = bracket(ys, y);
  if (!linear) {
    const v = table.v[by.i1]?.[bx.i1];
    return v == null ? { missingReason: `has no rate at ${xs[bx.i1]}${unit0} / ${ys[by.i1]}${unit1} — the chart marks it blank` } : { value: v };
  }
  // Bilinear: when a bracket is exact (t or u = 0) the two "sides" of that
  // axis are the same cell, so this reads correctly even right on a row.
  const c00 = table.v[by.i0]?.[bx.i0];
  const c01 = table.v[by.i0]?.[bx.i1];
  const c10 = table.v[by.i1]?.[bx.i0];
  const c11 = table.v[by.i1]?.[bx.i1];
  if ([c00, c01, c10, c11].some((c) => c == null)) return { missingReason: `has a blank cell near ${x}${unit0} / ${y}${unit1} — the chart marks the machine as unable to there` };
  const top = c00 + (c01 - c00) * bx.t;
  const bottom = c10 + (c11 - c10) * bx.t;
  return { value: top + (bottom - top) * by.t };
}

export function evaluateFormula(parsed, lookup, children = null, context = null, lookupTable = null) {
  if (parsed.usesRollup && !children) return { value: null, error: 'Roll-up terms are evaluated from BOM lines.' };
  if (parsed.usesContext && !context) return { value: null, error: 'item. and machine. values are read when a machine works on an item.' };
  const missing = parsed.references.filter((code) => !hasValue(lookup(code)));
  if (parsed.usesContext) {
    for (const code of parsed.itemRefs ?? []) if (!hasValue(context.item(code))) missing.push(`item · ${code}`);
    for (const code of parsed.machineRefs ?? []) if (!hasValue(context.machine(code))) missing.push(`machine · ${code}`);
  }
  // A table not yet fixed, defaulted or entered anywhere reachable is the same
  // class of gap as any other unmeasured input — reported here, before the
  // chart's own range/null-cell checks run inside ev() below.
  const tableOf = (ref) => (ref.role === 'item' ? context?.itemTable?.(ref.code)
    : ref.role === 'machine' ? context?.machineTable?.(ref.code)
    : lookupTable?.(ref.code));
  for (const ref of parsed.lookupRefs ?? []) {
    if (!tableOf(ref)) missing.push(ref.role === 'plain' ? ref.code : `${ref.role} · ${ref.code}`);
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
  /** LOOKUP(t, x[, y]) — t is n.args[0], already checked (parseFormula) to be a bare/item./machine. reference. */
  function lookupCall(n, child) {
    const t = n.args[0];
    const cx = CONTEXT_REF.exec(t.name);
    const role = cx ? cx[1].toLowerCase() : 'plain';
    const code = (cx ? cx[2] : t.name).toUpperCase();
    const named = role === 'plain' ? code : `${role}.${code}`;
    const table = tableOf({ role, code });
    if (!table) throw new MissingValueError(`${named} has no chart set yet`);
    const axisCount = Array.isArray(table.y) && table.y.length ? 2 : 1;
    if (n.args.length - 1 !== axisCount) {
      throw new FormulaError(`${code} has ${axisCount} chart axis${axisCount === 1 ? '' : 'es'} — LOOKUP(${code}${axisCount === 1 ? ', x' : ', x, y'}) takes ${axisCount} value${axisCount === 1 ? '' : 's'} to look up, not ${n.args.length - 1}`);
    }
    const x = ev(n.args[1], child);
    const y = n.args[2] ? ev(n.args[2], child) : null;
    const out = lookupTableValue(table, x, y);
    if (out.missingReason) throw new MissingValueError(`${named} ${out.missingReason}`);
    return out.value;
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
        if (n.name === LOOKUP_FN) return lookupCall(n, child);
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
    // A LOOKUP outside its chart's range, or on a null cell, is a data gap —
    // reported the way every other unmeasured input is, not as a formula bug.
    if (e.isMissing) return { value: null, missing: [e.message] };
    return { value: null, error: e.message };
  }
}
