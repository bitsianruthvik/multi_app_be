/**
 * Locations in Excel. Code (issued) · Name★ · Address line 1 · Address line 2 · City · State · Country · Pincode · Status.
 * Writes go through organisationService. A location belongs to the whole company.
 */
import { PERM, words, STATUS, changedKeys } from './_shared.js';
import * as ORG from '../../organisationService.js';

const ADDRESS = [['line1', 'Address line 1', 'Plot 12, Industrial Area'], ['line2', 'Address line 2', 'Phase 2'], ['city', 'City', 'Hyderabad'], ['state', 'State', 'Telangana'], ['country', 'Country', 'India'], ['pincode', 'Pincode', '500001']];
const readJson = (v) => { if (v == null) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v) ?? {}; } catch { return {}; } };

export default {
  entity: 'locations',
  label: 'Locations',
  area: 'org',
  viewRight: PERM.org.view,
  uploadRight: PERM.org.upload,
  wholeCompany: true,
  intro: ['One row is one location: a plant, an office, a unit.'],
  list: { name: 'locations', read: async (db, c) => (await ORG.listLocations(db, c.companyId)).rows },

  async load(db, c) {
    const [rows] = await db.query('SELECT id, code, name, address_json, status, updated_at FROM hrms_locations WHERE company_id = ? AND deleted_at IS NULL ORDER BY name, id', [c.companyId]);
    const current = new Map(rows.map((r) => {
      const a = readJson(r.address_json);
      // `postalCode` is how an older screen spelled it.
      const address = { ...a, pincode: a.pincode ?? a.postalCode ?? null };
      return [r.id, {
        id: r.id, seen: r.updated_at, label: `${r.code ?? ''} ${r.name}`.trim(), address: a,
        cells: { code: r.code, name: r.name, ...Object.fromEntries(ADDRESS.map(([k]) => [k, address[k] != null && String(address[k]).trim() !== '' ? String(address[k]) : null])), status: r.status },
      }];
    }));
    return { lists: { status: words('Status', STATUS) }, current };
  },

  columns: () => [
    { key: 'code', header: 'Code', kind: 'issued', width: 14, meaning: 'The location’s code.', example: 'L02' },
    { key: 'name', header: 'Name', kind: 'text', required: true, max: 200, width: 30, meaning: 'What the location is called.', example: 'Unit 2' },
    ...ADDRESS.map(([key, header, example]) => ({ key, header, kind: 'text', max: 500, width: key.startsWith('line') ? 34 : 18, meaning: '', example })),
    { key: 'status', header: 'Status', kind: 'list', list: 'status', width: 14, meaning: 'ACTIVE, or INACTIVE to keep it out of pickers.', example: 'ACTIVE' },
  ],

  check(row) {
    if (row.isNew && row.values.status == null) row.values.status = 'ACTIVE';
  },

  checkFile(rows) {
    const names = new Map();
    for (const r of rows) { const k = String(r.values.name ?? '').toLowerCase(); if (k) names.set(k, [...(names.get(k) ?? []), r]); }
    for (const list of names.values()) if (list.length > 1 && list.some((r) => r.isNew)) for (const r of list.filter((x) => x.isNew)) r.problems.push('Name: this location is in the file twice.');
  },

  address(row, before = {}) {
    const out = { ...before };
    delete out.postalCode;
    for (const [k] of ADDRESS) { if (row.values[k]) out[k] = row.values[k]; else delete out[k]; }
    return out;
  },

  async add(db, c, row) {
    const made = await ORG.createLocation(db, c, { name: row.values.name, locationType: 'PLANT', address: this.address(row), status: row.values.status });
    return { id: made.id, code: made.code };
  },

  async change(db, c, row) {
    const keys = changedKeys(row);
    const body = {};
    if (keys.has('name')) body.name = row.values.name;
    if (keys.has('status')) body.status = row.values.status;
    if (ADDRESS.some(([k]) => keys.has(k))) body.address = this.address(row, row.current.address);
    await ORG.updateLocation(db, c, row.id, body);
  },
};
