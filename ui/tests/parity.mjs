// Checks the snapshot engine against the server's own answers.
// Run by `go test ./internal/stats` (TestSnapshotParity), which writes
// DIR/cases.json (each case's route, parameters and the server's answer) and
// DIR/data/snapshot/ (the exported files). Exits 1 on any difference.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createEngine, itemCost} from '../src/lib/snapshot/engine.js';

const dir = process.argv[2];
const cases = JSON.parse(readFileSync(join(dir, 'cases.json'), 'utf8'));
const engine = createEngine({json: async name => JSON.parse(readFileSync(join(dir, 'data/snapshot', name), 'utf8'))});

// The server leaves some orders open (ties), so those lists are put in a fixed order first.
const by = (...keys) => (a, b) => {
  for (const k of keys) {
    const d = typeof a[k] === 'string' ? a[k].localeCompare(b[k]) : a[k] - b[k];
    if (d) return d;
  }
  return 0;
};
function normalize(route, v) {
  if (route === 'summary') {
    const sortTsums = t => [...t].sort(by('tsum'));
    return {
      ...v,
      tsums: sortTsums(v.tsums), medals: {...v.medals, tsums: sortTsums(v.medals.tsums)},
      dailyTsums: [...v.dailyTsums].sort(by('day', 'tsum')),
      mix: [...v.mix].sort(by('build', 'tsum', 'items')),
      histogram: {...v.histogram, bins: [...v.histogram.bins].sort(by('from', 'tsum'))},
    };
  }
  return v;
}

// Sums are added in a different order than SQLite's, so floats may differ in the last places.
function diff(a, b, path = '') {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)) ? [] : [`${path}: server ${a}, snapshot ${b}`];
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return a === b ? [] : [`${path}: server ${JSON.stringify(a)}, snapshot ${JSON.stringify(b)}`];
  }
  if (Array.isArray(a) !== Array.isArray(b)) return [`${path}: array vs object`];
  if (Array.isArray(a) && a.length !== b.length) return [`${path}: server has ${a.length} entries, snapshot ${b.length}`];
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out.push(...diff(a[k], b[k], `${path}.${k}`));
  return out;
}

// A row's coins in the case's column; "net:baseCoins" is base coins less the items' cost.
function coinsOf(r, column) {
  if (!column.startsWith('net:')) return r[column];
  const v = r[column.slice(4)], cost = itemCost(r.items);
  return v === null || cost === null ? null : v - cost;
}

let failed = 0;
for (const c of cases) {
  let got = await engine.call(c.route, c.params);
  let want = c.expected;
  if (c.route === 'rounds') {
    // Ids differ by design. Rows that tie on the sorted column may come in another order, so
    // when the column is not unique only the column is compared.
    const strip = rows => rows.map(({id, ...r}) => r);
    want = {...want, items: strip(want.items)};
    got = {...got, items: strip(got.items)};
    if (c.tieProne) {
      const col = c.sortColumn;
      const perSec = v => (v === null || !r0.durationSeconds ? null : v / r0.durationSeconds);
      let r0;
      const key = r => {
        r0 = r;
        if (col === 'coinsPerSec') return perSec(coinsOf(r, c.coinColumn));
        if (col === 'medalsPerSec') return perSec(r.medals);
        return r[col];
      };
      want = {...want, items: want.items.map(key)};
      got = {...got, items: got.items.map(key)};
    }
  } else {
    want = normalize(c.route, want);
    got = normalize(c.route, got);
  }
  const problems = diff(want, JSON.parse(JSON.stringify(got)));
  if (problems.length) {
    failed++;
    console.log(`FAIL ${c.name}\n  ${problems.slice(0, 8).join('\n  ')}${problems.length > 8 ? `\n  ...${problems.length - 8} more` : ''}`);
  }
}
console.log(`${cases.length - failed}/${cases.length} cases match`);
process.exit(failed ? 1 : 0);
