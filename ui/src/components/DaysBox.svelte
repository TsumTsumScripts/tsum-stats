<!-- "Last [14] days": any number of days up to today, beside the usual time ranges on the Stats rail
     and the Tsum page. days is the range as the filter keeps it ('14', 'all', ''); onpick(days) gets a
     whole number of days (util.js: cleanDays) a moment after typing stops, at once on Enter or on
     leaving the box. What is not a number of days is dropped, and leaving shows the range again.
     Entering the box selects what it shows, so typing replaces it. -->
<script>
  import {MAX_DAYS, cleanDays} from '../lib/util.js';

  let {days, onpick, sm = false} = $props();
  const shown = () => (Number(days) ? days : '');
  let timer;
  function typed(v, now = false) {
    clearTimeout(timer);
    const n = cleanDays(v.trim(), '');
    if (!Number(n)) return;
    if (now) onpick(n);
    else timer = setTimeout(() => onpick(n), 400);
  }
</script>

<label class="days-box" class:sm title="Rounds of the last so many days, today included">Last
  <input type="number" min="1" max={MAX_DAYS} step="1" inputmode="numeric" placeholder="N" aria-label="Number of days up to today"
    value={shown()} onfocus={e => e.target.select()} oninput={e => typed(e.target.value)}
    onkeydown={e => { if (e.key === 'Enter') typed(e.target.value, true); }}
    onchange={e => { typed(e.target.value, true); e.target.value = shown(); }}>
  {days === '1' ? 'day' : 'days'}</label>
