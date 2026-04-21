(() => {
  const FLUSH_EVENT = 'gdh:fragments';
  const SET_ENABLED_EVENT = 'gdh:set-enabled';
  console.log('[gdh] page-world loaded, readyState=', document.readyState);

  let gdhEnabled = false;
  document.addEventListener(SET_ENABLED_EVENT, (ev) => {
    const next = !!ev.detail;
    if (next === gdhEnabled) return;
    gdhEnabled = next;
    if (gdhEnabled) forceFlushNow();
    else document.dispatchEvent(new CustomEvent(FLUSH_EVENT, { detail: [] }));
  });

  // ------------------------------------------------------------------
  // 1) Capture the Kix application the moment Google Docs constructs it.
  // ------------------------------------------------------------------
  let rawCreate = window._createKixApplication;
  let wrapped;
  if (rawCreate) console.warn('[gdh] _createKixApplication already set — hook may be late');
  Object.defineProperty(window, '_createKixApplication', {
    configurable: true,
    enumerable: true,
    get() { return wrapped || rawCreate; },
    set(fn) {
      rawCreate = fn;
      wrapped = function (...args) {
        const app = rawCreate.apply(this, args);
        window.__GDH_KIX__ = app;
        console.log('[gdh] Kix captured', app);
        return app;
      };
    },
  });

  // ------------------------------------------------------------------
  // 2) Intercept every 2D canvas context.
  // ------------------------------------------------------------------
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  const patched = new WeakSet();
  const states = [];
  let canvasIdSeq = 0;

  // Diagnostic counters — surfaced via window.__GDH_DIAG__().
  const diag = {
    htmlGetContextCalls: 0,
    htmlGetContext2dCalls: 0,
    offGetContextCalls: 0,
    offGetContext2dCalls: 0,
    transferControlToOffscreenCalls: 0,
    drawImageCalls: 0,
    drawImageFromOffscreen: 0,
    drawImageFromCanvas: 0,
    offscreenFillTextCalls: 0,
    // canvasId -> { fillText, clearRect, lastFillText }
    perCanvas: new Map(),
  };

  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    diag.htmlGetContextCalls++;
    if (type === '2d') diag.htmlGetContext2dCalls++;
    const ctx = origGetContext.call(this, type, ...rest);
    if (type !== '2d' || !ctx || patched.has(ctx)) return ctx;
    patched.add(ctx);
    if (!this.dataset.gdhId) this.dataset.gdhId = String(++canvasIdSeq);
    console.log(`[gdh] getContext 2d on canvas#${this.dataset.gdhId}`,
      { w: this.width, h: this.height,
        ow: this.offsetWidth, oh: this.offsetHeight,
        connected: this.isConnected,
        parentCls: this.parentElement?.className });
    return wrapContext(this, ctx);
  };

  // Intercept width/height setters. Setting either wipes the canvas
  // framebuffer and resets the context state — so our recorded
  // fragments become stale ghosts. Drop them on any real resize.
  for (const prop of ['width', 'height']) {
    const desc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, prop);
    if (!desc || !desc.set) continue;
    const origSet = desc.set;
    Object.defineProperty(HTMLCanvasElement.prototype, prop, {
      ...desc,
      set(v) {
        const id = this.dataset.gdhId;
        if (id) {
          const old = desc.get.call(this);
          if (old !== v) {
            const state = diag.perCanvas.get(id);
            console.log(`[gdh] canvas#${id} ${prop} ${old} -> ${v} (connected=${this.isConnected}, frags=${state?.fragments.length ?? '?'})`);
            if (state) {
              state.fragments = [];
              state.transform = [1, 0, 0, 1, 0, 0];
              state.stack = [];
            }
          }
        }
        return origSet.call(this, v);
      },
    });
  }

  // Intercept canvas snapshot APIs — if Kix blanks a canvas via resize
  // after filling it, maybe it previously snapshotted the content and
  // blits it elsewhere (as an <img> or a pattern).
  for (const method of ['toDataURL', 'toBlob']) {
    const orig = HTMLCanvasElement.prototype[method];
    if (!orig) continue;
    HTMLCanvasElement.prototype[method] = function (...args) {
      const id = this.dataset.gdhId;
      console.log(`[gdh] 📸 ${method} on canvas#${id ?? '?'} (w=${this.width} h=${this.height} connected=${this.isConnected})`);
      return orig.apply(this, args);
    };
  }
  if (HTMLCanvasElement.prototype.transferToImageBitmap) {
    const orig = HTMLCanvasElement.prototype.transferToImageBitmap;
    HTMLCanvasElement.prototype.transferToImageBitmap = function (...args) {
      console.log(`[gdh] 📸 transferToImageBitmap on canvas#${this.dataset.gdhId ?? '?'}`);
      return orig.apply(this, args);
    };
  }
  if (typeof OffscreenCanvas !== 'undefined' && OffscreenCanvas.prototype.transferToImageBitmap) {
    const orig = OffscreenCanvas.prototype.transferToImageBitmap;
    OffscreenCanvas.prototype.transferToImageBitmap = function (...args) {
      console.log('[gdh] 📸 transferToImageBitmap on OffscreenCanvas');
      return orig.apply(this, args);
    };
  }

  // Watch the DOM for canvas attach/detach so we can correlate with
  // fillText timing. Log only for canvases we've hooked.
  const attachObserver = new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n && n.nodeType === 1) {
          const cs = n.tagName === 'CANVAS' ? [n] : n.querySelectorAll?.('canvas') || [];
          for (const c of cs) {
            const id = c.dataset?.gdhId;
            if (id) console.log(`[gdh] 🟢 canvas#${id} attached (w=${c.width} h=${c.height} frags=${diag.perCanvas.get(id)?.fragments.length ?? '?'})`);
          }
          // Flag anything that might display a canvas snapshot.
          if (n.tagName === 'IMG') {
            const src = (n.src || '').slice(0, 40);
            if (src.startsWith('blob:') || src.startsWith('data:')) {
              console.log(`[gdh] 🖼️ <img> added with src=${src}… (parentCls=${n.parentElement?.className?.slice(0,40)})`);
            }
          }
          const imgs = n.querySelectorAll?.('img[src^="blob:"], img[src^="data:"]');
          if (imgs && imgs.length) {
            console.log(`[gdh] 🖼️ ${imgs.length} blob/data <img> added inside`, n.tagName, n.className?.slice(0,40));
          }
        }
      }
      for (const n of r.removedNodes) {
        if (n && n.nodeType === 1) {
          const cs = n.tagName === 'CANVAS' ? [n] : n.querySelectorAll?.('canvas') || [];
          for (const c of cs) {
            const id = c.dataset?.gdhId;
            if (id) console.log(`[gdh] 🔴 canvas#${id} detached`);
          }
        }
      }
      // Surface background-image changes on existing elements, which
      // could also indicate canvas snapshots being applied via CSS.
      if (r.type === 'attributes' && r.attributeName === 'style') {
        const bg = r.target.style?.backgroundImage || '';
        if (bg.includes('blob:') || bg.includes('data:image')) {
          console.log(`[gdh] 🎨 background-image set on`, r.target.tagName, r.target.className?.slice(0,40), '→', bg.slice(0, 60));
        }
      }
    }
  });
  (function startObserver() {
    if (!document.body) return requestAnimationFrame(startObserver);
    attachObserver.observe(document.body, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['style', 'src'],
    });
  })();

  // A one-shot DOM probe — call __GDH_SCAN_DOM__() after you scroll to
  // an unhighlighted page to find whatever is actually rendering it.
  window.__GDH_SCAN_DOM__ = () => {
    const all = document.querySelectorAll('*');
    const suspects = [];
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 200) continue;
      if (r.bottom < 0 || r.top > innerHeight) continue;
      const cs = getComputedStyle(el);
      const bg = cs.backgroundImage;
      const hasImg = bg && bg !== 'none';
      const isCanvas = el.tagName === 'CANVAS';
      const isImg = el.tagName === 'IMG';
      if (isCanvas || isImg || hasImg) {
        suspects.push({
          tag: el.tagName,
          cls: (el.className || '').toString().slice(0, 60),
          id: el.dataset?.gdhId || '',
          w: Math.round(r.width), h: Math.round(r.height),
          top: Math.round(r.top),
          src: (el.src || '').slice(0, 40),
          bg: hasImg ? bg.slice(0, 60) : '',
        });
      }
    }
    console.table(suspects);
    return suspects;
  };

  // If Kix calls transferControlToOffscreen, the canvas is driven from a
  // worker and our hooks never see its fillText. Flag it loudly.
  const origTransfer = HTMLCanvasElement.prototype.transferControlToOffscreen;
  if (origTransfer) {
    HTMLCanvasElement.prototype.transferControlToOffscreen = function (...args) {
      diag.transferControlToOffscreenCalls++;
      if (!this.dataset.gdhId) this.dataset.gdhId = String(++canvasIdSeq);
      console.warn(`[gdh] 🚨 transferControlToOffscreen on canvas#${this.dataset.gdhId} — this page will render in a worker and bypass our hook`,
        { w: this.width, h: this.height, parentCls: this.parentElement?.className });
      return origTransfer.apply(this, args);
    };
  }

  // Wrap OffscreenCanvas contexts too. Even if Kix does main-thread
  // offscreen rendering (not worker), we still want to capture fillText
  // there. Later, drawImage from such an offscreen to a visible canvas
  // should migrate fragments across.
  const offscreenStates = new WeakMap(); // OffscreenCanvas -> state
  if (typeof OffscreenCanvas !== 'undefined') {
    const origOffGetContext = OffscreenCanvas.prototype.getContext;
    OffscreenCanvas.prototype.getContext = function (type, ...rest) {
      diag.offGetContextCalls++;
      if (type === '2d') diag.offGetContext2dCalls++;
      const ctx = origOffGetContext.call(this, type, ...rest);
      if (type !== '2d' || !ctx || patched.has(ctx)) return ctx;
      patched.add(ctx);
      console.log('[gdh] getContext 2d on OffscreenCanvas',
        { w: this.width, h: this.height });
      return wrapContext(this, ctx, /*offscreen=*/true);
    };
  }

  function wrapContext(canvas, ctx, offscreen = false) {
    const canvasId = offscreen
      ? `off${++canvasIdSeq}`
      : canvas.dataset.gdhId;
    const state = {
      canvas,
      canvasId,
      offscreen,
      font: ctx.font,
      textAlign: 'start',
      textBaseline: 'alphabetic',
      transform: [1, 0, 0, 1, 0, 0],
      stack: [],
      fragments: [],
      fillTextCount: 0,
      clearRectCount: 0,
      sampleText: '',
    };
    if (offscreen) offscreenStates.set(canvas, state);
    states.push(state);
    diag.perCanvas.set(canvasId, state);
    const boundCache = new Map();

    return new Proxy(ctx, {
      get(target, prop) {
        switch (prop) {
          case 'fillText':
            return (text, x, y, maxWidth) => {
              state.fillTextCount++;
              if (offscreen) diag.offscreenFillTextCalls++;
              if (state.sampleText.length < 80) state.sampleText += text + ' ';
              if (state.fillTextCount === 1) {
                console.log(`[gdh] first fillText on ${offscreen ? 'OffscreenCanvas' : 'canvas#' + canvasId} text=${JSON.stringify(text.slice(0, 40))} (connected=${!offscreen && canvas.isConnected}, size=${canvas.width}x${canvas.height})`);
              }
              record(state, target, text, x, y);
              return target.fillText(text, x, y, maxWidth);
            };
          case 'strokeText':
            return (text, x, y, maxWidth) => {
              state.fillTextCount++;
              record(state, target, text, x, y);
              return target.strokeText(text, x, y, maxWidth);
            };
          case 'save':
            return () => {
              state.stack.push({
                t: [...state.transform],
                align: state.textAlign,
                baseline: state.textBaseline,
                font: state.font,
              });
              return target.save();
            };
          case 'restore':
            return () => {
              const s = state.stack.pop();
              if (s) {
                state.transform = s.t;
                state.textAlign = s.align;
                state.textBaseline = s.baseline;
                state.font = s.font;
              }
              return target.restore();
            };
          case 'setTransform':
            return (a, b, c, d, e, f) => {
              if (a && typeof a === 'object') {
                state.transform = [a.a, a.b, a.c, a.d, a.e, a.f];
                return target.setTransform(a);
              }
              state.transform = [a, b, c, d, e, f];
              return target.setTransform(a, b, c, d, e, f);
            };
          case 'resetTransform':
            return () => {
              state.transform = [1, 0, 0, 1, 0, 0];
              return target.resetTransform();
            };
          case 'transform':
            return (a, b, c, d, e, f) => {
              state.transform = mul(state.transform, [a, b, c, d, e, f]);
              return target.transform(a, b, c, d, e, f);
            };
          case 'translate':
            return (x, y) => {
              state.transform = mul(state.transform, [1, 0, 0, 1, x, y]);
              return target.translate(x, y);
            };
          case 'scale':
            return (sx, sy) => {
              state.transform = mul(state.transform, [sx, 0, 0, sy, 0, 0]);
              return target.scale(sx, sy);
            };
          case 'rotate':
            return (r) => {
              const c = Math.cos(r), s = Math.sin(r);
              state.transform = mul(state.transform, [c, s, -s, c, 0, 0]);
              return target.rotate(r);
            };
          case 'clearRect':
            return (x, y, w, h) => {
              state.clearRectCount++;
              invalidate(state, x, y, w, h);
              return target.clearRect(x, y, w, h);
            };
          case 'drawImage':
            return (...args) => {
              diag.drawImageCalls++;
              const src = args[0];
              if (src instanceof OffscreenCanvas) {
                diag.drawImageFromOffscreen++;
                handleDrawImage(state, src, args);
              } else if (src instanceof HTMLCanvasElement) {
                diag.drawImageFromCanvas++;
              }
              return target.drawImage(...args);
            };
        }
        const val = target[prop];
        if (typeof val !== 'function') return val;
        let bound = boundCache.get(prop);
        if (!bound) {
          bound = val.bind(target);
          boundCache.set(prop, bound);
        }
        return bound;
      },
      set(target, prop, value) {
        if (prop === 'font') state.font = value;
        else if (prop === 'textAlign') state.textAlign = value;
        else if (prop === 'textBaseline') state.textBaseline = value;
        target[prop] = value;
        return true;
      },
    });
  }

  // When a visible canvas blits a region of an OffscreenCanvas onto
  // itself, forward any fragments that sit inside that source region to
  // the destination state, translated into destination coordinates.
  function handleDrawImage(destState, sourceCanvas, args) {
    const srcState = offscreenStates.get(sourceCanvas);
    if (!srcState || !srcState.fragments.length) return;

    // drawImage signatures:
    //   (img, dx, dy)
    //   (img, dx, dy, dw, dh)
    //   (img, sx, sy, sw, sh, dx, dy, dw, dh)
    let sx = 0, sy = 0, sw = sourceCanvas.width, sh = sourceCanvas.height;
    let dx, dy, dw, dh;
    if (args.length === 3) {
      dx = args[1]; dy = args[2]; dw = sw; dh = sh;
    } else if (args.length === 5) {
      dx = args[1]; dy = args[2]; dw = args[3]; dh = args[4];
    } else if (args.length === 9) {
      sx = args[1]; sy = args[2]; sw = args[3]; sh = args[4];
      dx = args[5]; dy = args[6]; dw = args[7]; dh = args[8];
    } else {
      return;
    }
    const kx = dw / sw;
    const ky = dh / sh;

    for (const f of srcState.fragments) {
      // f.x/f.y/f.width/f.height are already in source-canvas pixel space.
      // Clip to source rect.
      const fx1 = Math.max(f.x, sx);
      const fy1 = Math.max(f.y, sy);
      const fx2 = Math.min(f.x + f.width, sx + sw);
      const fy2 = Math.min(f.y + f.height, sy + sh);
      if (fx2 <= fx1 || fy2 <= fy1) continue;

      // Transform through the source->dest mapping, then through the
      // destination context's current transform.
      const lx = dx + (fx1 - sx) * kx;
      const ly = dy + (fy1 - sy) * ky;
      const rx = dx + (fx2 - sx) * kx;
      const ry = dy + (fy2 - sy) * ky;
      const [x1, y1] = apply(destState.transform, lx, ly);
      const [x2, y2] = apply(destState.transform, rx, ry);
      const mapped = {
        text: f.text,
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
        font: f.font,
      };
      let merged = false;
      for (let i = 0; i < destState.fragments.length; i++) {
        const g = destState.fragments[i];
        if (g.text === mapped.text &&
            Math.abs(g.x - mapped.x) < 1 &&
            Math.abs(g.y - mapped.y) < 1) {
          destState.fragments[i] = mapped;
          merged = true;
          break;
        }
      }
      if (!merged) destState.fragments.push(mapped);
    }
    scheduleFlush();
  }

  function mul(A, B) {
    const [a1,b1,c1,d1,e1,f1] = A, [a2,b2,c2,d2,e2,f2] = B;
    return [
      a1*a2 + c1*b2,
      b1*a2 + d1*b2,
      a1*c2 + c1*d2,
      b1*c2 + d1*d2,
      a1*e2 + c1*f2 + e1,
      b1*e2 + d1*f2 + f1,
    ];
  }
  function apply(T, x, y) {
    return [T[0]*x + T[2]*y + T[4], T[1]*x + T[3]*y + T[5]];
  }

  function record(state, ctx, text, x, y) {
    if (!text) return;
    const m = ctx.measureText(text);
    const w = m.width;
    if (!w) return;

    let lx = x;
    if (state.textAlign === 'center') lx -= w / 2;
    else if (state.textAlign === 'right' || state.textAlign === 'end') lx -= w;

    const ascent = m.actualBoundingBoxAscent || fontSize(state.font) * 0.8;
    const descent = m.actualBoundingBoxDescent || fontSize(state.font) * 0.2;
    const top = y - ascent;
    const bottom = y + descent;

    const [x1, y1] = apply(state.transform, lx, top);
    const [x2, y2] = apply(state.transform, lx + w, bottom);

    const frag = {
      text,
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
      font: state.font,
    };

    for (let i = 0; i < state.fragments.length; i++) {
      const f = state.fragments[i];
      if (f.text === text && Math.abs(f.x - frag.x) < 1 && Math.abs(f.y - frag.y) < 1) {
        state.fragments[i] = frag;
        scheduleFlush();
        return;
      }
    }
    state.fragments.push(frag);
    scheduleFlush();
  }

  function invalidate(state, x, y, w, h) {
    const [x1, y1] = apply(state.transform, x, y);
    const [x2, y2] = apply(state.transform, x + w, y + h);
    const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
    state.fragments = state.fragments.filter(f =>
      f.x + f.width <= minX ||
      f.x >= maxX ||
      f.y + f.height <= minY ||
      f.y >= maxY
    );
  }

  function fontSize(fontStr) {
    const m = /([\d.]+)px/.exec(fontStr);
    return m ? parseFloat(m[1]) : 13;
  }

  // ------------------------------------------------------------------
  // 3) Batch & dispatch.
  // ------------------------------------------------------------------
  window.__GDH_FRAGMENTS__ = [];
  window.__GDH_TEXT__ = () =>
    window.__GDH_FRAGMENTS__.map(f => f.text).join(' ')
      .replace(/[\u202A-\u202E\u2066-\u2069]/g, '');

  // Call from devtools console: __GDH_DIAG__()
  window.__GDH_DIAG__ = () => {
    const visibleCanvases = Array.from(document.querySelectorAll('canvas[data-gdh-id]'));
    const rows = [];
    for (const s of states) {
      rows.push({
        id: s.canvasId,
        kind: s.offscreen ? 'offscreen' : 'html',
        connected: s.offscreen ? '—' : s.canvas.isConnected,
        fillText: s.fillTextCount,
        clearRect: s.clearRectCount,
        fragments: s.fragments.length,
        w: s.canvas.width, h: s.canvas.height,
        sample: s.sampleText.slice(0, 60),
      });
    }
    console.table(rows);
    console.log('[gdh] diag:', diag);
    console.log('[gdh] visible canvases in DOM:', visibleCanvases.length);
    return { states: rows, diag };
  };

  function buildPayload() {
    const payload = [];
    const perCanvas = new Map();
    for (const s of states) {
      if (s.offscreen) continue;
      // Don't filter by isConnected. Kix detaches canvases briefly
      // during its recycle dance; if a flush lands in that window we
      // lose the whole page. Content-script handles missing-from-DOM
      // naturally when it can't find the canvas by id.
      perCanvas.set(s.canvasId, s.fragments.length);
      for (const f of s.fragments) {
        payload.push({
          canvasId: s.canvasId,
          text: f.text,
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
          font: f.font,
        });
      }
    }
    return { payload, perCanvas };
  }

  function forceFlushNow() {
    const { payload, perCanvas } = buildPayload();
    const breakdown = [...perCanvas.entries()].map(([id, n]) => `${id}:${n}`).join(' ');
    console.log(`[gdh] force-flush on enable: ${payload.length} frags across ${perCanvas.size} live canvases — ${breakdown}`);
    window.__GDH_FRAGMENTS__ = payload;
    document.dispatchEvent(new CustomEvent(FLUSH_EVENT, { detail: payload }));
  }

  let flushPending = false;
  let flushCount = 0;
  function scheduleFlush() {
    if (flushPending) return;
    flushPending = true;
    requestAnimationFrame(() => {
      flushPending = false;
      if (!gdhEnabled) return;
      const { payload, perCanvas } = buildPayload();
      if (++flushCount <= 5 || flushCount % 30 === 0) {
        const breakdown = [...perCanvas.entries()]
          .map(([id, n]) => `${id}:${n}`).join(' ');
        console.log(`[gdh] flush #${flushCount}: ${payload.length} frags across ${perCanvas.size} live canvases — ${breakdown}`);
      }
      window.__GDH_FRAGMENTS__ = payload;
      document.dispatchEvent(new CustomEvent(FLUSH_EVENT, { detail: payload }));
    });
  }
})();
