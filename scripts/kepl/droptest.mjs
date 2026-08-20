import { dropsFor } from '../../apps/fab_erp/services/remnantService.js';
const S = { remnant_min_short_mm: 300, remnant_min_area_mm2: 500000, remnant_kerf_mm: 4 };
const m2 = (a) => (a / 1e6).toFixed(2);
let fail = 0;
const check = (label, ok, detail='') => { console.log(`  ${ok?'PASS':'FAIL'}  ${label}${detail?'  — '+detail:''}`); if(!ok) fail++; };

// 1. One 12000x500 strip off a 2000x12000 plate -> a 1500-wide strip remains.
let r = dropsFor({ length: 12000, width: 2000 }, [{ key:'a', length:12000, width:500, qty:1 }], S);
console.log('one strip off a 2000x12000 plate:', r.drops.map(d=>`${d.length}x${d.width}`).join(', '), `| used ${m2(r.usedAreaMm2)} m2`);
check('leaves one usable drop', r.drops.length === 1, `${r.drops.length}`);
check('the drop is the ~1500 remainder', r.drops[0] && Math.abs(Math.min(r.drops[0].length,r.drops[0].width) - 1496) < 2,
  r.drops[0] ? `short side ${Math.min(r.drops[0].length,r.drops[0].width)}` : 'none');
check('kerf was taken off', r.drops[0] && Math.max(r.drops[0].length,r.drops[0].width) < 12000);

// 2. A plate cut to nothing leaves nothing.
r = dropsFor({ length: 12000, width: 2000 }, [{ key:'a', length:12000, width:2000, qty:1 }], S);
check('a fully used plate leaves no drop', r.drops.length === 0, `${r.drops.length} drops`);

// 3. Slivers are scrap, not stock.
r = dropsFor({ length: 12000, width: 2100 }, [{ key:'a', length:12000, width:2000, qty:1 }], S);
check('a 100mm sliver is scrap, not stock', r.drops.length === 0, `scrap ${m2(r.scrapAreaMm2)} m2`);

// 4. Area conservation: used + drops + scrap must not exceed the plate.
const plate = { length: 12000, width: 2300 };
r = dropsFor(plate, [
  { key:'a', length:6000, width:500, qty:2 },
  { key:'b', length:3000, width:400, qty:4 },
], S);
const total = r.usedAreaMm2 + r.drops.reduce((s,d)=>s+d.areaMm2,0) + r.scrapAreaMm2;
console.log(`\nmixed nest: used ${m2(r.usedAreaMm2)} + drops ${m2(r.drops.reduce((s,d)=>s+d.areaMm2,0))} + scrap ${m2(r.scrapAreaMm2)} = ${m2(total)} m2 of a ${m2(plate.length*plate.width)} m2 plate`);
check('nothing is conjured — total <= plate area', total <= plate.length*plate.width + 1);
check('drops are reported largest first',
  r.drops.every((d,i)=> i===0 || r.drops[i-1].areaMm2 >= d.areaMm2));
console.log(fail ? `\n${fail} FAILED\n` : '\nall drop-geometry checks passed\n');
process.exit(fail?1:0);
