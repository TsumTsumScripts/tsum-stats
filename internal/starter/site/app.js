// The starter page: the device list, the chosen device's actions, the export,
// and the activity log. Talks only to /api/starter (internal/starter).
'use strict';

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const state = {
  status: null,
  devices: [],
  current: '', // the chosen serial
  busy: false, // an action is running; one at a time, as in the terminal menu
  follow: null, // AbortController of the live service log
  dots: {}, // serial -> badge colour
  update: null, // GET /api/starter/update
};

// ------------------------------------------------------------------- the API

async function api(path) {
  const r = await fetch('/api/starter/' + path);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || r.statusText);
  return r.json();
}

function post(path, body, opts = {}) {
  return fetch('/api/starter/' + path, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), ...opts,
  });
}

// Reads an NDJSON action stream: each {log} line goes to onLine, the last
// {done} line is the verdict.
async function readStream(resp, onLine) {
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    return {ok: false, msg: err.message || resp.statusText};
  }
  const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '', verdict = {ok: false, msg: 'The action ended without a verdict.'};
  for (;;) {
    const {value, done} = await reader.read();
    if (done) break;
    buf += value;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.done) verdict = msg;
      else onLine(msg.log);
    }
  }
  return verdict;
}

// ------------------------------------------------------------- what to say

// The service state as a word, a tone and what to do next. Worded as the
// terminal menu's "Next:" line (bin/posix/gap-menu.sh menu_next_step).
function describe(d) {
  const hasApks = state.status?.hasApks;
  switch (d.service) {
    case 'running':
      return {tone: 'ok', next: 'Nothing to do: the service is up. Use the app on the device. After the device restarts, come back and press Start service again.'};
    case 'stopped':
      return {tone: 'warn', next: 'Press Start service. The app needs it running before a script can run.'};
    case 'not installed':
      return {tone: 'bad', next: hasApks
        ? 'Install the app (the APK in this bundle, or the latest published one), then press Start service.'
        : 'Press Download & install the latest APK, then Start service.'};
    case 'wrong ABI':
      return {tone: 'bad', next: `The installed app was built for another processor. Download the latest APK, which fetches the build for ${d.abi}, then press Start service.`};
    case 'unreadable':
      return {tone: 'bad', next: 'The device answered, but not in a way this tool could read. Refresh; if it stays like this, reconnect the device.'};
    case 'unauthorized':
      return {tone: 'bad', next: 'Look at the device and tap Allow on the "Allow USB debugging?" prompt, then Refresh.'};
    case 'offline':
      return {tone: 'bad', next: 'Press Reconnect, then Refresh. If it stays offline, restart the emulator, or unplug the phone and plug it in again.'};
    case 'busy':
      return {tone: '', next: 'An action is running on this device.'};
    default:
      return {tone: 'bad', next: `adb reports this device as "${d.state}". Put that right on the device, then Refresh.`};
  }
}

// How a device is told apart. Emulators left on their defaults all report the
// same model, so the port (or USB serial) is the name, and a known port range
// names the emulator family: MuMu 16384 + 32i, Nox 62001 then 62025 + i,
// MEmu 21503 + 10i. Ambiguous ports (5555, used by several) get no family.
function identity(d) {
  const model = d.model && d.model !== '-' ? d.model : '';
  let m = /^(?:127\.0\.0\.1|localhost):(\d+)$/.exec(d.serial);
  if (m) {
    const port = Number(m[1]);
    let family = 'Emulator';
    if (port >= 16384 && port < 16384 + 32 * 16 && (port - 16384) % 32 === 0) family = `MuMu #${(port - 16384) / 32 + 1}`;
    else if (port === 7555) family = 'MuMu';
    else if (port === 62001) family = 'Nox #1';
    else if (port >= 62025 && port < 62040) family = `Nox #${port - 62023}`;
    else if (port >= 21503 && port < 21503 + 10 * 16 && (port - 21503) % 10 === 0) family = `MEmu #${(port - 21503) / 10 + 1}`;
    return {name: family, badge: `port ${port}`, model};
  }
  if ((m = /^emulator-(\d+)$/.exec(d.serial))) return {name: 'Emulator', badge: `port ${Number(m[1]) + 1}`, model};
  if ((m = /^([\d.]+):(\d+)$/.exec(d.serial))) return {name: 'Wi-Fi device', badge: `${m[1]}:${m[2]}`, model};
  return {name: model || 'USB phone', badge: `USB ${d.serial.slice(-6)}`, model: model ? 'USB' : ''};
}

// "MuMu #1 (port 16384)", for log lines and dialogs.
const label = d => { const id = identity(d); return `${id.name} (${id.badge})`; };

// One colour per device, kept for the session, on every badge for it.
const BADGE_DOTS = ['#ffb454', '#9db4ff', '#ff8fab', '#5cc9a7', '#c9a3ff', '#7fd6e8'];
const dotOf = serial => {
  if (!(serial in state.dots)) state.dots[serial] = BADGE_DOTS[Object.keys(state.dots).length % BADGE_DOTS.length];
  return state.dots[serial];
};

function badge(d, big = false) {
  const b = el('span', {class: 'port-badge' + (big ? ' port-badge--big' : ''), title: d.serial}, identity(d).badge);
  b.style.setProperty('--badge-dot', dotOf(d.serial));
  return b;
}

const svcClass = d => ({running: 'svc--ok', stopped: 'svc--warn', busy: 'svc--busy'})[d.service] || (d.busy ? 'svc--busy' : 'svc--bad');
const usable = d => d.state === 'device';
const current = () => state.devices.find(d => d.serial === state.current);

// ------------------------------------------------------------------ rendering

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  n.append(...kids.filter(k => k !== null && k !== undefined));
  return n;
}

function renderStatus() {
  const s = state.status;
  const adb = s.adb;
  const line = $('#adb-line');
  line.hidden = adb.missing;
  line.textContent = adb.missing ? '' : `adb: ${adb.source}  ·  ${adb.path}`;
  $('#adb-card').hidden = !adb.missing;
  $$('[data-adb="revision"]').forEach(n => { n.textContent = adb.revision ? 'r' + adb.revision : ''; });
  $$('[data-adb="size"]').forEach(n => { n.textContent = adb.sizeMB || '8 to 16'; });
  $('#adb-older').hidden = !adb.older;
  $('#adb-older').textContent = adb.older ? `An older adb is on this computer, ${adb.older}; this tool wants r${adb.revision} or newer. Set GAP_ADB to use it anyway.` : '';
  $('#adb-warning').hidden = !adb.warning;
  $('#adb-warning').textContent = adb.warning || '';
  $('#channel-line').textContent = s.channel
    ? `Pre-release channel: ${s.channel}`
    : 'Published releases. Fetches the build made for this device, checked against its published checksum.';
  $('#update-btn').textContent = s.channel ? 'Download & install the latest pre-release APK' : 'Download & install the latest APK';
  $('#channel-url').value = s.channel || '';
  $('#collected-path').textContent = s.collected;
  $('#foot').replaceChildren(
    `Tsum Tsum Starter ${s.version}  ·  this folder: `, el('code', {}, s.bundle),
    '  ·  device storage: ', el('code', {}, s.storage), '  ·  ', el('a', {href: '/', target: '_blank', rel: 'noopener'}, 'Stats site'));
}

function renderDevices(scanning = false) {
  const list = $('#device-list');
  if (scanning && !state.devices.length) {
    list.replaceChildren(el('p', {class: 'scanning muted'}, 'Looking for devices …'));
    return;
  }
  if (!state.devices.length) {
    list.replaceChildren(el('div', {class: 'patch patch--surface empty'},
      el('h3', {}, 'No device found'),
      el('p', {class: 'small'}, 'Start your emulator, or plug the phone in with USB debugging turned on, then press Refresh.'),
      el('p', {class: 'small'}, 'Emulators are looked for on 127.0.0.1, the usual ports of MuMu, LDPlayer, Nox and MEmu. Another port: set GAP_EXTRA_PORTS before starting.'),
      el('p', {class: 'small'}, 'Still missing one that is on and connected? Restart adb.'),
      el('div', {class: 'row'}, el('button', {class: 'patch patch--paper fbtn fbtn--sm', type: 'button', onclick: restartADB}, 'Restart adb'))));
    return;
  }
  list.replaceChildren(...state.devices.map(d => {
    const id = identity(d);
    const picked = d.serial === state.current;
    return el('button', {
      class: 'patch patch--surface device', type: 'button', 'aria-pressed': String(picked),
      'aria-label': `${label(d)}${id.model ? ', ' + id.model : ''}, service ${d.service}${picked ? ', selected' : ''}`,
      onclick: () => choose(d.serial),
    },
    el('span', {class: 'device__top'}, el('span', {class: 'device__model'}, id.name), el('span', {class: 'device__picked'}, '✓ Selected')),
    el('span', {class: 'device__port'}, badge(d)),
    el('span', {class: 'device__serial'}, [id.model, d.serial].filter(Boolean).join('  ·  ')),
    el('span', {class: 'device__meta'},
      el('span', {class: 'svc ' + svcClass(d)}, d.busy ? 'busy' : d.service),
      d.abi && d.abi !== '-' ? el('span', {class: 'abi'}, d.abi) : null));
  }));
}

async function renderDevice() {
  const d = current();
  $('#device').hidden = !d;
  if (!d) return;
  const {tone, next} = describe(d);
  const id = identity(d);
  $('#device-title').textContent = id.name;
  $('#device-sub').textContent = [id.model, d.serial, d.abi !== '-' ? d.abi : ''].filter(Boolean).join('  ·  ');
  $('#device-badge').replaceChildren(badge(d, true));
  $$('[data-device-badge]').forEach(n => n.replaceChildren(badge(d)));
  $$('[data-device-name]').forEach(n => { n.textContent = id.name; });
  $('#status-card').dataset.tone = tone;
  $('#status-text').textContent = d.busy ? 'busy' : d.service;
  $('#next-step').textContent = next;
  $('#service-actions').hidden = !usable(d);
  $('#offline-actions').hidden = d.state !== 'offline';
  $('#root-note').hidden = !usable(d);
  $$('[data-needs-device]').forEach(n => { n.hidden = !usable(d); });
  $('#all-devices-label').hidden = state.devices.filter(usable).length < 2;
  setBusy(state.busy);

  if (state.status.hasApks && usable(d)) {
    const {apks} = await api('apks?abi=' + encodeURIComponent(d.abi));
    $('#apk-select').replaceChildren(...apks.map(a => el('option', {value: a.name},
      a.name + (a.default ? '  (built for this device)' : a.universal ? '  (every ABI)' : ''))));
    $('#install-row').hidden = !apks.length;
  } else {
    $('#install-row').hidden = true;
  }
}

function setBusy(busy) {
  state.busy = busy;
  $$('[data-action], [data-delete], [data-update-apply], #export-btn, #refresh, #adb-restart').forEach(b => { b.disabled = busy; });
}

// ------------------------------------------------------------- the activity

function logLine(line) {
  const c = $('#console');
  const atEnd = c.scrollTop + c.clientHeight >= c.scrollHeight - 8;
  c.append(line + '\n');
  if (atEnd) c.scrollTop = c.scrollHeight;
}

function showVerdict(v) {
  $('#activity').hidden = false;
  const box = $('#verdict');
  box.hidden = !v.msg;
  box.dataset.ok = String(Boolean(v.ok));
  $('#verdict-text').textContent = (v.ok ? 'Done: ' : 'Problem: ') + v.msg;
  const open = $('#verdict-open');
  open.hidden = !v.path;
  open.dataset.path = v.path || '';
  open.textContent = v.path?.endsWith('.zip') ? 'Show the file' : 'Open the folder';
}

function startActivity(title) {
  const a = $('#activity');
  a.hidden = false;
  $('#verdict').hidden = true;
  logLine('');
  logLine('▸ ' + title);
}

// ------------------------------------------------------------- the actions

const LABELS = {
  start: 'Start service', restart: 'Restart service', stop: 'Stop service', log: 'Show service log',
  install: 'Install APK', update: 'Download & install the latest APK', 'add-source': 'Add the Tsum Tsum library',
  reconnect: 'Reconnect',
  'copy-script': 'Copy the script log', 'import-stats': 'Import round stats into Stats',
  'delete-script': 'Delete the script log', 'delete-stats': 'Delete round stats',
};

async function runAction(action, options = {}) {
  const d = current();
  if (!d || state.busy) return;
  setBusy(true);
  const toLog = action === 'log';
  if (toLog) {
    $('#service-log').hidden = false;
    $('#service-log').textContent = '';
  } else {
    startActivity(`${LABELS[action] || action} on ${label(d)}`);
  }
  try {
    const resp = await post('action', {serial: d.serial, action, options});
    const v = await readStream(resp, toLog ? line => { $('#service-log').append(line + '\n'); } : logLine);
    if (toLog) {
      if (!$('#service-log').textContent) $('#service-log').textContent = '(the service log is empty)';
    } else {
      showVerdict(v);
      $('#activity').scrollIntoView({behavior: 'smooth', block: 'nearest'});
    }
  } catch (e) {
    showVerdict({ok: false, msg: e.message});
  } finally {
    setBusy(false);
  }
  await refreshCurrent();
}

// The live service log runs beside other actions: it holds no device lock.
async function toggleFollow() {
  const btn = $('#follow-btn');
  if (state.follow) {
    state.follow.abort();
    return;
  }
  const d = current();
  if (!d) return;
  const out = $('#service-log');
  out.hidden = false;
  out.textContent = '';
  state.follow = new AbortController();
  btn.textContent = 'Stop following';
  try {
    const resp = await post('action', {serial: d.serial, action: 'follow'}, {signal: state.follow.signal});
    await readStream(resp, line => {
      const atEnd = out.scrollTop + out.clientHeight >= out.scrollHeight - 8;
      out.append(line + '\n');
      if (atEnd) out.scrollTop = out.scrollHeight;
    });
  } catch (e) {
    if (e.name !== 'AbortError') out.append('\n' + e.message + '\n');
  } finally {
    state.follow = null;
    btn.textContent = 'Follow live';
  }
}

async function confirmDelete(kind) {
  const d = current();
  if (!d || state.busy) return;
  setBusy(true);
  let files = [];
  try {
    ({files} = await api(`files?serial=${encodeURIComponent(d.serial)}&kind=${kind}`));
  } catch (e) {
    showVerdict({ok: false, msg: e.message});
  }
  setBusy(false);
  const what = kind === 'script' ? 'script log' : 'round stats';
  if (!files.length) {
    showVerdict({ok: false, msg: `No ${what} on this device: nothing matched under ${state.status.storage}.`});
    return;
  }
  $('#confirm-title').textContent = `Delete ${files.length} file(s) from ${label(d)}?`;
  $('#confirm-body').textContent = kind === 'script'
    ? 'The service holds script.log open, so it is stopped for the delete and started again afterwards. Anything the script was doing is ended.'
    : 'Round stats not imported into Stats or exported first are gone for good.';
  $('#confirm-files').replaceChildren(...files.map(f => el('li', {}, f)));
  const dlg = $('#confirm');
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', () => {
    if (dlg.returnValue === 'yes') runAction('delete-' + kind, {confirm: true});
  }, {once: true});
}

// -------------------------------------------------------------- the export

function exportName(serials) {
  const p = n => String(n).padStart(2, '0');
  const t = new Date();
  const who = serials.length === 1 ? serials[0].replace(/[^A-Za-z0-9._-]/g, '_') : 'devices';
  return `tsum-export-${who}-${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}.zip`;
}

// Asks where to save, then zips. Chrome and Edge have a save picker; elsewhere
// the server shows this computer's own save dialog, and a plain download is
// the last resort.
async function exportZip() {
  const d = current();
  if (!d || state.busy) return;
  const parts = $$('input[name="part"]:checked').map(i => i.value);
  const status = $('#export-status');
  if (!parts.length) {
    status.textContent = 'Tick at least one thing to export.';
    return;
  }
  const serials = $('#all-devices').checked ? state.devices.filter(usable).map(x => x.serial) : [d.serial];
  const name = exportName(serials);
  const body = {serials, parts};

  // The picker has to open straight from the click, before anything is awaited.
  let handle = null;
  if (window.showSaveFilePicker) {
    try {
      handle = await window.showSaveFilePicker({suggestedName: name, types: [{description: 'Zip archive', accept: {'application/zip': ['.zip']}}]});
    } catch (e) {
      if (e.name === 'AbortError') return;
      handle = null;
    }
  }
  setBusy(true);
  status.textContent = 'Copying files off the device and zipping them …';
  try {
    if (handle) {
      const resp = await post('export', {...body, mode: 'download'});
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).message || resp.statusText);
      await resp.body.pipeTo(await handle.createWritable());
      done(`Saved ${handle.name}.`, '');
      return;
    }
    const r = await (await post('export', {...body, mode: 'dialog'})).json();
    if (r.path) return done(`Saved ${r.path}`, r.path);
    if (r.cancelled) {
      status.textContent = 'Nothing was saved.';
      return;
    }
    if (r.message) throw new Error(r.message);
    // No dialog here either: the browser's own download.
    const resp = await post('export', {...body, mode: 'download'});
    if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).message || resp.statusText);
    const url = URL.createObjectURL(await resp.blob());
    el('a', {href: url, download: name}).click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    done(`Downloaded ${name} to your browser's download folder.`, '');
  } catch (e) {
    status.textContent = '';
    showVerdict({ok: false, msg: 'The export failed: ' + e.message});
  } finally {
    setBusy(false);
  }

  function done(msg, path) {
    status.textContent = msg;
    showVerdict({ok: true, msg, path});
  }
}

// ------------------------------------------------------------ the devices

async function loadDevices() {
  if (state.status.adb.missing) return;
  renderDevices(true);
  $('#refresh').disabled = true;
  try {
    const {devices} = await api('devices');
    state.devices = devices;
  } catch (e) {
    showVerdict({ok: false, msg: 'Could not list devices: ' + e.message});
  } finally {
    $('#refresh').disabled = state.busy;
  }
  // Keep the chosen device; else the one chosen last time, when it is usable;
  // else the first usable one, so the actions and the export are on screen.
  if (!current()) {
    const last = state.devices.find(d => d.serial === state.status.lastDevice && usable(d));
    state.current = (last || state.devices.find(usable) || state.devices[0])?.serial || '';
  }
  renderDevices();
  renderDevice();
}

async function refreshCurrent() {
  const d = current();
  if (!d) return;
  const r = await api('device?serial=' + encodeURIComponent(d.serial)).catch(() => null);
  if (!r) return;
  if (r.gone) {
    showVerdict({ok: false, msg: `${d.serial} is no longer listed by adb.`});
    state.devices = state.devices.filter(x => x.serial !== d.serial);
    state.current = '';
  } else {
    state.devices = state.devices.map(x => (x.serial === d.serial ? r.device : x));
  }
  renderDevices();
  renderDevice();
}

function choose(serial) {
  if (state.follow) state.follow.abort();
  state.current = serial;
  $('#service-log').hidden = true;
  post('remember', {serial}).catch(() => {});
  renderDevices();
  renderDevice().then(() => $('#device').scrollIntoView({behavior: 'smooth', block: 'start'}));
}

// ------------------------------------------------------------------- start

async function downloadADB() {
  const btn = $('#adb-download');
  const out = $('#adb-log');
  btn.disabled = true;
  out.hidden = false;
  out.textContent = '';
  const v = await readStream(await post('adb/download', {}), line => out.append(line + '\n'));
  out.append('\n' + v.msg + '\n');
  btn.disabled = false;
  if (v.ok) {
    state.status = await api('status');
    renderStatus();
    loadDevices();
  }
}

// kill-server + start-server, for devices adb should list but does not.
async function restartADB() {
  if (state.busy) return;
  if (!confirm('Restart adb?\n\nAndroid Studio, scrcpy or your emulator manager lose their device for a moment, and reconnect by themselves. A live service log stops.')) return;
  if (state.follow) state.follow.abort();
  setBusy(true);
  startActivity('Restart adb');
  try {
    showVerdict(await readStream(await post('adb/restart', {}), logLine));
  } catch (e) {
    showVerdict({ok: false, msg: e.message});
  } finally {
    setBusy(false);
  }
  state.devices = [];
  await loadDevices();
}

async function setChannel(url) {
  const r = await post('channel', {url});
  const j = await r.json();
  if (!r.ok) {
    showVerdict({ok: false, msg: j.message});
    return;
  }
  state.status.channel = j.channel;
  renderStatus();
  showVerdict({ok: true, msg: j.channel ? `Pre-release channel set: ${j.channel}` : 'Back to the published releases.'});
}

// ------------------------------------------------------------------ updates

function renderUpdate() {
  const u = state.update;
  if (!u) return;
  const ready = u.available && !u.disabled;
  $('#update-banner').hidden = !ready;
  $('#update-banner-text').textContent = ready ? `tsum-stats ${u.latest} is out; this is ${u.current}.` : '';
  $$('[data-update-apply]').forEach(b => { b.hidden = !ready; });
  $('#update-check').hidden = u.disabled;
  $('#update-line').textContent =
    u.disabled ? `tsum-stats ${u.current}, a local build: it does not update itself.`
    : u.installed ? `tsum-stats ${u.latest} is installed. Close this window's terminal and start the starter again to use it.`
    : ready ? `tsum-stats ${u.current}. Version ${u.latest} is available.`
    : u.latest ? `tsum-stats ${u.current}, the newest version.`
    : `tsum-stats ${u.current}.`;
  $('#update-checked').textContent = u.error ? `Could not check: ${u.error}`
    : u.checked ? `Last checked ${new Date(u.checked).toLocaleString()}.` : '';
}

async function loadUpdate() {
  try {
    state.update = await api('update');
    renderUpdate();
  } catch { /* the page still works without it */ }
}

async function checkUpdate() {
  const btn = $('#update-check');
  btn.disabled = true;
  btn.textContent = 'Checking …';
  try {
    const r = await post('update/check', {});
    if (r.ok) state.update = await r.json();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check for updates';
    renderUpdate();
  }
}

async function applyUpdate() {
  const u = state.update;
  if (state.busy || !u?.available) return;
  if (!confirm(`Update tsum-stats to ${u.latest}?\n\n${u.canRestart
    ? 'The starter restarts, and this page and Stats reload in a few seconds.'
    : 'You restart the starter yourself afterwards.'}`)) return;
  if (state.follow) state.follow.abort();
  setBusy(true);
  const out = $('#update-log');
  out.hidden = false;
  out.textContent = '';
  $('#updates').scrollIntoView({behavior: 'smooth', block: 'nearest'});
  let v;
  try {
    v = await readStream(await post('update/apply', {}), line => out.append(line + '\n'));
  } catch (e) {
    v = {ok: false, msg: e.message};
  }
  out.append('\n' + v.msg + '\n');
  if (v.restart) {
    await waitForRestart(u.current, out);
    return;
  }
  setBusy(false);
  await loadUpdate();
}

// Polls until the new version answers, then reloads.
async function waitForRestart(old, out) {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      if ((await api('status')).version !== old) {
        location.reload();
        return;
      }
    } catch { /* down between the two */ }
  }
  out.append('The starter has not come back. Look at its terminal window for what went wrong.\n');
}

function wire() {
  $('#refresh').addEventListener('click', loadDevices);
  $('#adb-restart').addEventListener('click', restartADB);
  $('#adb-download').addEventListener('click', downloadADB);
  $('#follow-btn').addEventListener('click', toggleFollow);
  $('#export-btn').addEventListener('click', exportZip);
  $('#clear-log').addEventListener('click', () => { $('#console').textContent = ''; $('#verdict').hidden = true; });
  $('#open-collected').addEventListener('click', () => {
    const d = current();
    post('reveal', {path: d ? state.status.collected + sep() + d.serial.replace(/[^A-Za-z0-9._-]/g, '_') : state.status.collected});
  });
  $('#verdict-open').addEventListener('click', e => post('reveal', {path: e.currentTarget.dataset.path}));
  $('#channel-form').addEventListener('submit', e => { e.preventDefault(); setChannel($('#channel-url').value.trim()); });
  $('#channel-off').addEventListener('click', () => setChannel('off'));
  $('#update-check').addEventListener('click', checkUpdate);
  $$('[data-update-apply]').forEach(b => b.addEventListener('click', applyUpdate));
  for (const b of $$('[data-action]')) {
    b.addEventListener('click', () => {
      const action = b.dataset.action;
      runAction(action, action === 'install' ? {apk: $('#apk-select').value} : {});
    });
  }
  for (const b of $$('[data-delete]')) b.addEventListener('click', () => confirmDelete(b.dataset.delete));
}

// The bundle path's own separator, so a Windows path stays one.
const sep = () => (state.status.bundle.includes('\\') ? '\\' : '/');

async function init() {
  wire();
  try {
    state.status = await api('status');
  } catch (e) {
    $('#device-list').replaceChildren(el('p', {class: 'muted'}, 'The starter is not answering: ' + e.message));
    return;
  }
  renderStatus();
  loadDevices();
  loadUpdate();
  setInterval(loadUpdate, 10 * 60 * 1000);
}

init();
