'use strict';
// events: EventEmitter, and events.once as a promise.

class EventEmitter {
  constructor() { this._events = new Map(); this._max = 10; }
  _list(ev) { if (!this._events) this._events = new Map(); return this._events.get(ev) || []; }
  on(ev, fn) { this._list(ev); this._events.set(ev, this._list(ev).concat([fn])); return this; }
  addListener(ev, fn) { return this.on(ev, fn); }
  prependListener(ev, fn) { this._events.set(ev, [fn].concat(this._list(ev))); return this; }
  once(ev, fn) { const w = (...a) => { this.off(ev, w); fn.apply(this, a); }; w.listener = fn; return this.on(ev, w); }
  prependOnceListener(ev, fn) { const w = (...a) => { this.off(ev, w); fn.apply(this, a); }; w.listener = fn; return this.prependListener(ev, w); }
  off(ev, fn) { const l = this._list(ev); const i = l.findIndex((f) => f === fn || f.listener === fn); if (i >= 0) { const n = l.slice(); n.splice(i, 1); this._events.set(ev, n); } return this; }
  removeListener(ev, fn) { return this.off(ev, fn); }
  removeAllListeners(ev) { if (ev === undefined) this._events = new Map(); else this._events.delete(ev); return this; }
  emit(ev, ...a) {
    const l = this._list(ev);
    if (ev === 'error' && !l.length) throw a[0] instanceof Error ? a[0] : new Error('Unhandled error. (' + a[0] + ')');
    for (const fn of l) fn.apply(this, a);
    return l.length > 0;
  }
  listeners(ev) { return this._list(ev).map((f) => f.listener || f); }
  rawListeners(ev) { return this._list(ev).slice(); }
  listenerCount(ev) { return this._list(ev).length; }
  eventNames() { return this._events ? [...this._events.keys()] : []; }
  setMaxListeners(n) { this._max = n; return this; }
  getMaxListeners() { return this._max; }
}
EventEmitter.EventEmitter = EventEmitter;
EventEmitter.defaultMaxListeners = 10;
EventEmitter.once = (emitter, ev) => new Promise((resolve, reject) => {
  const onErr = (e) => { emitter.off('error', onErr); reject(e); };
  emitter.once(ev, (...a) => { if (ev !== 'error') emitter.off('error', onErr); resolve(a); });
  if (ev !== 'error') emitter.once('error', onErr);
});
EventEmitter.on = () => { throw new Error('events.on is not available'); };
EventEmitter.default = EventEmitter;
module.exports = EventEmitter;
