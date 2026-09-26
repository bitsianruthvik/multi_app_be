import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCodegenRouter } from './routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * codegen — the user-configurable code and name generator.
 *
 * A separate module by the user's decision (2026-09-22): codes and names are
 * not columns on definitions (as the architecture diagram drew them); they come
 * from user-defined rules that any entity can use. ./models/init.sql explains
 * the tables; ./engine.js explains selection, rendering and numbering.
 *
 * Boundary rules — what keeps this module liftable into the platform core:
 *   - Nothing in this folder imports from the rest of cf_erp, and its tables
 *     have no foreign keys into cf_erp tables.
 *   - Entities adopt the generator by registering a provider (engine.js
 *     registerEntity). Providers live with the entity that owns them.
 *   - The host supplies permission tags when it mounts the routes.
 */
export { registerEntity, generate, listEntities, BLANK } from './engine.js';
export { findConditionsReferencing, findSegmentsUsingToken } from './service.js';
export { CodegenError } from './errors.js';

export default {
  name: 'codegen',
  resourceDefs: JSON.parse(fs.readFileSync(path.join(__dirname, 'resourceDef.json'), 'utf-8')),
  schema: path.join(__dirname, 'models', 'init.sql'),
  createRouter: createCodegenRouter,
};
