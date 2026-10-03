// Builds the Tsum Tsum Stats site into ../web, which the tsum-stats binary embeds.
// `npm run dev` serves it with hot reload and sends /api to a running tsum-stats.
import {defineConfig} from 'vite';
import {svelte} from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  base: './',
  build: {
    outDir: '../web',
    emptyOutDir: true,
    // Fixed names, so a --web-dir file can stand in for a built one.
    rollupOptions: {
      output: {entryFileNames: 'assets/app.js', chunkFileNames: 'assets/[name].js', assetFileNames: a => (a.names?.[0]?.endsWith('.css') ? 'assets/app.css' : 'assets/[name][extname]')},
    },
  },
  server: {
    proxy: {'/api': {target: 'http://127.0.0.1:8090', ws: true}},
  },
});
