/**
 * cf_plant_machines.mjs — the plant's machine tree, its machines, and their
 * specs, from the plant's own workbook (TM/imports/Process_Flow_v5.xlsx).
 *
 * Sheets read: PFPL_Mc_Master_ASIS (the equipment register — one row per
 * physical unit already on the floor: model/capacity/serial/status/service
 * dates, but NO category) and PFPL_Mc_Group_ASIS (the purchase register — one
 * row per purchase line: CATEGORY, MACHINE/PROCESS, QTY, rate, vendor,
 * invoice). Crew numbers come from Stage_Wise_Variables — a 28-row reference
 * table, hand-transcribed below with its sheet row cited on each one rather
 * than parsed at runtime, the same way cf_bridge_data.mjs turns a small
 * source table into checkable constants.
 *
 * NEVER commit TM/imports/Process_Flow_v5.xlsx, and nothing extracted from it
 * (this script's own working dumps lived in scripts/_scratch, deleted after
 * use) — it holds purchase prices and invoices. Writing purchase rate/vendor/
 * invoice into THIS DATABASE is what the plan (CF_ERP_PLAN.md, "production
 * setup from the plant's Process_Flow_v5 workbook", B.3) asks for; the rule is
 * about the file and raw extracts never reaching a git repo.
 *
 * REPLACES the generic machine tree `cf_shop_import.mjs` built (copied from
 * fab_erp: one family "Machines", 8 subfamilies grouped by what a machine does
 * to steel, 16 types, ~19 machines). That tree is RETIRED (status set to
 * inactive), never deleted: cf_operation_machine_rules and the KEPL catalog's
 * flows still point at it, and a hard delete would either refuse (IN_USE) or,
 * worse, silently orphan something upstream. See retireOldTree() below.
 *
 * THE TREE
 * --------
 * classificationService requires exactly three levels for a machine — Family
 * (depth 0) > Subfamily (depth 1) > Type (depth 2, where machines sit).
 *   Family    = PFPL_Mc_Group_ASIS.CATEGORY (six of them: Major equipment,
 *               Welding machines, Material handling equipment, Other,
 *               Electrical, Vehicles) — the register's own top division.
 *   Subfamily = a purpose grouping inside that category (Cutting, Drilling,
 *               Welding, Cranes, Grinding, Jacks, Compressors, Tools, ...).
 *               The register gives no middle tier of its own — CATEGORY is
 *               already its coarsest split — so this script supplies one, by
 *               what the machine is FOR: the same axis the plan names
 *               explicitly for "Other" ("split by purpose"), applied to every
 *               family so none of them gets a Subfamily that only repeats its
 *               Family's name.
 *   Type/leaf = the MACHINE/PROCESS value, normalised so one leaf is one KIND
 *               of machine: "CNC 1" and "CNC 2" merge into one leaf "CNC
 *               plasma cutting" (two machines on it — Sample_Calculations
 *               gives each its own cutting-speed chart, so they stay two
 *               MACHINES on the SAME type, not two types); a bed, a power
 *               supply or a welding bed bought alongside a real machine
 *               becomes its own accessories leaf that no operation names
 *               (cf_plant_operations.mjs never writes a machine rule against
 *               one — checked in plant_setup_test.mjs).
 *
 * MERGING THE TWO REGISTERS
 * --------------------------
 * The equipment register enumerates PHYSICAL UNITS (one row = one machine).
 * The purchase register enumerates PURCHASE LINES (one row = one invoice
 * line; qty = how many units it bought) and is the only source for rate,
 * vendor, invoice and date of purchase. Merge rule, in order:
 *   1. A purchase line's CODE, when the equipment register also carries it,
 *      merges that row with the matching equipment-register row(s) — one
 *      machine per match, both sources' facts kept.
 *   2. Quantity beyond the equipment-register matches (or a coded line the
 *      equipment register never lists) still becomes machines: the first
 *      keeps the purchase line's own code, the rest are coded by CFMC-ANY
 *      (the rule cf_shop_import.mjs added: `{classification.code}-{00}`,
 *      recreated here if missing).
 *   3. An equipment-register row whose equipment ID no purchase line ever
 *      names is still a real machine — created from the equipment register
 *      alone, matched to a leaf by its NAME (the register has no category),
 *      and printed as "only in the equipment register".
 * A purchase line's UOM decides whether qty means machines at all: NO'S and
 * SET are countable (qty 2 -> two machines); MT and MTR are steel or cable
 * bought by weight or length, so the whole line becomes ONE asset record
 * carrying its qty and UOM as a fact (120 m of armoured cable is one cable
 * run, not 120 one-metre "machines").
 *
 * WHOLE ASSET REGISTER: the user's own words — "it doesn't hurt to have them
 * all; anyway we will have to model" — so panels, transformers, UPS, cables,
 * lights, hand tools and vehicles are loaded exactly like the machines an
 * operation actually runs on; only the classification differs (they sit on
 * leaves no operation's machine rule ever names).
 *
 * DATA QUALITY, TAKEN AS GIVEN, NEVER "FIXED"
 * --------------------------------------------
 *  - "Year of manufacture" mixes a bare year, a year with a stray letter
 *    ("2019 L", "2019 H") and a full date — kept as TEXT.
 *  - "Date of purchase" mixes DD.MM.YYYY text, ISO dates, a multi-date cell
 *    ("24, 25.01.2025") and one row where an invoice number was typed into
 *    the date cell (purchase S.No 153, the Bolero Camper) — kept as TEXT.
 *  - "Machine Status" is normalised only for casing/typos the sheet itself is
 *    inconsistent about ("Idel" -> "idle") — see STATUS_MAP.
 *  - AMC/Warranty, Last Service, Next Service Due, Critical Spares and every
 *    REMARKS column are empty for every row in this workbook. The specs are
 *    still created so the fields exist to fill in later.
 *
 * Code = the equipment ID where the row has one (PFPL/CNCP/01); otherwise
 * CFMC-ANY mints one from the leaf's own code, numbered per leaf.
 *
 *   cd multi_app_be && node scripts/cf_kepl/cf_plant_machines.mjs
 *   cd multi_app_be && CF_PLANT_COMPANY=30005 node scripts/cf_kepl/cf_plant_machines.mjs --commit
 *
 * Dry run by default: the plan is printed from the sheets alone before the
 * database is touched; the tree, machines and values are then built inside
 * ONE transaction, read back through the same services a screen would use
 * (proving the write really works), and only THEN committed if --commit was
 * given — otherwise rolled back, leaving the database exactly as it was.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import ExcelJS from 'exceljs';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');            // registers the 'machine' codegen entity
const cls = await imp('apps/cf_erp/services/classificationService.js');
const mach = await imp('apps/cf_erp/services/machineService.js');
const specSvc = await imp('apps/cf_erp/services/specificationService.js');
const valueSvc = await imp('apps/cf_erp/services/valueService.js');
const ruleSvc = await imp('apps/cf_erp/services/assignmentService.js');
const codegen = await imp('apps/cf_erp/modules/codegen/service.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const { insertRows } = await imp('apps/cf_erp/lib/db.js');
const engine = await imp('apps/cf_erp/modules/codegen/engine.js');

const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? process.env.CF_PLANT_COMPANY ?? 2);
const COMMIT = process.argv.includes('--commit');
const SERIAL = process.argv.includes('--serial'); // reference path for golden comparisons
const WORKBOOK = path.join(BE, '..', 'imports', 'Process_Flow_v5.xlsx');
const where = /^(localhost|127\.0\.0\.1|::1)?$/i.test(process.env.DB_HOST ?? '') ? 'local' : 'PRODUCTION';
const say = (...a) => console.log(...a);
const str = (v) => (v == null || v === '' ? null : String(v).trim());

if (!fs.existsSync(WORKBOOK)) throw new Error(`${WORKBOOK} is missing — this script reads TM/imports/Process_Flow_v5.xlsx directly.`);

// ===========================================================================
// 1. Taxonomy — defined before any row is read, so the mapping is auditable
//    on its own and never grown ad hoc while scanning rows.
// ===========================================================================

const FAMILIES = {
  MAJOR: { code: 'PLANT-MAJOR', name: 'Major equipment' },
  WELD: { code: 'PLANT-WELD', name: 'Welding machines' },
  HANDLE: { code: 'PLANT-HANDLE', name: 'Material handling equipment' },
  OTHER: { code: 'PLANT-OTHER', name: 'Other' },
  ELEC: { code: 'PLANT-ELEC', name: 'Electrical' },
  VEH: { code: 'PLANT-VEH', name: 'Vehicles' },
};

const SUB = {
  MAJOR_CUT: { code: 'PLANT-MAJOR-CUT', name: 'Cutting', family: 'MAJOR' },
  MAJOR_DRILL: { code: 'PLANT-MAJOR-DRILL', name: 'Drilling', family: 'MAJOR' },
  MAJOR_FITUP: { code: 'PLANT-MAJOR-FITUP', name: 'Fit-up', family: 'MAJOR' },
  MAJOR_FINISH: { code: 'PLANT-MAJOR-FINISH', name: 'Finishing', family: 'MAJOR' },
  WELD_PROC: { code: 'PLANT-WELD-PROC', name: 'Welding processes', family: 'WELD' },
  HANDLE_CRANE: { code: 'PLANT-HANDLE-CRANE', name: 'Cranes', family: 'HANDLE' },
  HANDLE_LIFT: { code: 'PLANT-HANDLE-LIFT', name: 'Lifting', family: 'HANDLE' },
  HANDLE_TRANS: { code: 'PLANT-HANDLE-TRANS', name: 'Transport', family: 'HANDLE' },
  OTHER_CUT: { code: 'PLANT-OTHER-CUT', name: 'Cutting', family: 'OTHER' },
  OTHER_GRIND: { code: 'PLANT-OTHER-GRIND', name: 'Grinding', family: 'OTHER' },
  OTHER_DRILL: { code: 'PLANT-OTHER-DRILL', name: 'Drilling', family: 'OTHER' },
  OTHER_BLAST: { code: 'PLANT-OTHER-BLAST', name: 'Blasting', family: 'OTHER' },
  OTHER_METAL: { code: 'PLANT-OTHER-METAL', name: 'Metallising', family: 'OTHER' },
  OTHER_PAINT: { code: 'PLANT-OTHER-PAINT', name: 'Painting', family: 'OTHER' },
  OTHER_WEIGH: { code: 'PLANT-OTHER-WEIGH', name: 'Weighing', family: 'OTHER' },
  OTHER_OVEN: { code: 'PLANT-OTHER-OVEN', name: 'Ovens', family: 'OTHER' },
  OTHER_COMPR: { code: 'PLANT-OTHER-COMPR', name: 'Compressors', family: 'OTHER' },
  OTHER_JACK: { code: 'PLANT-OTHER-JACK', name: 'Jacks', family: 'OTHER' },
  OTHER_POWER: { code: 'PLANT-OTHER-POWER', name: 'Power & standby', family: 'OTHER' },
  OTHER_PACK: { code: 'PLANT-OTHER-PACK', name: 'Packing', family: 'OTHER' },
  OTHER_TOOL: { code: 'PLANT-OTHER-TOOL', name: 'Tools & measurement', family: 'OTHER' },
  OTHER_SWEEP: { code: 'PLANT-OTHER-SWEEP', name: 'Housekeeping', family: 'OTHER' },
  ELEC_DIST: { code: 'PLANT-ELEC-DIST', name: 'Distribution', family: 'ELEC' },
  ELEC_CABLE: { code: 'PLANT-ELEC-CABLE', name: 'Cabling', family: 'ELEC' },
  ELEC_LIGHT: { code: 'PLANT-ELEC-LIGHT', name: 'Lighting', family: 'ELEC' },
  VEH_SITE: { code: 'PLANT-VEH-SITE', name: 'Site vehicles', family: 'VEH' },
};

/** "CATEGORY|MACHINE/PROCESS" -> leaf placement. accessory leaves are never
 *  named by an operation's machine rule (cf_plant_operations.mjs / the test). */
const PAIR = new Map(Object.entries({
  'MAJOR EQUIPMENT|CNC 1': { sub: 'MAJOR_CUT', leaf: 'CNCPLASMA', leafName: 'CNC plasma cutting' },
  'MAJOR EQUIPMENT|CNC 2': { sub: 'MAJOR_CUT', leaf: 'CNCPLASMA', leafName: 'CNC plasma cutting' },
  'MAJOR EQUIPMENT|BEAM LINE': { sub: 'MAJOR_FITUP', leaf: 'HBEAMLINE', leafName: 'H-beam line' },
  'MAJOR EQUIPMENT|CNC DRILLING': { sub: 'MAJOR_DRILL', leaf: 'CNCDRILL', leafName: 'CNC drilling' },
  'MAJOR EQUIPMENT|AUTOMATIC BLASTING': { sub: 'MAJOR_FINISH', leaf: 'AUTOBLAST', leafName: 'Automatic blasting' },
  'MAJOR EQUIPMENT|PAINT FUME EXTRACTION': { sub: 'MAJOR_FINISH', leaf: 'BLASTACC', leafName: 'Blasting & finishing accessories', accessory: true },
  'MAJOR EQUIPMENT|BLASTING': { sub: 'MAJOR_FINISH', leaf: 'BLASTACC', leafName: 'Blasting & finishing accessories', accessory: true },

  // Leaf codes SAWWELD/MIGWELD, not SAW/MIG: the OLD generic tree
  // (cf_shop_import.mjs, being retired below) already used bare SAW and MIG
  // for its own machine types — ensureLeaf's collision guard would refuse a
  // plain reuse of either code outright, which is exactly what caught this.
  'WELDING MACHINES|SAW': { sub: 'WELD_PROC', leaf: 'SAWWELD', leafName: 'SAW welding' },
  'WELDING MACHINES|MIG': { sub: 'WELD_PROC', leaf: 'MIGWELD', leafName: 'MIG welding' },
  'WELDING MACHINES|ARC': { sub: 'WELD_PROC', leaf: 'ARC', leafName: 'Arc welding' },
  'WELDING MACHINES|STUD': { sub: 'WELD_PROC', leaf: 'STUD', leafName: 'Stud welding' },

  'MATERIAL HANDLING EQUIPMENT|EOT': { sub: 'HANDLE_CRANE', leaf: 'EOT', leafName: 'EOT crane' },
  'MATERIAL HANDLING EQUIPMENT|GANTRY': { sub: 'HANDLE_CRANE', leaf: 'GANTRY', leafName: 'Gantry crane' },
  'MATERIAL HANDLING EQUIPMENT|MAGNETIC LIFTING': { sub: 'HANDLE_LIFT', leaf: 'MAGLIFT', leafName: 'Magnetic lifting' },
  'MATERIAL HANDLING EQUIPMENT|TRANSFER TROLLEY': { sub: 'HANDLE_TRANS', leaf: 'TROLLEY', leafName: 'Transfer trolley' },

  'OTHER|PUG CUTTING': { sub: 'OTHER_CUT', leaf: 'PUGCUT', leafName: 'Pug cutting' },
  'OTHER|CUTTING MACHINE': { sub: 'OTHER_CUT', leaf: 'HANDCUT', leafName: 'Hand cutting tools' },
  'OTHER|BEVELLING MACHINE': { sub: 'OTHER_CUT', leaf: 'BEVEL', leafName: 'Bevelling' },
  'OTHER|GRINDING MACHINE': { sub: 'OTHER_GRIND', leaf: 'GRIND', leafName: 'Grinding machines' },
  'OTHER|DRILLING MACHINE': { sub: 'OTHER_DRILL', leaf: 'MANDRILL', leafName: 'Manual & magnetic drilling' },
  'OTHER|BLASTING M/C': { sub: 'OTHER_BLAST', leaf: 'BLASTHOPPER', leafName: 'Manual blasting accessories', accessory: true },
  'OTHER|METALZIING': { sub: 'OTHER_METAL', leaf: 'METALGUN', leafName: 'Metallising gun' },
  'OTHER|PAINTING': { sub: 'OTHER_PAINT', leaf: 'PAINTGUN', leafName: 'Airless paint sprayer' },
  'OTHER|WEIGH BRIDGE': { sub: 'OTHER_WEIGH', leaf: 'WEIGHBR', leafName: 'Weighbridge' },
  'OTHER|OVEN': { sub: 'OTHER_OVEN', leaf: 'OVEN', leafName: 'Oven' },
  'OTHER|COMPRESSOR': { sub: 'OTHER_COMPR', leaf: 'COMPRESSOR', leafName: 'Air compressor' },
  'OTHER|JACKS': { sub: 'OTHER_JACK', leaf: 'JACK', leafName: 'Hydraulic jack' },
  'OTHER|UPS': { sub: 'OTHER_POWER', leaf: 'UPSOTHER', leafName: 'UPS' },
  'OTHER|STABILIZER': { sub: 'OTHER_POWER', leaf: 'STAB', leafName: 'Voltage stabilizer' },
  'OTHER|FEEDER': { sub: 'OTHER_POWER', leaf: 'FEEDER', leafName: 'Wire feeder' },
  'OTHER|PACKING M/C': { sub: 'OTHER_PACK', leaf: 'PACKMC', leafName: 'Packing machine' },
  'OTHER|BLOWER': { sub: 'OTHER_TOOL', leaf: 'HANDTOOL', leafName: 'Hand tools & measurement' },
  'OTHER|TOOLS': { sub: 'OTHER_TOOL', leaf: 'HANDTOOL', leafName: 'Hand tools & measurement' },
  'OTHER|SWEEPING MACHINE': { sub: 'OTHER_SWEEP', leaf: 'SWEEPER', leafName: 'Sweeping machine' },

  'ELECTRICAL|TRANSFORMER': { sub: 'ELEC_DIST', leaf: 'TRANSFORMER', leafName: 'Transformer' },
  'ELECTRICAL|PANELS': { sub: 'ELEC_DIST', leaf: 'PANEL', leafName: 'Electrical panel' },
  'ELECTRICAL|CABLES': { sub: 'ELEC_CABLE', leaf: 'CABLE', leafName: 'Armoured cable' },
  'ELECTRICAL|LIGHTS': { sub: 'ELEC_LIGHT', leaf: 'LIGHT', leafName: 'LED light' },

  'VEHICLES|HYDRA': { sub: 'VEH_SITE', leaf: 'HYDRA', leafName: 'Hydra crane truck' },
  'VEHICLES|CAMBER': { sub: 'VEH_SITE', leaf: 'UTILITYVEH', leafName: 'Utility vehicle' },
}));

/** Exceptions where one MACHINE/PROCESS value hides an accessory bought
 *  alongside the real machine — by purchase S.No, checked against its own
 *  DESCRIPTION so a re-extract that reorders rows cannot silently misfire. */
const ACCESSORY_OVERRIDE = new Map([
  [2, { leaf: 'CNCCUTACC', leafName: 'CNC cutting accessories', sub: 'MAJOR_CUT', mustInclude: 'CNC BED' }],
  [4, { leaf: 'CNCCUTACC', leafName: 'CNC cutting accessories', sub: 'MAJOR_CUT', mustInclude: 'POWER SUPPLY' }],
  [5, { leaf: 'CNCCUTACC', leafName: 'CNC cutting accessories', sub: 'MAJOR_CUT', mustInclude: 'CNC BED' }],
  [16, { leaf: 'SAWACC', leafName: 'SAW welding accessories', sub: 'WELD_PROC', mustInclude: 'SAW BED' }],
]);

/** Equipment-register rows carry no CATEGORY, so an equipment-only row (no
 *  purchase line names its equipment ID) is placed by its own NAME instead.
 *  Only names that actually turn up equipment-only are listed — anything else
 *  is reported as unmapped rather than guessed at. */
const normName = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const EQUIP_NAME_LEAF = new Map(Object.entries({
  TRANSFORMER: { sub: 'ELEC_DIST', leaf: 'TRANSFORMER', leafName: 'Transformer' },
  WEIGHTBRIDGE: { sub: 'OTHER_WEIGH', leaf: 'WEIGHBR', leafName: 'Weighbridge' },
  LTKIOSKPANEL: { sub: 'ELEC_DIST', leaf: 'PANEL', leafName: 'Electrical panel' },
  PCCPANEL: { sub: 'ELEC_DIST', leaf: 'PANEL', leafName: 'Electrical panel' },
  APFCPANEL: { sub: 'ELEC_DIST', leaf: 'PANEL', leafName: 'Electrical panel' },
  LIGHTINGPANEL: { sub: 'ELEC_DIST', leaf: 'PANEL', leafName: 'Electrical panel' },
  SUBLTPANEL01: { sub: 'ELEC_DIST', leaf: 'PANEL', leafName: 'Electrical panel' },
  SUBLTPANEL02: { sub: 'ELEC_DIST', leaf: 'PANEL', leafName: 'Electrical panel' },
  SUBLTPANEL03: { sub: 'ELEC_DIST', leaf: 'PANEL', leafName: 'Electrical panel' },
  SUBLTPANEL04: { sub: 'ELEC_DIST', leaf: 'PANEL', leafName: 'Electrical panel' },
  SUBLTPANEL05: { sub: 'ELEC_DIST', leaf: 'PANEL', leafName: 'Electrical panel' },
  CNCPANEL01: { sub: 'ELEC_DIST', leaf: 'PANEL', leafName: 'Electrical panel' },
  CNCPANEL02: { sub: 'ELEC_DIST', leaf: 'PANEL', leafName: 'Electrical panel' },
  HBEAMPANEL: { sub: 'ELEC_DIST', leaf: 'PANEL', leafName: 'Electrical panel' },
  STDWPANEL01: { sub: 'ELEC_DIST', leaf: 'PANEL', leafName: 'Electrical panel' },
  STDWPANEL02: { sub: 'ELEC_DIST', leaf: 'PANEL', leafName: 'Electrical panel' },
  SDBSUBDISTRUBITIONBOARD: { sub: 'ELEC_DIST', leaf: 'PANEL', leafName: 'Electrical panel' },
  CNCPLASMACUTTING01: { sub: 'MAJOR_CUT', leaf: 'CNCPLASMA', leafName: 'CNC plasma cutting' },
  CNCPLASMACUTTING02: { sub: 'MAJOR_CUT', leaf: 'CNCPLASMA', leafName: 'CNC plasma cutting' },
  SERVOSTABILIZER: { sub: 'OTHER_POWER', leaf: 'STAB', leafName: 'Voltage stabilizer' },
  AIRCOMPRESSOR: { sub: 'OTHER_COMPR', leaf: 'COMPRESSOR', leafName: 'Air compressor' },
  EXHASTFAN: { sub: 'OTHER_TOOL', leaf: 'HANDTOOL', leafName: 'Hand tools & measurement' },
  HBEAMASSEMBLINGMACHINE: { sub: 'MAJOR_FITUP', leaf: 'HBEAMLINE', leafName: 'H-beam line' },
  CNCDRILLINGMACHINE: { sub: 'MAJOR_DRILL', leaf: 'CNCDRILL', leafName: 'CNC drilling' },
  PEDESTALDRILLINGMACHINE: { sub: 'OTHER_DRILL', leaf: 'MANDRILL', leafName: 'Manual & magnetic drilling' },
  EOTCRANE: { sub: 'HANDLE_CRANE', leaf: 'EOT', leafName: 'EOT crane' },
  GANTRYCRANE: { sub: 'HANDLE_CRANE', leaf: 'GANTRY', leafName: 'Gantry crane' },
  TRANSVERSETROLLEY: { sub: 'HANDLE_TRANS', leaf: 'TROLLEY', leafName: 'Transfer trolley' },
  SAWRECTIFIER: { sub: 'WELD_PROC', leaf: 'SAWWELD', leafName: 'SAW welding' },
  SAWRECTIFIERFEEDER: { sub: 'WELD_PROC', leaf: 'SAWWELD', leafName: 'SAW welding' },
  SAWINVERTER: { sub: 'WELD_PROC', leaf: 'SAWWELD', leafName: 'SAW welding' },
  SAWINVERTERFEEDER: { sub: 'WELD_PROC', leaf: 'SAWWELD', leafName: 'SAW welding' },
  STUDWELDINGMACHINE: { sub: 'WELD_PROC', leaf: 'STUD', leafName: 'Stud welding' },
  HYDRAULICPOWERPACK: { sub: 'OTHER_JACK', leaf: 'JACK', leafName: 'Hydraulic jack' },
  AUTOSHOTBLASTINGLINE: { sub: 'MAJOR_FINISH', leaf: 'AUTOBLAST', leafName: 'Automatic blasting' },
  FUMEEXTRACTIONSYSTEM: { sub: 'MAJOR_FINISH', leaf: 'BLASTACC', leafName: 'Blasting & finishing accessories', accessory: true },
  BLASTINGHOPPERMANUAL: { sub: 'OTHER_BLAST', leaf: 'BLASTHOPPER', leafName: 'Manual blasting accessories', accessory: true },
  AIRLESSPAINTSPRAYER: { sub: 'OTHER_PAINT', leaf: 'PAINTGUN', leafName: 'Airless paint sprayer' },
  METALSPRAYGUN: { sub: 'OTHER_METAL', leaf: 'METALGUN', leafName: 'Metallising gun' },
  UPS: { sub: 'OTHER_POWER', leaf: 'UPSOTHER', leafName: 'UPS' },
}));

function leafOfPurchase(row) {
  const override = ACCESSORY_OVERRIDE.get(row.sno);
  if (override) {
    if (!String(row.description ?? '').toUpperCase().includes(override.mustInclude)) {
      throw new Error(`purchase S.No ${row.sno} was expected to describe "${override.mustInclude}" (accessory override) but says "${row.description}" — check ACCESSORY_OVERRIDE.`);
    }
    return { subKey: override.sub, leaf: override.leaf, leafName: override.leafName, accessory: true };
  }
  const p = PAIR.get(`${row.category}|${row.machineProcess}`);
  return p ? { subKey: p.sub, leaf: p.leaf, leafName: p.leafName, accessory: !!p.accessory } : null;
}
function leafOfEquipmentOnly(equip) {
  const g = EQUIP_NAME_LEAF.get(normName(equip.name));
  return g ? { subKey: g.sub, leaf: g.leaf, leafName: g.leafName, accessory: !!g.accessory } : null;
}

const STATUS_MAP = {
  active: 'active', inactive: 'inactive', idel: 'idle', idle: 'idle',
  'under maintenance': 'under_maintenance', 'under repair': 'under_repair',
};
function normalizeStatus(raw, problems, label) {
  if (raw == null || raw === '') return null;
  const v = STATUS_MAP[String(raw).trim().toLowerCase()];
  if (!v) { problems.push(`${label}: unrecognised Machine Status "${raw}" — left unset.`); return null; }
  return v;
}
const COUNTABLE_UOM = new Set(['NOS', 'SET']);
const isCountable = (uom) => COUNTABLE_UOM.has(String(uom ?? '').toUpperCase().replace(/[^A-Z]/g, ''));

/** The 19 new machine specs (plan B.3). Rules are attached on every top-level
 *  Family below, since there is no single shared root above all six of them. */
const MACHINE_SPECS = [
  { code: 'MODEL', name: 'Model', dataType: 'text' },
  { code: 'CAPACITY', name: 'Capacity', dataType: 'text', description: 'Freeform: the register mixes kVA, AMP, tonnes, L/S and more — no single unit fits all of it.' },
  { code: 'MANUFACTURER', name: 'Manufacturer', dataType: 'text' },
  { code: 'YEAR_OF_MANUFACTURE', name: 'Year of manufacture', dataType: 'text', description: 'Text, not a number: the register mixes a bare year, a year with a stray letter ("2019 L") and a full date.' },
  { code: 'PURCHASE_DATE', name: 'Purchase date', dataType: 'text', description: 'Text, not a date: the register mixes DD.MM.YYYY, ISO dates, a multi-date cell, and one row where an invoice number was typed into the date column.' },
  { code: 'PURCHASE_RATE', name: 'Purchase rate', dataType: 'number', decimals: 2, defaultUom: 'INR' },
  { code: 'INVOICE_NO', name: 'Invoice no.', dataType: 'text' },
  { code: 'VENDOR', name: 'Vendor', dataType: 'text' },
  { code: 'LOCATION', name: 'Location', dataType: 'text' },
  {
    code: 'EQUIPMENT_STATUS', name: 'Equipment status', dataType: 'option',
    options: [{ value: 'active' }, { value: 'inactive' }, { value: 'under_maintenance', label: 'Under maintenance' }, { value: 'under_repair', label: 'Under repair' }, { value: 'idle' }],
    description: 'Finer than cf_machines.status (active/inactive only) — matches the register\'s own Machine Status column.',
  },
  { code: 'AMC_WARRANTY', name: 'AMC / warranty', dataType: 'text' },
  { code: 'LAST_SERVICE', name: 'Last service date', dataType: 'date' },
  { code: 'NEXT_SERVICE_DUE', name: 'Next service due', dataType: 'date' },
  { code: 'CRITICAL_SPARES', name: 'Critical spares', dataType: 'text' },
  { code: 'REMARKS', name: 'Remarks', dataType: 'text' },
  { code: 'OPERATORS_DAY', name: 'Operators — day shift', dataType: 'number', decimals: 0 },
  { code: 'OPERATORS_NIGHT', name: 'Operators — night shift', dataType: 'number', decimals: 0 },
  { code: 'HELPERS_DAY', name: 'Helpers — day shift', dataType: 'number', decimals: 0 },
  { code: 'HELPERS_NIGHT', name: 'Helpers — night shift', dataType: 'number', decimals: 0 },
];

/**
 * Crew per shift, by leaf — Stage_Wise_Variables (28 rows), only where the
 * sheet gives clean numbers. "(depends on no. of fitups)", "same as above"
 * and "min 8 per assembly" are not numbers and are left out, same as the
 * sheet's own "depends" note for Fit-up.
 */
const CREW = {
  // row3/4: CNC-1 and CNC-2 give identical crew; they share one leaf.
  CNCPLASMA: { OPERATORS_DAY: 2, OPERATORS_NIGHT: 1, HELPERS_DAY: 3, HELPERS_NIGHT: 0 },
  HBEAMLINE: { OPERATORS_DAY: 1, OPERATORS_NIGHT: 0, HELPERS_DAY: 0, HELPERS_NIGHT: 0 }, // row5
  CNCDRILL: { OPERATORS_DAY: 1, OPERATORS_NIGHT: 0, HELPERS_DAY: 0, HELPERS_NIGHT: 0 }, // row6
  AUTOBLAST: { OPERATORS_DAY: 1, OPERATORS_NIGHT: 0, HELPERS_DAY: 0, HELPERS_NIGHT: 0 }, // row7
  PUGCUT: { OPERATORS_DAY: 2, OPERATORS_NIGHT: 2, HELPERS_DAY: 2, HELPERS_NIGHT: 2 }, // row10
  MIGWELD: { OPERATORS_DAY: 12, OPERATORS_NIGHT: 12, HELPERS_DAY: 12, HELPERS_NIGHT: 12 }, // row12 ("3 per contractor")
  SAWWELD: { OPERATORS_DAY: 4, OPERATORS_NIGHT: 4, HELPERS_DAY: 4, HELPERS_NIGHT: 4 }, // row13 ("1 per contractor")
  STUD: { OPERATORS_DAY: 2, OPERATORS_NIGHT: 2, HELPERS_DAY: 2, HELPERS_NIGHT: 2 }, // row14 (contractor scope)
  MANDRILL: { OPERATORS_DAY: 16, OPERATORS_NIGHT: 16, HELPERS_DAY: 0, HELPERS_NIGHT: 0 }, // row15 ("4 per contractor")
  METALGUN: { OPERATORS_DAY: 2, OPERATORS_NIGHT: 2, HELPERS_DAY: 2, HELPERS_NIGHT: 2 }, // row23
  PAINTGUN: { OPERATORS_DAY: 2, OPERATORS_NIGHT: 2, HELPERS_DAY: 2, HELPERS_NIGHT: 2 }, // row24
  // Left out (not clean numbers): Fitup ("depends on no. of fitups", row11),
  // Line Matching / Laydown Assembly / hole transfer / Mig welding-in-laydown
  // ("same as above", rows17-20), Trial Assembly ("min 8 per assembly", row21),
  // manual Blasting (row22 — no distinct leaf; the operation's machine is the
  // automatic blast line above, and the manual top-up crew has no machine
  // group of its own in this tree).
};

// ===========================================================================
// 2. Read the workbook
// ===========================================================================

const val = (cell) => {
  if (cell.type === ExcelJS.ValueType.Merge) return val(cell.master);
  const v = cell.value;
  if (v == null) return null;
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((r) => r.text).join('').replace(/\s+/g, ' ').trim();
    if (v.result !== undefined) return v.result == null ? null : v.result;
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return null;
  }
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v;
};

function readSheet(wb, name, columns) {
  const ws = wb.getWorksheet(name);
  if (!ws) throw new Error(`sheet ${name} is missing from the workbook`);
  const out = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const rec = { _row: r };
    let any = false;
    for (const [key, col] of Object.entries(columns)) {
      const v = val(row.getCell(col));
      if (v !== null && v !== '') any = true;
      rec[key] = v;
    }
    if (any) out.push(rec);
  }
  return out;
}

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(WORKBOOK);

const equipmentRows = readSheet(wb, 'PFPL_Mc_Master_ASIS', {
  sno: 1, name: 2, model: 3, capacity: 4, serial: 5, manufacturer: 6,
  yearOfManufacture: 7, purchaseDate: 8, equipmentId: 9, location: 10,
  status: 11, amcWarranty: 12, lastService: 13, nextServiceDue: 14,
  criticalSpares: 15, remarks: 16,
}).map((r) => ({ ...r, equipmentId: str(r.equipmentId) }));

const purchaseRows = readSheet(wb, 'PFPL_Mc_Group_ASIS', {
  sno: 1, category: 2, code: 3, machineProcess: 4, description: 5, make: 6,
  model: 7, qty: 8, uom: 9, rate: 10, totalAmount: 11, dateOfPurchase: 12,
  invoiceNo: 13, vendor: 14, remarks: 15,
}).map((r) => ({ ...r, code: str(r.code), qty: Number(r.qty) || 1, uom: String(r.uom ?? '').trim() }));

say(`${where}, company ${COMPANY} — ${COMMIT ? 'writing the plant machine tree' : 'dry run: builds it, prints it, rolls back'}`);
say(`source: ${path.relative(path.join(BE, '..'), WORKBOOK)}`);
say(`   PFPL_Mc_Master_ASIS: ${equipmentRows.length} equipment rows`);
say(`   PFPL_Mc_Group_ASIS : ${purchaseRows.length} purchase rows`);

// ===========================================================================
// 3. Merge into a flat list of machines to create
// ===========================================================================

const equipmentEntries = equipmentRows.map((equip, index) => ({ equip, index }));
const equipmentById = new Map();
for (const entry of equipmentEntries) {
  const e = entry.equip;
  if (!e.equipmentId) continue;
  if (!equipmentById.has(e.equipmentId)) equipmentById.set(e.equipmentId, []);
  equipmentById.get(e.equipmentId).push(entry);
}
const consumed = new Set(); // equipment-register row index
const problems = [];
const unmapped = new Map(); // label -> count
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
const planned = []; // { subKey, leaf, leafName, accessory, code, name, serialNumber, values, notes, from }

function equipValues(equip) {
  return {
    MODEL: str(equip.model), CAPACITY: str(equip.capacity), MANUFACTURER: str(equip.manufacturer),
    YEAR_OF_MANUFACTURE: str(equip.yearOfManufacture), PURCHASE_DATE: str(equip.purchaseDate),
    LOCATION: str(equip.location), EQUIPMENT_STATUS: normalizeStatus(equip.status, problems, `equipment S.No ${equip.sno} (${equip.name})`),
    AMC_WARRANTY: str(equip.amcWarranty), LAST_SERVICE: str(equip.lastService), NEXT_SERVICE_DUE: str(equip.nextServiceDue),
    CRITICAL_SPARES: str(equip.criticalSpares), REMARKS: str(equip.remarks),
  };
}

const matchText = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function fallbackEquipmentMatches(purchase, leaf) {
  const model = matchText(purchase.model);
  const maker = matchText(purchase.make);
  if (!model || !maker) return [];
  return equipmentEntries.filter(({ equip, index }) => {
    if (consumed.has(index)) return false;
    const placement = leafOfEquipmentOnly(equip);
    return placement?.leaf === leaf.leaf
      && matchText(equip.model) === model
      && matchText(equip.manufacturer) === maker;
  });
}

for (const p of purchaseRows) {
  const leaf = leafOfPurchase(p);
  if (!leaf) { bump(unmapped, `${p.category} | ${p.machineProcess}`); continue; }
  const unitCount = isCountable(p.uom) ? Math.max(1, p.qty) : 1;
  const matches = p.code
    ? (equipmentById.get(p.code) ?? []).filter(({ index }) => !consumed.has(index))
    : fallbackEquipmentMatches(p, leaf);
  for (let i = 0; i < unitCount; i++) {
    const entry = matches[i];
    const equip = entry?.equip;
    if (entry) consumed.add(entry.index);
    const notes = [];
    if (!isCountable(p.uom) && p.qty !== 1) notes.push(`bulk: ${p.qty} ${p.uom} on purchase S.No ${p.sno} — one asset record, not ${p.qty} machines.`);
    if (p.code && matches.length === 0) notes.push(`code ${p.code} given in the purchase register; no equipment-register row carries it.`);
    if (p.code && i >= matches.length && matches.length > 0) notes.push(`purchase S.No ${p.sno} qty ${p.qty} exceeds the ${matches.length} equipment-register row(s) coded ${p.code}; this unit has no equipment match.`);
    planned.push({
      ...leaf,
      code: equip ? equip.equipmentId : (i === 0 ? p.code : null),
      name: str(equip?.name) ?? str(p.description) ?? leaf.leafName,
      serialNumber: equip ? str(equip.serial) : null,
      values: {
        ...equipValues(equip ?? {}),
        MODEL: (equip && str(equip.model)) ?? str(p.model),
        MANUFACTURER: (equip && str(equip.manufacturer)) ?? str(p.make),
        VENDOR: str(p.vendor), INVOICE_NO: str(p.invoiceNo),
        PURCHASE_DATE: (equip && str(equip.purchaseDate)) ?? str(p.dateOfPurchase),
        PURCHASE_RATE: p.rate == null || p.rate === '' ? null : Number(p.rate),
        REMARKS: (equip && str(equip.remarks)) ?? str(p.remarks),
      },
      notes,
      from: equip ? 'matched' : 'purchase-only',
      purchaseSno: p.sno,
      sourceKey: `purchase:${p.sno}:${i + 1}`,
    });
  }
}

for (const { equip, index } of equipmentEntries) {
    if (consumed.has(index)) continue;
    const leaf = leafOfEquipmentOnly(equip);
    if (!leaf) { bump(unmapped, `(equipment only) ${equip.name}`); continue; }
    planned.push({
      ...leaf, code: equip.equipmentId, name: str(equip.name) ?? leaf.leafName, serialNumber: str(equip.serial),
      values: { ...equipValues(equip), VENDOR: null, INVOICE_NO: null, PURCHASE_RATE: null },
      notes: [`only in the equipment register — no purchase line carries code ${equip.equipmentId}.`],
      from: 'equipment-only', equipmentSno: equip.sno,
      sourceKey: `equipment:${index + 1}`,
    });
}

// ===========================================================================
// 4. Print the plan (from the sheets alone — before the database is touched)
// ===========================================================================

const byLeaf = new Map();
for (const m of planned) {
  if (!byLeaf.has(m.leaf)) byLeaf.set(m.leaf, []);
  byLeaf.get(m.leaf).push(m);
}
say('\n-- reconciliation --');
const tallyFrom = { matched: 0, 'purchase-only': 0, 'equipment-only': 0 };
for (const m of planned) tallyFrom[m.from]++;
say(`   ${planned.length} machines planned: ${tallyFrom.matched} matched in both registers, ${tallyFrom['purchase-only']} only in purchases, ${tallyFrom['equipment-only']} only in the equipment register`);
const notable = planned.filter((m) => m.notes.length);
if (notable.length) {
  say(`   ${notable.length} with a reconciliation note:`);
  for (const m of notable.slice(0, 40)) say(`     ${(m.code ?? '(auto code)').padEnd(20)} ${m.leafName.padEnd(30)} ${m.notes.join(' ')}`);
  if (notable.length > 40) say(`     ... and ${notable.length - 40} more`);
}
if (unmapped.size) {
  say(`\n   ${unmapped.size} (CATEGORY | MACHINE/PROCESS) pair(s) this script does not place — nothing built for them:`);
  for (const [k, n] of unmapped) say(`     ${k}  (${n} row${n === 1 ? '' : 's'})`);
}
if (problems.length) { say(`\n   ${problems.length} data problem(s):`); for (const p of problems) say(`     ${p}`); }

say('\n-- tree plan --');
for (const [famKey, fam] of Object.entries(FAMILIES)) {
  const subsOf = Object.entries(SUB).filter(([, s]) => s.family === famKey);
  say(`${fam.code}  ${fam.name}`);
  for (const [subKey, sub] of subsOf) {
    const leavesOf = [...byLeaf.entries()].filter(([, ms]) => ms[0].subKey === subKey);
    if (!leavesOf.length) continue;
    say(`   ${sub.code.padEnd(22)} ${sub.name}`);
    for (const [leafCode, ms] of leavesOf) {
      const acc = ms[0].accessory ? '  [accessory — no operation]' : '';
      say(`      ${leafCode.padEnd(14)} ${ms[0].leafName.padEnd(32)} ${String(ms.length).padStart(3)} machine(s)${acc}`);
    }
  }
}
say(`\n   ${planned.length} machines total across ${byLeaf.size} leaf types`);

// ===========================================================================
// 5. Write it (one transaction; commit only with --commit)
// ===========================================================================

const tally = { created: {}, reused: {} };
const bumpTally = (bag, k, n = 1) => { bag[k] = (bag[k] ?? 0) + n; };

async function ensureSpec(db, c, def) {
  const [[row]] = await db.query('SELECT id FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [c.companyId, def.code]);
  if (row) { bumpTally(tally.reused, 'specification'); return row.id; }
  const s = await specSvc.createSpec(db, c, def);
  bumpTally(tally.created, 'specification');
  return s.id;
}

async function ensureCodingRule(db, c) {
  const [[have]] = await db.query(
    `SELECT id, code FROM cf_code_schemes WHERE company_id = ? AND entity_type = 'machine' AND target_field = 'code' AND status = 'active' AND deleted_at IS NULL`,
    [c.companyId],
  );
  if (have) { bumpTally(tally.reused, 'coding rule'); return; }
  await codegen.createScheme(db, c.companyId, c.userId, {
    code: 'CFMC-ANY', name: 'Machine code', entityType: 'machine', targetField: 'code', seqScope: 'prefix', priority: 0,
    description: 'Machine type code, then a number that restarts for each type: SAW-01, SAW-02.', conditions: [],
    segments: [
      { segmentType: 'token', tokenKey: 'classification.code', transform: 'upper', isRequired: true },
      { segmentType: 'literal', literalText: '-' },
      { segmentType: 'sequence', format: '00' },
    ],
  });
  bumpTally(tally.created, 'coding rule');
}

async function nodeByCode(db, c, code) {
  const [[r]] = await db.query('SELECT id, parent_id, depth, scope, status FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [c.companyId, code]);
  return r ?? null;
}

/**
 * Family/Subfamily/Leaf, created together the first time a leaf under them is
 * needed. A leaf code this company already has under a DIFFERENT family is
 * refused rather than silently reused — classification codes are unique
 * company-wide, and the old cf_shop_import.mjs tree (being retired, not yet
 * gone) happens to use a couple of the same short words (SAW, MIG) for its own
 * machine types. Reusing one of those by mistake would attach this leaf to the
 * OLD tree, where none of this script's rules or machine specs reach it — the
 * exact bug PAIR's leaf codes (SAWWELD, MIGWELD, not SAW, MIG) were renamed to
 * avoid, caught by this check while developing the script.
 */
async function ensureLeaf(db, c, familyKey, subKey, leafCode, leafName) {
  const fam = FAMILIES[familyKey];
  const sub = SUB[subKey];
  const existing = await nodeByCode(db, c, leafCode);
  if (existing) {
    if (existing.scope !== 'machine' || existing.depth !== 2) throw new Error(`${leafCode} already exists but is not a machine type (scope ${existing.scope}, depth ${existing.depth}).`);
    const [[grandparent]] = await db.query(
      `SELECT g.code FROM cf_classification_nodes n
         JOIN cf_classification_nodes p ON p.id = n.parent_id
         JOIN cf_classification_nodes g ON g.id = p.parent_id
        WHERE n.id = ?`,
      [existing.id],
    );
    if (grandparent?.code !== fam.code) {
      throw new Error(`leaf code ${leafCode} already exists under family "${grandparent?.code}", not "${fam.code}" — pick a different leaf code (this is exactly the SAW/MIG collision with the old tree; check PAIR/EQUIP_NAME_LEAF for the code that needs renaming).`);
    }
    bumpTally(tally.reused, 'machine type');
    return existing.id;
  }
  const famRow = await nodeByCode(db, c, fam.code);
  const subRow = await nodeByCode(db, c, sub.code);
  const made = await cls.createMachineType(db, c, {
    family: famRow ? { id: famRow.id } : { code: fam.code, name: fam.name },
    subfamily: subRow ? { id: subRow.id } : { code: sub.code, name: sub.name },
    code: leafCode, name: leafName,
  });
  if (made.created.family) bumpTally(tally.created, 'family');
  if (made.created.subfamily) bumpTally(tally.created, 'subfamily');
  bumpTally(tally.created, 'machine type');
  return made.id;
}

const marker = (unit) => `[plant-register:${unit.sourceKey}]`;
const machineNotes = (unit) => [marker(unit), ...unit.notes].join('\n');
async function ensureMachine(db, c, leafId, unit) {
  const [[have]] = await db.query('SELECT id, classification_id FROM cf_machines WHERE company_id = ? AND (code = ? OR notes LIKE ?) AND deleted_at IS NULL', [c.companyId, unit.code, `${marker(unit)}%`]);
  const entries = Object.entries(unit.values)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([specCode, value]) => ({ specCode, value }));
  if (have) {
    if (Number(have.classification_id) !== Number(leafId)) throw new Error(`Existing machine ${unit.code} belongs to a different type.`);
    bumpTally(tally.reused, 'machine'); return have.id;
  }
  const created = await mach.createMachine(db, c, {
    code: unit.code ?? undefined, name: unit.name, classificationId: leafId,
    serialNumber: unit.serialNumber ?? undefined, values: entries, notes: machineNotes(unit),
  });
  bumpTally(tally.created, 'machine');
  return created.id;
}

/** Identical purchased units share validation and resolved values. The first
 * goes through the ordinary service; the rest copy that proven result in bulk.
 * Codes still come from the real generator. IDs are read by code, never guessed.
 * --serial keeps the original path for a full golden snapshot comparison. */
async function ensureMachineGroup(db, c, leafId, units) {
  if (SERIAL || units.length === 1) {
    for (const unit of units) await ensureMachine(db, c, leafId, unit);
    return;
  }
  const groups = [];
  let previousKey = null;
  for (const unit of units) {
    const key = JSON.stringify([unit.name, unit.serialNumber, unit.values]);
    if (key !== previousKey) groups.push([]);
    groups.at(-1).push(unit);
    previousKey = key;
  }
  const [existing] = await db.query('SELECT id,code,notes FROM cf_machines WHERE company_id=? AND classification_id=? AND deleted_at IS NULL', [c.companyId, leafId]);
  const existingCodes = new Set(existing.map((m) => m.code));
  const existingNotes = new Set(existing.map((m) => String(m.notes ?? '').split('\n')[0]));
  for (const group of groups) {
    const missing = group.filter((u) => !(u.code && existingCodes.has(u.code)) && !existingNotes.has(marker(u)));
    bumpTally(tally.reused, 'machine', group.length - missing.length);
    if (!missing.length) continue;
    const referenceId = await ensureMachine(db, c, leafId, missing[0]);
    const rest = missing.slice(1);
    if (!rest.length) continue;
    const context = await engine.getProvider('machine').draftContext(db, c.companyId, { classificationId: leafId });
    const scheme = await engine.selectScheme(db, c.companyId, 'machine', 'code', context);
    const [segments] = scheme ? await db.query('SELECT * FROM cf_code_scheme_segments WHERE company_id=? AND scheme_id=? AND deleted_at IS NULL ORDER BY sort_order,id', [c.companyId, scheme.id]) : [[]];
    const codes = [];
    for (const unit of rest) {
      const code = unit.code ?? (scheme ? (await engine.renderSegments(db, c.companyId, scheme, segments, context, { consume: true })).text : null);
      if (!code || code.length > 50 || !/^[A-Za-z0-9][A-Za-z0-9_\-./]*$/.test(code)) throw new Error('A machine code is missing or invalid.');
      codes.push(code);
    }
    await insertRows(db, 'cf_machines', ['company_id','code','name','classification_id','serial_number','status','notes','created_by'], rest.map((u,i) => [c.companyId,codes[i],u.name,leafId,u.serialNumber,'active',machineNotes(u),c.userId]));
    const [copies] = await db.query('SELECT id FROM cf_machines WHERE company_id=? AND code IN (?) AND deleted_at IS NULL', [c.companyId,codes]);
    if (copies.length !== rest.length) throw new Error('Bulk machine read-back did not match the inserted assets.');
    const ids = copies.map((m) => m.id);
    await db.query(`INSERT INTO cf_spec_values(company_id,specification_id,subject_type,subject_id,value_number,value_text,value_bool,value_date,option_id,value_json,uom,source,created_by)
      SELECT v.company_id,v.specification_id,'machine',m.id,v.value_number,v.value_text,v.value_bool,v.value_date,v.option_id,v.value_json,v.uom,v.source,?
      FROM cf_spec_values v JOIN cf_machines m ON m.company_id=v.company_id AND m.id IN (?)
      WHERE v.company_id=? AND v.subject_type='machine' AND v.subject_id=? AND v.deleted_at IS NULL`, [c.userId,ids,c.companyId,referenceId]);
    await db.query(`INSERT INTO cf_spec_value_history(company_id,value_id,specification_id,subject_type,subject_id,change_type,old_value,new_value,changed_by)
      SELECT h.company_id,v.id,h.specification_id,'machine',v.subject_id,h.change_type,h.old_value,h.new_value,?
      FROM cf_spec_value_history h JOIN cf_spec_values v ON v.company_id=h.company_id AND v.specification_id=h.specification_id AND v.subject_type='machine' AND v.subject_id IN (?) AND v.deleted_at IS NULL
      WHERE h.company_id=? AND h.subject_type='machine' AND h.subject_id=?`, [c.userId,ids,c.companyId,referenceId]);
    bumpTally(tally.created, 'machine', rest.length);
  }
}

/** Marks the OLD generic tree cf_shop_import.mjs built inactive — never
 *  deleted, since operations, machine rules and the KEPL catalog's flows may
 *  still name it. Safe to re-run: updateNode/updateMachine are no-ops on an
 *  already-inactive row (setStatus-style idempotency lives in the service). */
async function retireOldTree(db, c) {
  const [[oldFamily]] = await db.query(`SELECT id, status FROM cf_classification_nodes WHERE company_id = ? AND code = 'MACHINES' AND deleted_at IS NULL`, [c.companyId]);
  if (!oldFamily) { say('   no old "MACHINES" tree found — nothing to retire.'); return; }
  const [nodes] = await db.query(
    `SELECT id, code, depth, status FROM cf_classification_nodes
      WHERE company_id = ? AND deleted_at IS NULL AND scope = 'machine' AND (id = ? OR parent_id = ? OR parent_id IN (SELECT id FROM cf_classification_nodes WHERE company_id = ? AND parent_id = ? AND deleted_at IS NULL))`,
    [c.companyId, oldFamily.id, oldFamily.id, c.companyId, oldFamily.id],
  );
  let retiredNodes = 0;
  // The operations import follows this script. Until its flow mappings are
  // settled, retiring the old capacity would disable work that still uses it.
  const [[{ n: used }]] = await db.query(
    `SELECT COUNT(*) AS n FROM cf_operation_machine_rules r
      JOIN cf_operation_flow_steps s ON s.company_id = r.company_id AND s.operation_id = r.operation_id AND s.deleted_at IS NULL
      JOIN cf_operation_flows f ON f.company_id = s.company_id AND f.id = s.flow_id AND f.deleted_at IS NULL AND f.status = 'active'
     WHERE r.company_id = ? AND r.deleted_at IS NULL AND r.eligible = 1
       AND ((r.subject_type = 'classification' AND r.subject_id IN (?))
         OR (r.subject_type = 'machine' AND r.subject_id IN
           (SELECT id FROM cf_machines WHERE company_id = ? AND classification_id IN (?) AND deleted_at IS NULL)))`,
    [c.companyId, nodes.map((n) => n.id), c.companyId, nodes.map((n) => n.id)],
  );
  if (Number(used)) {
    say('   kept the old machine tree active: active flows still use its capacity. Re-run after the flow migration is complete.');
    return;
  }
  for (const n of nodes) {
    if (n.status === 'inactive') continue;
    if (n.depth === 2) await cls.updateMachineNode(db, c, n.id, { status: 'inactive' });
    else await cls.updateMachineNode(db, c, n.id, { status: 'inactive' });
    retiredNodes++;
  }
  const [machines] = await db.query(
    `SELECT id, status FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL AND classification_id IN (${nodes.map(() => '?').join(',') || 'NULL'})`,
    [c.companyId, ...nodes.map((n) => n.id)],
  );
  let retiredMachines = 0;
  for (const m of machines) {
    if (m.status === 'inactive') continue;
    await mach.updateMachine(db, c, m.id, { status: 'inactive' });
    retiredMachines++;
  }
  say(`   retired ${retiredNodes} old classification node(s) and ${retiredMachines} old machine(s) under "${oldFamily.id}" (MACHINES) — marked inactive, not deleted.`);
}

let conn;
let queryCount = 0;
try {
  conn = await pool.getConnection();
  const query = conn.query.bind(conn);
  conn.query = (...args) => { queryCount++; return query(...args); };
  await conn.beginTransaction();
  attachNodeCache(conn);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: Number(process.env.CF_PLANT_USER ?? user?.id) };
  if (!c.userId) throw new Error(`no user found for company ${COMPANY} — set CF_PLANT_USER.`);

  say('\n-- writing --');
  await ensureCodingRule(conn, c);
  const specId = {};
  for (const d of MACHINE_SPECS) specId[d.code] = await ensureSpec(conn, c, d);

  const leafId = {};
  for (const [leafCode, ms] of byLeaf) leafId[leafCode] = await ensureLeaf(conn, c, SUB[ms[0].subKey].family, ms[0].subKey, leafCode, ms[0].leafName);
  say(`   specifications and ${Object.keys(leafId).length} machine types ready`);

  // Rules on every Family, so a value on any machine anywhere is accepted —
  // there is no single shared root above the six Families to hang one rule on.
  for (const famKey of Object.keys(FAMILIES)) {
    const fam = await nodeByCode(conn, c, FAMILIES[famKey].code);
    if (!fam) continue; // a family with no leaves planned this run was never created
    for (const d of MACHINE_SPECS) {
      const existing = await ruleSvc.listRules(conn, c.companyId, 'classification', fam.id);
      if (existing.some((r) => r.specificationId === specId[d.code])) { bumpTally(tally.reused, 'spec rule'); continue; }
      await ruleSvc.createRule(conn, c, { subjectType: 'classification', subjectId: fam.id, specificationId: specId[d.code], captureAt: 'item', valueRule: 'entered' });
      bumpTally(tally.created, 'spec rule');
    }
  }

  for (const [leafCode, ms] of byLeaf) {
    await ensureMachineGroup(conn, c, leafId[leafCode], ms);
    const crew = CREW[leafCode];
    if (crew) {
      await valueSvc.setValues(conn, c, 'classification', leafId[leafCode], Object.entries(crew).map(([specCode, value]) => ({ specCode, value })));
    }
    say(`   ${leafCode}: ${ms.length} assets checked`);
  }

  if (process.argv.includes('--verify-repeat') && where === 'local') {
    const made = tally.created.machine;
    for (const [leafCode, ms] of byLeaf) await ensureMachineGroup(conn, c, leafId[leafCode], ms);
    if (tally.created.machine !== made) throw new Error('A second import created duplicate assets.');
    say('   repeat import created no duplicate assets');
  }

  say('\n-- retiring the old generic tree --');
  await retireOldTree(conn, c);

  // Read back, inside the same transaction, through the same services a
  // screen would use — proves the write really works before deciding whether
  // to keep it.
  say('\n-- what is there (inside this transaction) --');
  const { families } = await cls.listMachineTypes(conn, COMPANY);
  // Not mach.listMachines(): it caps at 500 rows (a screen's own page size),
  // and this plant alone plans 500+ — a direct, uncapped read is what a
  // verification step needs.
  const [allMachines] = await conn.query('SELECT id, code, classification_id AS classificationId FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
  const byType = new Map();
  for (const m of allMachines) { if (!byType.has(m.classificationId)) byType.set(m.classificationId, []); byType.get(m.classificationId).push(m); }
  let leafCount = 0;
  let machineCount = 0;
  const verifyProblems = [];
  const seenCodes = new Set();
  for (const f of families.filter((f) => f.code.startsWith('PLANT-'))) {
    say(`${f.code}  ${f.name}`);
    for (const s of f.subfamilies) {
      say(`   ${s.code.padEnd(22)} ${s.name}`);
      for (const t of s.types) {
        leafCount++;
        const ms = byType.get(t.id) ?? [];
        machineCount += ms.length;
        say(`      ${t.code.padEnd(14)} ${t.name.padEnd(32)} ${ms.length} machine(s)`);
        const wanted = byLeaf.get(t.code)?.length ?? 0;
        if (wanted && ms.length !== wanted) verifyProblems.push(`${t.code}: ${ms.length} machines in the database, ${wanted} planned`);
        for (const m of ms) {
          if (seenCodes.has(m.code)) verifyProblems.push(`duplicate machine code ${m.code}`);
          seenCodes.add(m.code);
        }
      }
    }
  }
  if (verifyProblems.length) throw new Error(`Import verification failed: ${verifyProblems.join('; ')}`);
  say(`\n   ${leafCount} leaf types, ${machineCount} machines, ${seenCodes.size} distinct codes`);

  // Local comparison only; the snapshot contains private workbook values.
  if (process.env.CF_PLANT_SNAPSHOT && where === 'local') {
    const [snapshot] = await conn.query(`SELECT m.code,m.name,m.serial_number,m.status,m.notes,n.code AS machine_type,
      s.code AS spec,v.value_number,v.value_text,v.value_bool,v.value_date,o.value AS option_value,v.value_json,v.uom,v.source
      FROM cf_machines m JOIN cf_classification_nodes n ON n.id=m.classification_id
      JOIN cf_classification_nodes sub ON sub.id=n.parent_id JOIN cf_classification_nodes f ON f.id=sub.parent_id
      LEFT JOIN cf_spec_values v ON v.company_id=m.company_id AND v.subject_type='machine' AND v.subject_id=m.id AND v.deleted_at IS NULL
      LEFT JOIN cf_specifications s ON s.id=v.specification_id LEFT JOIN cf_spec_options o ON o.id=v.option_id
      WHERE m.company_id=? AND m.deleted_at IS NULL AND f.code LIKE 'PLANT-%' ORDER BY m.code,s.code`, [COMPANY]);
    const [history] = await conn.query(`SELECT m.code,s.code AS spec,h.change_type,COUNT(*) AS n
      FROM cf_spec_value_history h JOIN cf_machines m ON m.company_id=h.company_id AND m.id=h.subject_id
      JOIN cf_specifications s ON s.id=h.specification_id
      WHERE h.company_id=? AND h.subject_type='machine' AND m.notes LIKE '[plant-register:%'
      GROUP BY m.code,s.code,h.change_type ORDER BY m.code,s.code,h.change_type`, [COMPANY]);
    fs.writeFileSync(process.env.CF_PLANT_SNAPSHOT, JSON.stringify({ values: snapshot, history, queryCount }));
  }

  detachNodeCache(conn);
  if (COMMIT) { await conn.commit(); say('\ncommitted.'); }
  else { await conn.rollback(); say('\ndry run — rolled back. Nothing was written.'); }

  say(`\n  created: ${JSON.stringify(tally.created)}`);
  say(`  reused : ${JSON.stringify(tally.reused)}`);
  say(`  database round trips: ${queryCount}`);
  if (verifyProblems.length) process.exitCode = 1;
} catch (e) {
  if (conn) { try { await conn.rollback(); } catch { /* Preserve the original connection error. */ } }
  console.error('\nFAILED:', e.code ?? '', e.message, e.problems ?? '');
  process.exitCode = 1;
} finally {
  if (conn) { detachNodeCache(conn); conn.release(); }
  await pool.end();
}
