/**
 * reader.js — text -> a draft plan (spec §14.1 part 2). A MATCHER, not a chat
 * model: nothing generative, nothing outside the server.
 *
 * 1. QUOTES FIRST. "…", “…”, '…' are lifted out before anything else and put
 *    back word for word as new text; nothing inside them is read as a cue.
 * 2. CLAUSES. Split on new lines, ";", sentence ends, "then", and on "and" / ","
 *    when an action verb follows ("… under Production and add a position …").
 *    "… and a position X in it" (no verb) borrows the verb before it.
 * 3. WHICH ACTION. Cue words first — cheap, and right for the way people write
 *    these: the first thing-word after the verb ("add a SECTION …", "add a KRA
 *    … to the X role" — the role is the target, not the action), the verb
 *    (put / move / assign a person; change / switch a shift) and a few sentence
 *    shapes ("X should …", "make X responsible for …", "measure X on …").
 *    Thing-words are matched with a typo allowed ("responsiblity").
 *    ONLY when no cue decides it is the built-in sentence model asked
 *    (semantic/embedder.js): the clause against every action's example
 *    phrasings, nearest by meaning, above MODEL_FLOOR. The model is loaded for
 *    that alone — never for a request the cue words read — and the memory guard
 *    applies; if it cannot load the clause is "not understood".
 * 4. FIELDS. Per action: quoted text is new text; "under / in / to / for / on
 *    the X shift / reporting to" decide which field a name fills; names are
 *    matched against the company's records (records.js: exact, then any case,
 *    then word by word with typos); a close tie keeps the candidates. "it",
 *    "there", "the new one" point at the last thing of that kind an earlier step
 *    makes; a name an earlier step creates points at that step.
 *
 * The person corrects whatever is wrong on the screen; nothing is written until
 * they press Apply on a plan with no problems (plan.js).
 */
import { embed, dot, ModelUnavailable } from '../semantic/embedder.js';
import { ACTIONS } from './actions/index.js';
import { findRecord, labelOf } from './records.js';
import {
  distance, typoBudget, nameScore, readDateWords, tidyName,
} from './text.js';

export const MODEL_FLOOR = 0.45;

/* ── 1. quotes ─────────────────────────────────────────────────────────── */

const QUOTE_RE = /"([^"]+)"|“([^”]+)”|‘([^’]+)’|(^|[\s:(])'([^']+?)'(?=[\s,.;:)!?]|$)/g;

function maskQuotes(text) {
  const quotes = [];
  const masked = String(text).replace(QUOTE_RE, (m, a, b, c, lead, d) => {
    const q = a ?? b ?? c ?? d;
    quotes.push(q.trim());
    return `${lead ?? ''} «${quotes.length - 1}» `;
  });
  return { masked, quotes };
}
const QMARK = /«(\d+)»/g;
const unmask = (s, quotes) => String(s ?? '').replace(QMARK, (m, i) => quotes[Number(i)] ?? '').replace(/\s+/g, ' ').trim();
const quotedIn = (s, quotes) => [...String(s ?? '').matchAll(QMARK)].map((m) => quotes[Number(m[1])]);
const onlyQuote = (s, quotes) => {
  const t = String(s ?? '').trim();
  const m = /^«(\d+)»$/.exec(t);
  return m ? quotes[Number(m[1])] : null;
};

/* ── 2. clauses ────────────────────────────────────────────────────────── */

const VERBS = 'add|ad|create|creat|make|put|place|move|change|set|assign|give|appoint|transfer|switch|open|new|fill|track|measure|shift|also add|please add|we need|then';
const VERB_AHEAD = new RegExp(`^\\s*(?:${VERBS})\\b`, 'i');
const NOUN_AHEAD = /^\s*(?:a|an|another|one more|1 more)\s+(?:new\s+)?(?:position|vacancy|seat|post|section|department|dept|role|kra|kpi|responsibility|duty|task)\b/i;

function splitClauses(masked) {
  const rough = masked
    .split(/\r?\n+|;|(?<=[a-z0-9»)])\.\s+(?=[A-Za-z])|\s*\bthen\b\s*|\s*\band also\b\s*/i)
    .map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const piece of rough) {
    // "… and add …", ", add …", "… and a position …"
    const parts = [];
    let rest = piece;
    const re = /(?:,\s*and\s+|\s+and\s+|,\s+)/gi;
    let last = 0;
    let m;
    while ((m = re.exec(rest))) {
      const after = rest.slice(m.index + m[0].length);
      if (VERB_AHEAD.test(after) || NOUN_AHEAD.test(after)) {
        parts.push(rest.slice(last, m.index));
        last = m.index + m[0].length;
      }
    }
    parts.push(rest.slice(last));
    let verb = null;
    for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
      const v = /^(?:please\s+|also\s+)?(add|create|make|open|new)\b/i.exec(p);
      if (v) verb = v[1];
      out.push(NOUN_AHEAD.test(p) && !VERB_AHEAD.test(p) && verb ? `${verb} ${p}` : p);
    }
    rest = null;
  }
  return out;
}

/* ── 3. which action ───────────────────────────────────────────────────── */

const NOUNS = {
  kra: ['kra', 'kras', 'kra’s'],
  kpi: ['kpi', 'kpis'],
  responsibility: ['responsibility', 'responsibilities', 'responsible', 'duty', 'duties', 'task', 'tasks'],
  position: ['position', 'positions', 'vacancy', 'vacancies', 'seat', 'seats', 'post', 'opening', 'chair', 'headcount'],
  department: ['department', 'departments', 'dept', 'section', 'sections', 'unit', 'division', 'sub-department', 'subdepartment'],
  role: ['role', 'roles', 'designation', 'job'],
};
const PHRASE_NOUNS = [
  [/\bkey result areas?\b/i, 'kra'], [/\bkey performance indicators?\b/i, 'kpi'], [/\bjob title\b/i, 'role'],
];
const nounOf = (w) => {
  for (const [kind, list] of Object.entries(NOUNS)) if (list.includes(w)) return kind;
  if (w.length >= 6) {
    for (const [kind, list] of Object.entries(NOUNS)) {
      for (const n of list) if (n.length >= 6 && distance(w, n, typoBudget(n.length)) <= typoBudget(n.length)) return kind;
    }
  }
  return null;
};
const NOUN_ACTION = {
  kra: 'add_kra', kpi: 'add_kpi', responsibility: 'add_responsibility', position: 'add_position', department: 'add_department', role: 'add_role',
};
const CUE_WORDS = new Set(['to', 'for', 'on', 'in', 'into', 'under', 'of', 'from', 'at', 'reporting', 'with', 'as']);
const PERSON_VERB = /^(?:please\s+)?(put|place|move|assign|transfer|appoint|fill|shift|post)\b/i;
const CREATE_VERB = /^(?:please\s+|also\s+|we\s+need\s+(?:to\s+add\s+)?|i\s+want\s+to\s+add\s+|can\s+you\s+add\s+)?(add|ad|create|creat|make|open|new|set\s+up|setup|need|introduce)\b/i;
const SHIFT_WORD = /\b(shifts?|nights?|night-shift|day-shift)\b/i;

/** The first thing-word that is the action's object, not a target after a cue. */
function actionNoun(masked) {
  let lower = masked.replace(QMARK, ' ').toLowerCase();
  for (const [re, kind] of PHRASE_NOUNS) lower = lower.replace(new RegExp(re.source, 'gi'), ` ${kind} `);
  lower = lower.replace(/\bjob dut(y|ies)\b/g, ' duty ');
  const tokens = lower.replace(/[^a-z0-9’\- ]+/g, ' ').split(/\s+/).filter(Boolean);
  // "give the Store Keeper role a KRA …": the thing given comes after "a / an".
  let start = 0;
  if (tokens[0] === 'give') {
    const at = tokens.findIndex((w, i) => i > 1 && (w === 'a' || w === 'an'));
    start = at < 0 ? 1 : at + 1;
  }
  let sawCue = false;
  for (let i = start; i < tokens.length; i += 1) {
    const w = tokens[i];
    const kind = nounOf(w);
    if (kind) {
      // "under the KRA X" names where a line is filed, not what is added
      if (kind === 'kra' && (tokens[i - 1] === 'under' || (tokens[i - 1] === 'the' && tokens[i - 2] === 'under'))) { sawCue = true; continue; }
      // after a cue a role / position / department word is the target ("to the X role")
      if (sawCue && !['kra', 'kpi', 'responsibility'].includes(kind)) continue;
      return { kind, at: i };
    }
    if (CUE_WORDS.has(w) && i > start) sawCue = true;
  }
  return null;
}

/** The cue-word reading of one clause -> { action, confidence } or null. */
export function actionByCues(masked) {
  const lower = masked.replace(QMARK, ' "" ').toLowerCase().trim();
  // Sentence shapes first.
  if (/\bresponsible for\b/.test(lower) && !/\bkpi|kra\b/.test(lower)) return { action: 'add_responsibility', confidence: 0.9, shape: 'responsible' };
  if (/^(?:please\s+)?(?:measure|track)\b/.test(lower) || /\bshould be measured on\b|\bmeasured on\b/.test(lower)) return { action: 'add_kpi', confidence: 0.85, shape: 'measure' };
  if (/\b(?:should|must|needs? to|has to|will)\s+(?:also\s+)?(?!be measured|have|work)\w+/.test(lower) && !actionNoun(masked)) {
    return { action: 'add_responsibility', confidence: 0.8, shape: 'should' };
  }
  const noun = actionNoun(masked);
  const creating = CREATE_VERB.test(lower) || /^(?:give|we need|need)\b/.test(lower) || /\bshould have\b/.test(lower);
  const person = PERSON_VERB.test(lower) || /^make\s+\S+(\s+\S+)?\s+the\b/.test(lower) || /\btakes\b/.test(lower);
  const shiftTalk = SHIFT_WORD.test(lower) && /\b(move|change|switch|put|set|make|shift|goes|go|work|works)\b/.test(lower);

  if (noun && ['kra', 'kpi', 'responsibility'].includes(noun.kind)) return { action: NOUN_ACTION[noun.kind], confidence: creating ? 0.95 : 0.85 };
  if (noun?.kind === 'position' && creating && !person) return { action: 'add_position', confidence: 0.95 };
  // "create a role Shift Supervisor": a thing being made wins over the word "shift" in its name
  if (noun && creating && (noun.kind === 'department' || noun.kind === 'role')) return { action: NOUN_ACTION[noun.kind], confidence: 0.95 };
  if (shiftTalk && !(noun?.kind === 'position' && creating)) return { action: 'change_shift', confidence: 0.9 };
  if (person && !creating) return { action: 'place_person', confidence: noun?.kind === 'position' || /\b(in|into|to|as)\b/.test(lower) ? 0.9 : 0.75 };
  if (/^make\s+/.test(lower) && /\bthe\b/.test(lower) && !noun) return { action: 'place_person', confidence: 0.75 };
  if (noun?.kind === 'position') return { action: creating ? 'add_position' : 'place_person', confidence: 0.7 };
  if (noun?.kind === 'department' && (creating || !person)) return { action: 'add_department', confidence: creating ? 0.95 : 0.75 };
  if (noun?.kind === 'role' && (creating || !person)) return { action: 'add_role', confidence: creating ? 0.95 : 0.75 };
  if (/\b(machine)\b/.test(lower) && /^(?:add|create|new)\b/.test(lower)) return { action: 'add_department', confidence: 0.7 };
  return null;
}

/* ── the model, only when the cues do not decide ───────────────────────── */

let exampleVectors = null;   // [{ action, vec }]
async function actionByMeaning(clauseText) {
  if (!exampleVectors) {
    const all = ACTIONS.flatMap((a) => a.examples.map((e) => ({ action: a.key, text: e })));
    const vecs = await embed(all.map((x) => x.text));
    exampleVectors = all.map((x, i) => ({ action: x.action, vec: vecs[i] }));
  }
  const [q] = await embed([clauseText]);
  const best = new Map();
  for (const e of exampleVectors) {
    const s = dot(q, e.vec);
    if (s > (best.get(e.action) ?? -1)) best.set(e.action, s);
  }
  const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]);
  const [action, score] = ranked[0];
  return score >= MODEL_FLOOR ? { action, confidence: Math.min(0.8, score), byMeaning: true } : null;
}

/* ── 4. fields ─────────────────────────────────────────────────────────── */

const LEAD = /^(?:(?:please|kindly|can you|could you|i want to|we want to|we need to|we need|let's|lets|also|and|then|now|just)\s+)*(?:add|ad|create|creat|make|new|open|set up|setup|introduce|put|place|move|assign|give|appoint|transfer|fill|shift|post|need)?\s*(?:(?:a|an|the|another|one more|1 more|one|new|extra|additional)\s+)*/i;
const stripLead = (s) => String(s ?? '').replace(LEAD, '').trim();
const ARTICLES = /^(?:(?:the|a|an|our|this|that|new)\s+)+/i;
const stripArticles = (s) => String(s ?? '').trim().replace(ARTICLES, '').trim();
const KIND_TAIL = {
  role: /\s+(?:role|job|designation)$/i,
  position: /\s+(?:position|seat|post|chair|vacancy)$/i,
  department: /\s+(?:department|dept|section|unit|division|machine)$/i,
  shift: /\s+shift$/i,
};
const KIND_HEAD = {
  role: /^(?:role|job|designation)\s+(?:of\s+)?/i,
  position: /^(?:position|seat|post|chair|vacancy)\s+(?:of\s+)?/i,
  department: /^(?:department|dept|section|unit|division)\s+/i,
  shift: /^shift\s+/i,
};
const clean = (s, kind) => {
  let t = stripArticles(String(s ?? '').replace(/[,.;:!?]+$/g, '').trim());
  if (KIND_HEAD[kind]) t = t.replace(KIND_HEAD[kind], '');
  if (KIND_TAIL[kind]) t = t.replace(KIND_TAIL[kind], '');
  return stripArticles(t).trim();
};
const REF_WORDS = /^(?:it|there|here|that|this|them|the same|same|the new one|new one|that one|this one|the one|him|her)$/i;
const POSITION_CODE = /\b[A-Za-z]{1,4}\d{2,4}(?:-\d+)?\b/;

function newText(text, quotes, confidence = 0.85) {
  const q = onlyQuote(text, quotes);
  const value = q ?? tidyName(unmask(text, quotes));
  return { value: value || null, fromText: unmask(text, quotes) || null, confidence: value ? (q != null ? 1 : confidence) : 0 };
}

/** A field naming a record (or an earlier step). */
function entity(kind, rawText, R, { filter = null, allowSteps = true } = {}) {
  const fromText = unmask(rawText, R.quotes);
  const t = clean(fromText, kind);
  const empty = { value: null, fromText: fromText || null, confidence: 0 };
  if (!fromText) return empty;
  // "it", "there", "the new section": the last thing of this kind the plan makes.
  const bare = stripArticles(fromText.replace(/[,.;:!?]+$/g, ''));
  const refLike = REF_WORDS.test(bare) || REF_WORDS.test(t) || !t
    || /^(?:new|same|newly created|just created)(?:\s+one)?$/i.test(t);
  if (allowSteps && refLike) {
    const made = [...R.made].reverse().find((m) => m.kind === kind);
    if (made) return { value: null, ref: { kind: 'step', id: made.stepId, label: `${made.name} (new)` }, fromText, confidence: 0.9 };
    return empty;
  }
  if (allowSteps) {
    const made = [...R.made].reverse().find((m) => m.kind === kind && nameScore(t, m.name) >= 0.85);
    if (made) return { value: null, ref: { kind: 'step', id: made.stepId, label: `${made.name} (new)` }, fromText, confidence: 0.95 };
  }
  const found = findRecord(R.recs, kind, t, { filter });
  if (found.record) {
    return {
      value: found.record.id,
      ref: { kind, id: found.record.id, label: labelOf(kind, found.record, R.recs) },
      candidates: found.candidates.map((r) => ({ id: r.id, label: labelOf(kind, r, R.recs) })),
      fromText,
      confidence: found.confidence,
    };
  }
  return {
    value: null,
    candidates: found.candidates.map((r) => ({ id: r.id, label: labelOf(kind, r, R.recs) })),
    fromText,
    confidence: found.candidates.length ? found.confidence * 0.8 : 0,
  };
}

const score = (f) => (f?.ref ? f.confidence ?? 0 : 0);

/** Split `text` at the rightmost cue whose tail names a record of one of `kinds`. */
function tailTarget(text, cues, kinds, R, { minScore = 0.74 } = {}) {
  const re = new RegExp(`\\b(${cues.join('|')})\\b`, 'gi');
  const hits = [...String(text).matchAll(re)];
  for (let i = hits.length - 1; i >= 0; i -= 1) {
    const h = hits[i];
    const tail = text.slice(h.index + h[0].length).trim();
    if (!tail) continue;
    // "to P159-1": a position code is a position, whatever else it resembles
    const order = POSITION_CODE.test(unmask(tail, R.quotes)) && kinds.includes('position')
      ? ['position', ...kinds.filter((k) => k !== 'position')] : kinds;
    for (const kind of order) {
      const f = entity(kind, tail, R);
      if (f.ref && (f.ref.kind === 'step' || score(f) >= minScore)) return { kind, field: f, head: text.slice(0, h.index).trim(), cue: h[1].toLowerCase() };
      if (!f.ref && f.candidates?.length && f.confidence >= 0.6) return { kind, field: f, head: text.slice(0, h.index).trim(), cue: h[1].toLowerCase() };
    }
  }
  return null;
}

/**
 * Role or position named by `text` — the role unless the words say position (a
 * code, "position"); a PERSON (spec §16.2) when it names neither a role nor a
 * position but one of the company's people.
 */
function roleOrPosition(text, R, { allowPosition = true, allowPerson = false } = {}) {
  const t = unmask(text, R.quotes);
  const saysPosition = POSITION_CODE.test(t) || /\b(position|seat|post|chair)\b/i.test(t);
  const role = entity('role', text, R);
  const position = allowPosition ? entity('position', text, R) : { value: null };
  if (saysPosition && allowPosition && (position.ref || position.candidates?.length)) return { position };
  if (role.ref || role.candidates?.length) return { role };
  if (allowPosition && (position.ref || position.candidates?.length)) return { position };
  if (allowPerson) {
    const person = entity('employee', text, R, { allowSteps: false });
    if (person.ref || person.candidates?.length) return { person };
  }
  return { role };
}

const fieldsOf = (pairs) => Object.fromEntries(Object.entries(pairs).filter(([, v]) => v != null));

/* ── the readers, one per action ───────────────────────────────────────── */

function readDepartment(cl, R) {
  const { masked, quotes } = cl;
  const lower = masked.toLowerCase();
  const label = /\bsection\b/.test(lower) ? 'Section'
    : /\bmachine\b/.test(lower) ? 'Machine'
      : /\b(department|dept|division)\b/.test(lower) ? 'Department' : null;
  const known = R.recs.labels.find((l) => l.toLowerCase() === (label ?? '').toLowerCase())
    ?? R.recs.labels.find((l) => new RegExp(`\\b${escapeRe(l.toLowerCase())}\\b`).test(lower));
  let body = stripLead(masked);
  // Labels of the company's other groups, by name ("… in Unit 2", "… of the Plant area"): taken out of the
  // sentence before the place is read, so "under Production in Unit 2" is Production, labelled Unit 2.
  const others = [];
  for (const l of [...(R.recs.otherLabels ?? [])].sort((a, b) => b.name.length - a.name.length)) {
    if (others.some((o) => o.groupId === l.groupId)) continue;
    // "in Unit 2" / "of the Plant area" — a place word before it, or its group's name after it; and
    // nothing but the end or another cue after it, so "under Plant Maintenance" is not read as the label Plant.
    const name = escapeRe(l.name);
    const after = `(?:\\s+(?:${escapeRe(l.groupName)}|group|label))?(?=\\s*(?:$|[,;.]|\\b(?:under|below|inside|within|in|of|at|and|with|for)\\b))`;
    const m = new RegExp(`\\s*,?\\s*\\b(?:in|of|at|for|from|on|with|labelled|labeled)\\s+(?:the\\s+)?${name}\\b${after}`, 'i').exec(body)
      ?? new RegExp(`\\b${name}\\s+${escapeRe(l.groupName)}\\b(?=\\s*(?:$|[,;.]|\\b(?:under|below|inside|within|in|of|at|and|with|for)\\b))`, 'i').exec(body);
    if (!m) continue;
    others.push(l);
    body = `${body.slice(0, m.index)} ${body.slice(m.index + m[0].length)}`.replace(/\s+/g, ' ').trim();
  }
  let under = null;
  const t = tailTarget(body, ['under', 'below', 'beneath', 'inside', 'within', 'in', 'into', 'of'], ['department'], R, { minScore: 0.8 });
  if (t) { under = t.field; body = t.head; }
  let name = quotedIn(body, quotes)[0] ?? null;
  if (!name) {
    const called = /\b(?:called|named)\s+(.+)$/i.exec(body);
    // "a Machine department Printing 3": a Kind label's name may stand before the thing-word.
    const kindWords = R.recs.labels.map((l) => escapeRe(l)).join('|') || 'department';
    const lead = new RegExp(`^(?:new\\s+|sub-?)?(?:(?:${kindWords})\\s+)?(?:department|dept|section|unit|division|machine)\\s+(?:for\\s+|of\\s+)?`, 'i');
    const raw = called ? called[1] : stripArticles(body)
      .replace(lead, '')
      .replace(/\s+(?:department|dept|section|unit|division|machine)$/i, '');
    name = tidyName(unmask(stripArticles(raw), quotes));
  }
  return {
    name: { value: name || null, fromText: name || null, confidence: name ? (quotedIn(masked, quotes).length ? 1 : 0.85) : 0 },
    label: { value: known ?? R.recs.labels[0] ?? 'Department', fromText: label, confidence: known ? 1 : 0.7 },
    under: under ?? undefined,
    // The other groups' labels: their ids, comma-separated (the screen shows one choice per group).
    labels: others.length
      ? { value: others.map((l) => l.id).join(','), fromText: others.map((l) => l.name).join(', '), confidence: 1 }
      : undefined,
  };
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function readRole(cl) {
  const { masked, quotes } = cl;
  let body = stripLead(masked);
  let purpose = null;
  const p = /\s*,?\s*(?:with (?:the |a )?purpose(?: of)?|whose purpose is|purpose:?)\s+(.+)$/i.exec(body);
  if (p) { purpose = newText(p[1], quotes, 0.85); body = body.slice(0, p.index); }
  const q = quotedIn(body, quotes);
  let title;
  if (q.length) title = q[0];
  else {
    const called = /\b(?:called|named)\s+(.+)$/i.exec(body);
    title = tidyName(unmask((called ? called[1] : body)
      .replace(/^(?:new\s+)?(?:role|job title|job|designation)\s*:?\s*(?:called\s+|named\s+)?(?:(?:for|of|as)\s+)?(?:(?:a|an|the)\s+)?/i, '')
      .replace(/\s+(?:role|job)$/i, ''), quotes));
  }
  return { title: { value: title || null, fromText: title || null, confidence: title ? (q.length ? 1 : 0.85) : 0 }, purpose: purpose ?? undefined };
}

function readContent(cl, R, kind) {
  const { masked, quotes, shape } = cl;
  let body = masked.trim();
  const out = {};
  // "under the KRA Manpower & training"
  if (kind !== 'KRA') {
    const k = /\s*,?\s*under (?:the )?(?:kra|key result area)\s+(.+?)(?=\s+\b(?:to|for|on|of)\b\s|,|$)/i.exec(body);
    if (k) { out.kraText = unmask(k[1], quotes); body = (body.slice(0, k.index) + body.slice(k.index + k[0].length)).trim(); }
  }
  // the KPI's target
  if (kind === 'KPI') {
    const tg = /\s*,?\s*(?:with (?:a |the )?target(?: of)?|target(?: of| is|:)?|against (?:a )?target(?: of)?)\s+(.+?)(?=\s+\b(?:to|for|on)\b\s+(?:the\s+)?[A-Z]|,|$)/i.exec(body);
    if (tg) { out.target = newText(tg[1], quotes, 0.9); body = (body.slice(0, tg.index) + body.slice(tg.index + tg[0].length)).trim(); }
  }
  const nounRe = kind === 'KRA' ? '(?:kras?|key result areas?)' : kind === 'KPI' ? '(?:kpis?|key performance indicators?)' : '(?:responsibilit(?:y|ies)|duty|duties|tasks?|job duty)';
  let text = null;
  let target = null;

  // "only for position P124-1 add the responsibility …" — the target first.
  const front = /^(?:only\s+)?(?:for|on|to)\s+(.+?),?\s+(?=(?:add|create|new|put)\b)/i.exec(body);
  if (front) { target = front[1]; body = body.slice(front[0].length); }

  const shapes = [
    [/^(?:the\s+)?(.+?)\s+(?:is|are)\s+responsible for\s+(.+)$/i, 1, 2],
    [/^make\s+(?:the\s+)?(.+?)\s+responsible for\s+(.+)$/i, 1, 2],
    [/^(?:measure|track)\s+(?:the\s+)?(.+?)\s+on\s+(.+)$/i, 1, 2],
    [/^(?:the\s+)?(.+?)\s+should be measured on\s+(.+)$/i, 1, 2],
    [/^(?:the\s+)?(.+?)\s+should have\s+(?:a|an|the)\s+(?:kra|key result area)\s+(?:for\s+|of\s+|called\s+)?(.+)$/i, 1, 2],
    [/^give\s+(?:the\s+)?(.+?)\s+(?:a|an|the)\s+(?:new\s+)?(?:kras?|kpis?|responsibility|duty|task|key result area)\s+(?:of\s+|called\s+|for\s+)?(.+)$/i, 1, 2],
    [/^(?:the\s+)?(.+?)\s+(?:should|must|needs? to|has to|will)\s+(?:also\s+)?(.+)$/i, 1, 2],
  ];
  if (!target && (shape || /^(make|give|measure|track)\b/i.test(body) || /\bshould\b|\bresponsible for\b/i.test(body))) {
    for (const [re, ti, xi] of shapes) {
      const m = re.exec(body);
      if (m) { target = m[ti]; text = m[xi]; break; }
    }
  }
  if (text == null) {
    // "add a duty to P159-1: inspect the rolls" — target before the colon.
    const colon = body.indexOf(':');
    if (colon > 0) {
      const left = body.slice(0, colon);
      text = body.slice(colon + 1);
      const t = tailTarget(left, ['to', 'for', 'on', 'of'], kind === 'KRA' ? ['role', 'position'] : ['role', 'position', 'employee'], R);
      if (t && !target) target = { field: t.field, kind: t.kind };
    } else {
      const m = new RegExp(`\\b${nounRe}\\b\\s*(?:called\\s+|named\\s+|of\\s+|that\\s+)?`, 'i').exec(body);
      let region = m ? body.slice(m.index + m[0].length) : stripLead(body);
      if (!target) {
        const t = tailTarget(region, ['to', 'for', 'on', 'in', 'of', 'at'], kind === 'KRA' ? ['role'] : ['role', 'position', 'employee'], R);
        if (t) { target = { field: t.field, kind: t.kind }; region = t.head; }
      }
      text = region.replace(/^(?:for|of|about|to)\s+/i, '');
    }
  }
  const q = quotedIn(text ?? '', quotes);
  out.text = q.length ? { value: q[0], fromText: q[0], confidence: 1 } : newText(String(text ?? '').replace(/^[\s:,-]+/, '').replace(/^(?:the\s+)?(?:duty|task|responsibility)\s+(?:of\s+)?/i, ''), quotes);
  if (target && typeof target === 'string') {
    const t = clean(unmask(target, quotes), 'role').replace(/^(?:position|role)\s+/i, '');
    const rp = roleOrPosition(t, R, { allowPosition: kind !== 'KRA', allowPerson: kind !== 'KRA' });
    Object.assign(out, rp);
  } else if (target) {
    out[target.kind === 'employee' ? 'person' : target.kind] = target.field;
  } else {
    out.role = { value: null, fromText: null, confidence: 0 };
  }
  // the KRA it is filed under, among that role's KRAs (or one an earlier step adds)
  if (out.kraText) {
    const personRole = out.person?.ref ? R.recs.positionById.get(R.recs.employees.find((e) => e.id === out.person.ref.id)?.positionId)?.roleId ?? null : null;
    const roleId = out.role?.ref?.kind === 'role' ? out.role.ref.id : out.position?.ref ? R.recs.positionById.get(out.position.ref.id)?.roleId : personRole;
    const roleStep = out.role?.ref?.kind === 'step' ? out.role.ref.id : null;
    const made = [...R.made].reverse().find((m) => m.kind === 'kra' && (roleStep ? m.roleStep === roleStep : true) && nameScore(out.kraText, m.name) >= 0.85);
    if (made) out.kra = { value: null, ref: { kind: 'step', id: made.stepId, label: `${made.name} (new)` }, fromText: out.kraText, confidence: 0.95 };
    else {
      const list = (R.recs.roleKras.get(roleId) ?? []).map((k) => ({ ...k }));
      const scored = list.map((k) => ({ k, s: nameScore(out.kraText, k.name) })).filter((x) => x.s >= 0.7).sort((a, b) => b.s - a.s);
      out.kra = scored.length && (scored.length === 1 || scored[0].s - scored[1].s > 0.04)
        ? { value: scored[0].k.id, ref: { kind: 'kra', id: scored[0].k.id, label: scored[0].k.name }, fromText: out.kraText, confidence: scored[0].s }
        : { value: null, candidates: scored.map((x) => ({ id: x.k.id, label: x.k.name })), fromText: out.kraText, confidence: 0 };
    }
    delete out.kraText;
  }
  return out;
}

const SHIFT_RE = /\b(?:on|in|to|for|into)?\s*(?:the\s+)?([a-z]+)[\s-]+shift\b|\bshift\s+(?:to\s+)?(?:the\s+)?([a-z]+)\b|\b(nights|night|days)\b/i;

/** The shift a clause names ("on the night shift", "shift to Day", "nights"), taken out of it. Only a real shift counts. */
function takeShift(body, R) {
  const re = new RegExp(SHIFT_RE.source, 'gi');
  for (const m of body.matchAll(re)) {
    for (let word of [m[1], m[2], m[3]]) {
      word = String(word ?? '').toLowerCase();
      if (!word) continue;
      if (word === 'nights') word = 'night';
      if (word === 'days') word = 'day';
      const f = entity('shift', word, R, { allowSteps: false });
      if (f.ref && f.confidence >= 0.9) {
        return { body: (body.slice(0, m.index) + ' ' + body.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim(), shift: f };
      }
    }
  }
  return { body, shift: null };
}

function readPosition(cl, R) {
  const { masked } = cl;
  let body = stripLead(masked).replace(/[,.]\s*$/, '');
  const { body: b1, shift } = takeShift(body, R);
  body = b1.replace(/\s*,\s*$/, '');
  let reportsTo = null;
  const rep = /\s*,?\s*(?:reporting (?:to|into)|reports to|report to|who reports to)\s+(.+?)(?=\s+\b(?:in|on|from)\b|,|$)/i.exec(body);
  if (rep) {
    reportsTo = entity('position', rep[1], R);
    body = (body.slice(0, rep.index) + body.slice(rep.index + rep[0].length)).trim();
  }
  let department = null;
  // "… there" / "… in it" with no cue word before the name
  const there = /\s+(?:there|in there|in it|inside it|into it)$/i.exec(body);
  if (there) { department = entity('department', 'it', R); body = body.slice(0, there.index); }
  const t = department ? null : tailTarget(body, ['in', 'into', 'within', 'for', 'at', 'under'], ['department'], R, { minScore: 0.8 });
  if (t) { department = t.field; body = t.head; }
  if (!reportsTo) {
    const u = /\s+under\s+(.+)$/i.exec(body);
    if (u) { reportsTo = entity('position', u[1], R); body = body.slice(0, u.index); }
  }
  const roleText = body
    .replace(/^(?:new\s+|vacant\s+|more\s+)?(?:position|vacancy|seat|post|opening|chair)s?\s*(?:(?:for|of|as)\s+)?(?:(?:a|an|the|one)\s+)?(?:(?:for|of)\s+the\s+role\s+)?/i, '')
    .replace(/^(?:for|of)\s+(?:the\s+)?role\s+/i, '')
    .replace(/\s+(?:position|vacancy|seat|post|opening)s?$/i, '')
    .trim();
  return {
    role: entity('role', roleText, R),
    department: department ?? { value: null, fromText: null, confidence: 0 },
    shift: shift ?? undefined,
    reportsTo: reportsTo ?? undefined,
  };
}

function readShiftChange(cl, R) {
  const { masked } = cl;
  let body = masked.replace(/[,.]\s*$/, '');
  let { body: b1, shift } = takeShift(body, R);
  if (!shift?.ref) {
    // "change the shift of P124-2 to Day"
    const m = /\bto\s+(?:the\s+)?([A-Za-z]+)\s*$/i.exec(b1);
    if (m) {
      const f = entity('shift', m[1], R, { allowSteps: false });
      if (f.ref) { shift = f; b1 = b1.slice(0, m.index); }
    }
  }
  body = b1
    .replace(/^(?:please\s+)?(?:move|change|switch|put|set|make|shift)\s+/i, '')
    .replace(/^(?:the\s+)?shift\s+of\s+/i, '')
    .replace(/\s+(?:should|will|must)\s+work.*$/i, '')
    .replace(/\s+(?:goes|go|moves)\b.*$/i, '')
    .replace(/\s+(?:to|on|onto|into)\s*$/i, '')
    .replace(/\s+shift\s*$/i, '')
    .replace(/\s+a\s*$/i, '')
    .replace(/\s+from now on\s*$/i, '')
    .trim();
  let position = entity('position', body, R);
  if (!position.ref && !position.candidates?.length) {
    // a person's name: the position they hold
    const person = entity('employee', body, R, { allowSteps: false });
    if (person.ref) {
      const pos = R.recs.positionById.get(R.recs.employees.find((e) => e.id === person.ref.id)?.positionId);
      if (pos) position = { value: null, candidates: [{ id: pos.id, label: labelOf('position', pos, R.recs) }], fromText: unmask(body, cl.quotes), confidence: 0.6 };
    }
  }
  return { position, shift: shift ?? { value: null, fromText: null, confidence: 0 } };
}

function readPlacement(cl, R) {
  const { masked } = cl;
  let body = masked.replace(/[,.]\s*$/, '').trim();
  let from;
  const d = /\s*,?\s*\b(?:from|starting(?: from| on)?|with effect from|w\.?e\.?f\.?|effective(?: from)?|on)\s+(.+)$/i.exec(body);
  if (d && readDateWords(d[1])) { from = { value: readDateWords(d[1]), fromText: d[1], confidence: 0.95 }; body = body.slice(0, d.index); }
  const vacant = (r) => r.occupantId == null;
  let empText = null;
  let posText = null;
  let m;
  if ((m = /^(?:please\s+)?make\s+(.+?)\s+(?:the|our)\s+(?:new\s+)?(.+)$/i.exec(body))) { empText = m[1]; posText = m[2]; }
  else if ((m = /^(?:please\s+)?fill\s+(.+?)\s+with\s+(.+)$/i.exec(body))) { posText = m[1]; empText = m[2]; }
  else if ((m = /^(.+?)\s+takes\s+(?:over\s+)?(.+)$/i.exec(body))) { empText = m[1]; posText = m[2]; }
  else {
    const rest = body.replace(/^(?:please\s+)?(?:put|place|move|assign|transfer|appoint|shift|post)\s+/i, '');
    // "X from Printing to Y": the "from" part says where they are now; it is not needed.
    const cue = /\s+\b(?:in|into|to|as|at|on)\b\s+/i;
    const parts = rest.split(cue);
    if (parts.length >= 2) {
      empText = parts[0].replace(/\s+from\s+.+$/i, '');
      posText = rest.slice(rest.search(cue)).replace(cue, '');
    } else empText = rest;
  }
  empText = String(empText ?? '').replace(/^(?:employee|person|mr\.?|mrs\.?|ms\.?)\s+/i, '');
  const employee = /^(?:him|her|them)$/i.test(empText.trim())
    ? { value: null, fromText: empText, confidence: 0 }
    : entity('employee', empText, R, { allowSteps: false });
  let position = { value: null, fromText: null, confidence: 0 };
  if (posText) {
    // "Store Keeper in Stores": a title within a department
    const inDept = /^(.+?)\s+\b(?:in|at)\b\s+(.+)$/i.exec(unmask(posText, cl.quotes));
    let deptId = null;
    let titleText = posText;
    if (inDept) {
      const dept = entity('department', inDept[2], R, { allowSteps: false });
      if (dept.ref) { deptId = dept.ref.id; titleText = inDept[1]; }
    }
    const inside = (r) => (deptId == null || r.departmentId === deptId);
    position = entity('position', titleText, R, { filter: (r) => vacant(r) && inside(r) });
    if (!position.ref && !position.candidates?.length) position = entity('position', titleText, R, { filter: inside });
  }
  return { employee, position, from };
}

const READERS = {
  add_department: (cl, R) => readDepartment(cl, R),
  add_role: (cl) => readRole(cl),
  add_kra: (cl, R) => readContent(cl, R, 'KRA'),
  add_responsibility: (cl, R) => readContent(cl, R, 'RESPONSIBILITY'),
  add_kpi: (cl, R) => readContent(cl, R, 'KPI'),
  add_position: (cl, R) => readPosition(cl, R),
  change_shift: (cl, R) => readShiftChange(cl, R),
  place_person: (cl, R) => readPlacement(cl, R),
};

/** What a step makes, for later steps to point at. */
function madeBy(step) {
  const f = step.fields;
  switch (step.action) {
    case 'add_department': return f.name?.value ? { kind: 'department', name: f.name.value } : null;
    case 'add_role': return f.title?.value ? { kind: 'role', name: f.title.value } : null;
    case 'add_kra': return f.text?.value ? { kind: 'kra', name: f.text.value, roleStep: f.role?.ref?.kind === 'step' ? f.role.ref.id : null } : null;
    case 'add_position': return { kind: 'position', name: f.role?.ref?.label?.replace(/ \(new\)$/, '') ?? f.role?.fromText ?? 'position' };
    default: return null;
  }
}

/**
 * Read a request. -> { plan: { steps }, notUnderstood: [text], stats }
 * `recs` from records.loadRecords (the caller loads them once).
 */
export async function readCommand(text, recs, { useModel = true } = {}) {
  const started = Date.now();
  const src = String(text ?? '').trim();
  if (!src) return { plan: { steps: [] }, notUnderstood: [], stats: { clauses: 0, modelUsed: false, ms: 0 } };
  const { masked, quotes } = maskQuotes(src.slice(0, 4000));
  const R = { recs, quotes, made: [] };
  const steps = [];
  const notUnderstood = [];
  let modelUsed = false;
  let modelNote = null;
  const clauses = splitClauses(masked);
  for (const [i, clause] of clauses.entries()) {
    const sourceText = unmask(clause, quotes);
    let pick = actionByCues(clause);
    if (!pick && useModel) {
      try {
        pick = await actionByMeaning(sourceText);
        modelUsed = true;
      } catch (err) {
        if (!(err instanceof ModelUnavailable)) throw err;
        modelNote = err.reason === 'memory'
          ? 'The server is short of memory, so words that are not plain cue words could not be read by meaning.'
          : 'Reading by meaning is not available right now.';
      }
    }
    const id = `s${i + 1}`;
    if (!pick) {
      notUnderstood.push(sourceText);
      steps.push({ id, action: null, fields: {}, sourceText, confidence: 0 });
      continue;
    }
    const fields = fieldsOf(READERS[pick.action]({ masked: clause, quotes, shape: pick.shape }, R));
    const action = ACTIONS.find((a) => a.key === pick.action);
    const required = action.fields.filter((f) => f.required).map((f) => fields[f.name]);
    const anyOf = action.oneOf ? [Math.max(...action.oneOf.map((n) => (fields[n]?.ref ? fields[n].confidence ?? 0 : 0)))] : [];
    const confidence = Math.round(Math.min(pick.confidence, ...required.map((f) => (f?.ref || f?.value ? f.confidence ?? 0 : 0)), ...anyOf) * 100) / 100;
    const step = { id, action: pick.action, fields, sourceText, confidence, ...(pick.byMeaning ? { byMeaning: true } : {}) };
    steps.push(step);
    const made = madeBy(step);
    if (made) R.made.push({ ...made, stepId: id });
  }
  return {
    plan: { steps },
    notUnderstood,
    notice: modelNote,
    stats: { clauses: clauses.length, modelUsed, ms: Date.now() - started },
  };
}

export default { readCommand, actionByCues, MODEL_FLOOR };
