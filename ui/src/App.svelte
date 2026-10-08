<!-- The shell: hash routing between the sections, the top bar, live updates,
     and importing CSV files by picker, drop or rescan. -->
<script>
  import {onMount} from 'svelte';
  import DataDialog from './components/DataDialog.svelte';
  import LivePills from './components/LivePills.svelte';
  import PublishDialog from './components/PublishDialog.svelte';
  import ThemePicker from './components/ThemePicker.svelte';
  import SnapshotNote from './components/SnapshotNote.svelte';
  import Tip from './components/Tip.svelte';
  import Toasts from './components/Toasts.svelte';
  import {onReconnect, restart, start, subscribe} from './lib/realtime.js';
  import {isSnapshot} from './lib/snapshot/client.js';
  import {expand, shared, toast} from './lib/ui.svelte.js';
  import {api, fmt, isOnline, loadCatalog} from './lib/util.js';
  import Catalog from './sections/Catalog.svelte';
  import Help from './sections/Help.svelte';
  import Stats from './sections/Stats.svelte';

  // A published snapshot is read-only: nothing to set up, so no Help, Data or live devices.
  const snapshot = isSnapshot();
  const ROUTES = [['stats', 'Stats'], ['catalog', 'Catalog'], ['help', 'Help']].filter(([r]) => !(snapshot && r === 'help'));

  // "#/stats?tsum=mickey" → {route: 'stats', params: {tsum: 'mickey'}}
  function readHash() {
    const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
    return {route: ROUTES.some(([r]) => r === path) ? path : 'stats', params: Object.fromEntries(new URLSearchParams(query))};
  }

  // A section mounts the first time it is shown, with that link's params, and stays mounted.
  let route = $state('');
  let version = $state('');
  // Served beside the service starter (--starter): link back to it.
  let starter = $state(false);
  const initial = $state({});
  let stats = $state(), catalog = $state(), help = $state(), dataDialog = $state(), publishDialog = $state();
  const sectionOf = r => ({stats, catalog, help})[r];

  // Each section's latest link, so the top buttons return to it rather than to defaults.
  const lastHash = {};

  /** push adds a history entry (marked gapDrill) instead of replacing the current one. */
  function writeHash(r, state, {push = false} = {}) {
    const q = new URLSearchParams(Object.entries(state).filter(([k, v]) => v !== '' && v !== null && v !== undefined &&
      !(k === 'page' && Number(v) === 1) && !(k === 'perPage' && Number(v) === 50)));
    const hash = `#/${r}${q.size ? '?' + q : ''}`;
    lastHash[r] = hash;
    if (push) history.pushState({gapDrill: true}, '', hash);
    else history.replaceState(history.state, '', hash);
  }

  function show() {
    const {route: r, params} = readHash();
    route = r;
    if (!(r in initial)) initial[r] = params;
    else sectionOf(r)?.shown?.(params);
  }

  // ---- Importing ----

  async function upload(files) {
    if (snapshot) return;
    const csv = [...files].filter(f => f.name.endsWith('.csv'));
    if (!csv.length) return toast('Only .csv files can be imported');
    const body = new FormData();
    for (const f of csv) body.append('files', f);
    const res = await fetch('/api/stats/import', {method: 'POST', body}).then(r => r.json());
    if (res.errors?.length) toast(res.errors.join('; '), 6000);
  }

  let dragDepth = 0;
  let dragging = $state(false);
  const hasFiles = e => !snapshot && e.dataTransfer?.types.includes('Files');
  function onDrop(e) {
    e.preventDefault();
    dragDepth = 0;
    dragging = false;
    if (e.dataTransfer?.files.length) upload(e.dataTransfer.files);
  }

  // The --web-dir override: say so when it is being ignored.
  const overrideText = s => (s.override.active
    ? `Site files in ${s.override.dir} replace the built-in ones.`
    : `Site files in ${s.override.dir} are ignored: ${s.override.reason}.`);

  // ---- Page-wide classes and sticky offsets ----

  let topbarH = $state(0);
  $effect(() => { document.documentElement.style.setProperty('--topbar-h', `${topbarH}px`); });
  $effect(() => { document.body.classList.toggle('dragging', dragging); });
  $effect(() => { document.body.classList.toggle('chart-open', Boolean(expand.open)); });

  // ---- Live updates ----

  subscribe('ts/devices', d => { shared.devices = d; });
  subscribe('ts/publish', s => publishDialog?.update(s));
  subscribe('ts/rounds', r => stats?.roundArrived(r));
  subscribe('ts/imports', res => {
    if (res.rounds) stats?.refresh();
    if (res.lists) catalog?.listsChanged();
    help?.refresh();
    toast(`Imported ${fmt(res.files)} file(s): ${fmt(res.rounds)} rounds, ${fmt(res.lists)} Tsum list(s)`);
  });
  onReconnect(async () => {
    shared.devices = await api('devices');
    stats?.refresh();
    publishDialog?.update(await api('publish'));
  });

  // A stream can go quiet without an error (a PC waking from sleep, a frozen tab).
  // A device gone stale here but fresh on the server means pushes stopped: reconnect.
  async function checkDevices() {
    if (!shared.devices.some(d => d.online && !isOnline(d))) return;
    const fresh = await api('devices').catch(() => null);
    if (!fresh) return;
    shared.devices = fresh;
    if (fresh.some(isOnline)) restart();
  }

  onMount(async () => {
    shared.catalog = await loadCatalog();
    show();
    if (snapshot) return;
    start();
    shared.devices = await api('devices');
    // The shell is never unmounted, so these are not cleared.
    setInterval(checkDevices, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkDevices(); });
    fetch('/api/starter/status').then(r => { starter = r.ok; }).catch(() => {});
    api('status').then(s => { version = s.version || ''; if (s.override && !s.override.active && !s.override.unused) toast(overrideText(s), 8000); }).catch(() => {});
  });
</script>

<svelte:window
  onhashchange={show}
  ondragenter={e => { if (hasFiles(e)) { dragDepth++; dragging = true; } }}
  ondragleave={() => { if (--dragDepth <= 0) { dragDepth = 0; dragging = false; } }}
  ondragover={e => e.preventDefault()}
  ondrop={onDrop} />
<svelte:document onkeydown={e => { if (e.key === 'Escape') expand.open = null; }} />

{#if shared.catalog}
  <div class="page">
    <header class="topbar" bind:offsetHeight={topbarH}>
      <div class="brand"><div class="brand-badge">TT</div><h1>Tsum Tsum Stats</h1>{#if version}<span class="brand-version" title="Version">v{version}</span>{/if}</div>
      <nav class="seg" aria-label="Sections">
        {#each ROUTES as [r, label] (r)}
          <button type="button" aria-pressed={String(r === route)} onclick={() => { location.hash = lastHash[r] || `#/${r}`; }}>{label}</button>
        {/each}
      </nav>
      <div class="spacer"></div>
      {#if snapshot}<SnapshotNote />{:else}<LivePills />{/if}
      <ThemePicker />
      {#if !snapshot}
        {#if starter}<a class="btn" id="starter-btn" href="/starter/">Starter</a>{/if}
        <button type="button" class="btn" id="share-btn" onclick={() => publishDialog.open()}>Share</button>
        <button type="button" class="btn" id="data-btn" onclick={() => dataDialog.open()}>Data</button>
      {/if}
    </header>

    {#if initial.stats}
      <Stats bind:this={stats} hidden={route !== 'stats'} initial={initial.stats} onStateChange={(s, o) => writeHash('stats', s, o)} />
    {/if}
    {#if initial.catalog}
      <Catalog bind:this={catalog} hidden={route !== 'catalog'} initial={initial.catalog} onStateChange={s => writeHash('catalog', s)} />
    {/if}
    {#if initial.help}
      <Help bind:this={help} hidden={route !== 'help'} initial={initial.help} />
    {/if}
  </div>
  {#if !snapshot}
    <DataDialog bind:this={dataDialog} {upload} {overrideText} />
    <PublishDialog bind:this={publishDialog} />
  {/if}
{/if}

<div class="drop-hint">Drop CSV files to import</div>
{#if expand.open}<div class="chart-backdrop" role="presentation" onclick={() => (expand.open = null)}></div>{/if}
<Tip />
<Toasts />
