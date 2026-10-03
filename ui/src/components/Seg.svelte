<!-- A segmented toggle. options: [[value, label, icon?, name?], ...]; icon ('coin') is drawn after the label,
     alone when the label is empty (then name says what it is); the pressed one is value. -->
<script>
  let {options, value, onpick, label, sm = false, hidden = false} = $props();
</script>

<div class="seg" class:sm role="group" aria-label={label} {hidden}>
  {#each options as [v, text, icon, name] (v)}
    <button type="button" aria-pressed={String(v === value)} aria-label={name} title={name} onclick={() => onpick(v)}>{text}{#if icon}<img class="seg-icon" src="img/{icon}.png" alt={text ? icon : ''}>{/if}</button>
  {/each}
</div>
