// The skill level correction's rules (ui/src/lib/skillFix.js), on made-up
// rounds: what moves, and above all what must not. `npm run test:fix`.
import test from 'node:test';
import assert from 'node:assert/strict';
import {FIX, compare, fixContext, lowerMedian, refile, refileRounds, runsOf, trustedVersion} from '../src/lib/skillFix.js';

// A small deterministic generator, so a failure repeats.
let seed = 1;
const next = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
let clock = 0;
/** n rounds of one player at a recorded level, their coins about `coins` (±10 %). */
function stretch(player, level, n, coins, {trusted = false, context = 2} = {}) {
  return Array.from({length: n}, () => {
    clock++;
    return {id: `r${String(clock).padStart(6, '0')}`, at: `2026-10-01 ${String(clock).padStart(8, '0')}`, player, level, trusted, context,
      value: Math.round(coins * (0.9 + next(2001) / 10000))};
  });
}
const moved = rounds => refileRounds(rounds).fixes.map(f => `${f.player}:${f.from}>${f.to}:${f.rounds}:${f.rule}`);

test('a version with Auto Set Skill Level is 6.0a19 and later', () => {
  for (const v of ['6.0a19', '6.0a20', '6.0b1', '6.0b33', '6.0', '6.0.1', '6.1a1', '7.0', '10.2b3']) assert.equal(trustedVersion(v), true, v);
  for (const v of ['6.0a18', '6.0a1', '6.0a', '5.0', '5.0b3', '0.11', '3.0b', '', null, undefined, 'dev', '4.0a2']) assert.equal(trustedVersion(v), false, String(v));
});

test('the item context leaves out +Coin, +Exp and +Score', () => {
  assert.equal(fixContext(1 | 2), 2);
  assert.equal(fixContext(1 | 8 | 16), 0);
  assert.equal(fixContext(2 | 4 | 32 | 64), 2 | 4 | 32 | 64);
  assert.equal(fixContext(-1), -1);
  assert.equal(fixContext(null), -1);
  assert.equal(lowerMedian([5, 1, 3, 2]), 2);
});

test('a lower level between two runs of a higher one, with the same coins, moves up', () => {
  const rounds = [...stretch('a', 5, 200, 9000), ...stretch('a', 3, 60, 9000), ...stretch('a', 5, 150, 9000)];
  const {levels, fixes} = refileRounds(rounds);
  assert.deepEqual(moved(rounds), ['a:3>5:60:order']);
  assert.ok(levels.every(l => l === 5));
  assert.equal(fixes[0].confidence, 'high');
  assert.ok(Math.abs(fixes[0].ratio - 1) < 0.05);
  // The rounds given are not touched.
  assert.equal(rounds[220].level, 3);
});

test('a higher level between two runs of a lower one moves down', () => {
  const rounds = [...stretch('a', 1, 100, 1700), ...stretch('a', 3, 25, 1700), ...stretch('a', 1, 600, 1700)];
  assert.deepEqual(moved(rounds), ['a:3>1:25:order']);
});

test('a real progression stays, whatever the coins do', () => {
  for (const step of [1, 1.2, 1.4]) {
    const rounds = [...stretch('a', 3, 250, 7000), ...stretch('a', 4, 220, 7000 * step, {trusted: true}), ...stretch('a', 5, 900, 7000 * step * step, {trusted: true})];
    assert.deepEqual(moved(rounds), [], `step ${step}`);
  }
});

test('levels that go down are left alone when the coins do not match', () => {
  // Half the coins at the lower level: not the same account's rounds at level 5, whatever they are.
  const rounds = [...stretch('a', 5, 300, 8000), ...stretch('a', 2, 70, 4400), ...stretch('a', 5, 300, 8000)];
  assert.deepEqual(moved(rounds), []);
});

test('levels that go down are left alone when neither side clearly outweighs the other', () => {
  assert.deepEqual(moved([...stretch('a', 5, 100, 8000), ...stretch('a', 4, 100, 8000)]), []);
  // The default level counts half: 100 rounds at 5 are not outvoted by 300 at 3.
  assert.deepEqual(moved([...stretch('a', 5, 100, 8000), ...stretch('a', 3, 300, 8000)]), []);
  // But 300 at 5 outweigh 100 at 3.
  assert.deepEqual(moved([...stretch('a', 5, 300, 8000), ...stretch('a', 3, 100, 8000)]), ['a:3>5:100:order']);
});

test('a run is not compared across item sets, and a short run is never moved', () => {
  // The lower run used other items: nothing to hold it to.
  assert.deepEqual(moved([...stretch('a', 5, 200, 9000), ...stretch('a', 3, 60, 9000, {context: 0}), ...stretch('a', 5, 150, 9000)]), []);
  // 19 rounds are too few.
  assert.deepEqual(moved([...stretch('a', 5, 200, 9000), ...stretch('a', 3, FIX.MIN_ROUNDS - 1, 9000), ...stretch('a', 5, 150, 9000)]), []);
  // Single rounds swapping back and forth move nothing.
  const swaps = [];
  for (let i = 0; i < 30; i++) swaps.push(...stretch('a', i % 2 ? 5 : 3, 1, 3000));
  assert.deepEqual(moved([...stretch('a', 3, 290, 3000), ...swaps]), []);
});

test('one player is never held to another', () => {
  // b records 3 and earns what a's level 6 does; nothing says b's level.
  const rounds = [...stretch('a', 3, 300, 5000, {trusted: true}), ...stretch('a', 6, 300, 12000, {trusted: true}), ...stretch('b', 3, 500, 12000)];
  assert.deepEqual(moved(rounds), []);
});

test('rounds before Auto Set Skill Level match the same player\'s own trusted run', () => {
  // c shows the levels are far apart for this Tsum; a played at "3" for months, then 6.0 read level 6 with the same coins.
  const others = [...stretch('c', 3, 300, 5000, {trusted: true}), ...stretch('c', 6, 300, 12000, {trusted: true})];
  const rounds = [...others, ...stretch('a', 3, 500, 11800), ...stretch('a', 6, 200, 12000, {trusted: true})];
  assert.deepEqual(moved(rounds), ['a:3>6:500:trusted']);
  // A real level-up shows as a step: left alone.
  assert.deepEqual(moved([...others, ...stretch('a', 3, 500, 5100), ...stretch('a', 6, 200, 12000, {trusted: true})]), []);
  // Runs in between move with it, newest first, when trusted rounds tell their level from 6 too...
  const between = [...stretch('a', 3, 500, 11800), ...stretch('a', 4, 100, 12100), ...stretch('a', 6, 200, 12000, {trusted: true})];
  assert.deepEqual(moved([...others, ...stretch('c', 4, 300, 7000, {trusted: true}), ...between]).sort(), ['a:3>6:500:trusted', 'a:4>6:100:trusted']);
  // ...and nothing moves when they do not, as the run at 4 would be left under the one before it.
  assert.deepEqual(moved([...others, ...between]), []);
});

test('a Tsum whose level barely changes its coins moves nothing', () => {
  // Trusted rounds at 3 and 6 earn about the same: the same coins say nothing about the level.
  const flat = [...stretch('c', 3, 300, 1700, {trusted: true}), ...stretch('c', 6, 300, 1800, {trusted: true})];
  assert.deepEqual(moved([...flat, ...stretch('a', 3, 500, 1750), ...stretch('a', 6, 200, 1800, {trusted: true})]), []);
  // And with no trusted rounds at a lower level at all.
  assert.deepEqual(moved([...stretch('a', 3, 500, 11800), ...stretch('a', 6, 200, 12000, {trusted: true})]), []);
});

test('the trusted rule never moves a run down or a trusted run', () => {
  const others = [...stretch('c', 3, 300, 5000, {trusted: true}), ...stretch('c', 6, 300, 12000, {trusted: true})];
  assert.deepEqual(moved([...others, ...stretch('a', 3, 500, 11800, {trusted: true}), ...stretch('a', 6, 200, 12000, {trusted: true})]), []);
});

test('a later trusted run at a lower level wins by the order rule', () => {
  // "6" typed in for 800 rounds, then the Tsum List read 1, same medals: the level was 1 all along.
  assert.deepEqual(moved([...stretch('a', 6, 800, 150, {context: 0}), ...stretch('a', 1, 700, 155, {trusted: true, context: 0})]), ['a:6>1:800:order']);
});

test('a fix already made is kept through a little drift, a new one is not made on it', () => {
  const made = (drift, prev) => {
    const rounds = [...stretch('a', 5, 300, 9000), ...stretch('a', 3, 60, 9000 * drift), ...stretch('a', 5, 300, 9000)];
    const runs = runsOf(rounds);
    return refile(runs, prev ? runs.map(r => (r.level === 3 ? 5 : null)) : null).map(d => d.level);
  };
  assert.deepEqual(made(0.85, false), [5, 3, 5]);
  assert.deepEqual(made(0.85, true), [5, 5, 5]);
  assert.deepEqual(made(0.7, true), [5, 3, 5]);
});

test('runs keep the rounds without a level out and compare within the best shared context', () => {
  const rounds = [...stretch('a', 5, 30, 9000), {id: 'x', at: '2026-10-01 00000030', player: 'a', level: null, trusted: false, context: 2, value: 1}, ...stretch('a', 5, 30, 9000)];
  // Sorted by time the level-less round falls in the middle and does not break the run.
  rounds.forEach((r, i) => { r.at = `2026-10-01 ${String(i).padStart(8, '0')}`; });
  const runs = runsOf(rounds);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].n, 60);
  assert.equal(refileRounds(rounds).levels[30], null);
  const a = {contexts: [{context: 0, n: 30, mid: 100}, {context: 2, n: 80, mid: 200}]};
  const b = {contexts: [{context: 0, n: 25, mid: 100}, {context: 2, n: 40, mid: 220}, {context: 4, n: 500, mid: 1}]};
  assert.equal(compare(a, b).context, 2);
  assert.equal(compare(a, {contexts: [{context: 4, n: 500, mid: 1}]}), null);
});
