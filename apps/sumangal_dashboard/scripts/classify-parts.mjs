/**
 * Groups part names that are not yet in data/part-groups.json, on two axes (component and family).
 *
 *   node apps/sumangal_dashboard/scripts/classify-parts.mjs <facts.json>            list the unclassified names (no API call)
 *   node apps/sumangal_dashboard/scripts/classify-parts.mjs <facts.json> --apply    classify them with the Claude API and write the file
 *
 * Needs ANTHROPIC_API_KEY for --apply. Each name gets one value per axis, chosen only from the lists in the
 * file's "legend", and is saved with "by": "model" so a person can review it. A person's edit to a row is never
 * overwritten: only names missing from the file are sent. Re-running is safe.
 */
import fs from 'fs';

const MAP_FILE = new URL('../data/part-groups.json', import.meta.url);
const file = process.argv[2];
if (!file || file.startsWith('--')) { console.error('Usage: classify-parts.mjs <facts.json> [--apply]'); process.exit(1); }
const APPLY = process.argv.includes('--apply');
const MODEL = 'claude-sonnet-5-5';
const BATCH = 40;

const doc = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
const { legend } = doc;
const names = [...new Set(JSON.parse(fs.readFileSync(file, 'utf8')).parts.map((p) => String(p.name).trim()))];
const todo = names.filter((n) => !doc.groups[n]);
console.log(`${names.length} part names; ${todo.length} not yet grouped.`);
if (!todo.length) process.exit(0);
if (!process.env.ANTHROPIC_API_KEY) {
  console.log('ANTHROPIC_API_KEY is not set, so nothing was classified. Until it is, these names show as "Unclassified".');
  process.exit(0);
}

const SYSTEM = `You group foundry part names (investment castings for valves and pumps). For each name return:
- component: what the casting is. One of: ${legend.component.map((v) => `"${v}"`).join(', ')}.
- family: the product line it belongs to, only when the name makes it clear (for example "BALL VALVE"). Otherwise "Unclear". One of: ${legend.family.map((v) => `"${v}"`).join(', ')}.
Do not guess a family from a size or pressure rating. Answer with a JSON array only: [{"name": "...", "component": "...", "family": "..."}], same names, same order.`;

async function classifyBatch(batch) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, system: SYSTEM, messages: [{ role: 'user', content: JSON.stringify(batch) }] }),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const text = (await res.json()).content.map((c) => c.text || '').join('');
  const parsed = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
  return parsed.filter((r) => batch.includes(r.name) && legend.component.includes(r.component) && legend.family.includes(r.family));
}

let added = 0;
for (let i = 0; i < todo.length; i += BATCH) {
  const got = await classifyBatch(todo.slice(i, i + BATCH));
  for (const r of got) doc.groups[r.name] = { component: r.component, family: r.family, by: 'model' };
  added += got.length;
  console.log(`  classified ${got.length} of ${Math.min(BATCH, todo.length - i)} in this batch`);
}
console.log(`${added} of ${todo.length} classified. ${todo.length - added} left Unclassified (rejected by the check).`);
if (APPLY) { fs.writeFileSync(MAP_FILE, JSON.stringify(doc, null, 1)); console.log('written to data/part-groups.json'); }
else console.log('dry run: add --apply to write data/part-groups.json');
