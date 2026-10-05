// PocketBase realtime over SSE: connect, get a client id, then say which topics
// this page wants. Each reconnect is a new client that has to subscribe again.
// EventSource retries a dropped stream by itself, but gives up for good on an
// error reply, so a closed or unsubscribed stream is reopened here.

const handlers = new Map();
const onConnect = new Set();
const RETRY_MS = 5000;

let source = null;
let retry = null;
let first = true;

/** Register before start(); a topic's listener is attached when it connects. */
export function subscribe(topic, fn) {
  if (!handlers.has(topic)) handlers.set(topic, new Set());
  handlers.get(topic).add(fn);
}

/** fn runs on every (re)connect, so a page can refetch what it missed. */
export const onReconnect = fn => onConnect.add(fn);

export const start = () => connect();

/** Opens a new stream, for a page that has stopped hearing from the old one. */
export const restart = () => connect();

function connect() {
  clearTimeout(retry);
  source?.close();
  const es = new EventSource('/api/realtime');
  source = es;
  es.addEventListener('PB_CONNECT', async e => {
    const {clientId} = JSON.parse(e.data);
    const ok = await fetch('/api/realtime', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({clientId, subscriptions: [...handlers.keys()]}),
    }).then(r => r.ok, () => false);
    if (es !== source) return;
    // Connected but subscribed to nothing: no message would ever arrive.
    if (!ok) return retryLater();
    if (!first) for (const fn of onConnect) fn();
    first = false;
  });
  es.onerror = () => { if (es === source && es.readyState === EventSource.CLOSED) retryLater(); };
  for (const [topic, fns] of handlers) {
    es.addEventListener(topic, e => {
      const data = JSON.parse(e.data);
      for (const fn of fns) fn(data);
    });
  }
}

function retryLater() {
  source?.close();
  clearTimeout(retry);
  retry = setTimeout(connect, RETRY_MS);
}
