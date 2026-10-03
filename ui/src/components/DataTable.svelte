<!--
  A data table on TanStack Table's core. Two modes:
  - client: the table sorts, searches and pages the rows it is given;
  - manual (server): sorting and paging go to manual.onSort / manual.onPage, and
    the caller passes one page of rows, the total, and the page they are for.

  columns: TanStack column defs, plus
    header: string, or () → string for one that changes;
    cell(row) → text, or snippet: a snippet taking the row, for markup;
    meta: {num, cls, hidden, title, search, show() → false to drop the column for now}.
  key saves the column choices (and a client table's sort and page size) per browser.
-->
<script>
  import {createTable, getCoreRowModel, getFilteredRowModel, getPaginationRowModel, getSortedRowModel} from '@tanstack/table-core';
  import {untrack} from 'svelte';
  import {fmt, loadPref, savePref} from '../lib/util.js';

  let {
    columns, rows = [], key = '', search = '', pageSize = 0, pageSizes = [25, 50, 100], sorting = [],
    manual = null, total = 0, page = null, countLabel = null, rowClass = null, empty = null,
  } = $props();

  const PREF_KEY = 'tsum-stats.tables';
  const sortName = s => (s ? (s === 'desc' ? 'descending' : 'ascending') : null);
  const headerOf = c => (typeof c.columnDef.header === 'function' ? c.columnDef.header() : c.columnDef.header);
  // The table is set up once, from the props it mounts with.
  const setup = untrack(() => ({columns, key, manual, sorting, pageSize, pageSizes}));
  const isManual = Boolean(setup.manual);

  const table = createTable({
    columns: setup.columns, data: [], state: {}, onStateChange: () => {}, renderFallbackValue: null,
    enableSortingRemoval: false, enableMultiSort: false,
    manualSorting: isManual, manualPagination: isManual,
    getCoreRowModel: getCoreRowModel(),
    ...(isManual ? {} : {getSortedRowModel: getSortedRowModel(), getFilteredRowModel: getFilteredRowModel(), getPaginationRowModel: getPaginationRowModel()}),
    getColumnCanGlobalFilter: col => Boolean(col.columnDef.meta?.search),
    globalFilterFn: 'includesString',
    autoResetPageIndex: !isManual,
  });

  const saved = setup.key ? loadPref(PREF_KEY, {})[setup.key] || {} : {};
  // What the user chose; columns whose show() is false are dropped on top of it.
  let chosen = {...Object.fromEntries(setup.columns.filter(c => c.meta?.hidden).map(c => [c.id, false])), ...saved.columnVisibility};
  const effective = () => ({...chosen, ...Object.fromEntries(setup.columns.filter(c => c.meta?.show && !c.meta.show()).map(c => [c.id, false]))});
  let data = [];
  let count = 0;
  // TanStack's state for this table (sorting, paging, columns).
  let ts = {
    ...table.initialState,
    sorting: (!isManual && saved.sorting) || setup.sorting,
    pagination: {pageIndex: 0,
      pageSize: (!isManual && setup.pageSizes.includes(saved.pageSize) && saved.pageSize) || setup.pageSize || setup.pageSizes[0]},
    columnVisibility: effective(),
  };
  // Bumped whenever the table changes; the markup reads the table through it.
  let tick = $state(0);

  function save() {
    if (!setup.key) return;
    savePref(PREF_KEY, {...loadPref(PREF_KEY, {}), [setup.key]: {columnVisibility: chosen,
      ...(isManual ? {} : {sorting: ts.sorting, pageSize: ts.pagination.pageSize})}});
  }

  // The options are replaced whole: setOptions would otherwise keep stale data.
  function sync() {
    table.setOptions(o => ({
      ...o, data, state: ts,
      pageCount: isManual ? Math.max(1, Math.ceil(count / ts.pagination.pageSize)) : undefined,
      onStateChange: updater => {
        const before = ts;
        ts = typeof updater === 'function' ? updater(ts) : updater;
        if (before.columnVisibility !== ts.columnVisibility) chosen = {...chosen, ...ts.columnVisibility};
        if (before.columnVisibility !== ts.columnVisibility || before.sorting !== ts.sorting
          || before.pagination.pageSize !== ts.pagination.pageSize) save();
        sync();
        if (isManual && before.sorting !== ts.sorting) setup.manual.onSort?.(ts.sorting);
        else if (isManual && before.pagination !== ts.pagination) setup.manual.onPage?.(ts.pagination);
        else tick++;
      },
    }));
  }
  sync();

  // New rows; in manual mode also the total and the page and sort they are for.
  $effect(() => {
    const next = rows, n = total, p = page;
    untrack(() => {
      data = next;
      if (isManual) {
        count = n;
        ts = {...ts,
          sorting: p?.sorting ?? ts.sorting,
          pagination: {pageIndex: p?.pageIndex ?? ts.pagination.pageIndex, pageSize: p?.pageSize ?? ts.pagination.pageSize}};
      }
      // show() may have changed with the data (the primary stat did).
      ts = {...ts, columnVisibility: effective()};
      sync();
      tick++;
    });
  });

  // Plain snapshots: TanStack reuses its objects, so the markup would not see them change.
  const view = $derived.by(() => {
    tick;
    const n = isManual ? count : table.getFilteredRowModel().rows.length;
    const {pageIndex, pageSize: size} = ts.pagination;
    const pages = Math.max(1, Math.ceil(n / size));
    return {
      headers: table.getHeaderGroups().flatMap(g => g.headers).map(h => ({
        id: h.id, label: headerOf(h.column), sorted: sortName(h.column.getIsSorted()), meta: h.column.columnDef.meta || {},
        toggle: h.column.getCanSort() ? h.column.getToggleSortingHandler() : null,
      })),
      rows: table.getRowModel().rows.map(r => ({
        id: r.id, cls: rowClass?.(r.original) || null, original: r.original,
        cells: r.getVisibleCells().map(c => ({id: c.id, def: c.column.columnDef})),
      })),
      visible: table.getVisibleLeafColumns().length,
      hideable: table.getAllLeafColumns().filter(c => c.getCanHide() && c.columnDef.meta?.show?.() !== false)
        .map(c => ({id: c.id, label: headerOf(c), on: c.getIsVisible(), set: v => c.toggleVisibility(v)})),
      count: countLabel ? countLabel(n) : `${fmt(n)} rows`,
      pageInfo: n ? `${fmt(pageIndex * size + 1)}–${fmt(Math.min(n, (pageIndex + 1) * size))} of ${fmt(n)} · page ${fmt(pageIndex + 1)}/${fmt(pages)}` : '',
      size,
      canPrev: table.getCanPreviousPage(),
      canNext: table.getCanNextPage(),
    };
  });

  let menu;
  const cellClass = m => [m?.num ? 'num' : '', m?.cls || ''].join(' ').trim() || null;
</script>

<svelte:document onclick={e => { if (menu && !menu.contains(e.target)) menu.open = false; }} />

<!-- The pager sticks to the bottom of the window while the table is in view. -->
<div class="dt">
  <div class="table-tools">
    {#if search}
      <input class="search" type="search" placeholder={search} autocomplete="off" oninput={e => table.setGlobalFilter(e.target.value)}>
    {/if}
    <div class="spacer"></div>
    <span class="sub">{view.count}</span>
    <details class="col-menu" bind:this={menu}>
      <summary class="btn">Columns</summary>
      <div class="panel col-list">
        {#each view.hideable as c (c.id)}
          <label><input type="checkbox" checked={c.on} onchange={e => c.set(e.target.checked)}>{c.label}</label>
        {/each}
      </div>
    </details>
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          {#each view.headers as h (h.id)}
            <th class={h.meta.num ? 'num' : null} scope="col" aria-sort={h.sorted} title={h.meta.title}>
              {#if h.toggle}<button type="button" onclick={h.toggle}>{h.label}</button>{:else}{h.label}{/if}
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each view.rows as r (r.id)}
          <tr class={r.cls}>
            {#each r.cells as c (c.id)}
              <td class={cellClass(c.def.meta)}>
                {#if c.def.snippet}{@render c.def.snippet(r.original)}{:else}{c.def.cell(r.original)}{/if}
              </td>
            {/each}
          </tr>
        {:else}
          <tr><td colspan={view.visible} class="dim empty-row">{#if empty}{@render empty()}{:else}Nothing to show.{/if}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>

  <div class="pager">
    <span class="pager-nav">
      <button type="button" class="btn" title="First page" disabled={!view.canPrev} onclick={() => table.firstPage()}>«</button>
      <button type="button" class="btn" disabled={!view.canPrev} onclick={() => table.previousPage()}>‹ Prev</button>
    </span>
    <span class="pager-mid">
      <span class="sub">{view.pageInfo}</span>
      <select aria-label="Rows per page" value={view.size} onchange={e => table.setPageSize(Number(e.target.value))}>
        {#each pageSizes as n (n)}<option value={n}>{n} rows</option>{/each}
      </select>
    </span>
    <span class="pager-nav">
      <button type="button" class="btn" disabled={!view.canNext} onclick={() => table.nextPage()}>Next ›</button>
      <button type="button" class="btn" title="Last page" disabled={!view.canNext} onclick={() => table.lastPage()}>»</button>
    </span>
  </div>
</div>
