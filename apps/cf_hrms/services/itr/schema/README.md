# Official e-filing JSON schemas (vendored, unchanged)

| File | Form | Year | Version | Source (downloaded 2026-10-20) | SHA-256 |
|---|---|---|---|---|---|
| ITR-1_AY2026-27_V1.1.json | ITR-1 (Sahaj) | FY 2025-26 = AY 2026-27 (Income-tax Act 1961) | V1.1, 30 Jun 2026 (first release 15 May 2026); inside: SchemaVer "Ver1.0" | https://www.incometax.gov.in/iec/foportal/sites/default/files/2026-06/ITR-1_2026_Main_V1.1.json (incometax.gov.in › Downloads › ITR-1 › Schema) | 6a0ef9f64065431879dcc724869d8455a640bcf11279d1818eb19f11448ce763 |

Not vendored:
- ITR-2 AY 2026-27 schema V1.2 (13 Aug 2026): https://www.incometax.gov.in/iec/foportal/sites/default/files/2026-08/ITR-2_2026_Main_V1.2.json — the helper does not build ITR-2 JSON (guide + PDF instead).
- Tax year 2026-27 (Income-tax Act 2025, filed in 2027): no form or schema published as of 2026-10-20.

When a new version is published: download it, add a row here, point `SCHEMAS` in ../itrJson.js at it, and run `node scripts/cf_hrms/run.mjs --area=itr`.
