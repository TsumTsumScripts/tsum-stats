<!-- Skill progress: what the player actually opened, from one device's Tsum
     lists over time (queries.go: TsumListHistory). Between one list and the
     next, the boxes each Tsum moved through (lib/boxes.js: its boxes left
     before, less after) and what they cost, the Tsums that went up a skill
     level, and over all the lists the coins a day that went on boxes, beside
     what Cost to max says the rounds earn. Only Tsums in both lists count:
     a list that missed Tsums (an export cut short) does not read as boxes
     opened, and a Tsum new in a list is counted apart, as getting it. Progress
     within a level counts only when both lists keep it (older lists do not). -->
<script>
  import Panel from '../../components/Panel.svelte';
  import {BOX_PRICE, toMax} from '../../lib/boxes.js';
  import {shared} from '../../lib/ui.svelte.js';
  import {api, fmt, tsumName} from '../../lib/util.js';

  let {build, device} = $props();
  const catalog = shared.catalog;

  let history = $state.raw([]);
  $effect(() => {
    const b = build, d = device;
    api('owned-history', {build: b, device: d}).then(h => { if (b === build && d === device) history = h; }, () => { history = []; });
  });

  /** A list's stamp (the device's local time, YYYYMMDD-HHMMSS) as a Date. */
  const when = s => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}`);
  const dateFmt = new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
  const span = ms => (ms < 36e5 ? `${fmt(Math.max(1, ms / 6e4))} min` : ms < 48 * 36e5 ? `${fmt(ms / 36e5)} h` : `${fmt(ms / 864e5)} days`);

  const steps = $derived.by(() => {
    const out = [];
    for (let i = 1; i < history.length; i++) {
      const before = new Map(history[i - 1].items.map(t => [t.tsum, t])), after = history[i].items;
      const step = {stamp: history[i].stamp, ms: when(history[i].stamp) - when(history[i - 1].stamp), boxes: 0, coins: 0, medals: 0, ups: [], got: 0};
      for (const t of after) {
        const entry = catalog.byId.get(t.tsum);
        const was = before.get(t.tsum);
        if (!was) { step.got++; continue; }
        // A list from before skill progress was kept has none: progress within a level then counts on neither side.
        const sure = was.skillProgress != null && t.skillProgress != null;
        const left0 = toMax(entry, sure ? was : {...was, skillProgress: null}), left1 = toMax(entry, sure ? t : {...t, skillProgress: null});
        if (!left0 || !left1) continue;
        const opened = left0.boxes - left1.boxes;
        if (opened <= 0) continue;
        step.boxes += opened;
        step[left1.unit] += opened * BOX_PRICE[left1.unit];
        if ((t.skill ?? 0) > (was.skill ?? 0)) step.ups.push(`${tsumName(catalog, t.tsum)} ${was.skill}→${t.skill}`);
      }
      out.push(step);
    }
    return out;
  });
  const total = $derived.by(() => {
    if (history.length < 2) return null;
    const days = (when(history.at(-1).stamp) - when(history[0].stamp)) / 864e5;
    const sum = k => steps.reduce((n, s) => n + s[k], 0);
    return {days, boxes: sum('boxes'), coins: sum('coins'), medals: sum('medals')};
  });
</script>

{#if steps.length}
  <Panel title="Skill progress" sub="from this device's Tsum lists over time: the boxes opened between one list and the next · only Tsums in both lists count, so a list cut short does not read as boxes opened">
    {#if total && total.days >= 1}
      <p class="sub">Over {fmt(total.days)} days: {fmt(total.boxes)} boxes, {fmt(total.coins / total.days)} coins{total.medals ? ` and ${fmt(total.medals / total.days)} medals` : ''} a day on boxes. Cost to max above says what your rounds earn a day.</p>
    {/if}
    <div class="table-wrap">
      <table class="breakdown">
        <thead>
          <tr>
            <th>List</th>
            <th class="num" title="Since the list before it">After</th>
            <th class="num">Boxes opened</th>
            <th class="num">Coins</th>
            <th class="num">Medals</th>
            <th class="num" title="Tsums in this list and not the one before">New Tsums</th>
            <th>Skill-ups</th>
          </tr>
        </thead>
        <tbody>
          {#each [...steps].reverse() as s (s.stamp)}
            <tr>
              <td>{dateFmt.format(when(s.stamp))}</td>
              <td class="num dim">{span(s.ms)}</td>
              <td class="num">{fmt(s.boxes)}</td>
              <td class="num coin">{s.coins ? fmt(s.coins) : ''}</td>
              <td class="num medal">{s.medals ? fmt(s.medals) : ''}</td>
              <td class="num dim">{s.got || ''}</td>
              <td class="dim">{s.ups.join(' · ')}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Panel>
{/if}
