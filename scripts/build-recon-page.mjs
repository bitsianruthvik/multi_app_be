/**
 * build-recon-page.mjs — render the BOQ reconciliation as a page.
 *
 * Reads the JSON from kepl-reconcile.mjs and writes standalone HTML. The point
 * of the page is that every one of the 137 BOQ rows is visible and checkable
 * against what was built — a total that agrees can hide two errors that cancel.
 */
import fs from 'fs';

const src = process.argv[2];
const dest = process.argv[3];
const d = JSON.parse(fs.readFileSync(src, 'utf8'));

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dim = (r) => (r ? `${r.t}<span class="x">×</span>${r.l}<span class="x">×</span>${r.w}` : '—');
const qty = (r) => (r ? r.qty : '—');

let checked = 0; let bad = 0;
for (const s of d.segments) for (const r of s.rows) { checked += 1; if (!r.ok) bad += 1; }
for (const s of d.sections) for (const r of s.rows) { checked += 1; if (!r.ok) bad += 1; }

const rowHtml = (r) => `
        <tr class="${r.ok ? '' : 'miss'}">
          <td class="pcode">${esc(r.boq.code ?? '')}</td>
          <td class="pname">${esc(r.boq.name)}${r.boq.boqName && r.boq.boqName !== r.boq.name ? `<span class="alias">sheet: ${esc(r.boq.boqName)}</span>` : ''}</td>
          <td class="num">${dim(r.boq)}</td>
          <td class="num q">${qty(r.boq)}</td>
          <td class="num">${dim(r.got)}</td>
          <td class="num q">${qty(r.got)}</td>
          <td class="tick">${r.ok ? '<span class="ok" title="matches">✓</span>' : '<span class="no" title="does not match">✕</span>'}</td>
        </tr>`;

const segHtml = d.segments.map((s) => `
    <section class="mark">
      <header class="markhead">
        <div class="marktitle">
          <span class="boqmark">${esc(s.mark)}</span>
          <span class="arrow">→</span>
          <span class="ourmark">${esc(s.code)}</span>
        </div>
        <div class="markmeta">${s.rows.length} parts · built on ${s.spans} span${s.spans === 1 ? '' : 's'}${s.extra.length ? ` · <span class="warn">${s.extra.length} extra</span>` : ''}</div>
      </header>
      <div class="scroll">
      <table>
        <thead>
          <tr>
            <th>Code</th><th>Part</th>
            <th colspan="2" class="grp boqgrp">Bill of Quantity</th>
            <th colspan="2" class="grp ourgrp">Built in ERP</th>
            <th></th>
          </tr>
          <tr class="sub">
            <th></th><th></th>
            <th class="num">thick × length × width</th><th class="num q">qty</th>
            <th class="num">thick × length × width</th><th class="num q">qty</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${s.rows.map(rowHtml).join('')}</tbody>
      </table>
      </div>
    </section>`).join('');

const secHtml = d.sections.map((s) => `
    <section class="mark">
      <header class="markhead">
        <div class="marktitle"><span class="boqmark">${esc(s.label)}</span></div>
        <div class="markmeta">${s.rows.length} parts · ${s.perSpan} per span · <strong>${s.builtTotal} built</strong></div>
      </header>
      <div class="scroll">
      <table>
        <thead>
          <tr>
            <th>Code</th><th>Part</th>
            <th colspan="2" class="grp boqgrp">Bill of Quantity</th>
            <th colspan="2" class="grp ourgrp">Built in ERP</th>
            <th></th>
          </tr>
          <tr class="sub">
            <th></th><th></th>
            <th class="num">thick × length × width</th><th class="num q">qty</th>
            <th class="num">thick × length × width</th><th class="num q">qty</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${s.rows.map(rowHtml).join('')}</tbody>
      </table>
      </div>
    </section>`).join('');

const html = `<title>KEPL BOQ Reconciliation</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
  :root{
    --ground:#F2F4F6; --panel:#FFFFFF; --ink:#161B21; --ink-2:#4A5560; --ink-3:#7C8894;
    --rule:#D8DEE4; --rule-soft:#E9EDF1;
    --steel:#2C5F87; --verify:#0F6B4F; --warn:#9A5B00; --bad:#A6231C;
    --verify-wash:#E4F1EB; --steel-wash:#E6EEF5;
    --mono:'IBM Plex Mono',ui-monospace,monospace;
  }
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
    --ground:#11151A; --panel:#181D24; --ink:#E6EBF0; --ink-2:#A3AFBB; --ink-3:#6F7C89;
    --rule:#2A323B; --rule-soft:#222933;
    --steel:#7FB3DC; --verify:#5FC79E; --warn:#D79B3A; --bad:#E8776F;
    --verify-wash:#15302A; --steel-wash:#16283A;
  }}
  :root[data-theme="dark"]{
    --ground:#11151A; --panel:#181D24; --ink:#E6EBF0; --ink-2:#A3AFBB; --ink-3:#6F7C89;
    --rule:#2A323B; --rule-soft:#222933;
    --steel:#7FB3DC; --verify:#5FC79E; --warn:#D79B3A; --bad:#E8776F;
    --verify-wash:#15302A; --steel-wash:#16283A;
  }
  *{box-sizing:border-box}
  body{background:var(--ground);color:var(--ink);font-family:'IBM Plex Sans',system-ui,sans-serif;
       line-height:1.5;margin:0;padding:0 20px 72px}
  .wrap{max-width:1080px;margin:0 auto}

  header.top{padding:44px 0 26px;border-bottom:2px solid var(--ink);margin-bottom:0}
  .eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.13em;text-transform:uppercase;
           color:var(--ink-3);margin:0 0 10px}
  h1{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:clamp(34px,5.2vw,54px);
     line-height:1.02;letter-spacing:-.01em;margin:0 0 8px;text-wrap:balance}
  .sub{color:var(--ink-2);max-width:64ch;margin:0}
  .drg{font-family:var(--mono);font-size:12px;color:var(--ink-3);margin-top:14px}

  .verdict{display:flex;flex-wrap:wrap;gap:0;border:1px solid var(--rule);border-top:none;
           background:var(--panel);margin-bottom:38px}
  .v{flex:1 1 190px;padding:20px 22px;border-right:1px solid var(--rule-soft)}
  .v:last-child{border-right:none}
  .v .k{font-family:var(--mono);font-size:10.5px;letter-spacing:.11em;text-transform:uppercase;color:var(--ink-3)}
  .v .n{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:38px;line-height:1.05;
        margin-top:4px;font-variant-numeric:tabular-nums}
  .v .n.good{color:var(--verify)}
  .v .n.bad{color:var(--bad)}
  .v .cap{font-size:12.5px;color:var(--ink-2);margin-top:2px}

  h2{font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:26px;letter-spacing:.01em;
     margin:40px 0 4px}
  .lede{color:var(--ink-2);font-size:14px;margin:0 0 18px;max-width:66ch}

  section.mark{background:var(--panel);border:1px solid var(--rule);margin-bottom:14px}
  .markhead{display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap;
            padding:13px 18px;border-bottom:1px solid var(--rule-soft);background:var(--steel-wash)}
  .marktitle{display:flex;align-items:baseline;gap:9px}
  .boqmark{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:21px;letter-spacing:.02em}
  .arrow{color:var(--ink-3);font-size:13px}
  .ourmark{font-family:var(--mono);font-weight:600;font-size:15px;color:var(--steel)}
  .markmeta{font-size:12.5px;color:var(--ink-2);font-variant-numeric:tabular-nums}
  .warn{color:var(--warn);font-weight:600}

  .scroll{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:13px}
  thead th{font-family:var(--mono);font-size:10px;letter-spacing:.09em;text-transform:uppercase;
           color:var(--ink-3);font-weight:500;text-align:left;padding:9px 10px;white-space:nowrap}
  thead tr.sub th{padding-top:0;font-size:9.5px}
  th.grp{text-align:center;font-weight:600;letter-spacing:.12em}
  th.boqgrp{color:var(--ink-2)}
  th.ourgrp{color:var(--steel)}
  tbody td{padding:8px 10px;border-top:1px solid var(--rule-soft);vertical-align:baseline}
  tbody tr:hover{background:var(--steel-wash)}
  .pcode{font-family:var(--mono);font-size:12px;color:var(--ink-3);white-space:nowrap}
  .pname{font-weight:500;min-width:190px}
  .alias{display:block;font-size:11px;color:var(--warn);font-family:var(--mono)}
  .num{font-family:var(--mono);font-size:12.5px;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--ink-2)}
  .q{text-align:right;color:var(--ink);font-weight:500}
  .x{color:var(--ink-3);padding:0 1px}
  .tick{text-align:center;width:34px}
  .ok{color:var(--verify);font-weight:700}
  .no{color:var(--bad);font-weight:700}
  tr.miss{background:color-mix(in srgb,var(--bad) 8%,transparent)}

  .note{border-left:3px solid var(--warn);background:var(--panel);border-top:1px solid var(--rule);
        border-right:1px solid var(--rule);border-bottom:1px solid var(--rule);
        padding:16px 20px;margin:26px 0;font-size:14px;color:var(--ink-2)}
  .note b{color:var(--ink)}
  footer{margin-top:44px;padding-top:18px;border-top:1px solid var(--rule);
         font-family:var(--mono);font-size:11.5px;color:var(--ink-3)}
  @media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>

<div class="wrap">
  <header class="top">
    <p class="eyebrow">Bill of Quantity · Reconciliation</p>
    <h1>ROB 59.3 M — every BOQ row, checked</h1>
    <p class="sub">Kalpataru Engineering Projects · 2 spans · 4 lines each · 20 shipping marks.
       Each row below is one line of the customer's Bill of Quantity set against what the
       ERP built from the Composite Girder template. Nothing was entered by hand.</p>
    <p class="drg">DRG P103-VDB-WK-DD-MJB-200+003-401 &nbsp;·&nbsp; grade E350 BO &nbsp;·&nbsp; order SO-20260906-0005</p>
  </header>

  <div class="verdict">
    <div class="v"><div class="k">Rows checked</div><div class="n">${checked}</div><div class="cap">every BOQ line</div></div>
    <div class="v"><div class="k">Mismatched</div><div class="n ${bad ? 'bad' : 'good'}">${bad}</div><div class="cap">${bad ? 'see marked rows' : 'dimensions and quantities agree'}</div></div>
    <div class="v"><div class="k">Extra parts</div><div class="n ${d.segments.reduce((a, s) => a + s.extra.length, 0) ? 'bad' : 'good'}">${d.segments.reduce((a, s) => a + s.extra.length, 0)}</div><div class="cap">not on the sheet</div></div>
    <div class="v"><div class="k">Order weight</div><div class="n">${d.totals.orderMt}</div><div class="cap">MT · BOQ says ${d.totals.boqMt}</div></div>
  </div>

  <h2>Line segments</h2>
  <p class="lede">The sheet marks a segment <span class="num">G1 - 1</span>; the ERP writes
     <span class="num">L11</span> — line L1, segment 1 — which is the mark that goes on the steel.
     Each mark is built twice, once per span.</p>
  ${segHtml}

  <h2>Diaphragms, splices and studs</h2>
  <p class="lede">These hang off the span beside the lines, so their parts sit one level shallower
     than a line's do. Quantities below are per assembly.</p>
  ${secHtml}

  <section class="mark">
    <header class="markhead">
      <div class="marktitle"><span class="boqmark">Shear Studs</span></div>
      <div class="markmeta">bought whole · not cut from plate</div>
    </header>
    <div class="scroll">
    <table>
      <thead><tr><th>Item</th><th class="num q">BOQ</th><th class="num q">Built</th><th></th></tr></thead>
      <tbody>
        <tr>
          <td class="pname">25 dia × 175 headed, 760 g each</td>
          <td class="num q">${d.studs.boqTotal.toLocaleString('en-IN')}</td>
          <td class="num q">${d.studs.builtTotal.toLocaleString('en-IN')}</td>
          <td class="tick">${d.studs.boqTotal === d.studs.builtTotal ? '<span class="ok">✓</span>' : '<span class="no">✕</span>'}</td>
        </tr>
      </tbody>
    </table>
    </div>
  </section>

  <div class="note">
    <b>Two places the sheet contradicts itself</b>, resolved by width rather than by name, and recorded
    rather than silently patched. <b>G2-2</b> labels two rows “Intermediate Stiffener Hole”; their widths
    (178 and 170) match the Hole/Plain split used in the other nineteen marks, so the 170 is read as Plain.
    <b>G4-1</b> and <b>G4-5</b> carry two “End Stiffener” rows, 210 and 200 wide, where every other end
    segment has a Bearing Stiffener Plain at 200 — the 210 is read as the bearing stiffener whose slot it
    occupies. Both readings are marked <span class="num" style="color:var(--warn)">sheet:</span> on the row.
  </div>

  <footer>
    ${checked} rows · ${d.segments.length} shipping marks × 2 spans · generated from the customer BOQ PDF and the live order
  </footer>
</div>
`;

fs.writeFileSync(dest, html);
console.log(`wrote ${dest} — ${checked} rows, ${bad} mismatched`);
