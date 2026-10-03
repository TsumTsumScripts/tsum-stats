<!-- A Tsum's art, with its initials underneath for when the image is missing. -->
<script>
  import {IMAGE_URL, initials} from '../lib/util.js';

  let {id, name, large = false} = $props();
  let failed = $state('');
</script>

<span class={large ? 'avatar lg' : 'avatar'} title={name}>
  {initials(name)}
  {#if failed !== id}
    <img loading="lazy" decoding="async" alt="" src={IMAGE_URL(id)} onerror={() => (failed = id)}>
  {/if}
</span>
