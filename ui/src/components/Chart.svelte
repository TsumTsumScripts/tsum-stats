<!-- A d3 chart box. draw(box, ...args) fills it and returns legend items; it
     runs again when args, the box size, the unit or the theme change. -->
<script>
  import {untrack} from 'svelte';
  import {setUnit} from '../lib/charts.js';
  import {theme} from '../lib/ui.svelte.js';

  let {draw, args, unit = 'coins', size = '', legend = $bindable([])} = $props();
  let box;
  let w = $state(0), h = $state(0);

  $effect(() => {
    const a = args;
    theme.version;
    // A hidden or still-laying-out box is too small to draw in.
    if (!a || w < 120 || h < 80) return;
    untrack(() => {
      setUnit(unit);
      legend = draw(box, ...a) ?? [];
    });
  });
</script>

<div class="chart {size}" bind:this={box} bind:clientWidth={w} bind:clientHeight={h}></div>
