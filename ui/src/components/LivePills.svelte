<!-- The top bar's live devices: one pill each, saying what it is doing. -->
<script>
  import {onMount} from 'svelte';
  import {shared} from '../lib/ui.svelte.js';
  import {isOnline, tsumName} from '../lib/util.js';

  // A device goes Offline once it has not been heard from for a while, so look again now and then.
  let now = $state(Date.now());
  onMount(() => {
    const t = setInterval(() => (now = Date.now()), 15000);
    return () => clearInterval(t);
  });

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
      return {device: d.device, script: d.script || '', online, playing: online && Boolean(r), status};
    });
  });
</script>

<div class="live" aria-live="polite">
  {#each pills as p (p.device)}
    <span class="pill" class:online={p.online} class:playing={p.playing} title={p.script}><span class="dot"></span><b>{p.device}</b>{p.status}</span>
  {:else}
    <a class="pill" href="#/help?topic=live" title="Devices appear here once the app sends script events to this server. Click for how.">
      <span class="dot"></span>No devices
    </a>
  {/each}
</div>
