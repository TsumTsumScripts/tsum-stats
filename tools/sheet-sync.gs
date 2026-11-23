// Tsum Stats Recording: brings the global site's round counts into the group's
// Google Sheet, once a week, with nobody at the keyboard.
//
// This is a Google Apps Script, not a Node file: it lives in the spreadsheet
// (Extensions -> Apps Script) and runs on Google's servers as its owner.
// Setting it up, once:
//   1. Extensions -> Apps Script, replace what is there with this whole file,
//      save.
//   2. Pick setUp in the function list, Run, and approve the prompts (edit
//      this spreadsheet, fetch tsum-stats.gapscripts.app, run on a timer).
//   3. Reload the sheet: a "Tsum sync" menu appears, with Sync now.
// setUp installs the weekly timer (SYNC.weekDay at SYNC.hour, SYNC.timeZone).
// Running it again replaces the timer; it never adds a second one.
//
// What one run does, on the Skill levels tab only:
//   - Adds up the global site's rounds per Tsum and skill level from its
//     manifest and every part file the manifest lists (CONTRACT.md §4.1,
//     §4.2), checking each file's total against the manifest before any of it
//     is used.
//   - For each row the site has rounds for: an empty Rounds recorded gets the
//     site's count, a smaller number is raised to it, and a larger one (the
//     group's own count, ahead of what reached the site) is kept and listed.
//     Last updated becomes the day of the site's newest round whenever Rounds
//     recorded is set, and when it was empty.
//   - Writes only the cells that change. Notes, assignments, share codes and
//     the formula columns are never touched.
//   - Logs the run on the Sync log tab, and lists the rows that need a person
//     to look at them.
// Anything unexpected (a file that does not add up, a column it cannot find)
// stops the run before it writes anything; the error is logged and, on the
// timer, Google emails it to the owner.

const SYNC = {
  base: 'https://tsum-stats.gapscripts.app/data/global/',
  sheet: 'Skill levels',
  log: 'Sync log',
  idColumn: 1, // column A holds the Tsum ID, whatever its header says
  headers: {skill: 'Skill level', rounds: 'Rounds recorded', updated: 'Last updated'},
  timeZone: 'Asia/Singapore',
  weekDay: 'MONDAY',
  hour: 3,
  fetchBatch: 20, // part files fetched at once
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Tsum sync')
    .addItem('Sync now', 'syncNow')
    .addItem('Set up the weekly sync', 'setUp')
    .addToUi();
}

/** Installs (or replaces) the weekly timer and makes the log tab. */
function setUp() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'syncFromGlobal')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncFromGlobal')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay[SYNC.weekDay])
    .atHour(SYNC.hour)
    .nearMinute(0)
    .inTimezone(SYNC.timeZone)
    .create();
  logSheet_();
  SpreadsheetApp.getActive().toast(
    'Runs every ' + SYNC.weekDay.toLowerCase() + ' around ' + SYNC.hour + ':00 (' + SYNC.timeZone + ').',
    'Tsum sync set up', 10);
}

/** The menu's Sync now: the same run, with a summary when it finishes. */
function syncNow() {
  const r = syncFromGlobal();
  SpreadsheetApp.getActive().toast(
    r.filled + ' filled, ' + r.raised + ' raised, ' + r.higher + ' kept higher. See ' + SYNC.log + '.',
    'Tsum sync done', 10);
}

/** One run: what the timer calls. Throws on any failure, after logging it. */
function syncFromGlobal() {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) throw new Error('Another sync is still running.');
  try {
    const global = fetchGlobal_();
    const result = applyToSheet_(global);
    writeLog_(result, global);
    return result;
  } catch (e) {
    writeFailure_(e);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

// The global site's rounds per 'tsum|skill' as [rounds, newest day], from the
// manifest and every part file it lists.
function fetchGlobal_() {
  const manifest = fetchJson_(SYNC.base + 'manifest.json');
  if (manifest.kind !== 'tsum-global' || !Array.isArray(manifest.parts)) {
    throw new Error('manifest.json is not a manifest this script reads (kind "' + manifest.kind + '").');
  }
  const counts = {};
  let rounds = 0;
  let noSkill = 0;
  const parts = manifest.parts;
  for (let i = 0; i < parts.length; i += SYNC.fetchBatch) {
    const batch = parts.slice(i, i + SYNC.fetchBatch);
    const responses = UrlFetchApp.fetchAll(
      batch.map((p) => ({url: SYNC.base + p.file, muteHttpExceptions: true})));
    responses.forEach((res, j) => {
      const p = batch[j];
      if (res.getResponseCode() !== 200) {
        throw new Error(p.file + ' answered HTTP ' + res.getResponseCode() + '.');
      }
      const c = (JSON.parse(res.getContentText()) || {}).cells;
      const cols = ['tsum', 'skill', 'rounds', 'day'];
      if (!c || !cols.every((k) => Array.isArray(c[k]) && c[k].length === c.n)) {
        throw new Error(p.file + ' does not have the cells this script reads (' + cols.join(', ') + ').');
      }
      let sum = 0;
      for (let k = 0; k < c.n; k++) {
        const n = c.rounds[k];
        sum += n;
        if (!(c.skill[k] >= 1)) { noSkill += n; continue; }
        const key = c.tsum[k] + '|' + c.skill[k];
        const e = counts[key];
        if (!e) counts[key] = [n, c.day[k]];
        else { e[0] += n; if (c.day[k] > e[1]) e[1] = c.day[k]; }
      }
      if (sum !== p.rounds) {
        throw new Error(p.file + ' adds up to ' + sum + ' rounds but the manifest says ' + p.rounds + '.');
      }
      rounds += sum;
    });
  }
  if (rounds !== manifest.rounds) {
    throw new Error('The part files add up to ' + rounds + ' rounds but the manifest says ' + manifest.rounds + '.');
  }
  return {counts: counts, rounds: rounds, noSkill: noSkill, generatedAt: manifest.generatedAt};
}

function fetchJson_(url) {
  const res = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
  if (res.getResponseCode() !== 200) throw new Error(url + ' answered HTTP ' + res.getResponseCode() + '.');
  return JSON.parse(res.getContentText());
}

// Applies the counts to the Skill levels tab, writing only the cells that
// change. Returns what it did and the rows that need a look.
function applyToSheet_(global) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SYNC.sheet);
  if (!sheet) throw new Error('There is no tab named "' + SYNC.sheet + '".');
  const n = sheet.getLastRow() - 1;
  if (n < 1) throw new Error('The ' + SYNC.sheet + ' tab has no rows.');
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map((h) => h.trim());
  const column = (name) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error('The ' + SYNC.sheet + ' tab has no "' + name + '" column.');
    return i + 1;
  };
  const skillCol = column(SYNC.headers.skill);
  const roundsCol = column(SYNC.headers.rounds);
  const updatedCol = column(SYNC.headers.updated);

  const ids = sheet.getRange(2, SYNC.idColumn, n, 1).getDisplayValues();
  const skills = sheet.getRange(2, skillCol, n, 1).getDisplayValues();
  const rounds = sheet.getRange(2, roundsCol, n, 1).getValues();
  const updated = sheet.getRange(2, updatedCol, n, 1).getDisplayValues();

  const setRounds = {};
  const setUpdated = {};
  const r = {filled: 0, raised: 0, dated: 0, same: 0, higher: 0, notNumber: 0, missing: 0, sheetRounds: 0, look: []};
  const rowKeys = {};
  const rowTsums = {};
  for (let i = 0; i < n; i++) {
    const id = ids[i][0].trim();
    const skill = skills[i][0].trim();
    const v = rounds[i][0];
    if (id && skill) {
      rowKeys[id + '|' + skill] = true;
      rowTsums[id] = true;
    }
    const g = id && skill ? global.counts[id + '|' + skill] : null;
    let now = v;
    if (g) {
      if (v === '' || v === null) {
        now = setRounds[i] = g[0];
        setUpdated[i] = g[1];
        r.filled++;
      } else if (typeof v !== 'number' || v % 1 !== 0) {
        r.notNumber++;
        r.look.push([id, skill, String(v), g[0], 'Rounds recorded is not a whole number; left alone']);
      } else if (v < g[0]) {
        now = setRounds[i] = g[0];
        setUpdated[i] = g[1];
        r.raised++;
      } else if (v === g[0]) {
        r.same++;
        if (updated[i][0].trim() === '') { setUpdated[i] = g[1]; r.dated++; }
      } else {
        r.higher++;
        r.look.push([id, skill, v, g[0], 'The sheet is higher than the site: rounds not uploaded, or a typo']);
      }
    }
    if (typeof now === 'number') r.sheetRounds += now;
  }

  // Rounds on the site with no row to put them in.
  const lostTsums = {};
  Object.keys(global.counts).forEach((key) => {
    if (rowKeys[key]) return;
    const [id, skill] = key.split('|');
    const g = global.counts[key];
    if (!rowTsums[id]) {
      lostTsums[id] = (lostTsums[id] || 0) + g[0];
    } else {
      r.missing++;
      r.look.push([id, Number(skill), '', g[0], 'No row for this skill level']);
    }
  });
  Object.keys(lostTsums).forEach((id) => {
    r.missing++;
    r.look.push([id, 'all', '', lostTsums[id], 'Not in the sheet yet: add its rows']);
  });

  writeChanged_(sheet, roundsCol, setRounds);
  writeChanged_(sheet, updatedCol, setUpdated);
  return r;
}

// Writes {rowIndex: value} into one column, one setValues per run of
// neighbouring rows, so cells between them are never rewritten. A day goes in
// as 'yyyy-mm-dd' text, which the sheet reads as a date the way typing it does.
function writeChanged_(sheet, col, changes) {
  const rows = Object.keys(changes).map(Number).sort((a, b) => a - b);
  let start = -1;
  let run = [];
  const flush = () => {
    if (run.length) sheet.getRange(start + 2, col, run.length, 1).setValues(run);
    run = [];
  };
  rows.forEach((i) => {
    if (run.length && i !== start + run.length) flush();
    if (!run.length) start = i;
    run.push([changes[i]]);
  });
  flush();
}

// The log tab: runs in A:I, newest at the top; the latest run's rows that need
// a look in K:O, replaced each run.
const LOG_RUNS = ['Run at', 'Site data as of', 'Site rounds', 'Filled', 'Raised', 'Kept (sheet higher)',
  'Needs a look', 'Sheet rounds after', 'Notes'];
const LOG_LOOK = ['Tsum ID', 'Skill level', 'Sheet rounds', 'Site rounds', 'Why'];
const LOOK_COL = LOG_RUNS.length + 2;

function logSheet_() {
  const ss = SpreadsheetApp.getActive();
  let log = ss.getSheetByName(SYNC.log);
  if (!log) {
    log = ss.insertSheet(SYNC.log);
    log.getRange(1, 1, 1, LOG_RUNS.length).setValues([LOG_RUNS]).setFontWeight('bold');
    log.getRange(1, LOOK_COL, 1, LOG_LOOK.length).setValues([LOG_LOOK]).setFontWeight('bold');
    log.setFrozenRows(1);
  }
  return log;
}

function addRun_(log, row) {
  log.getRange(2, 1, 1, LOG_RUNS.length).insertCells(SpreadsheetApp.Dimension.ROWS);
  log.getRange(2, 1, 1, LOG_RUNS.length).setValues([row]);
}

function stamp_(date) {
  return Utilities.formatDate(date, SYNC.timeZone, 'yyyy-MM-dd HH:mm');
}

function writeLog_(r, global) {
  const log = logSheet_();
  const notes = [];
  if (r.dated) notes.push(r.dated + ' Last updated filled where the count already matched');
  if (global.noSkill) notes.push(global.noSkill + ' site rounds have no skill level and are not counted');
  addRun_(log, [stamp_(new Date()), stamp_(new Date(global.generatedAt)), global.rounds,
    r.filled, r.raised, r.higher, r.look.length, r.sheetRounds, notes.join('; ')]);
  const last = Math.max(log.getLastRow(), 2);
  log.getRange(2, LOOK_COL, last - 1, LOG_LOOK.length).clearContent();
  if (r.look.length) log.getRange(2, LOOK_COL, r.look.length, LOG_LOOK.length).setValues(r.look);
}

function writeFailure_(e) {
  try {
    addRun_(logSheet_(), [stamp_(new Date()), '', '', '', '', '', '', '', 'Failed: ' + e.message]);
  } catch (ignored) {
    // The failure itself still reaches the owner by email.
  }
}
