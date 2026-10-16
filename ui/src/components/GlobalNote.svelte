<!-- The global site's footnote, above the build line: when its figures were
     last worked out and how many players they come from. -->
<script>
  import {onMount} from 'svelte';
  import {api, fmt} from '../lib/util.js';

  let status = $state.raw(null);
  onMount(async () => { status = await api('status').catch(() => null); });

  const when = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC'});
</script>

<p class="global-note" title="Rounds from every player who sends them in through tsum-stats, worked out again every hour; contributors are those who sent rounds in the last 30 days. A round counts on the UTC day it began.">
  {#if status}Global · updated {when.format(new Date(status.generatedAt))} UTC · {fmt(status.contributors)} {status.contributors === 1 ? 'contributor' : 'contributors'} · {fmt(status.rounds)} {status.rounds === 1 ? 'round' : 'rounds'}{:else}Global stats{/if}
</p>
