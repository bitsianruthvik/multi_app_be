/**
 * verify-packer-verify.mjs — proves nestingPacker.verify() no longer rejects
 * plans that nestAsync's GRASP-restarts-plus-jitter search actually found.
 *
 * Bug: verify() used to repack each plate with ONE deterministic nestOnce()
 * pass (no restarts). A plan `nest()` only reached by trying several seeds
 * then failed re-verification whenever the single deterministic pass needed
 * a second plate for that same row set — reported as NEST_NOT_VERIFIED even
 * though the plan itself was valid.
 *
 * This packs 120 random scenarios with nest() (the same search quality
 * `nestAsync` uses) and asserts verify() finds zero problems on every one.
 * Pure in-memory geometry — no DB, no company/order data, safe to run any
 * time.
 *
 * Usage: node scripts/verify-packer-verify.mjs
 */
import { nest, verify } from '../apps/fab_erp/services/nestingPacker.js';

const SPECS = [
  { id: 1, length: 6000, width: 2000 },
  { id: 2, length: 3000, width: 1500 },
];

// mulberry32 — same tiny deterministic PRNG the packer itself uses, so this
// script's "randomness" is reproducible across runs without a dependency.
function mulberry32(seed) {
  let a = seed;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function scenario(i) {
  const rng = mulberry32(1000 + i);
  const rowCount = 3 + Math.floor(rng() * 4); // 3-6 rows
  const rows = [];
  for (let r = 0; r < rowCount; r += 1) {
    rows.push({
      key: `s${i}-r${r}`,
      length: 150 + Math.floor(rng() * 1650), // 150-1800 mm
      width: 150 + Math.floor(rng() * 750), // 150-900 mm
      qty: 1 + Math.floor(rng() * 3), // 1-3 pieces
    });
  }
  return rows;
}

let passed = 0;
const failures = [];

for (let i = 1; i <= 120; i += 1) {
  const rows = scenario(i);
  const result = nest(rows, SPECS, { margin: 2, restarts: 12, seed: i });
  const problems = verify(result.plates);
  if (problems.length === 0) {
    passed += 1;
  } else {
    failures.push({ i, problems, unplaced: result.unplaced.length });
  }
}

console.log(`verify-packer-verify: ${passed}/120 scenarios passed verify() with zero problems`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures.slice(0, 10)) {
    console.log(`  scenario ${f.i} (unplaced=${f.unplaced}):`, f.problems);
  }
  process.exit(1);
}
process.exit(0);
