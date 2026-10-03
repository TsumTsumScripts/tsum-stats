// PocketBase realtime over SSE: connect, get a client id, then say which topics
// this page wants. EventSource reconnects by itself, and each reconnect is a
// new client that has to subscribe again.

const handlers = new Map();
const onConnect = new Set();

/** Register before start(); a topic's listener is attached when it connects. */
export function subscribe(topic, fn) {
  if (!handlers.has(topic)) handlers.set(topic, new Set());
  handlers.get(topic).add(fn);
}

/** fn runs on every (re)connect, so a page can refetch what it missed. */
export const onReconnect = fn => onConnect.add(fn);

export function start() {
  const source = new EventSource('/api/realtime');
  let first = true;
  source.addEventListener('PB_CONNECT', async e => {
    const {clientId} = JSON.parse(e.data);
    await fetch('/api/realtime', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({clientId, subscriptions: [...handlers.keys()]}),
    });
    if (!first) for (const fn of onConnect) fn();
    first = false;
  });
  for (const [topic, fns] of handlers) {
    source.addEventListener(topic, e => {
      const data = JSON.parse(e.data);
      for (const fn of fns) fn(data);
    });
  }
}
