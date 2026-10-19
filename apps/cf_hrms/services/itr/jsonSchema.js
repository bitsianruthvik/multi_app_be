/**
 * jsonSchema.js — a small JSON Schema (draft-04) validator for the e-filing schemas the
 * Income Tax Department publishes. No dependency: the backend has no ajv, and these schemas
 * use only a small part of the standard. Unknown keywords are refused when the validator is
 * built (keywordsOf), so a future schema that needs more fails loudly, not silently.
 *
 *   validate(schema, data) → [{ path, message }]   (empty = valid)
 *
 * Supported: $ref (#/definitions/…), allOf, type (string, integer, number, object, array,
 * boolean), properties, required, additionalProperties (false), items (one schema), minItems,
 * maxItems, enum, pattern (unanchored, as the standard says), minLength, maxLength, minimum,
 * maximum, exclusiveMinimum / exclusiveMaximum (draft-04 booleans), multipleOf.
 * Ignored on purpose: description, default, $schema.
 */
const KNOWN = new Set(['$schema', '$ref', 'allOf', 'type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'enum', 'pattern',
  'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'description', 'default', 'definitions']);

/** Every keyword the schema uses that this validator does not know (property names excluded). */
export function unknownKeywords(schema) {
  const out = new Set();
  const walk = (s) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return;
    for (const [k, v] of Object.entries(s)) {
      if (!KNOWN.has(k)) out.add(k);
      if (k === 'properties' || k === 'definitions') for (const sub of Object.values(v)) walk(sub);
      else if (k === 'items' || k === 'additionalProperties') walk(v);
      else if (k === 'allOf') v.forEach(walk);
    }
  };
  walk(schema);
  return [...out];
}

const typeOk = (t, v) => {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    default: return false;
  }
};

export function validate(root, data) {
  const unknown = unknownKeywords(root);
  if (unknown.length) throw new Error(`The schema uses keywords this validator does not know: ${unknown.join(', ')}.`);
  const errors = [];
  const regex = new Map();
  const re = (p) => { if (!regex.has(p)) regex.set(p, new RegExp(p, 'u')); return regex.get(p); };
  const resolve = (ref) => {
    if (!ref.startsWith('#/')) throw new Error(`Only local $ref is supported (${ref}).`);
    return ref.slice(2).split('/').reduce((o, k) => o?.[k], root);
  };
  const check = (s, v, path) => {
    if (!s) return;
    if (s.$ref) { check(resolve(s.$ref), v, path); }
    if (s.allOf) for (const sub of s.allOf) check(sub, v, path);
    if (s.type) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some((t) => typeOk(t, v))) { errors.push({ path, message: `must be ${types.join(' or ')}` }); return; }
    }
    if (s.enum && !s.enum.some((e) => e === v)) errors.push({ path, message: `must be one of ${s.enum.slice(0, 12).join(', ')}${s.enum.length > 12 ? ' …' : ''}` });
    if (typeof v === 'string') {
      if (s.pattern != null && !re(s.pattern).test(v)) errors.push({ path, message: `does not match ${s.pattern}` });
      if (s.minLength != null && [...v].length < s.minLength) errors.push({ path, message: `shorter than ${s.minLength}` });
      if (s.maxLength != null && [...v].length > s.maxLength) errors.push({ path, message: `longer than ${s.maxLength}` });
    }
    if (typeof v === 'number') {
      // The ITD schemas also put `pattern` on integers; a pattern applies to strings only (draft-04).
      if (s.minimum != null && (s.exclusiveMinimum === true ? v <= s.minimum : v < s.minimum)) errors.push({ path, message: `below the minimum ${s.minimum}` });
      if (s.maximum != null && (s.exclusiveMaximum === true ? v >= s.maximum : v > s.maximum)) errors.push({ path, message: `above the maximum ${s.maximum}` });
      if (s.multipleOf != null && Math.abs(v / s.multipleOf - Math.round(v / s.multipleOf)) > 1e-9) errors.push({ path, message: `not a multiple of ${s.multipleOf}` });
    }
    if (Array.isArray(v)) {
      if (s.minItems != null && v.length < s.minItems) errors.push({ path, message: `fewer than ${s.minItems} items` });
      if (s.maxItems != null && v.length > s.maxItems) errors.push({ path, message: `more than ${s.maxItems} items` });
      if (s.items) v.forEach((x, i) => check(s.items, x, `${path}[${i}]`));
    }
    if (typeOk('object', v)) {
      for (const k of s.required ?? []) if (!(k in v)) errors.push({ path: `${path}.${k}`, message: 'is required' });
      const props = s.properties ?? {};
      for (const [k, x] of Object.entries(v)) {
        if (props[k]) check(props[k], x, `${path}.${k}`);
        else if (s.additionalProperties === false && s.properties) errors.push({ path: `${path}.${k}`, message: 'is not allowed here' });
        else if (s.additionalProperties && typeof s.additionalProperties === 'object') check(s.additionalProperties, x, `${path}.${k}`);
      }
    }
  };
  check(root, data, '$');
  return errors;
}
