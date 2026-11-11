#!/usr/bin/env node
// Copies the Tsum script's share-code table into ui/src/lib/presets/shareCodes.json, which the
// page's and the Worker's codec read (ui/src/lib/presets/shareCode.js).
//
//   node tools/sync-share-codes.js [FILE]   (default ../tsum-tsum-script/app.gap.Tsum/build/shareCodes.json)
//
// Build the script first; its `build:codes` step writes the file. Run this before every script
// alpha that adds a share slot or a skill, then deploy the site: a code naming a skill the
// table lacks is refused at submit (CONTRACT §2.7) until then.
'use strict';
const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '..');
const from = path.resolve(process.argv[2] || path.join(repo, '..', 'tsum-tsum-script', 'app.gap.Tsum', 'build', 'shareCodes.json'));
const to = path.join(repo, 'ui', 'src', 'lib', 'presets', 'shareCodes.json');

const data = JSON.parse(fs.readFileSync(from, 'utf8'));
if (!data.table || !Array.isArray(data.table.slots) || !Array.isArray(data.cases)) {
  console.error(`${from} is not a share-code table`);
  process.exit(1);
}
fs.writeFileSync(to, JSON.stringify(data, null, 1) + '\n');
console.log(`[share codes] script ${data.script}: ${data.table.slots.filter(Boolean).length} slots, ${data.cases.length} cases`);
