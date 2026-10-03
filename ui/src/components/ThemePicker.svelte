<!-- Picks a theme: the built-in look, or a themes/*.css file (built in, or added through --web-dir). -->
<script>
  import {onMount} from 'svelte';
  import {loadThemes, setTheme, theme} from '../lib/ui.svelte.js';

  onMount(loadThemes);
</script>

<label class="theme-pick" title="Themes are themes/*.css files; add your own with --web-dir">
  <span class="sub">Theme</span>
  <select value={theme.current} onchange={e => setTheme(e.target.value)}>
    <option value="">Tsum Night</option>
    {#each theme.list as t (t.file)}<option value={t.file}>{t.name}</option>{/each}
  </select>
</label>
