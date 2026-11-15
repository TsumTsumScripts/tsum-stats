// Runs the global engine off the page's thread, as ../snapshot/worker.js does
// for a snapshot, and keeps the parts it has loaded. A missing file's error
// carries its status, so the engine can tell a part replaced since the
// manifest was read from a failure.
import {createGlobalEngine} from './engine.js';

let engine;

self.onmessage = async ({data: {id, base, freshQuery, path, params}}) => {
  try {
    if (base) {
      engine = createGlobalEngine({
        async json(name, {fresh = false} = {}) {
          // fresh: past the browser's copy, which can be a few minutes old (the manifest's max-age).
          // freshQuery: the local server keeps copies of its own, and is asked past them.
          const url = new URL(name, base);
          if (fresh && freshQuery) url.searchParams.set('fresh', '1');
          const res = await fetch(url, fresh ? {cache: 'no-cache'} : {});
          if (!res.ok) throw Object.assign(new Error(`${name}: ${res.status}`), {status: res.status});
          return res.json();
        },
      });
      self.postMessage({id, ok: true});
    } else {
      self.postMessage({id, ok: true, value: await engine.call(path, params)});
    }
  } catch (e) {
    self.postMessage({id, ok: false, error: e.message});
  }
};
