/**
 * processService.js — how an order is worked, and where each of its lines has
 * got to (models/init.sql §18).
 *
 * A PROCESS is an ordered list of STAGES. A stage KIND is code — a screen
 * somebody wrote — so the kinds live in STAGE_CATALOGUE below and no
 * amount of configuration conjures another. What varies is data: which
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
 * Nothing here blocks anything — not even confirmation, since 2026-09-30
 * (CF_ERP_ORDER_FLOW_PLAN: Confirm is the customer's yes, not a stage).
 * `blockers` are things worth knowing, not permission to press a button.
 */
import { invalid, notFound, conflict, assertNoProblems } from '../lib/errors.js';
import { explode } from './bomService.js';
import { layoutDriftOfLines, driftSentence, FREEZE_FIRST } from './nestingService.js';
import { plannedMaterialOfLines } from './releaseService.js';
import { availability, madeRule } from './rollOutService.js';
import { cutPieceGaps } from './lockService.js';

export const PROCESS_STATUSES = ['draft', 'active', 'obsolete'];
export const STAGE_REQUIREMENTS = ['required', 'optional'];
export const PROCESS_ORDER_TYPES = ['customer', 'stock'];
export const STAGE_STATES = ['todo', 'partial', 'done', 'not_applicable'];

/**
 * The specification a material answers to say it must be nested. A code, not
 * an id: the kinds are code, and so is the one question a kind asks of
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
/**
 * CONFIRM IS NOT A STAGE ANY MORE (CF_ERP_ORDER_FLOW_PLAN, 2026-09-30: "how is
 * lock and confirm different?"). Confirming is the customer's yes — the order's
 * sales status in the header (Inquiry → Quoted → Confirmed), allowed any time
 * after lines exist. A process stored with a 'confirm' stage keeps the row
 * (nothing is deleted); it is simply not shown, and a stage waiting on the
 * customer's yes says so with action 'confirm' instead of a stage key.
 */
/*
 * CUT PIECES ARE NOT A STAGE ANY MORE EITHER (user, 2026-10-02: "why do we need
 * freeze design after cut pieces? … right after structure is locked, we should
 * auto generate cut pieces — no need to show that separately"). They were
 * always made by the system (cutPlateService.refreshCutPieces after every
 * structure / value save, and again inside lockLine before the checks), so a
 * stage of their own only ever showed a person something they could not do.
 * A plate part still without a cut piece is now said by Freeze design (while
 * the values are missing, or when freezing could not make it) and the list
 * itself opens from a button on Nesting. A stored 'cut_pieces' row is kept and
 * hidden, exactly like 'confirm'.
 */
export const RETIRED_STAGE_KEYS = new Set(['confirm', 'cut_pieces']);
/** The same keys as an SQL list literal, for the counts and the replace below. Constants, never input. */
const RETIRED_SQL = [...RETIRED_STAGE_KEYS].map((k) => `'${k}'`).join(', ');
const confirmFirst = (message) => ({ stageKey: null, action: 'confirm', message });
const orderStatusOf = (order) => (order.status === 'revised' ? order.status_before_revised ?? order.status : order.status);

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
      const { tree, drafts } = ctx;
      // A cut plate that has not picked its raw plate is not a structure
      // problem — NESTING chooses the plates, after the freeze — so it is not
      // counted here at all (CF_ERP_ORDER_FLOW_PLAN, 2026-09-30).
      const unresolved = ctx.unresolved.filter((x) => !x.underCutPlate);
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
    /**
     * Drawn as a CHECK on the Structure tab, not as a tab of its own (user,
     * 2026-10-02: "in the structure and value, same things are there so no
     * point having two tabs"). The stage is unchanged — its state, its
     * blockers and its hold on Freeze design — only where it is drawn moves.
     * A process without a Structure stage still shows it as its own tab.
     */
    shownIn: 'structure',
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
    key: 'lock',
    label: 'Freeze design',
    description: 'Gives out the piece codes: the structure is rolled out into pieces, each with its own code. From then on only the flows change (until release) — any other change means a new revision. It does not need the plates: nesting chooses them afterwards.',
    /** Only a line built from a template has a structure of its own to roll out. */
    applies: (ctx) => ctx.line.line_type === 'custom',
    state(ctx) {
      if (ctx.lock.lockedAt) return { state: 'done', detail: `Frozen — ${n(ctx.lock.pieces, 'piece')}`, blockers: [] };
      const L = ctx.line.line_no;
      const blockers = [];
      let waitingOn = null;
      const missing = ctx.values.missing;
      /*
       * CUT PIECES NEVER HOLD THE FREEZE ON THEIR OWN (user, 2026-10-02). They
       * are made by the system from the parts and values — after every save,
       * and once more by lockLine itself before its checks. So a plate part
       * with no cut piece yet is either waiting for the values (said in the
       * values blocker, which is the thing to do) or simply made when the
       * design is frozen. If freezing cannot make one, lockLine refuses with
       * the reason (lockService's cut-piece check), on the Freeze screen.
       */
      const bare = ctx.cut.parts.filter((p) => !p.hasCutPiece);
      if (missing.length) {
        waitingOn = { stageKey: 'values', message: `Fill the values first — ${n(missing.length, 'required value')} still empty.` };
        const named = missing.slice(0, 2).map((m) => `${m.itemLabel} · ${m.specCode}`);
        const cutToo = bare.length ? ` The cut pieces of ${n(bare.length, 'plate part')} are made as soon as they are filled.` : '';
        blockers.push({
          count: missing.length,
          message: `Line ${L}'s design cannot be frozen while ${n(missing.length, 'required value')} ${missing.length === 1 ? 'is' : 'are'} empty — ${named.join(', ')}${missing.length > 2 ? ` and ${missing.length - 2} more` : ''}.${cutToo}`,
        });
      }
      // A cut plate's raw plate still to be chosen does NOT hold the freeze
      // (CF_ERP_ORDER_FLOW_PLAN, 2026-09-30): nesting chooses it, after.
      const others = ctx.unresolved.filter((x) => !x.underCutPlate);
      if (others.length) {
        waitingOn ??= { stageKey: 'structure', message: 'Finish the structure first — some rows still need an item.' };
        blockers.push({
          count: others.length,
          message: `${n(others.length, 'row')} under line ${L} still need an item chosen before its design can be frozen — ${nameList(others.map(nameOf), 3)}.`,
        });
      }
      return {
        // Waiting on something is untouched; with nothing in the way, only the act is left.
        state: blockers.length ? 'todo' : 'partial',
        detail: blockers.length
          ? `Not frozen — ${n(blockers.length, 'thing')} to settle first`
          : bare.length
            ? `Ready to freeze — the cut pieces of ${n(bare.length, 'plate part')} are made first, then each piece gets its code`
            : 'Ready to freeze — each piece gets its code when the design is frozen',
        blockers,
        waitingOn,
      };
    },
  },
  {
    key: 'nesting',
    label: 'Nesting',
    description: 'Laying parts out on the plates they are cut from.',
    /**
     * The line has cut plates to lay out, or a material answers the NESTING
     * specification with yes. Buying and release need every cut plate's raw
     * plate, which nesting chooses, so a line with cut plates needs this stage
     * whether or not anybody created a NESTING specification. It comes AFTER
     * the freeze (CF_ERP_ORDER_FLOW_PLAN, 2026-09-30): it lays out the frozen
     * pieces, and nestingService refuses a line that is not frozen.
     */
    applies: (ctx) => ctx.nesting.items.length > 0 || (ctx.nesting.cutPieces ?? 0) > 0 || ctx.cut.parts.length > 0,
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
      const drift = ctx.nesting.drift ?? [];
      if (saved?.lots > 0 && drift.length) {
        const first = drift.find((d) => d.why === 'count') ?? drift[0];
        const which = first.code ?? 'a cut piece';
        const example = first.why === 'gone'
          ? `${which} is laid out but no longer in the structure`
          : `${which}: the line needs ${first.needs}, the layout places ${first.placed}`;
        const more = drift.length > 1 ? `, and ${n(drift.length - 1, 'more cut piece')}` : '';
        return {
          state: 'partial',
          detail: `The nesting is out of date — ${driftSentence(drift)}`,
          blockers: [{
            count: drift.length,
            message: `Line ${ctx.line.line_no}'s structure changed after it was nested (${example}${more}). Nest the line again so the plates it buys match what it cuts.`,
          }],
        };
      }
      if (saved?.lots > 0) {
        const byHand = saved.manual > 0 ? `, ${saved.manual} by hand` : '';
        // Left out by the line's nesting choices (§40): their plate is chosen at
        // nesting, so buying and release wait on them — said here, not hidden.
        const out = ctx.nesting.leftOut;
        const leftOut = out?.pieces ? ` · ${n(out.pieces, 'piece')} left out (plate chosen at nesting)` : '';
        return {
          state: 'done',
          detail: `${n(saved.lots, 'plate')} laid out, ${n(saved.pieces, 'piece')} placed${byHand}${leftOut}`,
          blockers: [],
        };
      }

      const pieces = ctx.nesting.cutPieces ?? 0;
      // Not frozen: nothing can be laid out yet, whatever else is missing — the
      // freeze stage says what IT waits on.
      if (ctx.line.line_type === 'custom' && !ctx.lock.lockedAt) {
        return {
          state: 'todo',
          detail: pieces ? `${n(pieces, 'cut piece')} to lay out once the design is frozen` : 'Waiting for the design to be frozen',
          blockers: [{
            count: pieces || 1,
            message: `Line ${ctx.line.line_no}'s design is not frozen yet — nesting lays out the frozen pieces.`,
          }],
          waitingOn: { stageKey: 'lock', message: FREEZE_FIRST },
        };
      }
      if (!items.length) {
        const missing = ctx.values.missing.length;
        const waitingOn = pieces === 0
          ? (missing
            ? { stageKey: 'values', message: `Fill the values first — ${n(missing, 'required value')} still empty.` }
            // Frozen with plate parts and no cut piece: they come from the structure's parts.
            : { stageKey: 'structure', message: "No cut pieces were made from this line's plate parts — check their thickness, size and grade in the structure." })
          : null;
        return {
          state: 'todo',
          detail: pieces ? `${n(pieces, 'cut piece')} to lay out on plates — no plan saved yet` : 'The cut pieces are not made yet — nothing to lay out',
          blockers: [{
            count: pieces || 1,
            message: `Line ${ctx.line.line_no} has cut plates and no nesting plan has been accepted. Nesting chooses the raw plate of every cut plate — buying and release need it.`,
          }],
          waitingOn,
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
    description: 'Getting in the material the order consumes but does not make — before production, once the order is confirmed and the design frozen (and nested).',
    /** The line draws material from stock at all — whether or not any is short today. */
    applies: (ctx) => ctx.material.length > 0 || ctx.buyRows.length > 0,
    state(ctx) {
      /*
       * BUYING COMES BEFORE PRODUCTION (CF_ERP_ORDER_FLOW_PLAN, 2026-09-30):
       * "Buying should happen before production na?" It waits on three things,
       * in this order: the customer's yes (nothing is bought for an inquiry),
       * the frozen design (the material is read off the frozen pieces) and,
       * where a cut plate still has no plate, the nest. After that the numbers
       * are the buy list's own: a released line's requirements, or a frozen
       * line's planned material (releaseService.plannedMaterialOfLines).
       */
      if (!ctx.confirmed) {
        return {
          state: 'todo',
          detail: 'Waiting for the order to be confirmed — nothing is bought for an inquiry',
          blockers: [],
          waitingOn: confirmFirst('Confirm the order first — nothing is bought for an inquiry.'),
        };
      }
      if (ctx.line.line_type === 'custom' && !ctx.lock.lockedAt) {
        return {
          state: 'todo',
          detail: 'Waiting for the design to be frozen — the material is read off the frozen pieces',
          blockers: [],
          waitingOn: { stageKey: 'lock', message: 'Freeze the design first — the buy list takes its material from the frozen pieces.' },
        };
      }
      if (!ctx.release && ctx.planned && !ctx.planned.ready) {
        const k = ctx.planned.openPlates;
        return {
          state: 'todo',
          detail: `Waiting for nesting — ${n(k, 'cut plate')} ${k === 1 ? 'has' : 'have'} no plate yet, so there is nothing to buy for ${k === 1 ? 'it' : 'them'}`,
          blockers: [],
          waitingOn: { stageKey: 'nesting', message: `Nest the line first — ${n(k, 'cut plate')} ${k === 1 ? 'has' : 'have'} no plate yet.` },
        };
      }
      const rows = ctx.buyRows;
      if (!rows.length) return { state: 'done', detail: 'Nothing to buy', blockers: [] };
      // Covered = held for the line, free in stock, or on order. On order counts:
      // the plan's "done when every material is covered (held / free / on order)".
      const open = rows.filter((m) => m.held + m.free + m.onOrder + EPS < m.required);
      const onOrderOnly = rows.filter((m) => m.held + m.free + EPS < m.required && m.held + m.free + m.onOrder + EPS >= m.required);
      // A catalog line has no freeze, so the buy list counts it once it is released.
      const unreleasedHint = open.length && ctx.buySource === 'estimate' && !ctx.release && ctx.made.length > 0
        ? { stageKey: 'production', message: 'Release the line first — the buy list counts this line once it is released.' } : null;
      if (!open.length) {
        return {
          state: 'done',
          detail: onOrderOnly.length
            ? `All ${n(rows.length, 'material')} covered — ${onOrderOnly.length} on order`
            : `All ${n(rows.length, 'material')} held or in stock`,
          blockers: [],
        };
      }
      const short = (m) => round6(m.required - m.held - m.free - m.onOrder);
      return {
        state: open.length < rows.length ? 'partial' : 'todo',
        detail: `${n(open.length, 'material')} to buy — ${nameList(open.map((m) => `${m.label} short ${short(m)}`))}`,
        blockers: [{
          count: open.length,
          message: `Line ${ctx.line.line_no} is short of ${n(open.length, 'material')} with nothing on order — ${nameList(open.map((m) => m.label), 3)}.`,
        }],
        waitingOn: unreleasedHint,
      };
    },
  },
  {
    key: 'production',
    label: 'Production',
    description: 'Releasing to the shop what the order makes rather than buys. Needs a confirmed order and a frozen design; the steps wait for their material.',
    /** Something under the line is made: a temporary item, or a catalog item sourced 'make'. */
    applies: (ctx) => ctx.made.length > 0,
    state(ctx) {
      const { release } = ctx;
      if (!release) {
        const mustFreeze = ctx.line.line_type === 'custom' && !ctx.lock.lockedAt;
        const openPlates = ctx.planned && !ctx.planned.ready ? ctx.planned.openPlates : 0;
        return {
          // Not buying: release does not wait for the steel — its steps do.
          waitingOn: !ctx.confirmed ? confirmFirst('Confirm the order first — release needs a confirmed order.')
            : mustFreeze ? { stageKey: 'lock', message: 'Freeze the design first — release takes its piece codes from the frozen design.' }
              : openPlates ? { stageKey: 'nesting', message: `Nest the line first — ${n(openPlates, 'cut plate')} ${openPlates === 1 ? 'has' : 'have'} no plate yet.` }
                : null,
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
              WHERE s.company_id = p.company_id AND s.process_id = p.id AND s.deleted_at IS NULL
                AND s.stage_key NOT IN (${RETIRED_SQL})) AS stage_count
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

/**
 * The catalogue's order, applied when a process is READ. Stage order is only a
 * position (cf_process_stages.sequence), and the real dependencies between
 * stages are fixed by the code (Nesting lays out the frozen design; Buying needs
 * a confirmed order and a frozen, nested line; Release needs a confirmed order
 * and a frozen design — CF_ERP_ORDER_FLOW_PLAN, 2026-09-30), so a process
 * stored in an older order is shown in the right one without a data fix. A key
 * this build has never heard of keeps its place after the known ones.
 */
export function inCatalogueOrder(stages, keyOf = (s) => s.stageKey) {
  const rank = (s) => { const i = STAGE_KEYS.indexOf(keyOf(s)); return i < 0 ? STAGE_KEYS.length : i; };
  return stages.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map((x) => x.s);
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
    // A retired kind (confirm) is kept in the table and left out here.
    stages: inCatalogueOrder(stages.filter((s) => !RETIRED_STAGE_KEYS.has(s.stage_key)).map(shapeStage)).map((s, i) => ({ ...s, sequence: i + 1 })),
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
      `SELECT COUNT(*) AS n FROM cf_process_stages WHERE company_id = ? AND process_id = ? AND deleted_at IS NULL AND stage_key NOT IN (${RETIRED_SQL})`,
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
        WHERE company_id = ? AND process_id = ? AND deleted_at IS NULL AND status NOT IN ('closed','lost','cancelled','revised')`,
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
  const given = Array.isArray(input.stages) ? input.stages : null;
  if (!given) throw invalid('INVALID', 'Send the stages as a list, in the order they are worked.');
  // 'confirm' and 'cut_pieces' are no longer stages (RETIRED_STAGE_KEYS): an older screen or
  // script that still sends it is not refused — the entry is simply dropped.
  const list = given.filter((s) => !RETIRED_STAGE_KEYS.has(String(s?.stageKey ?? s?.stage_key ?? '').trim()));

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

  // A stored retired row ('confirm', 'cut_pieces') is KEPT (nothing about it is deleted): it only moves
  // out of the way of the new sequence numbers, which it could otherwise clash
  // with on uq_cps_seq.
  await db.query(
    `UPDATE cf_process_stages SET deleted_at = NOW() WHERE company_id = ? AND process_id = ? AND deleted_at IS NULL AND stage_key NOT IN (${RETIRED_SQL})`,
    [c.companyId, processId],
  );
  await db.query(
    `UPDATE cf_process_stages SET sequence = 100000 + id WHERE company_id = ? AND process_id = ? AND deleted_at IS NULL AND stage_key IN (${RETIRED_SQL}) AND sequence < 100000`,
    [c.companyId, processId],
  );
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
  // Every read here is one round trip (~49 ms to production), so the reads that
  // do not need one another's answers go side by side (2026-10-01: 49 one after
  // another, ~3 s on the KEPL order; now in a handful of stages). On a single
  // connection (inside a transaction) mysql2 queues them — same answers.
  const lineIds = lines.map((l) => l.id);

  // 1. Each line's structure, exploded once — the lines side by side.
  const trees = new Map(await Promise.all(lines.map(async (line) => [
    line.id,
    line.item_id ? await explode(db, companyId, line.item_id, { rootQuantity: Number(line.quantity), maxDepth: 15 }) : null,
  ])));

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
  const lockedLines = lines.filter((l) => l.locked_at).map((l) => l.id);
  const temporaryIds = [...itemIds].filter((id) => detail.get(id)?.item_type === 'temporary');

  const onOrderOf = async (ids) => {
    if (!ids.length) return [];
    const [rows] = await db.query(
      `SELECT l.item_id, SUM(GREATEST(l.quantity - l.qty_received, 0)) AS outstanding
         FROM cf_purchase_order_lines l
         JOIN cf_purchase_orders p ON p.id = l.purchase_order_id AND p.deleted_at IS NULL
        WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.item_id IN (?)
          AND p.status IN ('requested','quoting','draft','ordered','partially_received')
        GROUP BY l.item_id`,
      [companyId, ids],
    );
    return rows;
  };

  // 5. Releases and how far their steps have got — then, for the released
  //    lines, their requirements; for the frozen ones, the planned material.
  const releasesStage = (async () => {
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
      [companyId, lineIds],
    ) : [[]];
    const releases = new Map(relRows.map((r) => [r.order_line_id, { id: r.id, steps: Number(r.steps), doneSteps: Number(r.done_steps) }]));
    // 7. What Buying counts (CF_ERP_ORDER_FLOW_PLAN, 2026-09-30) — the buy list's
    //    own numbers: a frozen line not released has its PLANNED material (the
    //    requirements release will write, in bulk — 3 round trips for any number
    //    of lines) and whether it is ready (no cut plate still without a plate);
    //    a released line has its requirements, with what is held for them.
    const releasedIds = [...releases.values()].map((r) => r.id);
    const [planned, [reqRows]] = await Promise.all([
      plannedMaterialOfLines(db, companyId, lines.filter((l) => l.locked_at && !releases.has(l.id) && l.item_id)),
      releasedIds.length ? db.query(
        `SELECT r.order_line_id, q.item_id, m.code, m.name,
                SUM(GREATEST(q.quantity - q.issued, 0)) AS wanted, SUM(COALESCE(v.held, 0)) AS held
           FROM cf_material_requirements q
           JOIN cf_production_releases r ON r.id = q.release_id
           JOIN cf_master_records m ON m.id = q.item_id
           LEFT JOIN (SELECT v.requirement_id, SUM(v.quantity) AS held
                        FROM cf_stock_reservations v
                        JOIN cf_material_requirements q2 ON q2.id = v.requirement_id AND q2.release_id IN (?)
                       WHERE v.company_id = ? AND v.status = 'active' AND v.deleted_at IS NULL
                       GROUP BY v.requirement_id) v ON v.requirement_id = q.id
          WHERE q.company_id = ? AND q.release_id IN (?) AND q.deleted_at IS NULL
          GROUP BY r.order_line_id, q.item_id, m.code, m.name
          ORDER BY r.order_line_id, m.code, q.item_id`,
        [releasedIds, companyId, companyId, releasedIds],
      ) : [[]],
    ]);
    return { releases, planned, reqRows };
  })();

  // 5b. The nesting actually saved against each line. cf_plate_lots is one row
  // per physical plate, so counting them is counting plates; the placements
  // under them are pieces. acceptNesting refuses a plan that does not cover
  // every required piece, so lots existing means the line IS laid out. 5d. What
  // a saved layout no longer matches — nestingService.layoutDrift, the rule the
  // Nesting screen shows, counted off the trees exploded in step 1. A piece
  // count changed after nesting (a quantity, a removed part, the line quantity)
  // makes it out of date, the same as a cut piece added or deleted: "done"
  // would be a lie the buy list inherits.
  const lotsStage = (async () => {
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
      [companyId, lineIds],
    ) : [[]];
    const lotsBy = new Map(lotRows.map((r) => [r.order_line_id, {
      lots: Number(r.lots), pieces: Number(r.pieces), manual: Number(r.manual_lots ?? 0),
    }]));
    // leftOutBy: cut pieces a line's nesting choices leave out (§40) — no drift, but said on the stage.
    const leftOutBy = new Map();
    const driftBy = await layoutDriftOfLines(db, companyId, lines.filter((l) => (lotsBy.get(l.id)?.lots ?? 0) > 0).map((l) => l.id), trees, { leftOut: leftOutBy });
    return { lotsBy, driftBy, leftOutBy };
  })();

  // 6. Specification chains for every item, the NESTING answer on each, and the
  //    required values still empty.
  const specStage = (async () => {
    const [chains, [[nestSpec]]] = await Promise.all([
      chainsFor(db, companyId, [...detail.values()].map((d) => ({
        id: d.master_id, classification_id: d.classification_id, source_definition_id: d.source_definition_id,
      }))),
      db.query("SELECT id, data_type FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL", [companyId, NESTING_SPEC_CODE]),
    ]);
    const [nestingBy, values] = await Promise.all([
      nestSpec && nestSpec.data_type === 'boolean' ? resolveBooleanSpec(db, companyId, nestSpec.id, chains) : new Map(),
      missingRequiredValues(db, companyId, chains),
    ]);
    return { chains, nestSpec, nestingBy, values };
  })();

  const [
    free, poRows, rel, lots, spec, [blankRows], [pieceRows], cut, [cutClassRows],
  ] = await Promise.all([
    // 3. Free stock, once, for every item that could be drawn from it.
    itemIds.size ? availability(db, companyId, [...itemIds]) : new Map(),
    // 4. What is already on order, so "short" can tell waiting from missing.
    onOrderOf([...itemIds]),
    releasesStage,
    lotsStage,
    specStage,
    // 5c. How many cut pieces a line already has (no stage of their own since
    // 2026-10-02 — Nesting counts them, and Freeze design says when one is
    // missing); nesting is done when they are laid out. Two questions, two counts.
    lines.length ? db.query(
      `SELECT i.owner_order_line_id AS order_line_id, COUNT(*) AS blanks
         FROM cf_master_records m
         JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
         JOIN cf_classification_nodes n ON n.id = m.classification_id AND n.code = 'CUT_PLATE'
        WHERE m.company_id = ? AND m.deleted_at IS NULL AND i.owner_order_line_id IN (?)
        GROUP BY i.owner_order_line_id`,
      [companyId, lineIds],
    ) : [[]],
    // 5e. What each locked line was rolled out into (cf_order_pieces): how many
    //     pieces, and which BOM lines it made — a 'both' item follows the lock's
    //     decision, not today's stock (rollOutService.madeRule).
    lockedLines.length ? db.query(
      `SELECT order_line_id, bom_line_id, COUNT(*) AS n FROM cf_order_pieces
        WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL
        GROUP BY order_line_id, bom_line_id`,
      [companyId, lockedLines],
    ) : [[]],
    // 5f. The plate parts under every line and whether each has its cut piece —
    //     lockService's question, so the stages and the Lock screen agree.
    cutPieceGaps(db, companyId, temporaryIds),
    // The classification a cut plate is filed under, so a selection hanging off
    // one can be told from any other unfinished row.
    db.query("SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = 'CUT_PLATE' AND deleted_at IS NULL", [companyId]),
  ]);

  const onOrder = new Map(poRows.map((r) => [r.item_id, Number(r.outstanding) || 0]));
  const { releases, planned, reqRows } = rel;
  const { lotsBy, driftBy, leftOutBy } = lots;
  const { chains, nestSpec, nestingBy, values } = spec;
  const cutPiecesBy = new Map(blankRows.map((r) => [r.order_line_id, Number(r.blanks)]));
  const locksBy = new Map(lockedLines.map((id) => [id, { pieces: 0, bomLines: new Set() }]));
  for (const r of pieceRows) {
    const e = locksBy.get(r.order_line_id);
    e.pieces += Number(r.n);
    if (r.bom_line_id != null) e.bomLines.add(Number(r.bom_line_id));
  }
  const partById = new Map(cut.parts.map((p) => [p.id, p]));
  const cutClassIds = new Set(cutClassRows.map((r) => Number(r.id)));
  const labelOf = (id) => nameOf(detail.get(id));

  const requiredBy = new Map();                      // lineId -> [{ id, label, required, held }]
  for (const r of reqRows) {
    if (!requiredBy.has(r.order_line_id)) requiredBy.set(r.order_line_id, []);
    requiredBy.get(r.order_line_id).push({ id: r.item_id, label: r.code ?? r.name, required: round6(r.wanted), held: round6(r.held) });
  }
  // Free stock and on-order for what those name that the trees did not (a nest's plates).
  const extra = [...new Set([
    ...reqRows.map((r) => r.item_id),
    ...[...planned.values()].flatMap((p) => p.reqs.map((q) => q.itemId)),
  ])].filter((id) => !itemIds.has(id));
  if (extra.length) {
    const [more, ooRows] = await Promise.all([availability(db, companyId, extra), onOrderOf(extra)]);
    for (const [id, v] of more) free.set(id, v);
    for (const r of ooRows) onOrder.set(r.item_id, Number(r.outstanding) || 0);
  }

  return { trees, detail, free, onOrder, releases, lotsBy, cutPiecesBy, driftBy, leftOutBy, chains, nestingBy, values, labelOf, nestSpec: nestSpec ?? null, locksBy, partById, cutClassIds, planned, requiredBy };
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
  if (!tree) return { made, material: [], unresolved, drafts };
  // The one made rule (rollOutService.madeRule). A locked line follows the
  // decisions its lock took; any other line asks today's free stock.
  const decide = madeRule({
    orderType: order.order_type,
    sourcingOf: (node) => (node.kind === 'catalog' ? (ctx.detail.get(node.id)?.sourcing ?? 'stock') : null),
    free: new Map([...ctx.free].map(([id, v]) => [id, v.free])),
    lockedBoth: ctx.locksBy.get(line.id)?.bomLines ?? null,
  });

  const consider = (node, count, parent = null) => {
    if (node.kind === 'selection' || node.kind === 'template') {
      // A row whose item is still a definition has nothing decided about it.
      if (node.kind === 'selection') {
        // Hanging off a cut plate, it is the raw plate nesting has yet to choose.
        node.underCutPlate = !!parent && ctx.cutClassIds.has(Number(ctx.detail.get(parent.id)?.classification_id));
        unresolved.push(node);
      }
      return;
    }
    // A catalog item still in draft is unfinished setup. A row of the line (a
    // temporary item) is not: it has no draft life of its own — locking the
    // line is what activates it — so it is never counted here.
    if (node.status === 'draft' && node.kind !== 'temporary') drafts.push(node);
    const isMade = decide(node, count, node === tree.root).made;

    if (isMade) {
      made.push(node);
      for (const kid of node.children) consider(kid, round6(kid.quantity * count), node);
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

/**
 * What Buying counts for a line, in the buy list's terms (purchaseService):
 * a released line's requirements, a frozen line's planned material, or — a
 * line with neither (a catalog line not released, a line not frozen) — the
 * estimate from the tree. Rows: { id, label, required, held, free, onOrder }.
 * Free stock and on order are per line, not shared out across lines, as
 * splitLine has always done.
 */
function buyRowsOf(ctx, line, material) {
  const withStock = (m) => ({ ...m, free: ctx.free.get(m.id)?.free ?? 0, onOrder: ctx.onOrder.get(m.id) ?? 0 });
  const released = ctx.releases.has(line.id);
  if (released) return { buySource: 'released', buyRows: (ctx.requiredBy.get(line.id) ?? []).map(withStock) };
  const planned = ctx.planned.get(Number(line.id));
  if (planned) {
    const byItem = new Map();
    for (const r of planned.reqs) {
      const e = byItem.get(r.itemId) ?? { id: r.itemId, label: r.design.code ?? r.design.name, required: 0, held: 0 };
      e.required = round6(e.required + r.quantity);
      byItem.set(r.itemId, e);
    }
    return { buySource: 'planned', buyRows: [...byItem.values()].map(withStock) };
  }
  return { buySource: 'estimate', buyRows: material.map((m) => withStock({ id: m.id, label: m.label, required: m.required, held: 0 })) };
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
      cutPieces: ctx.cutPiecesBy.get(line.id) ?? 0,
      drift: ctx.driftBy.get(line.id) ?? [],
      leftOut: ctx.leftOutBy?.get(line.id) ?? null,
    },
    values: { required, missing },
    release: ctx.releases.get(line.id) ?? null,
    confirmed: ['confirmed', 'closed'].includes(orderStatusOf(order)),
    planned: ctx.planned.get(Number(line.id)) ?? null,
    ...buyRowsOf(ctx, line, split.material),
    lock: { lockedAt: line.locked_at ?? null, pieces: ctx.locksBy.get(line.id)?.pieces ?? 0 },
    // This line's plate parts, each once, and whether each has its cut piece.
    cut: { parts: [...new Set(split.made.map((x) => x.id))].map((id) => ctx.partById.get(id)).filter(Boolean) },
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
/** Where a stage is drawn when it is a check on another stage's tab (Values on Structure); absent otherwise. */
const shownInOf = (kind) => (kind?.shownIn ? { shownIn: kind.shownIn } : {});

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
      ...shownInOf(kind),
      label,
      sequence: stage.sequence,
      requirement: stage.requirement,
      applies: false,
      decidedBy,
      state: 'not_applicable',
      waitingOn: null,
      detail: declared
        ? `Switched off for ${nameOf(ctx.line)} by ${stage.override_spec_code ?? 'a specification'}`
        : notApplicableDetail(kind.key, ctx),
      blockers: [],
    };
  }
  const out = kind.state(ctx);
  return {
    stageKey: kind.key,
    ...shownInOf(kind),
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
    // One line saying what this stage is waiting on, and where to go for it.
    // Only while the stage is not done.
    waitingOn: out.state === 'done' ? null : out.waitingOn ?? null,
  };
}

/** Why a derived stage does not apply — in the words of the thing that decided. */
function notApplicableDetail(key, ctx) {
  switch (key) {
    case 'structure': return 'Sells a catalog item with no BOM — there is nothing under it';
    case 'values': return 'Nothing under this line has a required value to capture';
    case 'lock': return 'Sells a catalog item as it is — only a line built from a template has a structure to lock';
    case 'nesting':
      // "No material says yes" sends somebody looking at the plates. If the
      // specification was never created, the plates are not the problem.
      return 'This line has no cut plates and no material to lay out';
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
  const base = { stageKey: stage.stage_key, ...shownInOf(kind), label, sequence: stage.sequence, requirement: stage.requirement };

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
    waitingOn: state === 'done' ? null : (worst.s.waitingOn ?? live.find((x) => x.s.waitingOn)?.s.waitingOn ?? null),
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
  // The order and its lines side by side: neither needs the other.
  const [[[order]], [lines]] = await Promise.all([
    db.query('SELECT * FROM cf_sales_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, orderId]),
    db.query(
      `SELECT l.*, m.code AS item_code, m.name AS item_name, m.status AS item_status
         FROM cf_sales_order_lines l
         LEFT JOIN cf_master_records m ON m.id = l.item_id
        WHERE l.company_id = ? AND l.order_id = ? AND l.deleted_at IS NULL
        ORDER BY l.line_no, l.id`,
      [companyId, orderId],
    ),
  ]);
  if (!order) throw notFound('Sales order');
  for (const l of lines) { l.code = l.item_code; l.name = l.item_name; }

  let process = null;
  let reason = null;
  // A stamped order nearly always has its process, so its context starts
  // reading beside the process (it does not need it); it is waited for below.
  let ctxP = null;
  if (order.process_id) {
    ctxP = loadOrderContext(db, companyId, order, lines);
    ctxP.catch(() => { /* awaited below, or dropped with a deleted process */ });
    process = await getProcess(db, companyId, order.process_id).catch(() => null);
    if (!process) reason = 'The process this order was stamped with has been deleted.';
  } else {
    // Not stamped: say what it WOULD get, so the screen can offer to fix it.
    const match = await resolveProcess(db, companyId, { customerId: order.customer_id, orderType: order.order_type });
    // A revised order answers as it stood when a later revision replaced it (init.sql §27).
    const was = order.status === 'revised' ? order.status_before_revised ?? order.status : order.status;
    reason = was === 'inquiry' || was === 'draft'
      ? `This order has no process. ${match.reason}`
      : `This order was created before it had a process. ${match.reason}`;
  }
  if (!process) {
    return { order: { id: order.id, code: order.code, status: order.status }, process: null, reason, lines: [], stages: [], nextStage: null, canConfirm: false };
  }

  const stageRows = process.stages
    .slice()
    .map((s) => ({ stage_key: s.stageKey, label: s.label, sequence: s.sequence, requirement: s.requirement, override_spec_id: s.overrideSpec?.id ?? null, override_spec_code: s.overrideSpec?.code ?? null }));

  // Each override specification, resolved once for every line's item. A stage
  // asks it of the LINE'S item — the thing being sold — not of everything
  // underneath: this is the customer saying what THIS line needs. Read beside
  // the order's context, which it does not need.
  const overrides = (async () => {
    const specIds = [...new Set(stageRows.map((s) => s.override_spec_id).filter(Boolean))];
    const out = new Map();
    if (!specIds.length) return out;
    const lineItemChains = await chainsFor(db, companyId, await lineItemsFor(db, companyId, lines));
    const values = await Promise.all(specIds.map((specId) => resolveBooleanSpec(db, companyId, specId, lineItemChains)));
    specIds.forEach((specId, i) => out.set(specId, values[i]));
    return out;
  })();
  const [ctx, overrideValues] = await Promise.all([ctxP ?? loadOrderContext(db, companyId, order, lines), overrides]);

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

  // CONFIRM IS THE CUSTOMER'S YES, NOT THE END OF THE DESIGN (2026-09-30): it
  // can happen at any point once the order has lines — no stage holds it up.
  // What setOrderStatus checks is checked here too, so the button never offers
  // what the server refuses: a customer order needs its customer and a
  // committed date (on the order, or on every line).
  const undated = lines.filter((l) => !l.committed_date);
  const canConfirm = lines.length > 0
    && ['inquiry', 'quoted', 'draft'].includes(order.status)
    && (order.order_type !== 'customer' || (!!order.customer_id && (!!order.committed_date || !undated.length)));

  return {
    order: { id: order.id, code: order.code, status: order.status, orderType: order.order_type },
    process: { id: process.id, code: process.code, name: process.name, status: process.status },
    reason,
    lines: perLine,
    stages,
    nextStage: next?.stageKey ?? null,
    canConfirm,
    // Everything still outstanding, across every stage — nothing gates the
    // confirm any more, so this is what is left to do, not what holds it up.
    blockers: stages.flatMap((s) => s.blockers ?? []),
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
