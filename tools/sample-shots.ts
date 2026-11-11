/**
 * Draws the sample economy's design screenshots (Task 37): the fictional
 * harbor-ledger app's search page before and after Lodestar's change (the
 * rebuild banner it added), and its berth board, which the change left
 * alone. The sample's scarred inspection shows them side by side; they are
 * written once to engine/sample-shots/ and committed, so the seed (and the
 * tests that run it) never need a browser.
 *
 *   npx tsx tools/sample-shots.ts
 *
 * Every name and number on them is made up, as is the rest of the sample.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'sample-shots');

const VESSELS: Array<[string, string, string, string, string, string]> = [
  ['Maren Dahl', '9411265', 'Ro-Ro cargo', '12 Mar 00:40', 'B4', 'Berthed'],
  ['Cabo Espichel', '9302148', 'Container', '12 Mar 03:15', 'C1', 'Arriving'],
  ['Northern Tern', '9550831', 'General cargo', '12 Mar 05:50', 'A2', 'Arriving'],
  ['Ilha Formosa', '9187712', 'Bulk carrier', '12 Mar 07:05', 'D3', 'Pilot booked'],
  ['Saga Heron', '9622054', 'Container', '12 Mar 09:30', 'C2', 'Pilot booked'],
  ['Tejo Spirit', '9473390', 'Tanker', '12 Mar 11:10', 'T1', 'Customs hold'],
  ['Alva Brenner', '9338127', 'Ro-Ro cargo', '12 Mar 13:45', 'B4', 'Scheduled'],
  ['Porto Moniz', '9266509', 'General cargo', '12 Mar 16:20', 'A1', 'Scheduled'],
  ['Kestrel Bay', '9705513', 'Reefer', '12 Mar 18:00', 'R2', 'Scheduled'],
  ['Henrike Voss', '9450276', 'Container', '12 Mar 21:35', 'C1', 'Scheduled'],
];

const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { width: 1440px; height: 900px; font: 14px/1.45 -apple-system, 'Helvetica Neue', Arial, sans-serif; color: #1d2733; background: #f3f4f1; }
header { height: 56px; display: flex; align-items: center; gap: 34px; padding: 0 32px; background: #12324a; color: #e9eef2; }
header b { font-size: 16px; letter-spacing: 0.01em; }
header nav { display: flex; gap: 22px; font-size: 13.5px; color: #a9bccb; }
header nav .on { color: #fff; border-bottom: 2px solid #e2a23b; padding-bottom: 16px; margin-bottom: -18px; }
header .who { margin-left: auto; font-size: 13px; color: #a9bccb; }
main { padding: 26px 32px; }
h1 { font-size: 22px; font-weight: 600; margin-bottom: 16px; }
.bar { display: flex; gap: 10px; margin-bottom: 14px; }
.field { flex: 1; height: 40px; border: 1px solid #b9c2c9; border-radius: 4px; background: #fff; padding: 0 14px; display: flex; align-items: center; color: #1d2733; }
.field small { color: #7d8a96; margin-left: 8px; }
.btn { height: 40px; padding: 0 18px; border-radius: 4px; background: #1c5a85; color: #fff; display: flex; align-items: center; font-weight: 600; }
.chips { display: flex; gap: 8px; margin-bottom: 18px; }
.chip { padding: 4px 10px; border: 1px solid #c8d0d6; border-radius: 12px; font-size: 12.5px; color: #44525f; background: #fff; }
.chip.on { background: #dde9f2; border-color: #9fbdd3; color: #12324a; }
table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d6dcdf; }
th { text-align: left; font-size: 12px; font-weight: 600; color: #5d6b78; padding: 10px 14px; background: #eef1f2; border-bottom: 1px solid #d6dcdf; }
td { padding: 11px 14px; border-bottom: 1px solid #e7ebec; font-size: 13.5px; }
td.mono { font-family: Menlo, monospace; font-size: 12.5px; color: #44525f; }
.st { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 12px; background: #e9eef1; color: #33424f; }
.st.hold { background: #fbe3d6; color: #8a3b14; }
.st.in { background: #dcefe1; color: #23603a; }
.foot { margin-top: 12px; font-size: 12.5px; color: #6b7884; }
.banner { display: flex; align-items: center; gap: 12px; margin: -6px 0 16px; padding: 12px 16px; border: 1px solid #e6c27a; border-radius: 4px; background: #fdf3dc; color: #6d4c0f; font-size: 13.5px; }
.banner i { width: 16px; height: 16px; border-radius: 50%; border: 2px solid #c98d1e; border-top-color: transparent; }
.banner b { font-weight: 600; }
.banner span { margin-left: auto; font-size: 12.5px; color: #8c6a2a; }
.grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
.berth { background: #fff; border: 1px solid #d6dcdf; border-radius: 4px; padding: 14px 16px; height: 156px; }
.berth h3 { font-size: 15px; margin-bottom: 4px; }
.berth p { font-size: 12.5px; color: #5d6b78; }
.berth .ship { margin-top: 14px; font-size: 14px; font-weight: 600; }
.berth .meter { margin-top: 12px; height: 6px; background: #e7ebec; border-radius: 3px; }
.berth .meter i { display: block; height: 100%; border-radius: 3px; background: #1c5a85; }
`;

function page(body: string, on: string): string {
  const nav = ['Berths', 'Schedule', 'Manifests', 'Fees', 'Search'].map((n) => `<span class="${n === on ? 'on' : ''}">${n}</span>`).join('');
  return `<!doctype html><meta charset="utf-8"><style>${CSS}</style><header><b>Harbor Ledger</b><nav>${nav}</nav><span class="who">Night shift, Lisbon</span></header><main>${body}</main>`;
}

function search(banner: boolean): string {
  const rows = VESSELS.map(([name, imo, type, eta, berth, st]) => `<tr><td><b>${name}</b></td><td class="mono">${imo}</td><td>${type}</td><td class="mono">${eta}</td><td>${berth}</td><td><span class="st ${st === 'Customs hold' ? 'hold' : st === 'Berthed' ? 'in' : ''}">${st}</span></td></tr>`).join('');
  return page(
    `<h1>Search vessels</h1>
    <div class="bar"><div class="field">arriving 12 Mar <small>vessel, IMO, berth or agent</small></div><div class="btn">Search</div></div>
    <div class="chips"><span class="chip on">Arriving</span><span class="chip">Berthed</span><span class="chip">Customs hold</span><span class="chip">Pilot booked</span></div>
    ${banner ? '<div class="banner"><i></i><b>The search index is rebuilding.</b> Results may be up to 40 seconds old. <span>Started 00:41:07</span></div>' : ''}
    <table><thead><tr><th>Vessel</th><th>IMO</th><th>Type</th><th>ETA (Lisbon)</th><th>Berth</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="foot">10 of 63 arrivals on 12 March</p>`,
    'Search',
  );
}

function berths(): string {
  const cells = [
    ['A1', 'Draught 9.5 m', 'Porto Moniz', 30],
    ['A2', 'Draught 9.5 m', 'Northern Tern', 55],
    ['B4', 'Ro-Ro ramp', 'Maren Dahl', 80],
    ['C1', 'Draught 14 m', 'Cabo Espichel', 45],
    ['C2', 'Draught 14 m', 'Saga Heron', 20],
    ['D3', 'Bulk, 2 cranes', 'Ilha Formosa', 65],
    ['R2', 'Reefer plugs 120', 'Kestrel Bay', 10],
    ['T1', 'Tanker, hose 2', 'Tejo Spirit', 90],
  ] as const;
  const grid = cells.map(([b, what, ship, pct]) => `<div class="berth"><h3>Berth ${b}</h3><p>${what}</p><div class="ship">${ship}</div><p>12 Mar, Lisbon time</p><div class="meter"><i style="width:${pct}%"></i></div></div>`).join('');
  return page(`<h1>Berths today</h1><div class="grid">${grid}</div><p class="foot">Thursday 12 March, night shift. Times are the harbour's own day.</p>`, 'Berths');
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    for (const [name, html] of [
      ['search-before', search(false)],
      ['search-after', search(true)],
      ['berths', berths()],
    ] as const) {
      await page.setContent(html);
      await page.screenshot({ path: join(OUT, `${name}.png`) });
    }
  } finally {
    await browser.close();
  }
}

void main();
