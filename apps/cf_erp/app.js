import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import indexRoutes from './routes/index.js';
import codegenModule from './modules/codegen/index.js';
import partiesModule, { registerReferenceCheck } from './modules/parties/index.js';
import { partyReferences } from './services/salesOrderService.js';
import { inventoryPartyReferences } from './services/stockService.js';
import { procurementPartyReferences } from './services/procurementService.js';
import { PERM, bodyErrors } from './lib/http.js';
// Side effect: registers items and definitions with the code generator.
import './services/codegenProvider.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const coreResourceDefs = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'resourceDef.json'), 'utf-8'),
);

// Self-contained modules inside cf_erp. Each owns its schema, resource
// definitions and (later) routes; app.js only merges and mounts them.
const modules = [partiesModule, codegenModule];

// The parties module cannot import cf_erp, so cf_erp tells it what uses a party.
registerReferenceCheck(partyReferences);
registerReferenceCheck(inventoryPartyReferences);
registerReferenceCheck(procurementPartyReferences);

function mergeResourceDefs() {
  const merged = { ...coreResourceDefs };
  for (const mod of modules) {
    for (const [slug, def] of Object.entries(mod.resourceDefs)) {
      if (merged[slug]) throw new Error(`[cf_erp] resource "${slug}" defined twice (module ${mod.name})`);
      merged[slug] = def;
    }
  }
  return merged;
}

/**
 * cf_erp — a second ERP built from scratch on the platform.
 *
 * Data model: ERP_Taxonomy_Summary_v3 + ERP_Database_Architecture, with every
 * decision recorded in TM/CF_ERP_PLAN.md. models/init.sql explains each table.
 *
 * Deliberately shares no code with fab_erp: the point of this app is a clean
 * second attempt, and importing fab_erp's services would re-import the model
 * decisions this one exists to redo.
 */
export default {
  slug: 'cf_erp',
  resourceDefs: mergeResourceDefs(),

  register(server) {
    server.use('/api/:companySlug/cf_erp', indexRoutes);
    // The module's tables are shared with cf_hrms (employee codes); its hrms_* rules belong on its own screen.
    server.use('/api/:companySlug/cf_erp', codegenModule.createRouter({ viewPerm: PERM.view, managePerm: PERM.codegen, entityTypes: (t) => !t.startsWith('hrms_') }));
    server.use('/api/:companySlug/cf_erp', partiesModule.createRouter({ viewPerm: PERM.ordersView, managePerm: PERM.parties }));
    // A body too large to read, or not JSON, answered as { code, message } on cf_erp's own paths (lib/http.js).
    server.use(bodyErrors);

    /*
     * AT BOOT: nesting runs a deploy or a sleep cut off are picked up again from their checkpoints
     * (services/nestRunService.resumeAtBoot), so a run carries on with nobody opening the screen.
     * A few seconds AFTER this returns — the server is listening first, and a database that is slow
     * to wake delays nothing. In production only (or CF_NEST_RESUME_AT_BOOT=1); never when it is 0:
     * a test that mounts this app must not start working whatever a developer's database holds.
     */
    const bootResume = process.env.CF_NEST_RESUME_AT_BOOT === '1' || (process.env.NODE_ENV === 'production' && process.env.CF_NEST_RESUME_AT_BOOT !== '0');
    if (bootResume) {
      const t = setTimeout(() => {
        import('./services/nestRunService.js')
          .then((m) => m.resumeAtBoot())
          .then((r) => { if (r.found) console.log(`[cf_erp] nesting runs left running: ${r.found} — picked up again ${r.resumed}, failed ${r.failed}, live elsewhere ${r.live}`); })
          .catch((e) => console.error('[cf_erp] resuming nesting runs at boot failed:', e?.message ?? e));
      }, 5000);
      if (typeof t.unref === 'function') t.unref();
    }
  },

  // Nothing executes these — the loader ignores them and push-to-prod applies a
  // hard-coded list. Order matters: parties first (sales orders reference it),
  // then core, then codegen, then the permission seed.
  migrations: [
    partiesModule.schema,
    path.join(__dirname, 'models', 'init.sql'),
    codegenModule.schema,
    path.join(__dirname, 'models', 'seed.sql'),
  ],
};
