<!-- The top bar's live devices: one chip summing them up, which opens a list
     saying what each is doing. -->
<script>
  import {onMount} from 'svelte';
  import {shared} from '../lib/ui.svelte.js';
  import {isOnline, tsumName} from '../lib/util.js';
  import Dropdown from './Dropdown.svelte';

  // A device goes Offline once it has not been heard from for a while, so look again now and then.
  let now = $state(Date.now());
  onMount(() => {
    const t = setInterval(() => (now = Date.now()), 15000);
    return () => clearInterval(t);
  });

  const seen = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'});

  const pills = $derived.by(() => {
    now;
    return shared.devices.map(d => {
      const online = isOnline(d);
      const r = d.round;
      let status = 'Idle';
      if (!online) status = 'Offline';
      else if (r) status = `${r.tally ? 'Tallying' : 'Round'} ${r.round} · ${r.tsum ? tsumName(shared.catalog, r.tsum, r.build) : '?'}`;
      else if (d.paused) status = 'Paused';
      else if (d.active) status = 'Running';
      const lastSeen = !online && d.lastSeen ? `last seen ${seen.format(new Date(d.lastSeen))}` : '';
      return {device: d.device, online, playing: online && Boolean(r), status,
        detail: [d.script, lastSeen].filter(Boolean).join(' · ')};
    });
  });
  const online = $derived(pills.filter(p => p.online).length);
  const playing = $derived(pills.filter(p => p.playing).length);
  // One device says what it is doing; several are counted.
  const summary = $derived(pills.length === 1 ? `${pills[0].device} · ${pills[0].status}`
    : `${online}/${pills.length} online${playing ? ` · ${playing} playing` : ''}`);
</script>

<div class="live" aria-live="polite">
  {#if pills.length}
    <Dropdown btnClass="pill live-chip{online ? ' online' : ''}{playing ? ' playing' : ''}" title="Devices sending script events">
      {#snippet label()}<span class="dot"></span><span class="live-text">{summary}</span><span class="caret" aria-hidden="true">▾</span>{/snippet}
      <ul class="device-list">
        {#each pills as p (p.device)}
          <li class:online={p.online} class:playing={p.playing}>
            <span class="dot"></span>
            <span><b>{p.device}</b> {p.status}{#if p.detail}<br><span class="sub">{p.detail}</span>{/if}</span>
          </li>
        {/each}
      </ul>
      <a class="sub" href="#/help?topic=live">How devices connect →</a>
    </Dropdown>
  {:else}
    <a class="pill" href="#/help?topic=live" title="Devices appear here once the app sends script events to this server. Click for how.">
      <span class="dot"></span>No devices
    </a>
  {/if}
</div>
