<!-- The shell: hash routing between the sections, the top bar, live updates,
     and importing CSV files by picker, drop or rescan. A snapshot and the
     global site are read-only, so they have only the routing and the top bar. -->
<script>
  import {onMount} from 'svelte';
  import ContributeDialog from './components/ContributeDialog.svelte';
  import DataDialog from './components/DataDialog.svelte';
  import Dropdown from './components/Dropdown.svelte';
  import GlobalNote from './components/GlobalNote.svelte';
  import LivePills from './components/LivePills.svelte';
  import PublishDialog from './components/PublishDialog.svelte';
  import ThemePicker from './components/ThemePicker.svelte';
  import SnapshotNote from './components/SnapshotNote.svelte';
  import Tip from './components/Tip.svelte';
  import Toasts from './components/Toasts.svelte';
  import {isGlobal} from './lib/global/client.js';
  import {onReconnect, restart, start, subscribe} from './lib/realtime.js';
  import {isSnapshot} from './lib/snapshot/client.js';
  import {expand, shared, toast} from './lib/ui.svelte.js';
  import {api, fmt, isOnline, loadCatalog} from './lib/util.js';
  import Catalog from './sections/Catalog.svelte';
  import Help from './sections/Help.svelte';
  import Stats from './sections/Stats.svelte';
  import Tsum from './sections/Tsum.svelte';

  // A published snapshot is read-only: nothing to set up, so no Help, Data or live devices.
  // The global site is too; its Tsum page is answered from the cells and their bins.
  const snapshot = isSnapshot();
  const globalSite = isGlobal();
  const readOnly = snapshot || globalSite;
  const ROUTES = [['stats', 'Stats'], ['tsum', 'Tsum'], ['catalog', 'Catalog'], ['help', 'Help']]
    .filter(([r]) => !(readOnly && r === 'help'));
  // The commit the site was built from (vite.config.js: siteBuild), for the footer.
  const build = __SITE_BUILD__;
  const buildText = `Site ${build.date} UTC${build.commit ? ` · ${build.commit}` : ''}${build.changed ? ' · with local changes' : ''}`;
  const buildTitle = build.commit
    ? `The site's code is from commit ${build.commit}, made ${build.date} UTC${build.changed ? ', with changes not yet committed' : ''}`
    : `The site's code was built ${build.date} UTC`;
  // The Tsum Tsum website, which the global site is part of.
  const WEBSITE = 'https://tsumtsum.gapscripts.app';
  // The website's page about tsum-stats, which says how to contribute.
  const CONTRIBUTE = 'https://tsumtsum.gapscripts.app/stats-site';

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
  let stats = $state(), tsum = $state(), catalog = $state(), help = $state();
  let dataDialog = $state(), publishDialog = $state(), contributeDialog = $state(), moreMenu = $state();
  const sectionOf = r => ({stats, tsum, catalog, help})[r];

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
    if (readOnly) return;
    const csv = [...files].filter(f => f.name.endsWith('.csv'));
    if (!csv.length) return toast('Only .csv files can be imported');
    const body = new FormData();
    for (const f of csv) body.append('files', f);
    const res = await fetch('/api/stats/import', {method: 'POST', body}).then(r => r.json());
    if (res.errors?.length) toast(res.errors.join('; '), 6000);
  }

  let dragDepth = 0;
  let dragging = $state(false);
  const hasFiles = e => !readOnly && e.dataTransfer?.types.includes('Files');
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
  subscribe('ts/global', s => contributeDialog?.update(s));
  subscribe('ts/rounds', r => { stats?.roundArrived(r); tsum?.refresh(); });
  subscribe('ts/imports', res => {
    if (res.rounds) { stats?.refresh(); tsum?.refresh(); catalog?.roundsChanged(); }
    if (res.lists) catalog?.listsChanged();
    help?.refresh();
    toast(`Imported ${fmt(res.files)} file(s): ${fmt(res.rounds)} rounds, ${fmt(res.lists)} Tsum list(s)`);
  });
  onReconnect(async () => {
    shared.devices = await api('devices');
    stats?.refresh();
    tsum?.refresh();
    publishDialog?.update(await api('publish'));
    contributeDialog?.update(await api('global'));
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
    if (readOnly) return;
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
      <div class="brand"><div class="brand-badge">TT</div><h1>Tsum Tsum Stats</h1>{#if globalSite}<span class="brand-version" title="Every contributing player's rounds together">Global</span>{:else if version}<span class="brand-version" title="Version">v{version}</span>{/if}</div>
      <nav class="seg" aria-label="Sections">
        {#each ROUTES as [r, label] (r)}
          <button type="button" aria-pressed={String(r === route)} onclick={() => { location.hash = lastHash[r] || `#/${r}`; }}>{label}</button>
        {/each}
      </nav>
      <div class="spacer"></div>
      {#if snapshot}<SnapshotNote />{:else}<LivePills />{/if}
      {#if readOnly}
        <ThemePicker />
        {#if globalSite}
          <a class="btn" id="contribute-link" href={CONTRIBUTE} title="How to add your rounds from tsum-stats">Contribute</a>
          <a class="btn" id="site-btn" href={WEBSITE} title="The Tsum Tsum script's website">Website</a>
        {/if}
      {:else}
        <div class="topbar-actions">
          <button type="button" class="btn" id="contribute-btn" title="Add your rounds to the global stats" onclick={() => contributeDialog.open()}>Contribute</button>
          <button type="button" class="btn" id="data-btn" onclick={() => dataDialog.open()}>Data</button>
          <!-- What is used now and then. -->
          <Dropdown bind:this={moreMenu} id="more-btn" title="Share, theme{starter ? ', service starter' : ''}">
            {#snippet label()}<span aria-label="More">⋯</span>{/snippet}
            <button type="button" class="btn" id="share-btn" onclick={() => { moreMenu.close(); publishDialog.open(); }}>Share a snapshot</button>
            {#if starter}<a class="btn" id="starter-btn" href="/starter/">Service starter</a>{/if}
            <ThemePicker />
          </Dropdown>
        </div>
      {/if}
    </header>

    {#if initial.stats}
      <Stats bind:this={stats} hidden={route !== 'stats'} initial={initial.stats} onStateChange={(s, o) => writeHash('stats', s, o)} />
    {/if}
    {#if initial.tsum}
      <Tsum bind:this={tsum} hidden={route !== 'tsum'} initial={initial.tsum} onStateChange={(s, o) => writeHash('tsum', s, o)} />
    {/if}
    {#if initial.catalog}
      <Catalog bind:this={catalog} hidden={route !== 'catalog'} initial={initial.catalog} onStateChange={s => writeHash('catalog', s)} />
    {/if}
    {#if initial.help}
      <Help bind:this={help} hidden={route !== 'help'} initial={initial.help} />
    {/if}
    <!-- When the site's code was last changed, out of the way at the foot of every page. -->
    {#if globalSite}<GlobalNote />{/if}
    <footer class="site-foot" title={buildTitle}>{buildText}</footer>
  </div>
  {#if !readOnly}
    <DataDialog bind:this={dataDialog} {upload} {overrideText} />
    <PublishDialog bind:this={publishDialog} />
    <ContributeDialog bind:this={contributeDialog} />
  {/if}
{/if}

<div class="drop-hint">Drop CSV files to import</div>
{#if expand.open}<div class="chart-backdrop" role="presentation" onclick={() => (expand.open = null)}></div>{/if}
<Tip />
<Toasts />
