// Builds the Tsum Tsum Stats site into ../web, which the tsum-stats binary embeds.
// `npm run dev` serves it with hot reload and sends /api to a running tsum-stats.
// `--mode global` builds the global site instead (global/CONTRACT.md §6): into
// ../global/site, tagged so api() reads data/global/; its dev server gets those
// files from global's `npm run dev` (wrangler dev on 127.0.0.1:8788).
import {execSync} from 'node:child_process';
import {defineConfig} from 'vite';
import {svelte} from '@sveltejs/vite-plugin-svelte';

/**
 * What the page says it was built from, in its footer: the date and time (UTC,
 * to the minute, as a day may see several) and short hash of the commit, and
 * whether the working tree had changes besides. Without git (a source
 * download), when it was built.
 */
function siteBuild() {
  const git = cmd => execSync(`git ${cmd}`, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: {...process.env, TZ: 'UTC'}}).trim();
  try {
    return {
      date: git("log -1 --format=%cd '--date=format-local:%Y-%m-%d %H:%M'"),
      commit: git('rev-parse --short HEAD'),
      changed: git('status --porcelain') !== '',
    };
  } catch {
    return {date: new Date().toISOString().slice(0, 16).replace('T', ' '), commit: '', changed: false};
  }
}

// The tag that makes the page the global site (lib/global/client.js: isGlobal),
// early in <head> so index.html's theme script sees it.
const globalSite = {
  name: 'tsum-global',
  transformIndexHtml: html => html
    .replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="tsum-global" content="1">')
    .replace('<title>Tsum Tsum Stats</title>', '<title>Tsum Tsum Global Stats</title>'),
};

export default defineConfig(({mode}) => {
  const global = mode === 'global';
  return {
    plugins: [svelte(), global && globalSite],
    // __LOCAL_ONLY__ is false in the global build, so code behind it (the devices chip,
    // importing, the dialogs, Help) is folded away there instead of shipped unused.
    define: {__SITE_BUILD__: JSON.stringify(siteBuild()), __LOCAL_ONLY__: JSON.stringify(!global)},
    base: './',
    build: {
      outDir: global ? '../global/site' : '../web',
      emptyOutDir: true,
      // Fixed names, so a --web-dir file can stand in for a built one.
      rollupOptions: {
        output: {entryFileNames: 'assets/app.js', chunkFileNames: 'assets/[name].js', assetFileNames: a => (a.names?.[0]?.endsWith('.css') ? 'assets/app.css' : 'assets/[name][extname]')},
      },
    },
    server: {
      proxy: global
        ? {'/data/global': {target: 'http://127.0.0.1:8788'}}
        : {'/api': {target: 'http://127.0.0.1:8090', ws: true}},
    },
  };
});
