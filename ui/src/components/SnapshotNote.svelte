<!-- The top bar's note on a published snapshot: when it was taken, in place of the live devices. -->
<script>
  import {onMount} from 'svelte';
  import {api, fmt} from '../lib/util.js';

  let status = $state.raw(null);
  onMount(async () => { status = await api('status'); });

  const day = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium'});
</script>

<div class="live">
  <span class="pill" title="A copy of the player's stats taken at that time; it does not update by itself.">
    {#if status}Snapshot · {day.format(new Date(status.generatedAt))} · {fmt(status.rounds)} rounds{:else}Snapshot{/if}
  </span>
</div>
