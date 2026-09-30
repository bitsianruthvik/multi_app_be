/**
 * gstin.js — India's GST state codes and the GSTIN check (CF_ERP_GST_PLAN §1).
 *
 * Lives in the parties module because a party's GSTIN is validated here, and the
 * module may not import its host. cf_erp's taxService imports it from here.
 *
 * A GSTIN is 15 characters: 2-digit state code, the 10-character PAN, the entity
 * number (1-9, A-Z), a 'Z', and a check character. The check character is the
 * GSTN's mod-36 scheme over 0-9A-Z (a Luhn mod-N): weights 1, 2, 1, 2 … from
 * the left; each product contributes (product div 36) + (product mod 36); the
 * check is (36 − sum mod 36) mod 36. Known-valid: 27AAPFU0939F1ZV, 29AAGCB7383J1Z4.
 */

/** The fixed list (GSTN state codes). 25 and 28 are the pre-merger / pre-split codes still seen on old GSTINs. */
export const GST_STATES = [
  ['01', 'Jammu and Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh'],
  ['05', 'Uttarakhand'], ['06', 'Haryana'], ['07', 'Delhi'], ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'],
  ['10', 'Bihar'], ['11', 'Sikkim'], ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'],
  ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'], ['18', 'Assam'], ['19', 'West Bengal'],
  ['20', 'Jharkhand'], ['21', 'Odisha'], ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'], ['24', 'Gujarat'],
  ['25', 'Daman and Diu (old code)'], ['26', 'Dadra and Nagar Haveli and Daman and Diu'], ['27', 'Maharashtra'],
  ['28', 'Andhra Pradesh (old code)'], ['29', 'Karnataka'], ['30', 'Goa'], ['31', 'Lakshadweep'], ['32', 'Kerala'],
  ['33', 'Tamil Nadu'], ['34', 'Puducherry'], ['35', 'Andaman and Nicobar Islands'], ['36', 'Telangana'],
  ['37', 'Andhra Pradesh'], ['38', 'Ladakh'], ['97', 'Other Territory'], ['96', 'Other Country'],
].map(([code, name]) => ({ code, name }));

const STATE_NAME = new Map(GST_STATES.map((s) => [s.code, s.name]));
/** The place of supply of an export (e-invoice Pos / Stcd). */
export const FOREIGN_STATE = '96';

export const stateName = (code) => (code == null ? null : STATE_NAME.get(String(code)) ?? null);
export const isStateCode = (code) => code != null && STATE_NAME.has(String(code));

/** '7' → '07'; '27' → '27'; anything else → null (not a known state). */
export function readStateCode(v) {
  if (v == null || String(v).trim() === '') return null;
  const s = String(v).trim().padStart(2, '0');
  return STATE_NAME.has(s) ? s : undefined;
}

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** The check character the first 14 characters call for. */
export function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14[i]);
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

/**
 * GET /tax/validate-gstin — { valid, gstin, stateCode, stateName, pan, message }.
 * Spaces are ignored and letters upper-cased; the message is plain words.
 */
export function validateGstin(input) {
  const g = String(input ?? '').replace(/\s+/g, '').toUpperCase();
  const out = (valid, message) => ({
    valid,
    gstin: g || null,
    stateCode: valid ? g.slice(0, 2) : null,
    stateName: valid ? stateName(g.slice(0, 2)) : null,
    pan: valid ? g.slice(2, 12) : null,
    message,
  });
  if (!g) return out(false, 'Type the GSTIN.');
  if (g.length !== 15) return out(false, `A GSTIN has 15 characters — this one has ${g.length}.`);
  if (!PATTERN.test(g)) return out(false, 'That is not a GSTIN: two digits for the state, the 10-character PAN, a digit or letter, Z, and a check character.');
  if (!isStateCode(g.slice(0, 2)) || g.slice(0, 2) === FOREIGN_STATE) return out(false, `${g.slice(0, 2)} is not a state code.`);
  if (gstinCheckChar(g) !== g[14]) return out(false, 'That GSTIN does not add up — its last character is wrong. Check it for a typing mistake.');
  return out(true, `Valid GSTIN — ${stateName(g.slice(0, 2))}.`);
}
