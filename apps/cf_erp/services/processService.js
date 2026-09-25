/**
 * processService.js — how an order is worked, and where each of its lines has
 * got to (models/init.sql §18).
 *
 * A PROCESS is an ordered list of STAGES. A stage KIND is code — a screen
 * somebody wrote — so the seven kinds live in STAGE_CATALOGUE below and no
 * amount of configuration conjures an eighth. What varies is data: which
 * stages a customer gets, in what order, whether each is required, and
 * whether a particular line needs it at all.
 *
 * ── THE THREE ANSWERS EVERY STAGE GIVES ──────────────────────────────────────
 *
 *   applies      does this line need this stage?
 *   decidedBy    who said so — 'always', the DATA, or a DECLARED specification
 *   state        todo | partial | done | not_applicable
 *
 * `decidedBy` is not decoration. Applicability is worked out from the data
 * (decision 2) — "this line has a BOM, so it has a structure" — and that is
 * the right default, because the data already knows and nobody should have to
 * tell it twice. But a line can overrule it: a stage with `override_spec_id`
 * asks that specification of the line's item, and a resolved true/false wins
 * (decision 3). Both answers are legitimate and they look identical on screen,
 * so every stage says which one it gave.
 *
 * ── STAGES ARE PER LINE ──────────────────────────────────────────────────────
 *
 * One line can be at nesting while another is still being drawn. The order is
 * the ROLL-UP of its lines, and the roll-up is deliberately pessimistic: a
 * stage is `done` for the order only when every line it applies to is done,
 * and `not_applicable` only when it applies to no line at all.
 *
 * ── WHAT THIS FILE OWES fab_erp ──────────────────────────────────────────────
 *
 * `fab_erp/services/orderReadinessService.js` argued all of this out first and
 * the debt is worth naming. Its three lessons, kept here:
 *
 *   1. ONE object, computed server-side. The wizard rail, the order strip and
 *      the Confirm refusal all read the same `stages` array, so they cannot
 *      contradict each other.
 *   2. NAME THE OFFENDER. "1 part without a size" is a search; "1 part without
 *      a size — Stiffener Plate 16 × 150" is a row to go and find.
 *   3. A STAGE THAT DOES NOT APPLY IS REPORTED, NEVER HIDDEN. A stage that
 *      vanishes leaves somebody wondering whether they forgot it.
 *
 * Nothing here blocks anything except confirmation. `blockers` are things
 * worth knowing before pressing a button, not permission to press it.
 */
import { invalid, notFound, conflict, assertNoProblems } from '../lib/errors.js';
import { explode } from './bomService.js';
import { availability } from './releaseService.js';

export const PROCESS_STATUSES = ['draft', 'active', 'obsolete'];
export const STAGE_REQUIREMENTS = ['required', 'optional'];
export const PROCESS_ORDER_TYPES = ['customer', 'stock'];
export const STAGE_STATES = ['todo', 'partial', 'done', 'not_applicable'];

/**
 * The specification a material answers to say it must be nested. A code, not
 * an id: the seven kinds are code, and so is the one question a kind asks of
 * the catalogue. A company that has never created it simply never sees the
 * nesting stage apply.
 */
export const NESTING_SPEC_CODE = 'NESTING';

const EPS = 1e-9;
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_\-./]*$/;
const blank = (v) => v == null || String(v).trim() === '';
const round6 = (n) => Number(Number(n).toFixed(6));

/** "1 row", "82 rows" — never "row(s)". */
const n = (count, word, plural = `${word}s`) => `${Number(count).toLocaleString('en-IN')} ${Number(count) === 1 ? word : plural}`;

/** "A, B and 3 more" — enough to go and find the thing, not a wall of names. */
function nameList(names, max = 2) {
  const shown = names.slice(0, max).join(', ');
  const rest = names.length - max;
  return rest > 0 ? `${shown} and ${n(rest, 'more', 'more')}` : shown;
}

const nameOf = (x) => x?.code ?? x?.name ?? '(unnamed)';
const readSettings = (v) => {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
};

// ── the stage catalogue — CODE, because each kind is a screen ────────────────

/**
 * `ctx` is one LINE's context, built once per order by `loadOrderContext` and
 * handed to every stage. Each kind answers two questions about it:
 *
 *   applies(ctx) -> boolean   is there anything of this kind to do here?
 *   state(ctx)   -> { state, detail, blockers[] }
 *
 * APPLICABILITY IS "IS THERE SOMETHING OF THIS KIND TO DEAL WITH", NOT "IS
 * SOMETHING OUTSTANDING". The difference only shows once the work is finished,
 * and it matters there: a `values` stage that turned `not_applicable` the
 * moment its last value was filled would claim it never applied, when what
 * actually happened is that somebody did it. So `applies` asks whether the
 * line has values to capture / material to source at all, and `state` says
 * whether any of it is outstanding.
 */
export const STAGE_CATALOGUE = [
  {
    key: 'lines',
    label: 'Line items',
    description: 'What the order sells: an item, how many, and by when.',
    /** Always: an order with no lines sells nothing, which is itself the answer. */
    always: true,
    applies: () => true,
    state(ctx) {
      const { line, order } = ctx;
      const blockers = [];
      if (!line.item_id) {
        return {
          state: 'todo',
          detail: 'Nothing chosen to sell yet',
          blockers: [{ count: 0, message: `Line ${line.line_no} has no item — choose a catalog item or a template.` }],
        };
      }
      const problems = [];
      if (!(Number(line.quantity) > 0)) problems.push('no quantity');
      // A DRAFT item is not this stage's business. Every custom line's item is
      // born draft (instantiationService) and stays so until the structure
      // under it is settled — which is the `structure` stage's whole job, and
      // where it is already counted. Reporting it twice would make a line that
      // has only just been added look broken in two places at once. Obsolete
      // is different: selling a retired item is a line-level mistake.
      if (line.item_status === 'obsolete') problems.push(`${nameOf(line)} is obsolete`);
      // Confirming needs a date somewhere — on the order or on every line
      // (salesOrderService.setOrderStatus). Saying so here, on the step that
      // owns the line, beats finding out at the Confirm button.
      if (order.order_type === 'customer' && !order.committed_date && !line.committed_date) problems.push('no committed date');
      for (const p of problems) blockers.push({ count: 0, message: `Line ${line.line_no}: ${p}.` });
      return {
        state: problems.length ? 'partial' : 'done',
        detail: problems.length
          ? `${nameOf(line)} — ${problems.join(', ')}`
          : `${Number(line.quantity)} × ${nameOf(line)}`,
        blockers,
      };
    },
  },
  {
    key: 'structure',
    label: 'Structure',
    description: 'What the thing sold is made of — its BOM, drawn or copied from a template.',
    /** The data knows: the line sells something with a BOM, or built from a template. */
    applies: (ctx) => ctx.hasBom || ctx.fromTemplate,
    state(ctx) {
      const { tree, unresolved, drafts } = ctx;
      const rows = tree ? tree.stats.nodes - 1 : 0;   // the root is the thing sold, not part of it
      const blockers = [];
      if (rows === 0) {
        return {
          state: 'todo',
          detail: ctx.fromTemplate ? 'Built from a template, but nothing in it yet' : 'No parts yet',
          blockers: [{ count: 0, message: `Line ${ctx.line.line_no} has no structure yet, so there is nothing to make.` }],
        };
      }
      if (unresolved.length) {
        blockers.push({
          count: unresolved.length,
          message: `${n(unresolved.length, 'row')} under line ${ctx.line.line_no} still need an item chosen — ${nameList(unresolved.map(nameOf), 3)}.`,
        });
      }
      if (drafts.length) {
        blockers.push({
          count: drafts.length,
          message: `${n(drafts.length, 'row')} under line ${ctx.line.line_no} are still drafts — ${nameList(drafts.map(nameOf), 3)}.`,
        });
      }
      return {
        state: blockers.length ? 'partial' : 'done',
        detail: unresolved.length
          ? `${n(unresolved.length, 'row')} still to choose an item for — ${nameList(unresolved.map(nameOf))}`
          : drafts.length
            ? `${n(drafts.length, 'row')} still a draft — ${nameList(drafts.map(nameOf))}`
            : `${n(rows, 'row')}`,
        blockers,
      };
    },
  },
  {
    key: 'values',
    label: 'Values',
    description: 'The specification values the setup asks for — thickness, grade, length.',
    /** Something under the line has a required, applicable, item-level rule. */
    applies: (ctx) => ctx.values.required > 0,
    state(ctx) {
      const { missing, required } = ctx.values;
      if (missing.length === 0) {
        return { state: 'done', detail: `All ${n(required, 'value')} filled`, blockers: [] };
      }
      const named = missing.slice(0, 2).map((m) => `${m.itemLabel} · ${m.specCode}`);
      const rest = missing.length - named.length;
      return {
        // Nothing filled at all is untouched; some filled is half done.
        state: missing.length >= required ? 'todo' : 'partial',
        detail: `${n(missing.length, 'value')} missing — ${named.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`,
        blockers: [{
          count: missing.length,
          message: `${n(missing.length, 'required value')} under line ${ctx.line.line_no} are empty — ${named.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}.`,
        }],
      };
    },
  },
  {
    key: 'blanks',
    label: 'Cut plates',
    description: 'Pooling the parts into the blanks they are cut from.',
    /*
     * WHY THIS IS ITS OWN STAGE AND NOT PART OF NESTING.
     *
     * Deriving blanks WRITES: it mints a temporary item per rectangle and puts
     * an area-fraction quantity on each one. The nesting screen's contract is
     * that opening it changes nothing — a look is a look — so the write cannot
     * live behind it.
     *
     * It is also a step somebody re-runs. Parts pool by (thickness, length,
     * width, grade), so editing the structure changes which rectangles exist,
     * and the shop needs to see that happen rather than have it slipped in.
     *
     * It applies wherever nesting does: if a material says it is cut to size,
     * the blanks have to exist before anything can be laid out.
     */
    applies: (ctx) => ctx.nesting.items.length > 0,
    state(ctx) {
      const made = ctx.nesting.blanks ?? 0;
      if (made > 0) {
        return {
          state: 'done',
          detail: `${n(made, 'rectangle')} pooled from the line's plate parts`,
          blockers: [],
        };
      }
      const items = ctx.nesting.items;
      return {
        state: 'todo',
        detail: `${n(items.length, 'material')} to cut — no blanks derived yet`,
        blockers: [{
          count: items.length,
          message: `Line ${ctx.line.line_no} has parts that are cut from plate, but nothing has been pooled into blanks yet. Derive the cut plates, and nesting has something to lay out.`,
        }],
      };
    },
  },
  {
    key: 'nesting',
    label: 'Nesting',
    description: 'Laying parts out on the plates they are cut from.',
    /** A material under the line answers the NESTING specification with yes. */
    applies: (ctx) => ctx.nesting.items.length > 0,
    state(ctx) {
      const items = ctx.nesting.items;
      const saved = ctx.nesting.saved;

      /*
       * DONE MEANS A PLAN IS SAVED, AND NOTHING WEAKER.
       *
       * cf_plate_lots is the record: one row per physical plate, written only
       * by acceptNesting, which refuses a layout that does not cover every
       * required piece. So lots existing means this line IS laid out — there is
       * no partial accept to mistake for a whole one.
       *
       * This used to be hardcoded `todo` because nothing could record a plan.
       * That was right then and is wrong now, but the reason behind it still
       * stands and is worth keeping: do not report `done` because nothing
       * contradicts it. That is the lie fab_erp's nesting stage told, where
       * "every part has material" went green and the first person to find out
       * otherwise was a cutter. Green here is read off saved rows, never off
       * the absence of a complaint.
       */
      if (saved?.lots > 0) {
        const byHand = saved.manual > 0 ? `, ${saved.manual} by hand` : '';
        return {
          state: 'done',
          detail: `${n(saved.lots, 'plate')} laid out, ${n(saved.pieces, 'piece')} placed${byHand}`,
          blockers: [],
        };
      }

      return {
        state: 'todo',
        detail: `${n(items.length, 'material')} to nest — ${nameList(items.map((i) => i.label))} · no plan saved yet`,
        blockers: [{
          count: items.length,
          message: `Line ${ctx.line.line_no} has ${n(items.length, 'material')} whose ${NESTING_SPEC_CODE} says it must be nested, and no nesting plan has been accepted. Open Nesting to lay them out, mark the stage optional on the process, or answer ${NESTING_SPEC_CODE} with no.`,
        }],
      };
    },
  },
  {
    key: 'buying',
    label: 'Buying',
    description: 'Getting in the material the order consumes but does not make.',
    /** The line draws material from stock at all — whether or not any is short today. */
    applies: (ctx) => ctx.material.length > 0,
    state(ctx) {
      const short = ctx.material.filter((m) => m.short > EPS);
      if (!short.length) {
        return { state: 'done', detail: `All ${n(ctx.material.length, 'material')} in stock`, blockers: [] };
      }
      const covered = short.filter((m) => m.onOrder + EPS >= m.short);
      const open = short.filter((m) => m.onOrder + EPS < m.short);
      const detail = open.length
        ? `${n(open.length, 'material')} to buy — ${nameList(open.map((m) => `${m.label} short ${round6(m.short - m.onOrder)}`))}`
        : `${n(covered.length, 'material')} on order`;
      return {
        // On order is real progress: somebody has acted, the steel is coming.
        state: open.length === 0 ? 'partial' : covered.length ? 'partial' : 'todo',
        detail,
        blockers: open.length ? [{
          count: open.length,
          message: `Line ${ctx.line.line_no} is short of ${n(open.length, 'material')} with nothing on order — ${nameList(open.map((m) => m.label), 3)}.`,
        }] : [],
      };
    },
  },
  {
    key: 'production',
    label: 'Production',
    description: 'Releasing to the shop what the order makes rather than buys.',
    /** Something under the line is made: a temporary item, or a catalog item sourced 'make'. */
    applies: (ctx) => ctx.made.length > 0,
    state(ctx) {
      const { release } = ctx;
      if (!release) {
        return {
          state: 'todo',
          detail: `${n(ctx.made.length, 'row')} to make — not released yet`,
          blockers: [{ count: 0, message: `Line ${ctx.line.line_no} is not released to production, so nothing of it is on the floor.` }],
        };
      }
      const { steps, doneSteps } = release;
      if (steps === 0) return { state: 'partial', detail: 'Released, but it has no steps', blockers: [] };
      return {
        state: doneSteps >= steps ? 'done' : 'partial',
        detail: doneSteps >= steps
          ? `All ${n(steps, 'step')} finished`
          : `${doneSteps} of ${n(steps, 'step')} finished`,
        blockers: [],
      };
    },
  },
  {
    key: 'confirm',
    label: 'Confirm',
    description: 'The commitment: the order leaves the office and becomes a job.',
    /** Always: every order is either confirmed or waiting to be. */
    always: true,
    applies: () => true,
    state(ctx) {
      const status = ctx.order.status;
      // Confirmation is one act on the whole order, so every line reports the
      // same answer. That is not a defect: a line cannot be half-committed.
      if (['confirmed', 'closed'].includes(status)) return { state: 'done', detail: `Order is ${status}`, blockers: [] };
      if (['lost', 'cancelled'].includes(status)) {
        return { state: 'not_applicable', detail: `Order is ${status} — there is nothing left to confirm`, blockers: [] };
      }
      return { state: 'todo', detail: `Order is ${status} — not confirmed yet`, blockers: [] };
    },
  },
];

const CATALOGUE_BY_KEY = new Map(STAGE_CATALOGUE.map((s) => [s.key, s]));
export const STAGE_KEYS = STAGE_CATALOGUE.map((s) => s.key);

/** What `GET /stage-catalogue` serves: the kinds a process can be built from. */
export function stageCatalogue() {
  return STAGE_CATALOGUE.map(({ key, label, description }) => ({ key, label, description }));
}

/**
 * A stage cannot hold an order up when it does not apply, and an OPTIONAL one
 * must not either — that is the whole of what optional buys. Both still report
 * their true state; they simply stop being gates. Shared by `nextStage` and
 * `canConfirm` so the two cannot disagree about what "done" means.
 */
const satisfied = (s) => s.state === 'done' || s.state === 'not_applicable' || s.requirement === 'optional';

// ── the process definition ───────────────────────────────────────────────────

async function requireProcess(db, companyId, id, { lock = false } = {}) {
  const [[p]] = await db.query(
    `SELECT * FROM cf_processes WHERE company_id = ? AND id = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, id],
  );
  if (!p) throw notFound('Process');
  return p;
}

/** The rules pointing at a set of processes, with the customer named. */
async function rulesOf(db, companyId, processIds) {
  const out = new Map(processIds.map((id) => [id, []]));
  if (!processIds.length) return out;
  const [rows] = await db.query(
    `SELECT r.id, r.process_id, r.customer_id, r.order_type, p.code AS customer_code, p.name AS customer_name
       FROM cf_process_rules r
       LEFT JOIN cf_parties p ON p.id = r.customer_id
      WHERE r.company_id = ? AND r.process_id IN (?) AND r.deleted_at IS NULL
      ORDER BY r.customer_id IS NULL, p.name, r.order_type`,
    [companyId, processIds],
  );
  for (const r of rows) {
    out.get(r.process_id)?.push({
      id: r.id,
      customer: r.customer_id ? { id: r.customer_id, code: r.customer_code ?? null, name: r.customer_name ?? null } : null,
      orderType: r.order_type,
    });
  }
  return out;
}

const shapeStage = (s) => ({
  id: s.id,
  stageKey: s.stage_key,
  label: s.label || CATALOGUE_BY_KEY.get(s.stage_key)?.label || s.stage_key,
  sequence: s.sequence,
  requirement: s.requirement,
  overrideSpec: s.override_spec_id ? { id: s.override_spec_id, code: s.spec_code ?? null, name: s.spec_name ?? null } : null,
  // mysql2 hands back a parsed value for a JSON column, but a connection
  // configured otherwise hands back the text. Parse when it parses, keep the
  // string when it does not — a stage whose settings are the JSON string
  // "compact" must come home as "compact", not as null.
  settings: readSettings(s.settings),
  // A kind that no longer exists in this build. Said out loud rather than
  // silently dropped, because a process quietly losing a step is worse.
  known: CATALOGUE_BY_KEY.has(s.stage_key),
});

export async function listProcesses(db, companyId) {
  const [rows] = await db.query(
    `SELECT p.*,
            (SELECT COUNT(*) FROM cf_process_stages s
              WHERE s.company_id = p.company_id AND s.process_id = p.id AND s.deleted_at IS NULL) AS stage_count
       FROM cf_processes p
      WHERE p.company_id = ? AND p.deleted_at IS NULL
      ORDER BY p.status = 'obsolete', p.code`,
    [companyId],
  );
  const rules = await rulesOf(db, companyId, rows.map((r) => r.id));
  return rows.map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    status: p.status,
    stageCount: Number(p.stage_count) || 0,
    rules: rules.get(p.id) ?? [],
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  }));
}

export async function getProcess(db, companyId, id) {
  const p = await requireProcess(db, companyId, id);
  const [stages] = await db.query(
    `SELECT s.*, sp.code AS spec_code, sp.name AS spec_name
       FROM cf_process_stages s
       LEFT JOIN cf_specifications sp ON sp.id = s.override_spec_id
      WHERE s.company_id = ? AND s.process_id = ? AND s.deleted_at IS NULL
      ORDER BY s.sequence, s.id`,
    [companyId, id],
  );
  const rules = await rulesOf(db, companyId, [id]);
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    status: p.status,
    stages: stages.map(shapeStage),
    rules: rules.get(id) ?? [],
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

function readHeader(input, problems, { partial = false } = {}) {
  const sets = {};
  if (!partial || input.code !== undefined) {
    const code = String(input.code ?? '').trim();
    if (!code) problems.push('A process needs a code.');
    else if (!CODE_RE.test(code) || code.length > 50) problems.push('Process code: up to 50 letters, digits and - _ . /, no spaces.');
    else sets.code = code;
  }
  if (!partial || input.name !== undefined) {
    const name = String(input.name ?? '').trim();
    if (!name) problems.push('A process needs a name.');
    else if (name.length > 200) problems.push('Name is up to 200 characters.');
    else sets.name = name;
  }
  if (input.description !== undefined) sets.description = blank(input.description) ? null : String(input.description);
  return sets;
}

/** input: { code, name, description?, status? } */
export async function createProcess(db, c, input = {}) {
  const problems = [];
  const sets = readHeader(input, problems);
  const status = blank(input.status) ? 'draft' : String(input.status);
  if (!PROCESS_STATUSES.includes(status)) problems.push('A process is draft, active or obsolete.');
  assertNoProblems(problems);
  const [r] = await db.query(
    'INSERT INTO cf_processes (company_id, code, name, description, status, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [c.companyId, sets.code, sets.name, sets.description ?? null, status, c.userId],
  );
  return getProcess(db, c.companyId, r.insertId);
}

/** input: { code?, name?, description? } — status moves through setProcessStatus. */
export async function updateProcess(db, c, id, input = {}) {
  await requireProcess(db, c.companyId, id, { lock: true });
  const problems = [];
  const sets = readHeader(input, problems, { partial: true });
  if (input.status !== undefined) problems.push('Use activate / make obsolete to change the status.');
  assertNoProblems(problems);
  if (Object.keys(sets).length) {
    await db.query(
      `UPDATE cf_processes SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...Object.values(sets), c.companyId, id],
    );
  }
  return getProcess(db, c.companyId, id);
}

export async function setProcessStatus(db, c, id, status) {
  const p = await requireProcess(db, c.companyId, id, { lock: true });
  if (!PROCESS_STATUSES.includes(status)) throw invalid('BAD_STATUS', 'A process is draft, active or obsolete.');
  if (p.status === status) return getProcess(db, c.companyId, id);
  if (status === 'active') {
    // An empty process would stamp itself on orders and then say nothing about
    // them, which looks exactly like a broken screen.
    const [[{ n: stages }]] = await db.query(
      'SELECT COUNT(*) AS n FROM cf_process_stages WHERE company_id = ? AND process_id = ? AND deleted_at IS NULL',
      [c.companyId, id],
    );
    if (!Number(stages)) throw invalid('NO_STAGES', `${p.code} has no stages — add some before activating it.`);
  }
  if (status === 'obsolete') {
    // Orders already running keep the process they were stamped with (§18), so
    // retiring one is safe. Saying how many are still on it is not a refusal —
    // it is what the person is about to want to know.
    const [[{ n: running }]] = await db.query(
      `SELECT COUNT(*) AS n FROM cf_sales_orders
        WHERE company_id = ? AND process_id = ? AND deleted_at IS NULL AND status NOT IN ('closed','lost','cancelled')`,
      [c.companyId, id],
    );
    if (Number(running)) {
      // Not a block: they finish on it. The count travels with the result.
      await db.query('UPDATE cf_processes SET status = ? WHERE company_id = ? AND id = ?', [status, c.companyId, id]);
      const out = await getProcess(db, c.companyId, id);
      const one = Number(running) === 1;
      out.note = `${n(Number(running), 'open order')} still ${one ? 'follows' : 'follow'} ${p.code} — ${one ? 'it finishes' : 'they finish'} on it; new orders will not get it.`;
      return out;
    }
  }
  await db.query('UPDATE cf_processes SET status = ? WHERE company_id = ? AND id = ?', [status, c.companyId, id]);
  return getProcess(db, c.companyId, id);
}

export async function deleteProcess(db, c, id) {
  const p = await requireProcess(db, c.companyId, id, { lock: true });
  const [[{ n: used }]] = await db.query(
    'SELECT COUNT(*) AS n FROM cf_sales_orders WHERE company_id = ? AND process_id = ? AND deleted_at IS NULL',
    [c.companyId, id],
  );
  if (Number(used)) {
    const one = Number(used) === 1;
    throw conflict('IN_USE', `${n(Number(used), 'order')} ${one ? 'follows' : 'follow'} ${p.code} — make it obsolete instead, so ${one ? 'its' : 'their'} history stays.`);
  }
  await db.query('UPDATE cf_process_rules SET deleted_at = NOW() WHERE company_id = ? AND process_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  await db.query('UPDATE cf_process_stages SET deleted_at = NOW() WHERE company_id = ? AND process_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  await db.query('UPDATE cf_processes SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  return { ok: true };
}

/**
 * Replaces the whole ordered list of stages in one call.
 *
 * Reordering IS the normal edit — you drag a stage up the list — and doing
 * that as a series of per-stage updates means passing through states where two
 * stages share a sequence, which `uq_cps_seq` forbids. Replacing sidesteps the
 * whole problem: the live rows go, the new ones arrive numbered 10, 20, 30 in
 * the order they were given.
 *
 * input: { stages: [{ stageKey, label?, requirement?, overrideSpecId?, settings? }] }
 */
export async function replaceStages(db, c, processId, input = {}) {
  const p = await requireProcess(db, c.companyId, processId, { lock: true });
  const list = Array.isArray(input.stages) ? input.stages : null;
  if (!list) throw invalid('INVALID', 'Send the stages as a list, in the order they are worked.');

  const problems = [];
  const seen = new Set();
  const specIds = [];
  const rows = list.map((s, i) => {
    const at = `Stage ${i + 1}`;
    const key = String(s?.stageKey ?? s?.stage_key ?? '').trim();
    // Refused BY NAME: "there is no stage called nestin" is a typo you can see.
    if (!CATALOGUE_BY_KEY.has(key)) {
      problems.push(`${at}: there is no stage called "${key || '(blank)'}". The stages are ${STAGE_KEYS.join(', ')}.`);
    } else if (seen.has(key)) {
      problems.push(`${at}: ${key} is already in this process — a stage happens once.`);
    } else seen.add(key);

    const requirement = blank(s?.requirement) ? 'required' : String(s.requirement);
    if (!STAGE_REQUIREMENTS.includes(requirement)) problems.push(`${at}: a stage is required or optional.`);

    const label = blank(s?.label) ? null : String(s.label).trim();
    if (label && label.length > 100) problems.push(`${at}: the label is up to 100 characters.`);

    let overrideSpecId = null;
    const raw = s?.overrideSpecId ?? s?.override_spec_id;
    if (!blank(raw)) {
      overrideSpecId = Number(raw);
      if (!Number.isInteger(overrideSpecId) || overrideSpecId <= 0) problems.push(`${at}: the override specification is an id.`);
      else specIds.push(overrideSpecId);
    }

    /*
     * SETTINGS ARE ROUND-TRIPPED UNTOUCHED, whatever shape they are.
     *
     * The Setup screen does not edit them: it reads a stage, hands the whole
     * thing back on the next save, and expects what it sent to come home. If
     * this validated the shape, a row written by anything else — a fixture, a
     * later stage kind with a different idea of its configuration — would make
     * an unrelated edit unsavable, and the person would have no idea why. The
     * only thing refused is a value that cannot become JSON at all.
     *
     * What is INSIDE settings is the stage screen's business, checked where it
     * is read, because only that screen knows what it means.
     */
    let settings = null;
    if (s?.settings != null) {
      try {
        const text = JSON.stringify(s.settings);
        if (text === undefined) problems.push(`${at}: settings could not be saved — they are not JSON.`);
        else settings = text;
      } catch {
        problems.push(`${at}: settings could not be saved — they refer to themselves.`);
      }
    }
    return { key, sequence: (i + 1) * 10, label, requirement, overrideSpecId, settings };
  });

  if (specIds.length) {
    const [specs] = await db.query(
      'SELECT id, code, data_type FROM cf_specifications WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL',
      [c.companyId, [...new Set(specIds)]],
    );
    const byId = new Map(specs.map((x) => [x.id, x]));
    for (const r of rows) {
      if (!r.overrideSpecId) continue;
      const spec = byId.get(r.overrideSpecId);
      if (!spec) { problems.push(`${r.key}: that override specification does not exist.`); continue; }
      // The override answers "does this stage apply", which is a yes or a no.
      // A number or a date cannot say it, and quietly treating 0 as no is how
      // a stage silently switches itself off.
      if (spec.data_type !== 'boolean') {
        problems.push(`${r.key}: ${spec.code} is a ${spec.data_type} specification. An override says yes or no, so it has to be a boolean.`);
      }
    }
  }
  assertNoProblems(problems, `The stages of ${p.code} need attention.`);

  await db.query('UPDATE cf_process_stages SET deleted_at = NOW() WHERE company_id = ? AND process_id = ? AND deleted_at IS NULL', [c.companyId, processId]);
  for (const r of rows) {
    await db.query(
      `INSERT INTO cf_process_stages (company_id, process_id, stage_key, sequence, label, requirement, override_spec_id, settings)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.companyId, processId, r.key, r.sequence, r.label, r.requirement, r.overrideSpecId, r.settings],
    );
  }
  return getProcess(db, c.companyId, processId);
}

/** input: { customerId?, orderType? } — either or both NULL means "any". */
export async function addRule(db, c, processId, input = {}) {
  const p = await requireProcess(db, c.companyId, processId, { lock: true });
  const problems = [];
  let customerId = null;
  if (!blank(input.customerId)) {
    customerId = Number(input.customerId);
    if (!Number.isInteger(customerId) || customerId <= 0) problems.push('The customer is an id.');
    else {
      const [[party]] = await db.query(
        'SELECT id, name, is_customer FROM cf_parties WHERE company_id = ? AND id = ? AND deleted_at IS NULL',
        [c.companyId, customerId],
      );
      if (!party) problems.push('That customer does not exist.');
      else if (!Number(party.is_customer)) problems.push(`${party.name} is not marked as a customer.`);
    }
  }
  let orderType = null;
  if (!blank(input.orderType)) {
    orderType = String(input.orderType);
    if (!PROCESS_ORDER_TYPES.includes(orderType)) problems.push('An order is a customer order or a stock order.');
  }
  // A stock order has no customer (salesOrderService), so a rule naming both
  // would never match anything — and a rule that cannot fire is a rule
  // somebody will spend an afternoon wondering about.
  if (customerId && orderType === 'stock') problems.push('A stock order has no customer, so this rule could never match.');
  assertNoProblems(problems);

  /*
   * A (customer, order type) pair belongs to ONE process company-wide —
   * `uq_cprr_match` enforces it, because two rules matching the same order
   * with the same weight would make the choice arbitrary.
   *
   * Checked here rather than left to the unique key: the key's own message is
   * "that value is already in use", which does not say what value, or where
   * the pair went instead. "Acme Bridges customer orders already follow
   * P9-W3" is an answer.
   */
  const [[clash]] = await db.query(
    `SELECT r.id, p.code, p.name FROM cf_process_rules r
       JOIN cf_processes p ON p.id = r.process_id
      WHERE r.company_id = ? AND r.deleted_at IS NULL
        AND ${customerId ? 'r.customer_id = ?' : 'r.customer_id IS NULL'}
        AND ${orderType ? 'r.order_type = ?' : 'r.order_type IS NULL'}`,
    [c.companyId, ...(customerId ? [customerId] : []), ...(orderType ? [orderType] : [])],
  );
  if (clash) {
    const who = customerId
      ? `That customer's ${orderType ? `${orderType} orders` : 'orders'}`
      : orderType ? `${orderType[0].toUpperCase()}${orderType.slice(1)} orders from any customer` : 'The house default';
    throw conflict('DUPLICATE',
      `${who} already ${customerId || orderType ? 'follow' : 'follows'} ${clash.code}. Remove that rule first, or point it at ${p.code} instead.`);
  }

  const [r] = await db.query(
    'INSERT INTO cf_process_rules (company_id, process_id, customer_id, order_type) VALUES (?, ?, ?, ?)',
    [c.companyId, processId, customerId, orderType],
  );
  const out = await getProcess(db, c.companyId, p.id);
  out.addedRuleId = r.insertId;
  return out;
}

export async function deleteRule(db, c, ruleId) {
  const [[r]] = await db.query('SELECT * FROM cf_process_rules WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, ruleId]);
  if (!r) throw notFound('Process rule');
  await db.query('UPDATE cf_process_rules SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, ruleId]);
  return getProcess(db, c.companyId, r.process_id);
}

// ── which process an order follows ───────────────────────────────────────────

/**
 * Most specific wins (§18, decision 3):
 *
 *   weight 3   this customer, this kind of order
 *   weight 2   this customer, any kind
 *   weight 1   any customer, this kind
 *   weight 0   the house default — both NULL
 *
 * Only ACTIVE processes are handed to new orders. A draft is one somebody is
 * still writing and an obsolete one is retired; stamping either would put an
 * order on a process nobody meant it to follow. A rule pointing at one is
 * reported in `reason` rather than ignored in silence, because "I made the
 * rule and nothing happened" is the worst possible outcome.
 *
 * @returns {Promise<{processId: number|null, process: object|null, weight: number|null, ruleId: number|null, reason: string}>}
 */
export async function resolveProcess(db, companyId, { customerId = null, orderType = null } = {}) {
  const [rows] = await db.query(
    `SELECT r.id AS rule_id, r.customer_id, r.order_type, p.id, p.code, p.name, p.status
       FROM cf_process_rules r
       JOIN cf_processes p ON p.id = r.process_id AND p.deleted_at IS NULL
      WHERE r.company_id = ? AND r.deleted_at IS NULL
        AND (r.customer_id IS NULL OR r.customer_id = ?)
        AND (r.order_type IS NULL OR r.order_type = ?)`,
    [companyId, customerId ?? null, orderType ?? null],
  );
  const weigh = (r) => (r.customer_id ? 2 : 0) + (r.order_type ? 1 : 0);
  const ranked = rows.map((r) => ({ ...r, weight: weigh(r) })).sort((a, b) => b.weight - a.weight || a.rule_id - b.rule_id);
  const best = ranked.find((r) => r.status === 'active') ?? null;
  const blocked = ranked.find((r) => r.status !== 'active') ?? null;

  if (best) {
    const how = best.weight === 3 ? 'this customer and this kind of order'
      : best.weight === 2 ? 'this customer'
        : best.weight === 1 ? `any ${orderType} order`
          : 'the house default';
    return {
      processId: best.id,
      process: { id: best.id, code: best.code, name: best.name, status: best.status },
      weight: best.weight,
      ruleId: best.rule_id,
      reason: `${best.code} — matched on ${how}.`,
    };
  }
  if (blocked) {
    return {
      processId: null, process: null, weight: null, ruleId: null,
      reason: `A rule points at ${blocked.code}, but it is ${blocked.status === 'draft' ? 'still a draft' : 'obsolete'} — activate it before orders can follow it.`,
    };
  }
  return {
    processId: null, process: null, weight: null, ruleId: null,
    reason: 'No process rule matches this order, and there is no house default. Add a rule under Setup › Processes.',
  };
}

// ── resolving a specification in bulk ────────────────────────────────────────

/**
 * The subjects whose specification rules and values reach each item, broadest
 * first — the same chain `resolutionService.chainForMaster` walks:
 *
 *   Family → Subfamily → Variant → [its Template Definition] → the item
 *
 * Why not just call `resolve()` per item: it answers one record completely,
 * with formulas, roll-ups and inheritance, in roughly eight queries. A single
 * order line's structure can hold hundreds of items, and this file needs two
 * narrow facts about all of them at once — is a required value empty, and does
 * one boolean say yes. Doing that per item would be four figures of queries
 * for a page that draws a progress strip.
 *
 * The cost of going around it is that the merge rule lives in two places. Both
 * helpers below stay deliberately narrow so the duplication stays small, and
 * both name the line of `resolutionService` they mirror.
 */
async function chainsFor(db, companyId, items) {
  // items: [{ id, classification_id, source_definition_id }]
  const byNode = new Map();
  let frontier = [...new Set(items.map((i) => i.classification_id).filter(Boolean))];
  while (frontier.length) {
    const [rows] = await db.query(
      'SELECT id, parent_id FROM cf_classification_nodes WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL',
      [companyId, frontier],
    );
    for (const r of rows) byNode.set(r.id, r.parent_id ?? null);
    frontier = [...new Set(rows.map((r) => r.parent_id).filter((p) => p && !byNode.has(p)))];
  }
  const nodeChain = (id) => {
    const out = [];
    let cur = id;
    let guard = 0;
    while (cur && guard++ < 12) { out.unshift(cur); cur = byNode.get(cur) ?? null; }
    return out;
  };
  const chains = new Map();
  for (const it of items) {
    const subjects = nodeChain(it.classification_id).map((id) => ({ type: 'classification', id }));
    if (it.source_definition_id) subjects.push({ type: 'master', id: it.source_definition_id });
    subjects.push({ type: 'master', id: it.id, self: true });
    chains.set(it.id, subjects);
  }
  return chains;
}

/**
 * One query over every subject the chains touch. The two subject kinds are
 * separate IN lists rather than a composite key, because ids collide across
 * them: classification 7 and master 7 are different things.
 */
async function loadSubjectRows(db, companyId, { table, columns, join = '', where = '', params = [], chains }) {
  const cls = new Set();
  const mst = new Set();
  for (const subjects of chains.values()) for (const s of subjects) (s.type === 'classification' ? cls : mst).add(s.id);
  const scope = [];
  const scopeParams = [];
  if (cls.size) { scope.push("(t.subject_type = 'classification' AND t.subject_id IN (?))"); scopeParams.push([...cls]); }
  if (mst.size) { scope.push("(t.subject_type = 'master' AND t.subject_id IN (?))"); scopeParams.push([...mst]); }
  if (!scope.length) return [];
  const [rows] = await db.query(
    `SELECT ${columns} FROM ${table} t ${join}
      WHERE t.company_id = ? AND t.deleted_at IS NULL AND (${scope.join(' OR ')})${where ? ` AND ${where}` : ''}`,
    [companyId, ...scopeParams, ...params],
  );
  return rows;
}

const rawValueOf = (row, dataType) => {
  if (!row) return null;
  switch (dataType) {
    case 'number': return row.value_number == null ? null : Number(row.value_number);
    case 'text': return row.value_text ?? null;
    case 'boolean': return row.value_bool == null ? null : !!row.value_bool;
    case 'date': return row.value_date ?? null;
    case 'option': return row.option_id ?? null;
    default: return null;
  }
};

/**
 * One boolean specification, resolved for many items at once: the nearest
 * value along the chain wins, the item's own beating its classification's.
 * `null` where nothing anywhere answers.
 *
 * Used twice — by the nesting stage (does this plate need nesting) and by the
 * override (does this line say the stage does not apply) — which is why it is
 * one helper and not two.
 */
async function resolveBooleanSpec(db, companyId, specId, chains) {
  const out = new Map([...chains.keys()].map((id) => [id, null]));
  if (!specId || !chains.size) return out;
  const rows = await loadSubjectRows(db, companyId, {
    table: 'cf_spec_values',
    columns: 't.subject_type, t.subject_id, t.value_bool',
    where: 't.specification_id = ?',
    params: [specId],
    chains,
  });
  const at = new Map(rows.map((r) => [`${r.subject_type}:${r.subject_id}`, r]));
  for (const [itemId, subjects] of chains) {
    for (let i = subjects.length - 1; i >= 0; i--) {   // narrowest first
      const row = at.get(`${subjects[i].type}:${subjects[i].id}`);
      const raw = rawValueOf(row, 'boolean');
      if (raw !== null) { out.set(itemId, raw); break; }
    }
  }
  return out;
}

/**
 * Required item-level values that are empty, per item.
 *
 * Mirrors the one line of `resolutionService.resolve` that decides it:
 *
 *   if (entry.rule.isRequired && !entry.value && ['entered','defaulted'].includes(r.value_rule)) entry.status = 'missing';
 *
 * — so only `entered` and `defaulted` rules can ever be missing. `fixed`,
 * `calculated`, `rollup` and `inherited` take their value from somewhere else
 * and have their own failure modes (no fixed value above, a formula cycle),
 * which are that screen's business and not this stage's gate.
 *
 * Counted PER ITEM, not per order: a line's stage must be about that line's
 * own rows, or one line with nothing to capture lights up because another line
 * has gaps.
 *
 * @returns {Promise<Map<number, {required: number, missing: Array<{specCode, specName}>}>>}
 */
async function missingRequiredValues(db, companyId, chains) {
  const perItem = new Map([...chains.keys()].map((id) => [id, { required: 0, missing: [] }]));
  if (!chains.size) return perItem;
  const assignments = await loadSubjectRows(db, companyId, {
    table: 'cf_spec_assignments',
    columns: 't.subject_type, t.subject_id, t.specification_id, t.is_required, t.is_applicable, t.value_rule, sp.code AS spec_code, sp.name AS spec_name, sp.data_type',
    join: 'JOIN cf_specifications sp ON sp.id = t.specification_id AND sp.deleted_at IS NULL',
    where: "t.capture_at = 'item'",
    chains,
  });
  if (!assignments.length) return perItem;
  const rulesAt = new Map();
  for (const a of assignments) {
    const k = `${a.subject_type}:${a.subject_id}`;
    if (!rulesAt.has(k)) rulesAt.set(k, []);
    rulesAt.get(k).push(a);
  }

  // Which specs any item could need a value for, so the value query is one.
  const specIds = [...new Set(assignments.map((a) => a.specification_id))];
  const valueRows = await loadSubjectRows(db, companyId, {
    table: 'cf_spec_values',
    columns: 't.subject_type, t.subject_id, t.specification_id, t.source, t.value_number, t.value_text, t.value_bool, t.value_date, t.option_id',
    where: 't.specification_id IN (?)',
    params: [specIds],
    chains,
  });
  const valueAt = new Map(valueRows.map((v) => [`${v.subject_type}:${v.subject_id}:${v.specification_id}`, v]));
  const dataTypeOf = new Map(assignments.map((a) => [a.specification_id, a.data_type]));

  for (const [itemId, subjects] of chains) {
    // Most specific wins, whole: walk broad → narrow and let the later rule
    // replace the earlier one, exactly as `resolve` does with its sorted list.
    const won = new Map();
    for (const s of subjects) for (const a of rulesAt.get(`${s.type}:${s.id}`) ?? []) won.set(a.specification_id, a);

    const self = subjects[subjects.length - 1];
    const above = subjects.slice(0, -1);
    const entry = perItem.get(itemId);
    for (const a of won.values()) {
      if (!Number(a.is_applicable) || !Number(a.is_required)) continue;
      if (!['entered', 'defaulted'].includes(a.value_rule)) continue;
      entry.required++;
      const type = dataTypeOf.get(a.specification_id);
      const own = valueAt.get(`${self.type}:${self.id}:${a.specification_id}`);
      const ownRaw = rawValueOf(own, type);
      let has = false;
      if (a.value_rule === 'entered') has = ownRaw !== null;
      else {
        // 'defaulted': the item's own ENTERED value, else the nearest above.
        if (ownRaw !== null && own.source === 'entered') has = true;
        else {
          for (let i = above.length - 1; i >= 0 && !has; i--) {
            has = rawValueOf(valueAt.get(`${above[i].type}:${above[i].id}:${a.specification_id}`), type) !== null;
          }
        }
      }
      if (!has) entry.missing.push({ specCode: a.spec_code, specName: a.spec_name });
    }
  }
  return perItem;
}

// ── the per-order context every stage reads ──────────────────────────────────

/**
 * Loaded ONCE for the whole order, then sliced per line. Every query this file
 * makes is here; the stages themselves are pure functions of it, which is what
 * keeps them readable and testable.
 */
async function loadOrderContext(db, companyId, order, lines) {
  // 1. Each line's structure, exploded once.
  const trees = new Map();
  for (const line of lines) {
    if (!line.item_id) { trees.set(line.id, null); continue; }
    trees.set(line.id, await explode(db, companyId, line.item_id, { rootQuantity: Number(line.quantity), maxDepth: 15 }));
  }

  // 2. Every item any tree touches, with what decides made-or-material.
  const itemIds = new Set();
  for (const tree of trees.values()) {
    if (!tree) continue;
    const walk = (x) => {
      if (x.kind === 'catalog' || x.kind === 'temporary') itemIds.add(x.id);
      x.children.forEach(walk);
    };
    walk(tree.root);
  }
  const [detailRows] = itemIds.size ? await db.query(
    `SELECT i.master_id, i.item_type, i.sourcing, i.source_definition_id, m.classification_id, m.code, m.name
       FROM cf_item_details i JOIN cf_master_records m ON m.id = i.master_id
      WHERE i.company_id = ? AND i.master_id IN (?) AND i.deleted_at IS NULL`,
    [companyId, [...itemIds]],
  ) : [[]];
  const detail = new Map(detailRows.map((r) => [r.master_id, r]));

  // 3. Free stock, once, for every item that could be drawn from it.
  const free = itemIds.size ? await availability(db, companyId, [...itemIds]) : new Map();

  // 4. What is already on order, so "short" can tell waiting from missing.
  const [poRows] = itemIds.size ? await db.query(
    `SELECT l.item_id, SUM(GREATEST(l.quantity - l.qty_received, 0)) AS outstanding
       FROM cf_purchase_order_lines l
       JOIN cf_purchase_orders p ON p.id = l.purchase_order_id AND p.deleted_at IS NULL
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.item_id IN (?)
        AND p.status IN ('draft','ordered','partially_received')
      GROUP BY l.item_id`,
    [companyId, [...itemIds]],
  ) : [[]];
  const onOrder = new Map(poRows.map((r) => [r.item_id, Number(r.outstanding) || 0]));

  // 5. Releases and how far their steps have got.
  const [relRows] = lines.length ? await db.query(
    `SELECT r.id, r.order_line_id,
            (SELECT COUNT(*) FROM cf_production_steps s
               JOIN cf_production_items pi ON pi.id = s.production_item_id
              WHERE pi.release_id = r.id AND s.deleted_at IS NULL) AS steps,
            (SELECT COUNT(*) FROM cf_production_steps s
               JOIN cf_production_items pi ON pi.id = s.production_item_id
              WHERE pi.release_id = r.id AND s.deleted_at IS NULL AND s.state = 'done') AS done_steps
       FROM cf_production_releases r
      WHERE r.company_id = ? AND r.order_line_id IN (?) AND r.deleted_at IS NULL`,
    [companyId, lines.map((l) => l.id)],
  ) : [[]];
  const releases = new Map(relRows.map((r) => [r.order_line_id, { id: r.id, steps: Number(r.steps), doneSteps: Number(r.done_steps) }]));

  // 5b. The nesting actually saved against each line. cf_plate_lots is one row
  // per physical plate, so counting them is counting plates; the placements
  // under them are pieces. acceptNesting refuses a plan that does not cover
  // every required piece, so lots existing means the line IS laid out.
  const [lotRows] = lines.length ? await db.query(
    `SELECT pl.order_line_id,
            COUNT(*) AS lots,
            SUM(pl.is_manual) AS manual_lots,
            (SELECT COUNT(*) FROM cf_nest_placements np
              WHERE np.company_id = pl.company_id AND np.plate_lot_id IN (
                SELECT p2.id FROM cf_plate_lots p2
                 WHERE p2.company_id = pl.company_id AND p2.order_line_id = pl.order_line_id AND p2.deleted_at IS NULL)
                AND np.deleted_at IS NULL) AS pieces
       FROM cf_plate_lots pl
      WHERE pl.company_id = ? AND pl.order_line_id IN (?) AND pl.deleted_at IS NULL
      GROUP BY pl.order_line_id, pl.company_id`,
    [companyId, lines.map((l) => l.id)],
  ) : [[]];
  // 5c. How many blanks a line already has. The blanks stage is done when the
  // rectangles exist; nesting is done when they are laid out. Two questions.
  const [blankRows] = lines.length ? await db.query(
    `SELECT i.owner_order_line_id AS order_line_id, COUNT(*) AS blanks
       FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
       JOIN cf_classification_nodes n ON n.id = m.classification_id AND n.code = 'CUT_PLATE'
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND i.owner_order_line_id IN (?)
      GROUP BY i.owner_order_line_id`,
    [companyId, lines.map((l) => l.id)],
  ) : [[]];
  const blanksBy = new Map(blankRows.map((r) => [r.order_line_id, Number(r.blanks)]));

  const lotsBy = new Map(lotRows.map((r) => [r.order_line_id, {
    lots: Number(r.lots), pieces: Number(r.pieces), manual: Number(r.manual_lots ?? 0),
  }]));

  // 6. Specification chains for every item, and the NESTING answer on each.
  const chains = await chainsFor(db, companyId, [...detail.values()].map((d) => ({
    id: d.master_id, classification_id: d.classification_id, source_definition_id: d.source_definition_id,
  })));
  const [[nestSpec]] = await db.query(
    "SELECT id, data_type FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL",
    [companyId, NESTING_SPEC_CODE],
  );
  const nestingBy = nestSpec && nestSpec.data_type === 'boolean'
    ? await resolveBooleanSpec(db, companyId, nestSpec.id, chains)
    : new Map();

  const labelOf = (id) => nameOf(detail.get(id));
  const values = await missingRequiredValues(db, companyId, chains);

  return { trees, detail, free, onOrder, releases, lotsBy, blanksBy, chains, nestingBy, values, labelOf, nestSpec: nestSpec ?? null };
}

/**
 * What a line makes and what it consumes.
 *
 * The same rule `releaseService.buildPlan` uses, and it has to be: a stage that
 * called something "made" which release then called "material" would send
 * somebody to the wrong screen. Where a catalog item comes from is its own
 * field: stock = drawn from stock, make = made on the order, both = from stock
 * when free stock covers it, else made. A temporary item is always made, and a
 * stock order's own line is always made — that order is what puts it in stock.
 *
 * Only what is MADE here is walked into: the structure under an item taken from
 * stock is that item's business, not this order's.
 */
function splitLine(ctx, order, line) {
  const tree = ctx.trees.get(line.id);
  const made = [];
  const material = new Map();
  const unresolved = [];
  const drafts = [];
  const seenFree = new Map();
  if (!tree) return { made, material: [], unresolved, drafts };

  const consider = (node, count) => {
    if (node.kind === 'selection' || node.kind === 'template') {
      // A row whose item is still a definition has nothing decided about it.
      if (node.kind === 'selection') unresolved.push(node);
      return;
    }
    // The root counts too: a temporary item is born draft and release refuses
    // one, so "activate it" is part of finishing the structure, not an aside.
    if (node.status === 'draft') drafts.push(node);
    const d = ctx.detail.get(node.id);
    const sourcing = node.kind === 'catalog' ? (d?.sourcing ?? 'stock') : null;
    let isMade;
    if (node.kind === 'temporary') isMade = true;
    else if (node === tree.root && order.order_type === 'stock') isMade = !!node.flow;
    else if (sourcing === 'make') isMade = true;
    else if (sourcing === 'both' && node.flow) {
      const left = seenFree.has(node.id) ? seenFree.get(node.id) : (ctx.free.get(node.id)?.free ?? 0);
      isMade = left + EPS < count;
      if (!isMade) seenFree.set(node.id, round6(left - count));
    } else isMade = false;

    if (isMade) {
      made.push(node);
      for (const kid of node.children) consider(kid, round6(kid.quantity * count));
    } else {
      const e = material.get(node.id) ?? { id: node.id, label: nameOf(node), required: 0 };
      e.required = round6(e.required + count);
      material.set(node.id, e);
    }
  };
  consider(tree.root, Number(line.quantity));

  return {
    made,
    unresolved,
    drafts,
    // Free stock is read PER LINE and not allocated across them: two lines
    // wanting the same plate each see the whole free pile. That is deliberate
    // and matches `releaseService.buildPlan`, which computes its own `freeLeft`
    // one line at a time — reservation is what actually claims stock, and it
    // happens at release. Cross-line allocation here would make the answer
    // depend on line order, which is a worse lie than an optimistic one.
    material: [...material.values()].map((m) => {
      const freeNow = ctx.free.get(m.id)?.free ?? 0;
      return { ...m, free: freeNow, onOrder: ctx.onOrder.get(m.id) ?? 0, short: round6(Math.max(0, m.required - freeNow)) };
    }),
  };
}

/** One line's slice of the order context — the object every stage is handed. */
function lineContext(ctx, order, line) {
  const tree = ctx.trees.get(line.id);
  const split = splitLine(ctx, order, line);

  // Everything this line is answerable for: what it makes, what it consumes,
  // and the thing it sells. Scoped per line, because a stage on line 10 must
  // not report a gap that belongs to line 20.
  const underLine = new Set();
  for (const x of split.made) underLine.add(x.id);
  for (const m of split.material) underLine.add(m.id);
  if (line.item_id) underLine.add(line.item_id);

  let required = 0;
  const missing = [];
  for (const id of underLine) {
    const e = ctx.values.get(id);
    if (!e) continue;
    required += e.required;
    for (const m of e.missing) missing.push({ itemId: id, itemLabel: ctx.labelOf(id), ...m });
  }

  return {
    order,
    line,
    tree,
    hasBom: !!tree?.root?.bom,
    fromTemplate: line.line_type === 'custom',
    made: split.made,
    material: split.material,
    unresolved: split.unresolved,
    drafts: split.drafts,
    nesting: {
      items: split.material.filter((m) => ctx.nestingBy.get(m.id) === true).map((m) => ({ id: m.id, label: m.label })),
      saved: ctx.lotsBy.get(line.id) ?? null,
      blanks: ctx.blanksBy.get(line.id) ?? 0,
    },
    values: { required, missing },
    release: ctx.releases.get(line.id) ?? null,
  };
}

// ── the answer ───────────────────────────────────────────────────────────────

/**
 * One stage, for one line: does it apply, who said so, and where has it got to.
 *
 * The override is asked FIRST but the derived answer is still computed, so a
 * stage switched off still knows what it would have said. That is the same
 * ordering fab_erp settled on, for the same reason: a stage that quietly
 * skipped the work of finding out cannot tell you what changed when somebody
 * switches it back on.
 */
function stageForLine(stage, kind, ctx, overrideValue) {
  const label = stage.label || kind.label;
  const derived = kind.applies(ctx);
  const declared = overrideValue === true || overrideValue === false;
  const applies = declared ? overrideValue : derived;
  // An always-stage that a specification switched off was still DECLARED —
  // somebody overruled "always", and that is exactly the case worth naming.
  const decidedBy = declared ? 'declared' : kind.always ? 'always' : 'data';

  if (!applies) {
    return {
      stageKey: kind.key,
      label,
      sequence: stage.sequence,
      requirement: stage.requirement,
      applies: false,
      decidedBy,
      state: 'not_applicable',
      detail: declared
        ? `Switched off for ${nameOf(ctx.line)} by ${stage.override_spec_code ?? 'a specification'}`
        : notApplicableDetail(kind.key, ctx),
      blockers: [],
    };
  }
  const out = kind.state(ctx);
  return {
    stageKey: kind.key,
    label,
    sequence: stage.sequence,
    requirement: stage.requirement,
    applies: true,
    decidedBy,
    state: out.state,
    detail: declared && derived === false
      // Somebody turned this on against the data. Worth saying out loud.
      ? `${out.detail} · switched on by ${stage.override_spec_code ?? 'a specification'}`
      : out.detail,
    blockers: (out.blockers ?? []).map((b) => ({ stageKey: kind.key, lineId: ctx.line.id, lineNo: ctx.line.line_no, ...b })),
  };
}

/** Why a derived stage does not apply — in the words of the thing that decided. */
function notApplicableDetail(key, ctx) {
  switch (key) {
    case 'structure': return 'Sells a catalog item with no BOM — there is nothing under it';
    case 'values': return 'Nothing under this line has a required value to capture';
    case 'blanks':
    case 'nesting':
      // "No material says yes" sends somebody looking at the plates. If the
      // specification was never created, the plates are not the problem.
      if (!ctx.nestSpec) return `No ${NESTING_SPEC_CODE} specification exists here, so nothing can ask to be nested`;
      return ctx.material.length
        ? `No material under this line answers ${NESTING_SPEC_CODE} with yes`
        : 'This line consumes no material to nest';
    case 'buying': return 'Everything under this line is made, so there is nothing to buy';
    case 'production': return 'Everything under this line comes from stock, so nothing is made';
    default: return 'Not needed for this line';
  }
}

/**
 * The order's answer for one stage: the roll-up of its lines.
 *
 * Pessimistic on purpose. `done` only when every line it applies to is done —
 * an order is not ready because most of it is. `not_applicable` only when it
 * applies to NO line, so a stage one line needs never disappears from the
 * order's strip.
 */
function rollUp(stage, kind, perLine) {
  const label = stage.label || kind?.label || stage.stage_key;
  // Paired with its line, because the detail names the line that is holding
  // the order up and a stage object on its own does not know which one it is.
  const mine = perLine
    .map((l) => ({ line: l, s: l.stages.find((x) => x.stageKey === stage.stage_key) }))
    .filter((x) => x.s);
  const live = mine.filter((x) => x.s.applies);
  const base = { stageKey: stage.stage_key, label, sequence: stage.sequence, requirement: stage.requirement };

  if (!perLine.length) {
    // An order with no lines has not decided that a stage does not apply — it
    // has decided nothing. The always-stages say so; the derived ones say they
    // have no line to look at, which is different from "not relevant here".
    const always = !!kind?.always;
    return {
      ...base,
      applies: !!always,
      decidedBy: always ? 'always' : 'data',
      state: always ? 'todo' : 'not_applicable',
      detail: always ? 'Nothing sold yet' : 'No line needs it — this order has no lines yet',
      blockers: always && stage.stage_key === 'lines' ? [{ stageKey: 'lines', count: 0, message: 'This order has no lines.' }] : [],
    };
  }
  // Mixed derivation: if ANY line had the answer DECLARED on it, say so — that
  // is the surprising fact. It is read across every line, not just the ones the
  // stage applies to, because a declaration usually shows up as a line switched
  // OFF, and those are exactly the ones `live` has dropped.
  const decidedBy = mine.some((x) => x.s.decidedBy === 'declared') ? 'declared'
    : mine.every((x) => x.s.decidedBy === 'always') ? 'always' : 'data';

  if (!live.length) {
    return {
      ...base,
      applies: false,
      decidedBy,
      state: 'not_applicable',
      detail: mine.length === 1 ? mine[0].s.detail : `Not needed on any of the ${mine.length} lines`,
      blockers: [],
    };
  }

  const states = live.map((x) => x.s.state);
  const doneCount = states.filter((s) => s === 'done' || s === 'not_applicable').length;
  const state = doneCount === live.length ? 'done'
    : states.every((s) => s === 'todo') ? 'todo'
      : 'partial';

  const worst = live.find((x) => x.s.state === 'todo') ?? live.find((x) => x.s.state === 'partial') ?? live[0];
  const detail = live.length === 1
    ? worst.s.detail
    : state === 'done'
      ? `All ${n(live.length, 'line')} done`
      : `${doneCount} of ${n(live.length, 'line')} done · line ${worst.line.lineNo}: ${worst.s.detail}`;

  return {
    ...base,
    applies: true,
    decidedBy,
    state,
    detail,
    blockers: live.flatMap((x) => x.s.blockers),
  };
}

/**
 * Where an order stands: the process it follows, each line's stages, the
 * order's roll-up, what to do next and whether it can be confirmed.
 *
 * An order with no process gets `process: null` and says why, plainly, rather
 * than being handed an invented one. A screen with nothing to draw is a
 * problem somebody can fix in a minute; a screen drawing the wrong stages is
 * one nobody notices for a month.
 */
export async function orderProcess(db, companyId, orderId) {
  const [[order]] = await db.query(
    'SELECT * FROM cf_sales_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL',
    [companyId, orderId],
  );
  if (!order) throw notFound('Sales order');

  const [lines] = await db.query(
    `SELECT l.*, m.code AS item_code, m.name AS item_name, m.status AS item_status
       FROM cf_sales_order_lines l
       LEFT JOIN cf_master_records m ON m.id = l.item_id
      WHERE l.company_id = ? AND l.order_id = ? AND l.deleted_at IS NULL
      ORDER BY l.line_no, l.id`,
    [companyId, orderId],
  );
  for (const l of lines) { l.code = l.item_code; l.name = l.item_name; }

  let process = null;
  let reason = null;
  if (order.process_id) {
    process = await getProcess(db, companyId, order.process_id).catch(() => null);
    if (!process) reason = 'The process this order was stamped with has been deleted.';
  } else {
    // Not stamped: say what it WOULD get, so the screen can offer to fix it.
    const match = await resolveProcess(db, companyId, { customerId: order.customer_id, orderType: order.order_type });
    reason = order.status === 'inquiry' || order.status === 'draft'
      ? `This order has no process. ${match.reason}`
      : `This order was created before it had a process. ${match.reason}`;
  }
  if (!process) {
    return { order: { id: order.id, code: order.code, status: order.status }, process: null, reason, lines: [], stages: [], nextStage: null, canConfirm: false };
  }

  const stageRows = process.stages
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map((s) => ({ stage_key: s.stageKey, label: s.label, sequence: s.sequence, requirement: s.requirement, override_spec_id: s.overrideSpec?.id ?? null, override_spec_code: s.overrideSpec?.code ?? null }));

  const ctx = await loadOrderContext(db, companyId, order, lines);

  // Each override specification, resolved once for every line's item. A stage
  // asks it of the LINE'S item — the thing being sold — not of everything
  // underneath: this is the customer saying what THIS line needs.
  const lineItemChains = await chainsFor(db, companyId, await lineItemsFor(db, companyId, lines));
  const overrideValues = new Map();
  for (const specId of [...new Set(stageRows.map((s) => s.override_spec_id).filter(Boolean))]) {
    overrideValues.set(specId, await resolveBooleanSpec(db, companyId, specId, lineItemChains));
  }

  const perLine = lines.map((line) => {
    const lctx = lineContext(ctx, order, line);
    return {
      lineId: line.id,
      lineNo: line.line_no,
      item: line.item_id ? { id: line.item_id, code: line.item_code, name: line.item_name, status: line.item_status } : null,
      quantity: Number(line.quantity),
      stages: stageRows.map((stage) => {
        const kind = CATALOGUE_BY_KEY.get(stage.stage_key);
        if (!kind) {
          return {
            stageKey: stage.stage_key, label: stage.label || stage.stage_key, sequence: stage.sequence,
            requirement: stage.requirement, applies: true, decidedBy: 'always', state: 'todo',
            detail: `There is no stage called "${stage.stage_key}" in this version — remove it from the process.`,
            blockers: [{ stageKey: stage.stage_key, lineId: line.id, lineNo: line.line_no, count: 0, message: `Process ${process.code} has an unknown stage "${stage.stage_key}".` }],
          };
        }
        const ov = stage.override_spec_id && line.item_id
          ? overrideValues.get(stage.override_spec_id)?.get(line.item_id) ?? null
          : null;
        return stageForLine(stage, kind, lctx, ov);
      }),
    };
  });

  const stages = stageRows.map((stage) => rollUp(stage, CATALOGUE_BY_KEY.get(stage.stage_key), perLine));
  const next = stages.find((s) => !satisfied(s)) ?? null;

  // Confirming is the commitment, so every stage before it has to be settled.
  // `confirm` itself is excluded — it is the act, not a precondition of itself.
  const before = stages.filter((s) => s.stageKey !== 'confirm');
  const canConfirm = lines.length > 0
    && before.every(satisfied)
    && ['inquiry', 'quoted', 'draft'].includes(order.status);

  return {
    order: { id: order.id, code: order.code, status: order.status, orderType: order.order_type },
    process: { id: process.id, code: process.code, name: process.name, status: process.status },
    reason,
    lines: perLine,
    stages,
    nextStage: next?.stageKey ?? null,
    canConfirm,
    blockers: stages.flatMap((s) => s.blockers),
  };
}

/** The classification chain inputs for the items the lines sell. */
async function lineItemsFor(db, companyId, lines) {
  const ids = lines.map((l) => l.item_id).filter(Boolean);
  if (!ids.length) return [];
  const [rows] = await db.query(
    `SELECT i.master_id AS id, i.source_definition_id, m.classification_id
       FROM cf_item_details i JOIN cf_master_records m ON m.id = i.master_id
      WHERE i.company_id = ? AND i.master_id IN (?) AND i.deleted_at IS NULL`,
    [companyId, [...new Set(ids)]],
  );
  return rows;
}
