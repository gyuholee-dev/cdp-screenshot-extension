/** Fake CDP: records calls, answers via a handler map, supports events. */
export function makePng(width, height) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b.toString('base64');
}

export function makeFakeCdp(handlers = {}) {
  const calls = [];
  const listeners = new Map();
  const defaults = {
    'Runtime.evaluate': (p) => ({ result: { value: p.expression === 'window.devicePixelRatio' ? 1 : undefined, objectId: 'body-obj' } }),
    'Page.getLayoutMetrics': () => ({
      cssLayoutViewport: { clientWidth: 800, clientHeight: 600 },
      cssContentSize: { width: 800, height: 600 },
      cssVisualViewport: { pageX: 0, pageY: 0, zoom: 1 },
    }),
    'Page.captureScreenshot': () => ({ data: makePng(800, 600) }),
  };
  const cdp = {
    calls,
    names: () => calls.map((c) => c.method),
    async send(method, params = {}) {
      calls.push({ method, params });
      const h = handlers[method] ?? defaults[method];
      if (!h) return {};
      return typeof h === 'function' ? h(params, calls) : h;
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return () => listeners.get(event).delete(handler);
    },
    emit(event, params) {
      for (const h of [...(listeners.get(event) ?? [])]) h(params);
    },
    listenerCount: (event) => listeners.get(event)?.size ?? 0,
  };
  return cdp;
}

/** callFunctionOn responder keyed by page function name. */
export function pageFns(map) {
  return (p) => {
    const name = /function\s+(\w+)/.exec(p.functionDeclaration)?.[1];
    const v = map[name];
    const value = typeof v === 'function' ? v(p) : v;
    return p.returnByValue ? { result: { value } } : { result: { objectId: 'state-obj' } };
  };
}
