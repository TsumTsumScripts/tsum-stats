#!/usr/bin/env node
//
// Verifies CODEMAP.md against the tree.
//
// The map is only worth reading if it is true, and the ways it goes stale are
// mechanical: a file moves, a new source file, test, document or tool is never
// listed. Those are the ones checked here. The prose is not checkable and is
// not tried. Adapted from general-automation-app's tools/codemap-check.js.
//
//   node tools/codemap-check.js
//
// Exits non-zero on any problem.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MAP = 'CODEMAP.md';

const problems = [];
const fail = (msg) => problems.push(msg);

const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const text = fs.readFileSync(path.join(ROOT, MAP), 'utf8');
const lines = text.split(/\r?\n/);

// Build output and installed packages: never walked, and a path into them may
// be named without existing (a fresh clone has not built anything yet).
const OUTPUT = ['web', 'build', 'global/site', 'global/.wrangler', 'global/test/.parity'];
const SKIP_NAMES = new Set(['.git', 'node_modules', '.wrangler']);
const isOutput = (rel) => OUTPUT.some((o) => rel === o || rel === o + '/' || rel.startsWith(o + '/'));

// Sections that talk in another tree's paths opt out until the next heading.
const external = [];
const fenced = [];
{
  let ext = false;
  let fence = false;
  lines.forEach((line, i) => {
    if (line.startsWith('```')) {
      fence = !fence;
      fenced[i] = true;
      external[i] = ext;
      return;
    }
    fenced[i] = fence;
    if (line.startsWith('#')) ext = false;
    if (line.indexOf('map:external') >= 0) ext = true;
    external[i] = ext;
  });
}

// --- 1. every path named here exists ---------------------------------------

const INDEX = [];
(function collect(rel) {
  fs.readdirSync(path.join(ROOT, rel || '.'), { withFileTypes: true }).forEach((entry) => {
    const child = rel ? rel + '/' + entry.name : entry.name;
    if (SKIP_NAMES.has(entry.name) || isOutput(child)) return;
    if (entry.isDirectory()) {
      INDEX.push(child + '/');
      collect(child);
    } else {
      INDEX.push(child);
    }
  });
})('');

const TOP = new Set(fs.readdirSync(ROOT));

// A table row may name a file relative to the part it sits in -- `src/index.ts`
// in the Worker's table -- so a token counts as found when any real path ends
// with it.
const resolves = (token) => {
  if (isOutput(token)) return true;
  const dir = token.endsWith('/') ? token : token + '/';
  return INDEX.some((rel) =>
    rel === token || rel === dir || rel.endsWith('/' + token) || rel.endsWith('/' + dir));
};

// A backticked token is taken for a path when it ends in a slash, its last part
// has an extension, or it starts at a top-level entry. That leaves out
// `gap.round-stats/1`, a realtime topic such as `ts/rounds`, and routes, which
// start with a slash.
const looksLikePath = (token) => {
  const last = token.replace(/\/$/, '').split('/').pop();
  return token.endsWith('/') || /\.[A-Za-z0-9]+$/.test(last) || TOP.has(token.split('/')[0]);
};

const claimed = new Set();
lines.forEach((line, i) => {
  if (external[i] || fenced[i]) return;
  const spans = line.match(/`[^`]+`/g) || [];
  spans.forEach((span) => {
    const token = span.slice(1, -1).trim();
    if (token.indexOf('/') < 0) return;            // not a path
    if (token.startsWith('/')) return;             // a route
    if (!/^[A-Za-z0-9._/-]+$/.test(token)) return; // prose, code, a glob
    if (token.indexOf('..') >= 0) return;          // another tree
    if (!looksLikePath(token)) return;
    claimed.add(token);
  });
});

claimed.forEach((token) => {
  if (!resolves(token)) fail('path named in ' + MAP + ' does not exist: ' + token);
});

// Top-level entries of the tree block, which the check above skips.
lines.forEach((line, i) => {
  if (!fenced[i] || external[i]) return;
  const m = /^[|│]?\s*[├└]── ([A-Za-z0-9._/-]+)/.exec(line);
  if (m && !exists(m[1]) && !isOutput(m[1])) fail('tree entry does not exist: ' + m[1]);
});

// --- 2. every source file, test, document and tool is mentioned ------------

const walk = (rel, test, out, deep = true) => {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) return out;
  fs.readdirSync(full, { withFileTypes: true }).forEach((entry) => {
    const child = rel ? rel + '/' + entry.name : entry.name;
    if (SKIP_NAMES.has(entry.name) || isOutput(child)) return;
    if (entry.isDirectory()) {
      if (deep) walk(child, test, out, deep);
    } else if (test(entry.name)) {
      out.push(child);
    }
  });
  return out;
};

const required = [];
const want = (files, label) => files.forEach((rel) => required.push({ rel, label }));

want(walk('', (n) => /\.go$/.test(n), [], false), 'Go source');
want(walk('internal', (n) => /\.go$/.test(n), []), 'Go source');
want(walk('internal/starter/site', () => true, []), 'starter page file');
want(walk('ui/src', (n) => /\.(svelte|js)$/.test(n), []), 'page source');
want(walk('ui/tests', (n) => /\.m?js$/.test(n), []), 'page test');
want(walk('global/src', (n) => /\.ts$/.test(n), [], false), 'Worker source');
want(walk('global/test', (n) => /\.ts$/.test(n), [], false), 'Worker test');
want(walk('docs', (n) => /\.md$/.test(n), []), 'document');
want(walk('global', (n) => /\.md$/.test(n), [], false), 'document');
want(walk('tools', () => true, []), 'tool');

// A basename shared by two required files (engine.js, adb.go, update.go) has
// to be named with its folder: `snapshot/engine.js`, `starter/adb.go`. A root
// file shares it with nothing above it, so its bare name must appear on its
// own, not as the end of a longer path.
const count = {};
required.forEach(({ rel }) => {
  const b = path.basename(rel);
  count[b] = (count[b] || 0) + 1;
});
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

required.forEach(({ rel, label }) => {
  const base = path.basename(rel);
  let ok;
  if (count[base] === 1) {
    ok = text.indexOf(base) >= 0;
  } else if (rel.indexOf('/') < 0) {
    ok = new RegExp('(^|[^/\\w])' + esc(base) + '(?![\\w])', 'm').test(text);
  } else {
    const parent = path.basename(path.dirname(rel));
    ok = text.indexOf(parent + '/' + base) >= 0;
  }
  if (!ok) fail(label + ' is not mentioned in ' + MAP + ': ' + rel);
});

// --- report ----------------------------------------------------------------

if (problems.length === 0) {
  console.log('CODEMAP.md: ok (' + claimed.size + ' paths, ' + required.length + ' files checked)');
  process.exit(0);
}
problems.forEach((p) => console.error('  ' + p));
console.error('\nCODEMAP.md: ' + problems.length + ' problem(s)');
process.exit(1);
