// ui/src/lib/accounts.js over the lists Go's TestAccountsParity wrote: prints
// the accounts each case's lists group into, and what they say of the levels
// it asks about, for the test to hold accounts.go to.
//   node accounts-parity.mjs cases.json
import {readFileSync} from 'node:fs';
import {boundAt, clamp, groupAccounts, readingsOf, segmentsOf} from '../src/lib/accounts.js';

const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));
console.log(JSON.stringify(cases.map(c => {
  const accounts = groupAccounts(c.lists);
  const readings = accounts.map(readingsOf);
  return {
    name: c.name,
    accounts: accounts.map(a => a.lists.map(l => l.id)),
    // Each question {account, tsum, at, level}: the level it counts at, by boundAt and by the segments.
    answers: c.asks.map(q => {
      const r = readings[q.account]?.[q.tsum] ?? [];
      const seg = segmentsOf(r, '').filter(([from]) => from <= q.at).at(-1);
      return [clamp(q.level, boundAt(r, q.at)), seg ? clamp(q.level, {floor: seg[1], cap: seg[2]}) : q.level];
    }),
  };
})));
