// Builds the Tsum Tsum Stats site into ../web, which the tsum-stats binary embeds.
// `npm run dev` serves it with hot reload and sends /api to a running tsum-stats.
// `--mode global` builds the global site instead (global/CONTRACT.md §6): into
// ../global/site, tagged so api() reads data/global/; its dev server gets those
// files from a `wrangler dev` on :8787.
import {defineConfig} from 'vite';
import {svelte} from '@sveltejs/vite-plugin-svelte';

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
        ? {'/data/global': {target: 'http://127.0.0.1:8787'}}
        : {'/api': {target: 'http://127.0.0.1:8090', ws: true}},
    },
  };
});
