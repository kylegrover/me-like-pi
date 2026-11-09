// Minimal Chrome DevTools Protocol client. Zero dependencies: uses Node's global WebSocket.

const DEFAULT_TIMEOUT_MS = 15_000;
const EVENT_BUFFER = 2_000;

export class CdpError extends Error {}

/** Wrap a WebSocket-like object ({send, close, onmessage, onclose, onerror}) as a transport. */
export function websocketTransport(ws) {
  return {
    send: (text) => ws.send(text),
    close: () => { try { ws.close(); } catch {} },
    onMessage: (cb) => { ws.onmessage = (e) => cb(typeof e.data === 'string' ? e.data : String(e.data)); },
    onClose: (cb) => {
      ws.onclose = () => cb(new CdpError('Chrome closed the DevTools connection'));
      ws.onerror = (e) => cb(new CdpError(`DevTools WebSocket error: ${e?.message || 'connection failed'}`));
    },
  };
}

/** Open a WebSocket to a local DevTools endpoint and resolve once connected. */
export async function connectWebSocket(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof WebSocket !== 'function') throw new CdpError('This Node has no global WebSocket; use Node 22 or newer.');
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new CdpError(`Timed out connecting to ${url}`)); }, timeoutMs);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = (e) => { clearTimeout(timer); reject(new CdpError(`Could not connect to ${url}: ${e?.message || 'connection failed'}`)); };
  });
  return websocketTransport(ws);
}

export class CdpClient {
  constructor(transport, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.listeners = new Set();
    this.closed = null;
    transport.onMessage((text) => this.#receive(text));
    transport.onClose((err) => this.#fail(err));
  }

  #receive(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new CdpError(`${entry.method}: ${msg.error.message || JSON.stringify(msg.error)}`));
      else entry.resolve(msg.result ?? {});
      return;
    }
    if (!msg.method) return;
    const event = { method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId };
    this.events.push(event);
    if (this.events.length > EVENT_BUFFER) this.events.splice(0, this.events.length - EVENT_BUFFER);
    for (const listener of this.listeners) { try { listener(event); } catch {} }
  }

  #fail(err) {
    if (this.closed) return;
    this.closed = err;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(err); }
    this.pending.clear();
  }

  send(method, params = {}, sessionId, { timeoutMs = this.timeoutMs } = {}) {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.transport.send(JSON.stringify(message)); }
      catch (err) { clearTimeout(timer); this.pending.delete(id); reject(new CdpError(`${method}: ${err.message}`)); }
    });
  }

  /** Take buffered events (optionally only one session's), removing them from the buffer. */
  drain(sessionId) {
    if (sessionId === undefined) return this.events.splice(0);
    const keep = [], out = [];
    for (const e of this.events) (e.sessionId === sessionId ? out : keep).push(e);
    this.events = keep;
    return out;
  }

  on(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  close() { this.#fail(new CdpError('DevTools connection closed')); this.transport.close(); }
}
