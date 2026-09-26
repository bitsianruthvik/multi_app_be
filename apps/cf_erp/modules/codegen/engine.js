/**
 * engine.js — which coding rule applies to a record, and what text it produces.
 *
 * Entities adopt the generator by registering a PROVIDER:
 *
 *   registerEntity('item', {
 *     label,                       // shown in the rules screen
 *     tokens,                      // [{ key, label, available, note, phrase, help, example }] renderable values
 *     tokenPatterns,               // [{ pattern: 'spec:<CODE>', label, phrase, help, example }] families of tokens
 *     conditionTokens,             // [{ key, label, operators, valueKind, values?, phrase, help }]
 *                                  // phrase/help/example are the rules screen's guide, shown as written
 *     validateToken(db, companyId, key)        -> null | problem text
 *     validateCondition(db, companyId, cond)   -> null | problem text
 *     loadContext(db, companyId, entityId)     -> Context
 *     draftContext(db, companyId, draft)       -> Context   (not yet saved)
 *   })
 *
 *   Context = {
 *     get(tokenKey)  -> string | number | null      value to render
 *     test(cond)     -> { ok: boolean, weight }     does a condition hold, how specific is it
 *   }
 *
 * Providers live with the entity that owns them, never in this folder.
 *
 * Numbers are handed out inside the caller's transaction (see nextNumber), so a
 * record that fails to save gives its number back automatically.
 */
import { CodegenError } from './errors.js';

const registry = new Map();
const SEQ_MARK = '\u0000#\u0000'; // NULs cannot occur in a rendered code

/**
 * A token a provider answers with BLANK is empty ON PURPOSE: it prints nothing
 * and is never "missing". An empty answer (null, '') means the record has no
 * value yet, and a required segment then holds the code back. The difference
 * matters for a short name deliberately set to none (user, 2026-09-26): a
 * girder segment prints no short name — {parent.code}-{record.shortName}{range}
 * reads …-G1-1 — where an item nobody has named yet must wait.
 */
export const BLANK = Object.freeze({ blank: true, toString: () => '' });

export function registerEntity(entityType, provider) {
  if (registry.has(entityType)) throw new Error(`[codegen] entity type "${entityType}" registered twice`);
  registry.set(entityType, provider);
}

export function getProvider(entityType) {
  const provider = registry.get(entityType);
  if (!provider) {
    throw new CodegenError(422, 'UNKNOWN_ENTITY', `Nothing called "${entityType}" uses the code generator.`);
  }
  return provider;
}

export function listEntities() {
  return [...registry.entries()].map(([entityType, p]) => ({
    entityType,
    label: p.label,
    tokens: p.tokens,
    tokenPatterns: p.tokenPatterns ?? [],
    conditionTokens: p.conditionTokens,
  }));
}

// ---------------------------------------------------------------------------
// Scheme selection
// ---------------------------------------------------------------------------

/*
 * Selection is three steps, and selectScheme (which picks the rule a code is
 * made by) and explainSelection (which tells the rules screen why) run the
 * SAME three: candidates() loads the rules, evaluate() tests them, rank()
 * orders the ones that apply. There is no second copy of the logic to drift —
 * whatever the screen says wins is what generate() uses.
 */

/** The active rules for one entity type and field, each with its conditions: [{ scheme, conditions }]. */
async function candidates(db, companyId, entityType, targetField) {
  const [schemes] = await db.query(
    `SELECT id, code, name, seq_scope, priority
       FROM cf_code_schemes
      WHERE company_id = ? AND entity_type = ? AND target_field = ?
        AND status = 'active' AND deleted_at IS NULL`,
    [companyId, entityType, targetField],
  );
  if (!schemes.length) return [];

  const [conditions] = await db.query(
    `SELECT scheme_id, token_key, operator, value
       FROM cf_code_scheme_conditions
      WHERE company_id = ? AND scheme_id IN (?) AND deleted_at IS NULL`,
    [companyId, schemes.map((s) => s.id)],
  );
  const bySchemeId = new Map(schemes.map((s) => [s.id, []]));
  for (const c of conditions) bySchemeId.get(c.scheme_id).push(c);
  return schemes.map((scheme) => ({ scheme, conditions: bySchemeId.get(scheme.id) }));
}

/**
 * Tests every rule against the record. A rule applies when every condition
 * holds; its weight is the sum of its conditions' weights (a deeper
 * classification weighs more). EVERY condition is tested, not only those up to
 * the first that fails — the screen shows each one held or not — which changes
 * nothing about the choice: a test only reads.
 */
function evaluate(list, context) {
  return list.map((candidate) => {
    const checks = candidate.conditions.map((cond) => {
      const r = context.test(cond);
      return { cond, ok: !!r.ok, weight: r.weight };
    });
    const applies = checks.every((c) => c.ok);
    let weight = 0;
    if (applies) for (const c of checks) weight += c.weight;
    return { ...candidate, checks, applies, weight: applies ? weight : null };
  });
}

/**
 * Orders the rules that apply: the highest total weight first, `priority`
 * breaking a tie. Rules still level at the top are `tied` — a configuration
 * error, reported rather than decided by row order.
 */
function rank(evaluated) {
  const matching = evaluated.filter((e) => e.applies);
  matching.sort((a, b) => b.weight - a.weight || b.scheme.priority - a.scheme.priority);
  const [top = null, second = null] = matching;
  const level = (e) => e.weight === top.weight && e.scheme.priority === top.scheme.priority;
  const tied = second && level(second) ? matching.filter(level) : null;
  return { matching, top, second, tied };
}

function tieError(tied) {
  const codes = tied.map((e) => e.scheme.code);
  return new CodegenError(409, 'SCHEME_TIE',
    `Coding rules ${codes.join(' and ')} apply equally here. Make one more specific, or give one a higher priority.`,
    { problems: codes });
}

/**
 * The single active scheme that applies to a context: every condition must
 * hold; the highest total weight wins (a deeper classification weighs more);
 * `priority` breaks a tie; a remaining tie is a configuration error, reported
 * rather than decided by row order.
 */
export async function selectScheme(db, companyId, entityType, targetField, context) {
  const list = await candidates(db, companyId, entityType, targetField);
  if (!list.length) return null;
  const { top, tied } = rank(evaluate(list, context));
  if (!top) return null;
  if (tied) throw tieError(tied);
  return { ...top.scheme, weight: top.weight };
}

/**
 * Why a record gets the rule it gets — "which rule wins" on the rules screen.
 * The same candidates(), evaluate() and rank() as selectScheme, so the answer
 * is the one generate() acts on. Two differences, both on purpose: a tie is an
 * answer here, not an error; and the rule being edited takes part as it WILL
 * be once saved.
 *
 * draft (optional) — the unsaved rule:
 *   { id?, code, name, seqScope, priority, status, conditions: [{ token_key, operator, value }], problems? }
 * It stands in for the saved rule with its id, or joins the rules when new.
 * Inactive, it takes no part (as it would not once saved) but is still tested,
 * so the screen can say whether it would apply. With `problems` — a condition
 * with no value yet — it is left out untested, and so is its saved self.
 *
 * Returns
 *   rules      [{ id, code, name, priority, draft, conditions: [{ tokenKey, operator, value, ok, weight }],
 *                 applies, weight, place, verdict: wins|tied|beaten|no|off|unfinished, problems? }]
 *              — the rules that apply in the order they rank, then the rest
 *   winner     { id, code, draft } | null
 *   decidedBy  only | weight | priority | tie | none
 *   runnerUp   the rule the winner beat: { id, code, draft, weight, priority } | null
 *   tied       [code] | null — the codes SCHEME_TIE would name, in its order
 */
export async function explainSelection(db, companyId, entityType, targetField, context, { draft = null } = {}) {
  let list = await candidates(db, companyId, entityType, targetField);
  let aside = null;
  if (draft) {
    const own = {
      draft: true,
      scheme: { id: draft.id ?? null, code: draft.code, name: draft.name, seq_scope: draft.seqScope ?? 'prefix', priority: draft.priority },
      conditions: draft.conditions ?? [],
    };
    if (draft.id != null) list = list.filter(({ scheme }) => scheme.id !== draft.id);
    if (draft.problems?.length) aside = { ...own, checks: [], applies: false, weight: null, verdict: 'unfinished', problems: draft.problems };
    else if (draft.status !== 'active') aside = { ...evaluate([own], context)[0], verdict: 'off' };
    else list.push(own);
  }

  const evaluated = evaluate(list, context);
  const { matching, top, second, tied } = rank(evaluated);
  const verdict = (e) => {
    if (!e.applies) return 'no';
    if (tied) return tied.includes(e) ? 'tied' : 'beaten';
    return e === top ? 'wins' : 'beaten';
  };
  const byCode = (a, b) => String(a.scheme.code).localeCompare(String(b.scheme.code));
  const ordered = [
    ...matching.map((e, i) => ({ ...e, place: i + 1, verdict: verdict(e) })),
    ...evaluated.filter((e) => !e.applies).sort(byCode).map((e) => ({ ...e, place: null, verdict: 'no' })),
    ...(aside ? [{ ...aside, place: null }] : []),
  ];
  const ref = (e) => (e ? { id: e.scheme.id, code: e.scheme.code, draft: !!e.draft } : null);

  return {
    rules: ordered.map((e) => ({
      id: e.scheme.id,
      code: e.scheme.code,
      name: e.scheme.name,
      priority: e.scheme.priority,
      draft: !!e.draft,
      conditions: e.checks.map(({ cond, ok, weight }) => ({ tokenKey: cond.token_key, operator: cond.operator, value: cond.value, ok, weight })),
      applies: e.applies,
      weight: e.weight,
      place: e.place,
      verdict: e.verdict,
      ...(e.problems ? { problems: e.problems } : {}),
    })),
    winner: top && !tied ? ref(top) : null,
    decidedBy: !top ? 'none' : tied ? 'tie' : !second ? 'only' : top.weight !== second.weight ? 'weight' : 'priority',
    runnerUp: top && second && !tied ? { ...ref(second), weight: second.weight, priority: second.scheme.priority } : null,
    tied: tied ? tied.map((e) => e.scheme.code) : null,
  };
}

async function loadSegments(db, companyId, schemeId) {
  const [rows] = await db.query(
    `SELECT segment_type, literal_text, token_key, format, transform, max_length, is_required
       FROM cf_code_scheme_segments
      WHERE company_id = ? AND scheme_id = ? AND deleted_at IS NULL
      ORDER BY sort_order, id`,
    [companyId, schemeId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function formatDate(date, format) {
  const pad = (n) => String(n).padStart(2, '0');
  return format.replace(/YYYY|YY|MM|DD/g, (t) => ({
    YYYY: String(date.getFullYear()),
    YY: String(date.getFullYear()).slice(-2),
    MM: pad(date.getMonth() + 1),
    DD: pad(date.getDate()),
  }[t]));
}

function plainNumber(n) {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

/**
 * A token's number format: '0.00' fixes the decimals (12.5 -> 12.50); zeros
 * alone round to a whole number and pad to that many digits ('00': 1 -> 01), so
 * positions read WEB01, WEB02.
 */
function formatNumber(raw, format) {
  if (!format) return plainNumber(raw);
  const decimals = /^0\.(0+)$/.exec(format);
  if (decimals) return raw.toFixed(decimals[1].length);
  if (/^0+$/.test(format)) {
    const whole = Math.round(raw);
    return (whole < 0 ? '-' : '') + String(Math.abs(whole)).padStart(format.length, '0');
  }
  return plainNumber(raw);
}

function shapeToken(raw, seg) {
  let text;
  if (typeof raw === 'number') {
    text = formatNumber(raw, seg.format);
  } else {
    text = String(raw);
  }
  if (seg.transform === 'upper') text = text.toUpperCase();
  else if (seg.transform === 'lower') text = text.toLowerCase();
  if (seg.max_length) text = text.slice(0, seg.max_length);
  return text;
}

/**
 * Hands out the next number for (scheme, key). MUST run inside the caller's
 * transaction: the upsert takes the row lock, FOR UPDATE keeps it, and the
 * increment commits with the record that used the number — or rolls back with
 * it, so a failed save never burns a number.
 */
async function nextNumber(db, companyId, schemeId, key) {
  await db.query(
    `INSERT INTO cf_code_sequences (company_id, scheme_id, seq_key, next_value)
     VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE next_value = next_value`,
    [companyId, schemeId, key],
  );
  const [[row]] = await db.query(
    `SELECT id, next_value FROM cf_code_sequences
      WHERE company_id = ? AND scheme_id = ? AND seq_key = ? FOR UPDATE`,
    [companyId, schemeId, key],
  );
  await db.query('UPDATE cf_code_sequences SET next_value = next_value + 1 WHERE id = ?', [row.id]);
  return row.next_value;
}

async function peekNumber(db, companyId, schemeId, key) {
  if (!schemeId) return 1;
  const [[row]] = await db.query(
    'SELECT next_value FROM cf_code_sequences WHERE company_id = ? AND scheme_id = ? AND seq_key = ?',
    [companyId, schemeId, key],
  );
  return row ? row.next_value : 1;
}

/**
 * Renders segments against a context. With `consume` the running number is
 * taken for real; without it (previews) the number is the one that WOULD be
 * next and nothing is written.
 *
 * Returns { text, number, missing }. A required token with no value makes
 * `text` null in a preview and throws TOKEN_MISSING when consuming — a code
 * with a hole in it is worse than no code.
 */
export async function renderSegments(db, companyId, scheme, segments, context, { consume = false, now = new Date() } = {}) {
  if (!segments.length) {
    throw new CodegenError(422, 'EMPTY_SCHEME', `Coding rule ${scheme.code} has no pattern.`);
  }
  let text = '';
  let seq = null;
  const missing = [];

  for (const seg of segments) {
    switch (seg.segment_type) {
      case 'literal':
        text += seg.literal_text ?? '';
        break;
      case 'date':
        text += formatDate(now, seg.format || 'YYYYMMDD');
        break;
      case 'token': {
        const raw = context.get(seg.token_key);
        if (raw === BLANK) break;   // empty on purpose: prints nothing, and is not missing
        if (raw === null || raw === undefined || raw === '') {
          if (seg.is_required) missing.push(seg.token_key);
          break;
        }
        text += shapeToken(raw, seg);
        break;
      }
      case 'sequence':
        seq = { seg, prefix: text };
        text += SEQ_MARK;
        break;
      default:
        throw new CodegenError(422, 'BAD_SEGMENT', `Unknown segment type "${seg.segment_type}".`);
    }
  }

  if (missing.length) {
    if (consume) {
      throw new CodegenError(422, 'TOKEN_MISSING',
        `Coding rule ${scheme.code} needs ${missing.join(', ')}, which ${missing.length > 1 ? 'have' : 'has'} no value yet.`,
        { problems: missing });
    }
    return { text: null, number: null, missing };
  }

  let number = null;
  if (seq) {
    const key = scheme.seq_scope === 'scheme' ? '' : seq.prefix;
    number = consume
      ? await nextNumber(db, companyId, scheme.id, key)
      : await peekNumber(db, companyId, scheme.id, key);
    const width = seq.seg.format && /^0+$/.test(seq.seg.format) ? seq.seg.format.length : 1;
    text = text.replace(SEQ_MARK, String(number).padStart(width, '0'));
  }
  return { text, number, missing: [] };
}

/**
 * The whole job: pick the scheme for a record (saved, or a draft), render it.
 * Returns null when no scheme applies — the caller decides whether that is
 * fine (a draft) or an error (activating a record without a code).
 *
 * `inline` renders an unsaved scheme definition against the record, skipping
 * selection — the rules screen uses it for live preview while editing.
 */
export async function generate(db, companyId, entityType, targetField, subject, { consume = false, inline = null } = {}) {
  const provider = getProvider(entityType);
  const context = subject.entityId != null
    ? await provider.loadContext(db, companyId, subject.entityId)
    : await provider.draftContext(db, companyId, subject.draft ?? {});

  if (inline) {
    const scheme = { id: inline.id ?? null, code: inline.code || '(unsaved rule)', seq_scope: inline.seqScope || 'prefix' };
    const out = await renderSegments(db, companyId, scheme, inline.segments, context, { consume: false });
    return { schemeId: scheme.id, schemeCode: scheme.code, ...out };
  }

  const scheme = await selectScheme(db, companyId, entityType, targetField, context);
  if (!scheme) return null;
  const segments = await loadSegments(db, companyId, scheme.id);
  const out = await renderSegments(db, companyId, scheme, segments, context, { consume });
  return { schemeId: scheme.id, schemeCode: scheme.code, ...out };
}
