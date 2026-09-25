import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import indexRoutes from './routes/index.js';
import nestingRoutes from './routes/nesting.js';
import codegenModule from './modules/codegen/index.js';
import partiesModule, { registerReferenceCheck } from './modules/parties/index.js';
import { partyReferences } from './services/salesOrderService.js';
import { inventoryPartyReferences } from './services/stockService.js';
import { PERM } from './lib/http.js';
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
    // Nesting — the cut plates laid out on real raw plates. Mounted here rather
    // than folded into routes/index.js only because it was written alongside
    // the packer; move it in with the rest when that settles.
    server.use('/api/:companySlug/cf_erp', nestingRoutes);
    server.use('/api/:companySlug/cf_erp', codegenModule.createRouter({ viewPerm: PERM.view, managePerm: PERM.codegen }));
    server.use('/api/:companySlug/cf_erp', partiesModule.createRouter({ viewPerm: PERM.ordersView, managePerm: PERM.parties }));
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
