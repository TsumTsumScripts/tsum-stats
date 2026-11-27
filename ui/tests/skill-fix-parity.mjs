// The skill level correction (ui/src/lib/skillFix.js) over the rounds Go's
// TestSkillFixParity wrote: prints, per case, every round's effective level
// and the runs that moved, for the test to hold skillfix.go to.
//   node skill-fix-parity.mjs cases.json
import {readFileSync} from 'node:fs';
import {refileRounds} from '../src/lib/skillFix.js';

const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));
console.log(JSON.stringify(cases.map(c => {
  const {levels, fixes} = refileRounds(c.rounds);
  return {
    name: c.name, levels: levels.map(l => l ?? 0),
    fixes: fixes.map(f => ({player: f.player, from: f.from, to: f.to, rounds: f.rounds, first: f.first, last: f.last, rule: f.rule,
      context: f.context, n: f.n, mid: f.mid, againstN: f.against.n, againstMid: f.against.mid, ratio: f.ratio, confidence: f.confidence})),
  };
})));
