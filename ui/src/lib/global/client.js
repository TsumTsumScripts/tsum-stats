// The page's side of the global site: it is one when its index.html says so
// (`vite build --mode global` adds the tag), and then api() is answered by the
// global engine in a worker, from the files under data/global/. Modelled on
// ../snapshot/client.js.

/** True on the global site; the local server's page and a snapshot have no such tag. */
export const isGlobal = () => document.querySelector('meta[name="tsum-global"]') !== null;

/**
 * A global engine in its own worker, reading the files under base. freshQuery
 * asks for a file past any copy kept with ?fresh=1 (the local server's
 * /api/stats/global-data/, which keeps copies), where the site itself is asked
 * past the browser's.
 */
function engineClient(base, {freshQuery = false} = {}) {
  let worker, ready, seq = 0;
  const pending = new Map();
  const send = message => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, {resolve, reject});
    worker.postMessage({id, ...message});
  });
  const start = () => {
    worker = new Worker(new URL('./worker.js', import.meta.url), {type: 'module'});
    worker.onmessage = ({data: {id, ok, value, error}}) => {
      const {resolve, reject} = pending.get(id);
      pending.delete(id);
      if (ok) resolve(value);
      else reject(new Error(error));
    };
    return send({base: new URL(base, document.baseURI).href, freshQuery});
  };
  return async (path, params) => {
    ready ??= start();
    await ready;
    return send({path, params});
  };
}

/** api() for the global site: the server's routes and parameters, answered in the browser. */
export const globalApi = engineClient('data/global/');

/**
 * The global site's answers on the local site, through the local server
 * (/api/stats/global-data/): everyone's rounds, for what one player's cannot
 * say (the Catalog's next skill levels). It fails when contributing is off.
 */
export const everyoneApi = engineClient('api/stats/global-data/', {freshQuery: true});
