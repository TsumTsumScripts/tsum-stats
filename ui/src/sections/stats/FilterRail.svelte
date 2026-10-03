<!-- The Stats rail: filters and the jump menu. Narrow, it is a bar under the
     top bar whose filters drop down; wide, a sticky side column. -->
<script>
  import Seg from '../../components/Seg.svelte';
  import TsumChip from '../../components/TsumChip.svelte';
  import {debounce, fmt} from '../../lib/util.js';

  let {
    filter, range, outliers, chips, picked, played, playedDevices, pickedDevices, comparing,
    set, reset, addTsum, dropTsum, matchTsum, nameOf, colorOf, open = $bindable(false),
  } = $props();

  const JUMPS = [
    ['s-overview', 'Overview'], ['s-compare', 'Head to head'], ['s-efficiency', 'Efficiency'], ['s-time', 'Over time'],
    ['s-share', 'Share'], ['s-when', 'Hours & items'], ['s-spread', 'Spread'], ['s-tsums', 'Tsum table'], ['s-rounds', 'Rounds'],
  ];
  const jumps = $derived(JUMPS.filter(([id]) => id !== 's-compare' || comparing));

  let rail, tsumBox, nav;
  let current = $state('');

  // The Tsums box adds each Tsum it matches to the picked ones.
  function pickTsum() {
    const id = matchTsum(tsumBox.value);
    if (!id) return;
    tsumBox.value = '';
    addTsum(id);
  }
  const pickSoon = debounce(pickTsum, 250);

  // Editing a date turns the rolling range into fixed dates; clearing both is all time.
  function dates(from, to) {
    set(from || to ? {days: '', from, to} : {days: 'all', from: '', to: ''});
  }
  // Ticking devices narrows the stats to them; none ticked is every device.
  const toggleDevice = (d, on) => set({device: (on ? [...pickedDevices, d] : pickedDevices.filter(x => x !== d)).join(',')});
  // One debounced setter per outlier bound, so typing in two boxes keeps both.
  const setters = {};
  const setBound = k => (setters[k] ??= debounce(v => set({[k]: v}), 350));
  const boundsSet = $derived(outliers.reduce((n, [, , lo, hi]) => n + (filter[lo] !== '' || filter[hi] !== '' ? 1 : 0), 0));
  const clearOutliers = () => set(Object.fromEntries(outliers.flatMap(([, , lo, hi]) => [[lo, ''], [hi, '']])));

  function jump(id) {
    open = false;
    document.getElementById(id)?.scrollIntoView({behavior: 'smooth', block: 'start'});
  }

  // The jump menu marks the section in view.
  $effect(() => {
    const ids = jumps.map(([id]) => id);
    const seen = new Map();
    const io = new IntersectionObserver(entries => {
      for (const e of entries) seen.set(e.target.id, e.isIntersecting);
      current = ids.find(id => seen.get(id)) || '';
    }, {rootMargin: '-35% 0px -60% 0px'});
    for (const id of ids) {
      const node = document.getElementById(id);
      if (node) io.observe(node);
    }
    return () => io.disconnect();
  });
  // Narrow, the jump menu scrolls sideways: keep the marked one on screen.
  $effect(() => {
    if (current) nav?.querySelector('[aria-current="true"]')?.scrollIntoView({block: 'nearest', inline: 'nearest'});
  });

  // --rail-h: the rail's height while it is a bar across the top, for sticky offsets below it.
  let railH = $state(0);
  let wide = $state(false);
  $effect(() => {
    const mq = matchMedia('(min-width: 1180px)');
    const update = () => { wide = mq.matches; };
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  });
  $effect(() => {
    document.documentElement.style.setProperty('--rail-h', wide ? '0px' : `${railH}px`);
  });
</script>

<svelte:document
  onclick={e => { if (rail && !rail.contains(e.target)) open = false; }}
  onkeydown={e => { if (e.key === 'Escape') open = false; }} />

<aside class="rail" class:open aria-label="Filters and sections" bind:this={rail} bind:offsetHeight={railH}>
  <div class="panel rail-panel">
    <div class="rail-head">
      <button type="button" class="btn rail-toggle" aria-expanded={String(open)} aria-controls="rail-body" onclick={() => (open = !open)}>Filters</button>
      <div class="chips">
        {#each chips as c (c.label)}
          <button type="button" class="chip" title="Remove this filter" onclick={c.clear}>{c.label}<span aria-hidden="true">×</span></button>
        {:else}
          <span class="sub">All rounds</span>
        {/each}
      </div>
    </div>
    <div class="rail-body" id="rail-body">
      <div class="filters">
        <div class="field span-all">
          <label for="f-tsum" title="Pick one Tsum to focus on it, or several to compare them head to head">Tsums</label>
          <input id="f-tsum" list="tsum-options" placeholder="All Tsums · type to add" autocomplete="off"
            bind:this={tsumBox} onchange={pickTsum} oninput={pickSoon}>
          <datalist id="tsum-options">
            {#each played as t (t.tsum)}<option value={nameOf(t.tsum)}>{fmt(t.rounds)} rounds</option>{/each}
          </datalist>
          {#if picked.length}
            <div class="picked">
              {#each picked as id (id)}<TsumChip {id} name={nameOf(id)} color={colorOf(id)} onremove={() => dropTsum(id)} />{/each}
            </div>
          {/if}
        </div>
        {#if playedDevices.length}
          <div class="field devices-field" title="Tick one or more devices to count only their rounds">Devices
            <details class="devices">
              <summary>{pickedDevices.length ? `${pickedDevices.length} selected` : 'All devices'}</summary>
              <div class="device-list">
                {#each playedDevices as d (d.device)}
                  <label title={d.device}><input type="checkbox" checked={pickedDevices.includes(d.device)}
                    onchange={e => toggleDevice(d.device, e.target.checked)}><span class="device-name">{d.device}</span><span class="sub">{fmt(d.rounds)}</span></label>
                {/each}
              </div>
            </details>
          </div>
        {/if}
        <label class="field">From <input type="date" value={range.from} onchange={e => dates(e.target.value, range.to)}></label>
        <label class="field">To <input type="date" value={range.to} onchange={e => dates(range.from, e.target.value)}></label>
        <div class="field outliers" title="Leave out rounds whose score, coins or medals fall outside these ranges">Outliers
          <details class="devices">
            <summary>{boundsSet ? `${boundsSet} ${boundsSet > 1 ? 'ranges' : 'range'} set` : 'None omitted'}{filter.incomplete ? ' · incomplete kept' : ''}</summary>
            <div class="outlier-grid">
              <span></span><span class="sub">Lowest</span><span class="sub">Highest</span>
              {#each outliers as [stat, label, lo, hi, step] (stat)}
                <span>{label}</span>
                {#each [lo, hi] as k (k)}
                  <input type="number" min="0" {step} inputmode="numeric" placeholder="Any" aria-label="{k.startsWith('min') ? 'Lowest' : 'Highest'} {stat}"
                    value={filter[k]} oninput={e => setBound(k)(e.target.value)}>
                {/each}
              {/each}
            </div>
            <p class="sub outlier-note">Rounds outside a range are left out. Coins are {filter.coins === 'final' ? 'final' : 'base'} coins;
              the medal range only judges Tsums that earn medals.</p>
            <label class="outlier-check"><input type="checkbox" checked={filter.incomplete === '1'}
              onchange={e => set({incomplete: e.target.checked ? '1' : ''})}> Include incomplete rounds</label>
            <p class="sub outlier-note">Incomplete rounds have no Tsum, or a score, coins, time or (for a Tsum that earns medals) medals that could not be read.</p>
            {#if boundsSet}<button type="button" class="btn" onclick={clearOutliers}>Clear ranges</button>{/if}
          </details>
        </div>
        <!-- The two toggles share a row when there is room and stack when not. -->
        <div class="seg-fields span-all">
          <div class="field">Game
            <Seg label="Game build" value={filter.build} onpick={v => set({build: v})} options={[['', 'All'], ['global', 'INTL'], ['jp', 'JP']]} />
          </div>
          <div class="field" title="Base coins are before the coin bonus; final coins are what the round paid; medals counts only rounds that earned medals">Primary stat
            <Seg label="Primary stat" value={filter.coins} onpick={v => set({coins: v})}
              options={[['', 'Base', 'coin'], ['final', 'Final', 'coin'], ['medals', '', 'medal', 'Medals']]} />
          </div>
        </div>
      </div>
      <div class="filter-actions">
        {#each [['7', '7 days'], ['30', '30 days'], ['all', 'All time']] as [days, label] (days)}
          <button type="button" class="btn" aria-pressed={String(filter.days === days)} onclick={() => set({days, from: '', to: ''})}>{label}</button>
        {/each}
        <button type="button" class="btn" onclick={reset}>Reset</button>
      </div>
    </div>
    <nav class="jump" aria-label="Stats sections" bind:this={nav}>
      {#each jumps as [id, label] (id)}
        <button type="button" aria-current={String(id === current)} onclick={() => jump(id)}>{label}</button>
      {/each}
    </nav>
  </div>
</aside>
