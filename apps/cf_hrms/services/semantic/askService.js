/**
 * askService.js — "Who owns X?" (CF_HRMS_HIRING_SPEC.md §21).
 *
 * The org chart's search by meaning, widened and turned round: a QUESTION in,
 * PEOPLE out.
 *
 *   1. READ THE QUESTION (`readQuestion`). Leading question words ("who owns",
 *      "who is responsible for", "which position does", …) and trailing kind
 *      words ("… as a KRA") are taken off, so the model compares the WORK with
 *      the lines, not "who is responsible for" with them. "as a KRA / KPI /
 *      responsibility" also narrows the kinds. A trailing "in <place>" whose
 *      place is exactly a location, a label or a department becomes a filter.
 *      The screen shows what was searched for ("Read as: vendor onboarding").
 *   2. MATCH everything that can answer it, ONE embedding of the question:
 *        KRA / RESPONSIBILITY / KPI lines   (definitions, as the old search)
 *        ROLE        a role's title and purpose
 *        POSITION    a position's own title (only where it differs from its role's)
 *        DEPARTMENT  a department's name with its labels
 *        LOCATION    a location's name
 *      Vectors from hrms_search_vectors (searchIndex.js: the per-process cache,
 *      freshness by hash, at most INLINE_CAP embedded inline). Score as the old
 *      search: (cosine + 0.3 x keyword) / 1.3; the structure kinds need a higher
 *      cosine, and a department or location only says WHERE someone works, so it
 *      counts for less than a line they own.
 *   3. MAP ONTO PEOPLE. Every live position's effective lines (role → position)
 *      and every holder's own layer on top (role → position → PERSON,
 *      contentResolver.effectiveLinesForAssignments) — a fixed number of
 *      company-wide queries, nothing per row. A person collects the matches of
 *      every position they hold; several matching lines rank a person higher.
 *      Vacant positions that match come after the people, as positions.
 *
 * THE MEMORY GUARD is the embedder's, unchanged: when the model cannot load the
 * answer is by exact words (every word of what was searched for must appear),
 * `mode: 'keyword'` and a one-line notice.
 *
 * RIGHTS: `positions_view`, as the chart. A department-scoped login (§12.3)
 * gets PEOPLE from its scope only; positions — structure — stay company-wide,
 * with the names of people outside the scope left out.
 */
import { invalid } from '../../lib/errors.js';
import { dateText, today, LIVE_ON } from '../positionService.js';
import { HOLDS_SEAT_SQL } from '../seatCount.js';
import { loadCards } from '../positionCards.js';
import { effectiveLinesForPositions, effectiveLinesForAssignments } from '../contentResolver.js';
import { DEPARTMENT_LABELS_SQL, parseLabelList, labelIndex, labelMatcher } from '../labelGroupService.js';
import { embed, dot, ModelUnavailable } from './embedder.js';
import { loadDefinitions, loadEntities, vectorsFor } from './searchIndex.js';

/* ══ the kinds a question can be limited to ═══════════════════════════════ */

/** What the person ticks: three kinds of line, and two of structure. */
export const ASK_KINDS = ['KRA', 'RESPONSIBILITY', 'KPI', 'ROLE', 'DEPARTMENT'];
const LINE_KINDS = ['KRA', 'RESPONSIBILITY', 'KPI'];
/** Each ticked structure kind and the index kinds it reads. */
const ENTITY_OF = { ROLE: ['ROLE', 'POSITION'], DEPARTMENT: ['DEPARTMENT', 'LOCATION'] };
const KIND_ALIAS = {
  KRA: 'KRA', KRAS: 'KRA',
  RESPONSIBILITY: 'RESPONSIBILITY', RESPONSIBILITIES: 'RESPONSIBILITY',
  KPI: 'KPI', KPIS: 'KPI',
  ROLE: 'ROLE', ROLES: 'ROLE',
  DEPARTMENT: 'DEPARTMENT', DEPARTMENTS: 'DEPARTMENT',
};

export function readAskKinds(value) {
  if (value == null || value === '') return null;
  const parts = (Array.isArray(value) ? value : String(value).split(','))
    .map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  const unknown = parts.filter((p) => !KIND_ALIAS[p]);
  if (unknown.length) throw invalid('INVALID', `Unknown kind: ${unknown.join(', ')}. Use KRA, RESPONSIBILITY, KPI, ROLE or DEPARTMENT.`);
  const kinds = ASK_KINDS.filter((k) => parts.some((p) => KIND_ALIAS[p] === k));
  if (!kinds.length) throw invalid('INVALID', 'Choose at least one kind.');
  return kinds;
}

/* ══ 1. reading the question ══════════════════════════════════════════════ */

/**
 * Taken off the FRONT, longest first, again and again ("tell me who owns …").
 * Only phrases that say "find the person" — never a verb that is the work
 * itself: "who prepares the dispatch plan" keeps "prepares", "who trains new
 * operators" keeps "trains".
 */
export const QUESTION_LEADS = [
  'can you tell me', 'could you tell me', 'i want to know', 'do you know', 'tell me', 'show me', 'find me', 'find out', 'please', 'find',
  'who is the person responsible for', 'who is the owner of', 'who is the one responsible for',
  'who is responsible for', "who's responsible for", 'who are responsible for', 'who is accountable for', "who's accountable for",
  'who are accountable for', 'who is in charge of', "who's in charge of", 'who is incharge of', 'who are in charge of',
  'who takes care of', 'who take care of', 'who looks after', 'who look after', 'who is looking after', 'who deals with', 'who deal with',
  'who is handling', 'who handles', 'who handle', 'who owns', 'who own',
  'whose job is to', 'whose job is', 'whose kra is', 'whose kpi is',
  'who has', 'who have', 'who all', 'who is', "who's", 'who are', 'who does', 'who do', 'who will', 'who should', 'who can', 'who',
  'which positions are responsible for', 'which position is responsible for', 'which role is responsible for',
  'which department is responsible for', 'which positions', 'which position does', 'which position', 'which roles', 'which role',
  'which person', 'which people', 'which department', 'which team', 'what position', 'what role',
  'is there anyone who', 'is there someone who', 'is anyone', 'does anyone', 'anyone who', 'someone who',
  'the person who', 'the one who', 'person who', 'people who',
];
/** Then, once a question word has gone, these fillers too (also repeatedly). */
export const QUESTION_FILLERS = [
  'the person responsible for', 'the owner of', 'responsible for', 'accountable for', 'in charge of', 'incharge of', 'owner of',
  'takes care of', 'take care of', 'looks after', 'look after', 'deals with', 'deal with', 'handles', 'handle', 'handling',
  'is', 'are', 'does', 'do', 'will', 'should', 'can',
];
/** Then leading articles. */
export const LEADING_ARTICLES = ['the', 'a', 'an', 'our', 'any', 'all'];
/** Taken off the END; the kind they name narrows the search. */
const TRAILING_KIND = /\s+(?:as|in|among)\s+(?:a|an|their|his|her|one of (?:their|his|her|the))?\s*(kras?|kpis?|responsibilit(?:y|ies)|key result areas?|key performance indicators?)$/i;
const KIND_WORD = (w) => (/^kra|^key result/i.test(w) ? 'KRA' : /^kpi|^key performance/i.test(w) ? 'KPI' : 'RESPONSIBILITY');
/** Not counted as words a line must contain. */
const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'to', 'and', 'or', 'in', 'on', 'at', 'by', 'with', 'our', 'their', 'his', 'her', 'is', 'are', 'be', 'all', 'any']);

const norm = (s) => String(s ?? '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
const sorted = (list) => [...list].sort((a, b) => b.length - a.length);
const LEADS = sorted(QUESTION_LEADS);
const FILLERS = sorted(QUESTION_FILLERS);

function stripFront(text, phrases) {
  const lower = text.toLowerCase();
  for (const p of phrases) {
    if (lower === p) return { rest: '', took: text };
    if (lower.startsWith(`${p} `)) return { rest: text.slice(p.length + 1).trim(), took: text.slice(0, p.length) };
  }
  return null;
}

/**
 * "Who is responsible for collections?" -> { searchedFor: 'collections', stripped: ['Who is responsible for', '?'], kinds: null }
 * `places` (optional): { name(lower) -> { kind, id, name } } — a trailing "in <place>" that is one of them becomes a filter.
 */
export function readQuestion(q, places = null) {
  const asked = norm(q);
  let text = asked;
  const stripped = [];
  const end = text.match(/[?.!]+$/);
  if (end) { stripped.push(end[0]); text = text.slice(0, -end[0].length).trim(); }

  let kinds = null;
  const kindTail = text.match(TRAILING_KIND);
  if (kindTail && kindTail.index > 0) {
    kinds = [KIND_WORD(kindTail[1])];
    stripped.push(kindTail[0].trim());
    text = text.slice(0, kindTail.index).trim();
  }

  let asked1 = false;
  for (let guard = 0; guard < 8; guard += 1) {
    const hit = stripFront(text, LEADS) ?? (asked1 ? stripFront(text, FILLERS) : null);
    if (!hit || !hit.rest) break;
    asked1 = true;
    stripped.push(hit.took);
    text = hit.rest;
  }
  for (let guard = 0; guard < 3; guard += 1) {
    const hit = stripFront(text, LEADING_ARTICLES);
    if (!hit || !hit.rest) break;
    stripped.push(hit.took);
    text = hit.rest;
  }

  // "… in Unit 2": the first " in " / " at " whose tail is exactly a place.
  let place = null;
  if (places && places.size) {
    const re = /\s(in|at)\s+(?:the\s+)?/gi;
    let m;
    while ((m = re.exec(text))) {
      const head = text.slice(0, m.index).trim();
      const tail = text.slice(m.index + m[0].length).trim();
      const found = head && places.get(tail.toLowerCase());
      if (found) {
        place = found;
        stripped.push(text.slice(m.index).trim());
        text = head;
        break;
      }
    }
  }

  const words = text.split(/\s+/).filter((w) => w && !STOP.has(w.toLowerCase())).slice(0, 8);
  return { asked, searchedFor: text, stripped, kinds, place, words: words.length ? words : text.split(/\s+/).filter(Boolean).slice(0, 8) };
}

/* ══ 2. matching ══════════════════════════════════════════════════════════ */

export const LINE_FLOOR = 0.45;
const ENTITY_FLOOR = { ROLE: 0.5, POSITION: 0.5, DEPARTMENT: 0.55, LOCATION: 0.55 };
/** Where someone works says less than a line they own. */
const ENTITY_WEIGHT = { ROLE: 1, POSITION: 1, DEPARTMENT: 0.85, LOCATION: 0.85 };
const KEYWORD_WEIGHT = 0.3;
const MATCHES_SHOWN = 6;
const MEMORY_NOTICE = 'The server is short of memory right now, so search by meaning is paused and these are the answers that contain every word you asked about.';
const MODEL_NOTICE = 'Search by meaning is not available right now, so these are the answers that contain every word you asked about.';

/** As orgChartService.keywordSignal, over the words that matter. */
function keyword(phraseText, words, text) {
  const t = String(text ?? '').toLowerCase().replace(/\s+/g, ' ');
  const lw = words.map((w) => w.toLowerCase());
  const present = lw.filter((w) => t.includes(w)).length;
  const all = lw.length > 0 && present === lw.length;
  const phrase = all && phraseText.length > 0 && t.includes(phraseText.toLowerCase());
  return { all, phrase, keyword: phrase ? 1 : all ? 0.6 : 0.3 * (lw.length ? present / lw.length : 0) };
}
const blend = (cosine, kw) => Math.max(0, Math.min(1, (cosine + KEYWORD_WEIGHT * kw) / (1 + KEYWORD_WEIGHT)));
const round3 = (n) => Math.round(n * 1000) / 1000;

/** -> { matches: Map(`${kind}:${id}` -> match), pending, mode, notice } */
async function matchAll(db, companyId, { lineKinds, entityKinds, reading, mode }) {
  const [defs, ents] = await Promise.all([
    lineKinds.length ? loadDefinitions(db, companyId, lineKinds) : [],
    entityKinds.length ? loadEntities(db, companyId, entityKinds) : [],
  ]);
  const all = [...defs, ...ents];
  const { searchedFor, words } = reading;
  let usedMode = mode;
  let notice = null;
  let pending = 0;
  let queryVec = null;
  let vectors = new Map();
  if (usedMode === 'meaning' && all.length) {
    try {
      [queryVec] = await embed([searchedFor]);
      const got = await vectorsFor(db, companyId, all);
      vectors = got.vectors;
      pending = got.pending.length;
      if (pending) notice = `${pending} recently changed item${pending === 1 ? ' was' : 's were'} matched by exact words only this time.`;
    } catch (err) {
      if (!(err instanceof ModelUnavailable)) throw err;
      usedMode = 'keyword';
      notice = err.reason === 'memory' ? MEMORY_NOTICE : MODEL_NOTICE;
    }
  }
  const matches = new Map();
  for (const d of all) {
    const key = `${d.kind}:${d.id}`;
    const kw = keyword(searchedFor, words, d.text);
    const isLine = LINE_KINDS.includes(d.kind);
    let score;
    let similarity = null;
    if (usedMode === 'meaning') {
      const vec = vectors.get(key);
      similarity = vec ? dot(queryVec, vec) : null;
      const floor = isLine ? LINE_FLOOR : ENTITY_FLOOR[d.kind];
      if (!(kw.all || (similarity != null && similarity >= floor))) continue;
      score = blend(similarity ?? floor, kw.keyword) * (isLine ? 1 : ENTITY_WEIGHT[d.kind]);
    } else {
      if (!kw.all) continue;
      score = isLine ? 1 : ENTITY_WEIGHT[d.kind];
    }
    matches.set(key, {
      kind: d.kind,
      id: d.id,
      text: d.text.length > 300 ? `${d.text.slice(0, 297).trimEnd()}...` : d.text,
      name: d.name ?? null,
      score: round3(score),
      similarity: similarity == null ? null : round3(similarity),
      how: kw.phrase ? 'has these words' : kw.all ? 'has every word' : 'close in meaning',
    });
  }
  return { matches, pending, mode: usedMode, notice };
}

/* ══ 3. the answer ════════════════════════════════════════════════════════ */

const KIND_WORD_OUT = { KRA: 'KRA', RESPONSIBILITY: 'Responsibility', KPI: 'KPI' };

function lineWhy(m, line, roleTitle, forPerson) {
  const kind = KIND_WORD_OUT[m.kind];
  let where;
  if (line.layer === 'PERSON') where = line.origin === 'ASSIGNMENT' ? `${kind} added for this person` : `${kind} changed for this person`;
  else if (line.layer === 'POSITION') where = line.origin === 'POSITION' ? `${kind} added for ${forPerson ? 'their position' : 'this position'}` : `${kind} changed for ${forPerson ? 'their position' : 'this position'}`;
  else where = `${kind} of the role ${roleTitle}`;
  return `${where} · ${m.how}`;
}

function entityWhy(m, forPerson) {
  if (m.kind === 'ROLE') return `The role ${m.name} — its title or purpose · ${m.how}`;
  if (m.kind === 'POSITION') return `The position's own title · ${m.how}`;
  if (m.kind === 'DEPARTMENT') return `${forPerson ? 'Works in' : 'In'} ${m.name} · ${m.how}`;
  return `${forPerson ? 'Works at' : 'At'} ${m.name} · ${m.how}`;
}

const outMatch = (m, why, layer = null, positionId = null) => ({
  kind: m.kind, id: m.id, text: m.text, score: m.score, similarity: m.similarity, layer, why, positionId,
});

/** Best match first; each further matching line adds a little (at most five count), so several lines rank a person higher. */
const rankOf = (best, count) => best + 0.01 * Math.min(Math.max(count - 1, 0), 5);

/**
 * @param opts.q          the question
 * @param opts.kinds      comma list of ASK_KINDS (default: what the question names, else all five)
 * @param opts.mode       meaning (default) | exact
 * @param opts.on         date (default today)
 * @param opts.department department id — that department and every one below it
 * @param opts.label      label ids (or names), comma list — labelGroupService rule (any of within a group, all groups)
 * @param opts.location   location id
 * @param opts.limit      people / positions returned (default 30, max 200)
 * @param opts.scope      accessScope answer ({ all: true } or { departmentIds })
 */
export async function askWhoOwns(db, companyId, opts = {}) {
  const asOf = dateText(opts.on) || today();
  const raw = norm(opts.q);
  if (!raw) throw invalid('INVALID', 'Type a question — for example "Who owns vendor onboarding?"');
  const mode = opts.mode == null || opts.mode === '' ? 'meaning' : String(opts.mode).trim().toLowerCase();
  if (!['meaning', 'exact'].includes(mode)) throw invalid('INVALID', 'mode is "meaning" or "exact".');
  const cap = Math.min(Math.max(Number(opts.limit) || 30, 1), 200);
  const scope = opts.scope ?? { all: true };
  const asId = (v, what) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw invalid('INVALID', `${what} must be an id.`);
    return n;
  };
  const departmentId = asId(opts.department, 'department');
  const locationId = asId(opts.location, 'location');
  const labelValue = opts.label == null ? '' : String(opts.label).trim();
  const explicitKinds = readAskKinds(opts.kinds);

  // The structure, read once: departments (with labels), locations, labels by name.
  const [[departments], [locations], labels, cardsAll] = await Promise.all([
    db.query(`SELECT d.id, d.name, d.parent_department_id, ${DEPARTMENT_LABELS_SQL('d')} AS label_list
                FROM hrms_departments d WHERE d.company_id = ? AND d.deleted_at IS NULL`, [companyId]),
    db.query('SELECT id, name FROM hrms_locations WHERE company_id = ? AND deleted_at IS NULL', [companyId]),
    labelIndex(db, companyId),
    loadCards(db, companyId, asOf),
  ]);
  const deptById = new Map(departments.map((d) => [Number(d.id), { ...d, labels: parseLabelList(d.label_list) }]));
  const locById = new Map(locations.map((l) => [Number(l.id), l]));
  const labelById = new Map();
  for (const d of deptById.values()) for (const l of d.labels) labelById.set(l.labelId, l);

  // Places a trailing "in …" may name: a location, else a label, else a department (exact name, any case).
  const places = new Map();
  for (const d of deptById.values()) places.set(d.name.trim().toLowerCase(), { kind: 'DEPARTMENT', id: Number(d.id), name: d.name });
  for (const l of labelById.values()) places.set(l.name.trim().toLowerCase(), { kind: 'LABEL', id: l.labelId, name: l.name, groupName: l.groupName });
  for (const l of locById.values()) places.set(l.name.trim().toLowerCase(), { kind: 'LOCATION', id: Number(l.id), name: l.name });
  const reading = readQuestion(raw, places);
  if (!reading.searchedFor) throw invalid('INVALID', 'Say what the work is — for example "Who owns vendor onboarding?"');

  const kinds = explicitKinds ?? reading.kinds ?? [...ASK_KINDS];
  const lineKinds = kinds.filter((k) => LINE_KINDS.includes(k));
  const entityKinds = kinds.flatMap((k) => ENTITY_OF[k] ?? []);

  // Filters: what was asked for wins over a place read from the question.
  let deptFilter = departmentId;
  let locFilter = locationId;
  let labelFilter = labelValue;
  const place = reading.place;
  if (place?.kind === 'DEPARTMENT' && deptFilter == null) deptFilter = place.id;
  if (place?.kind === 'LOCATION' && locFilter == null) locFilter = place.id;
  if (place?.kind === 'LABEL' && !labelFilter) labelFilter = String(place.id);
  const below = new Set();
  if (deptFilter != null) {
    const kids = new Map();
    for (const d of deptById.values()) {
      const p = d.parent_department_id == null ? null : Number(d.parent_department_id);
      if (p != null) kids.set(p, [...(kids.get(p) ?? []), Number(d.id)]);
    }
    const walk = [deptFilter];
    while (walk.length) { const id = walk.pop(); if (below.has(id)) continue; below.add(id); walk.push(...(kids.get(id) ?? [])); }
  }
  const inLabels = labelFilter ? labelMatcher(labels, labelFilter) : null;

  const [{ matches, pending, mode: usedMode, notice }, [positionRows], [holderRows]] = await Promise.all([
    matchAll(db, companyId, { lineKinds, entityKinds, reading, mode }),
    db.query(
      `SELECT p.id, p.role_id, p.position_code, p.department_id, p.location_id,
              COALESCE(NULLIF(TRIM(p.position_title), ''), r.title) AS title, r.title AS role_title
         FROM hrms_positions p
         JOIN hrms_roles r ON r.company_id = p.company_id AND r.id = p.role_id
        WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.status <> 'CLOSED' AND ${LIVE_ON('p')}
        ORDER BY p.position_code, p.id`,
      [companyId, asOf, asOf],
    ),
    db.query(
      `SELECT wa.id AS assignment_id, wa.position_id, wa.role_id, wa.employee_id, e.full_name, e.employee_code
         FROM hrms_work_assignments wa
         JOIN hrms_employees e ON e.company_id = wa.company_id AND e.id = wa.employee_id AND e.deleted_at IS NULL
        WHERE wa.company_id = ? AND ${HOLDS_SEAT_SQL('wa')} AND ${LIVE_ON('wa')}
        ORDER BY wa.is_primary DESC, e.full_name, wa.id`,
      [companyId, asOf, asOf],
    ),
  ]);

  const positions = positionRows.filter((p) => {
    const dept = p.department_id == null ? null : Number(p.department_id);
    if (deptFilter != null && !below.has(dept)) return false;
    if (locFilter != null && Number(p.location_id) !== locFilter) return false;
    if (inLabels && !(dept != null && inLabels(dept))) return false;
    return true;
  });
  const positionById = new Map(positions.map((p) => [Number(p.id), p]));
  const holders = holderRows.filter((h) => positionById.has(Number(h.position_id)));
  const holdersOf = new Map();
  for (const h of holders) holdersOf.set(Number(h.position_id), [...(holdersOf.get(Number(h.position_id)) ?? []), h]);

  const anyLine = [...matches.values()].some((m) => LINE_KINDS.includes(m.kind));
  const positionLines = anyLine
    ? await effectiveLinesForPositions(db, companyId, positions.map((p) => ({ id: p.id, roleId: p.role_id })), { on: asOf, kinds: lineKinds })
    : new Map();
  const personLines = anyLine && holders.length
    ? await effectiveLinesForAssignments(
      db, companyId,
      holders.map((h) => ({ workAssignmentId: h.assignment_id, positionId: h.position_id, roleId: h.role_id })),
      { on: asOf, kinds: lineKinds, positionLines },
    )
    : new Map();

  /** The structure matches of one position: its role, own title, department, location. */
  const structureOf = (p, forPerson) => {
    const out = [];
    const add = (key) => { const m = matches.get(key); if (m) out.push(outMatch(m, entityWhy(m, forPerson), null, Number(p.id))); };
    add(`ROLE:${p.role_id}`);
    add(`POSITION:${p.id}`);
    if (p.department_id != null) add(`DEPARTMENT:${p.department_id}`);
    if (p.location_id != null) add(`LOCATION:${p.location_id}`);
    return out;
  };
  const linesMatched = (lines, p, forPerson) => {
    const out = [];
    for (const line of lines ?? []) {
      const m = matches.get(`${line.kind}:${line.definitionId}`);
      if (m) out.push(outMatch(m, lineWhy(m, line, p.role_title, forPerson), line.layer, Number(p.id)));
    }
    return out;
  };
  const best = (list) => {
    const seen = new Map();
    for (const m of list) {
      const k = `${m.kind}:${m.id}`;
      if (!seen.has(k) || seen.get(k).score < m.score) seen.set(k, m);
    }
    return [...seen.values()].sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind) || a.id - b.id);
  };
  const shapePosition = (p) => {
    const dept = p.department_id == null ? null : deptById.get(Number(p.department_id));
    return {
      positionId: Number(p.id),
      cardId: cardsAll.cardOf.get(Number(p.id)) ?? Number(p.id),
      positionCode: p.position_code ?? null,
      title: p.title,
      roleTitle: p.role_title,
      departmentId: dept ? Number(dept.id) : null,
      departmentName: dept?.name ?? null,
      locationName: p.location_id == null ? null : locById.get(Number(p.location_id))?.name ?? null,
    };
  };
  const inScope = (p) => scope.all || (p.department_id != null && scope.departmentIds?.has(Number(p.department_id)));

  // ── positions (the structure: company-wide) ──
  const positionHits = [];
  for (const p of positions) {
    const hit = best([...linesMatched(positionLines.get(Number(p.id)), p, false), ...structureOf(p, false)]);
    const held = holdersOf.get(Number(p.id)) ?? [];
    // A person's own lines can make a filled position match although the seat's lines do not.
    const personOnly = held.some((h) => linesMatched(personLines.get(Number(h.assignment_id)), p, true).length);
    if (!hit.length && !personOnly) continue;
    const shown = held.filter(() => inScope(p));
    positionHits.push({
      ...shapePosition(p),
      vacant: held.length === 0,
      occupants: shown.map((h) => ({ employeeId: Number(h.employee_id), name: h.full_name, employeeCode: h.employee_code ?? null })),
      hiddenOccupants: held.length - shown.length,
      sentence: held.length === 0 ? `No one — the position ${p.position_code ?? p.title} is vacant` : null,
      score: hit[0]?.score ?? 0,
      rank: hit.length ? rankOf(hit[0].score, hit.length) : 0,
      matchCount: hit.length,
      matches: hit.slice(0, MATCHES_SHOWN),
    });
  }

  // ── people (scoped) ──
  const people = new Map();
  for (const h of holders) {
    const p = positionById.get(Number(h.position_id));
    if (!inScope(p)) continue;
    const found = [...linesMatched(personLines.get(Number(h.assignment_id)), p, true), ...structureOf(p, true)];
    const key = Number(h.employee_id);
    if (!people.has(key)) {
      people.set(key, { employeeId: key, name: h.full_name, employeeCode: h.employee_code ?? null, positions: [], all: [] });
    }
    const person = people.get(key);
    if (!person.positions.some((x) => x.positionId === Number(p.id))) person.positions.push(shapePosition(p));
    person.all.push(...found);
  }
  const peopleHits = [];
  for (const person of people.values()) {
    const list = best(person.all);
    if (!list.length) continue;
    // The positions that brought a match first.
    const matchedIds = new Set(list.map((m) => m.positionId));
    person.positions.sort((a, b) => Number(matchedIds.has(b.positionId)) - Number(matchedIds.has(a.positionId)));
    peopleHits.push({
      employeeId: person.employeeId,
      name: person.name,
      employeeCode: person.employeeCode,
      positions: person.positions,
      score: list[0].score,
      rank: rankOf(list[0].score, list.length),
      matchCount: list.length,
      matches: list.slice(0, MATCHES_SHOWN),
    });
  }
  const byRank = (a, b) => b.rank - a.rank || b.matchCount - a.matchCount;
  peopleHits.sort((a, b) => byRank(a, b) || String(a.name).localeCompare(String(b.name)));
  positionHits.sort((a, b) => byRank(a, b) || String(a.positionCode ?? '').localeCompare(String(b.positionCode ?? '')));
  const vacant = positionHits.filter((p) => p.vacant);

  const labelNames = labelFilter
    ? String(labelFilter).split(',').map((t) => t.trim()).filter(Boolean)
      .map((t) => (/^\d+$/.test(t) ? labelById.get(Number(t))?.name ?? t : t))
    : [];
  return {
    question: reading.asked,
    reading: {
      asked: reading.asked,
      searchedFor: reading.searchedFor,
      stripped: reading.stripped,
      kindsFromQuestion: reading.kinds,
      place: reading.place,
    },
    mode: usedMode,
    notice,
    kinds,
    pending,
    asOf,
    filters: {
      department: deptFilter == null ? null : { id: deptFilter, name: deptById.get(deptFilter)?.name ?? null },
      location: locFilter == null ? null : { id: locFilter, name: locById.get(locFilter)?.name ?? null },
      labels: labelNames,
    },
    scoped: !scope.all,
    totals: { people: peopleHits.length, positions: positionHits.length, vacant: vacant.length },
    people: peopleHits.slice(0, cap),
    positions: positionHits.slice(0, cap),
    vacant: vacant.slice(0, cap),
  };
}

export default { askWhoOwns, readQuestion, readAskKinds, ASK_KINDS, QUESTION_LEADS, QUESTION_FILLERS };
