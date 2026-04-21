(() => {
  const FLOAT_ID = "docslatex-float-btn";
  const TOOLBAR_ID = "docslatex-toolbar-btn";
  const LABEL_ID = "docslatex-label";
  const POPUP_ID = "docslatex-hover-popup";
  const FLUSH_EVENT = "gdh:fragments";
  const SET_ENABLED_EVENT = "gdh:set-enabled";
  const logoURL = chrome.runtime.getURL("logo.png");

  let pollTimer = null;
  let enabled = false;
  let autocompile = false;
  let debugMode = false;

  const scratch = document.createElement("canvas").getContext("2d");
  let latest = [];
  const overlays = new Map();

  // Hover popup state.
  let greenRegions = [];
  let hoveredRegion = null;
  let popupHost = null;
  let popupShadow = null;
  let popupBtn = null;
  let popupLabel = null;
  let popupHideTimer = null;

  // The green math region currently being touched by the Kix text caret
  // (separate from mouse hover — the popup follows the mouse, but the
  // dark-green paint follows the caret).
  let caretRegion = null;

  const GREEN_BG = "rgba(67, 160, 71, 0.14)";
  const GREEN_BORDER = "#43a047";
  const GREEN_BG_HOVER = "rgba(46, 125, 50, 0.34)";
  const GREEN_BORDER_HOVER = "#2e7d32";

  function paintRegion(region, hovered) {
    if (!region || !region.marks) return;
    let bg, border;
    if (hovered) {
      // Caret-touched: dark underline always; dark highlight only in
      // debug mode.
      border = GREEN_BORDER_HOVER;
      bg = debugMode ? GREEN_BG_HOVER : "transparent";
    } else {
      // Not touched: underline always visible; highlight only in debug.
      border = GREEN_BORDER;
      bg = debugMode ? GREEN_BG : "transparent";
    }
    for (const mark of region.marks) {
      if (!mark) continue;
      mark.box.style.background = bg;
      mark.under.style.background = border;
    }
  }

  function compileText(latex) {
    if (typeof window.latexToUnicode === "function") {
      return window.latexToUnicode(latex);
    }
    return latex;
  }

  function compile() {
    chrome.storage.local.get({ equations_compiled: 0 }, (data) => {
      chrome.storage.local.set({
        equations_compiled: (Number(data.equations_compiled) || 0) + 1,
      });
    });
  }

  // -- 1. Floating button (bottom-right, on <html> via Shadow DOM) --
  function injectFloat() {
    if (document.getElementById(FLOAT_ID)) return;

    const host = document.createElement("div");
    host.id = FLOAT_ID;
    const shadow = host.attachShadow({ mode: "closed" });

    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          right: 18px;
          bottom: 24px;
          z-index: 9999;
          pointer-events: auto;
        }
        button {
          all: unset;
          width: 44px;
          height: 44px;
          padding: 8px;
          border: 1px solid rgba(0,0,0,0.15);
          border-radius: 50%;
          background: #fff;
          box-shadow: 0 2px 8px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.04);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: transform 0.2s ease, box-shadow 0.2s ease;
          box-sizing: border-box;
        }
        button:hover {
          transform: scale(1.08);
          box-shadow: 0 4px 14px rgba(0,0,0,0.22), 0 0 0 1px rgba(0,0,0,0.06);
        }
        button:active { transform: scale(0.93); }
        img {
          width: 100%; height: 100%;
          object-fit: contain;
          pointer-events: none; user-select: none; -webkit-user-drag: none;
        }
      </style>
      <button title="Compile All LaTeX Equations" aria-label="Compile All LaTeX Equations">
        <img src="${logoURL}" alt="" />
      </button>
    `;

    shadow.querySelector("button").addEventListener("click", compile);
    document.documentElement.appendChild(host);
  }

  // -- 2. Toolbar button in #docs-side-toolbar --
  function injectToolbarButton() {
    if (document.getElementById(TOOLBAR_ID)) return;

    const toolbar = document.getElementById("docs-side-toolbar");
    if (!toolbar) return;

    const wrapper = document.createElement("div");
    wrapper.id = TOOLBAR_ID;
    wrapper.className = "goog-toolbar-button goog-inline-block";
    wrapper.setAttribute("role", "button");
    wrapper.setAttribute("aria-label", "Compile All LaTeX Equations");
    wrapper.setAttribute("data-tooltip", "Compile All LaTeX Equations");
    wrapper.style.cssText = "user-select:none;cursor:pointer;";

    wrapper.innerHTML = `
      <div class="goog-toolbar-button-outer-box goog-inline-block" style="user-select:none;">
        <div class="goog-toolbar-button-inner-box goog-inline-block" style="user-select:none;">
          <img src="${logoURL}" alt=""
            style="width:20px;height:20px;object-fit:contain;vertical-align:middle;pointer-events:none;-webkit-user-drag:none;"
          />
        </div>
      </div>
    `;

    wrapper.addEventListener("click", compile);

    const sep = document.getElementById("docs-toolbar-mode-switcher-separator");
    if (sep) {
      toolbar.insertBefore(wrapper, sep);
    } else {
      toolbar.appendChild(wrapper);
    }
  }

  // -- 3. "docslatex" label above the ruler in #kix-appview --
  function injectLabel() {
    if (document.getElementById(LABEL_ID)) return;

    const appview = document.getElementById("kix-appview");
    const ruler = document.getElementById("kix-horizontal-ruler-container");
    if (!appview || !ruler) return;

    const label = document.createElement("div");
    label.id = LABEL_ID;
    label.textContent = "docslatex";
    label.style.cssText =
      "text-align:center;" +
      "font-family:'Google Sans',Roboto,Arial,sans-serif;" +
      "font-size:11px;" +
      "letter-spacing:0.08em;" +
      "color:#888;" +
      "padding:4px 0;" +
      "user-select:none;" +
      "pointer-events:none;";

    appview.insertBefore(label, ruler);
  }

  function injectAll() {
    injectFloat();
    injectToolbarButton();
    injectLabel();
  }

  function removeAll() {
    const f = document.getElementById(FLOAT_ID);
    if (f) f.remove();
    const t = document.getElementById(TOOLBAR_ID);
    if (t) t.remove();
    const l = document.getElementById(LABEL_ID);
    if (l) l.remove();
  }

  // ------------------------------------------------------------------
  // Highlighter overlays — one absolutely-positioned <div> sibling per
  // Kix canvas, with one child mark per rendered word.
  // ------------------------------------------------------------------

  function splitWords(text) {
    const out = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      out.push({ word: m[0], start: m.index, end: m.index + m[0].length });
    }
    return out;
  }

  function mountOverlay(canvasId, canvas, parent) {
    const el = document.createElement("div");
    el.dataset.gdhOverlay = canvasId;
    Object.assign(el.style, {
      position: "absolute",
      pointerEvents: "none",
      overflow: "hidden",
      // Very high z-index within the local stacking context. This won't
      // escape to document level (nested stacking contexts clip it), but
      // it ensures we paint above the canvas even if Kix gives the canvas
      // an explicit z-index.
      zIndex: "2147483000",
      left: "0px", top: "0px",
      width: "0px", height: "0px",
    });
    // Insert right after the canvas so tree order stacks overlay above
    // it without needing z-index (which could conflict with ancestor
    // stacking).
    if (canvas.nextSibling) parent.insertBefore(el, canvas.nextSibling);
    else parent.appendChild(el);
    return { el, canvas, parent,
      lastLeft: -1, lastTop: -1, lastWidth: -1, lastHeight: -1 };
  }

  function clearOverlays() {
    for (const [, entry] of overlays) entry.el.remove();
    overlays.clear();
  }

  function rebuild() {
    if (!enabled) {
      clearOverlays();
      greenRegions = [];
      return;
    }

    const byCanvas = new Map();
    for (const f of latest) {
      let arr = byCanvas.get(f.canvasId);
      if (!arr) { arr = []; byCanvas.set(f.canvasId, arr); }
      arr.push(f);
    }

    for (const [id, entry] of overlays) {
      if (!byCanvas.has(id)) {
        entry.el.remove();
        overlays.delete(id);
      }
    }

    const newRegions = [];
    for (const [canvasId, frags] of byCanvas) {
      const canvas = document.querySelector(
        `canvas[data-gdh-id="${CSS.escape(canvasId)}"]`
      );
      const parent = canvas && canvas.parentElement;
      if (!canvas || !parent) {
        const old = overlays.get(canvasId);
        if (old) { old.el.remove(); overlays.delete(canvasId); }
        continue;
      }
      let entry = overlays.get(canvasId);
      // Re-mount if the canvas moved to a new parent, or our overlay got
      // yanked out of the tree by Kix.
      if (!entry || entry.parent !== parent || !entry.el.isConnected) {
        if (entry) entry.el.remove();
        entry = mountOverlay(canvasId, canvas, parent);
        overlays.set(canvasId, entry);
      } else {
        entry.canvas = canvas;
      }
      const regions = populateMarks(entry.el, frags, canvas);
      if (regions && regions.length) newRegions.push(...regions);
    }

    // If the currently hovered region vanished from this rebuild, drop
    // the popup so it doesn't point at stale geometry.
    if (hoveredRegion) {
      const stillThere = newRegions.find(
        (r) => r.latex === hoveredRegion.latex && r.canvas === hoveredRegion.canvas
      );
      if (stillThere) hoveredRegion = stillThere;
      else { hoveredRegion = null; hidePopupImmediately(); }
    }

    // Re-point the caret-touched region too, and reapply dark paint
    // since marks are recreated on every rebuild.
    if (caretRegion) {
      const stillThere = newRegions.find(
        (r) => r.latex === caretRegion.latex && r.canvas === caretRegion.canvas
      );
      if (stillThere) {
        caretRegion = stillThere;
        paintRegion(stillThere, true);
      } else {
        caretRegion = null;
      }
    }

    greenRegions = newRegions;
    syncRegionViewportRects();
    syncPositions();
    // Catch the case where the caret is already inside a region that
    // was just created (e.g., user closed a `\)`): otherwise the first
    // dark-green paint would be deferred to the next rAF tick.
    updateCaretHighlight();
  }

  function populateMarks(overlay, frags, canvas) {
    const cssW = canvas.offsetWidth || canvas.getBoundingClientRect().width;
    const cssH = canvas.offsetHeight || canvas.getBoundingClientRect().height;
    const sx = (canvas.width / cssW) || 1;
    const sy = (canvas.height / cssH) || 1;

    // Dedupe by position+text so redundant fillTexts don't create
    // spurious extra math regions in the concatenated reading-order text.
    const deduped = [];
    const seenKey = new Set();
    for (const f of frags) {
      const key = Math.round(f.x) + "," + Math.round(f.y) + "," + f.text;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      deduped.push(f);
    }

    // Reading order: top-to-bottom, left-to-right. We join these with a
    // single space separator (below) so a dangling "\" at one fragment's
    // end can't fuse with "[" at the next fragment's start to form a
    // spurious "\[".
    deduped.sort((a, b) => a.y - b.y || a.x - b.x);

    const SEP = " ";
    const fragStarts = new Array(deduped.length);
    const parts = [];
    let pos = 0;
    for (let i = 0; i < deduped.length; i++) {
      if (i > 0) {
        parts.push(SEP);
        pos += SEP.length;
      }
      fragStarts[i] = pos;
      parts.push(deduped[i].text);
      pos += deduped[i].text.length;
    }
    const concat = parts.join("");

    // Math regions: \[ ... \] and \( ... \). Non-greedy pairs the
    // earliest closer with each opener, and the alternation prevents
    // mismatched pairs like \( ... \].
    const mathRe = /\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)/g;
    const mathRanges = [];
    let mm;
    while ((mm = mathRe.exec(concat)) !== null) {
      mathRanges.push([mm.index, mm.index + mm[0].length]);
    }

    // Unclosed delimiter: mask out matched math regions, then find the
    // first remaining \[ or \( — everything from it to end is unclosed.
    const maskedArr = concat.split("");
    for (const [ra, rb] of mathRanges) {
      for (let i = ra; i < rb; i++) maskedArr[i] = " ";
    }
    const masked = maskedArr.join("");
    const unclosedRanges = [];
    const openerMatch = /\\\[|\\\(/.exec(masked);
    if (openerMatch) {
      unclosedRanges.push([openerMatch.index, concat.length]);
    }

    const isCovered = (a, b) => {
      for (const [ra, rb] of mathRanges) if (a < rb && b > ra) return true;
      for (const [ra, rb] of unclosedRanges) if (a < rb && b > ra) return true;
      return false;
    };

    const nodes = [];

    // Continuous block for a concat range [ra, rb] — one rectangle per
    // overlapping fragment, covering internal spaces (unlike the per-
    // word marks below). If rectsOut is provided, CSS-space rects are
    // collected there for later hit-testing; marksOut collects the
    // created elements so hover state can be toggled later.
    function pushBlock(ra, rb, bg, border, rectsOut, marksOut) {
      for (let fi = 0; fi < deduped.length; fi++) {
        const fs = fragStarts[fi];
        const f = deduped[fi];
        const L = f.text.length;
        const localStart = Math.max(0, ra - fs);
        const localEnd = Math.min(L, rb - fs);
        if (localStart >= localEnd) continue;

        const fragLeft = f.x / sx;
        const fragTop = f.y / sy;
        const fragWidth = f.width / sx;
        const fragHeight = f.height / sy;

        scratch.font = f.font;
        const totalW = scratch.measureText(f.text).width;
        if (!totalW) continue;

        const prefixW = localStart === 0
          ? 0
          : scratch.measureText(f.text.slice(0, localStart)).width;
        const rightW = localEnd === L
          ? totalW
          : scratch.measureText(f.text.slice(0, localEnd)).width;
        const fracStart = prefixW / totalW;
        const fracEnd = rightW / totalW;

        const cssLeft = fragLeft + fragWidth * fracStart;
        const cssTop = fragTop;
        const cssWidth = fragWidth * (fracEnd - fracStart);
        const cssHeight = fragHeight;

        // The mark itself is the highlight box (over the text).
        const mark = document.createElement("div");
        Object.assign(mark.style, {
          position: "absolute",
          left: cssLeft + "px",
          top: cssTop + "px",
          width: cssWidth + "px",
          height: cssHeight + "px",
          background: bg,
          transition: "background 120ms ease",
        });
        // Underline is a separate child positioned below the text with
        // a 1.5×-height gap, so it reads as its own element rather than
        // hugging the descenders. Pill-shaped via border-radius on both
        // top and bottom corners.
        const under = document.createElement("div");
        Object.assign(under.style, {
          position: "absolute",
          left: "0px",
          top: (cssHeight + 2) + "px",
          width: "100%",
          height: "4px",
          background: border,
          borderRadius: "2px",
          transition: "background 120ms ease",
        });
        mark.appendChild(under);
        nodes.push(mark);

        if (rectsOut) {
          rectsOut.push({ cssLeft, cssTop, cssWidth, cssHeight });
        }
        if (marksOut) marksOut.push({ box: mark, under });
      }
    }

    // Green math marks are always created. The underline shows in both
    // modes; the tinted background only in debug (caret-touched regions
    // pick up the dark bg via paintRegion regardless of mode).
    const regionsOut = [];
    const mathBg = debugMode ? GREEN_BG : "transparent";
    const mathBorder = GREEN_BORDER;
    for (const [ra, rb] of mathRanges) {
      const rects = [];
      const marks = [];
      pushBlock(ra, rb, mathBg, mathBorder, rects, marks);
      if (rects.length) {
        const latex = concat.substring(ra, rb);
        regionsOut.push({
          rects,
          latex,
          compiled: compileText(latex),
          canvas,
          marks,
        });
      }
    }

    // Orange (unclosed) underline shows in both modes, same treatment
    // as green math: background tint is debug-only.
    const unclosedBg = debugMode ? "rgba(251, 192, 45, 0.22)" : "transparent";
    for (const [ra, rb] of unclosedRanges) {
      pushBlock(ra, rb, unclosedBg, "#fbc02d");
    }

    // Red per-word spell-check underlines stay debug-only.
    if (debugMode) {
      for (let fi = 0; fi < deduped.length; fi++) {
        const f = deduped[fi];
        const words = splitWords(f.text);
        if (!words.length) continue;

        const fragLeft = f.x / sx;
        const fragTop = f.y / sy;
        const fragWidth = f.width / sx;
        const fragHeight = f.height / sy;

        scratch.font = f.font;
        const totalW = scratch.measureText(f.text).width;
        if (!totalW) continue;

        const fs = fragStarts[fi];

        for (const w of words) {
          const norm = w.word.replace(/[^\p{L}]/gu, "").toLowerCase();
          if (!norm) continue;
          if (isCovered(fs + w.start, fs + w.end)) continue;

          const prefixW = scratch.measureText(f.text.slice(0, w.start)).width;
          const wordW = scratch.measureText(f.text.slice(w.start, w.end)).width;
          const fracStart = prefixW / totalW;
          const fracEnd = (prefixW + wordW) / totalW;

          const wordW_css = fragWidth * (fracEnd - fracStart);
          const mark = document.createElement("div");
          Object.assign(mark.style, {
            position: "absolute",
            left: (fragLeft + fragWidth * fracStart) + "px",
            top: fragTop + "px",
            width: wordW_css + "px",
            height: fragHeight + "px",
            background: "rgba(229, 57, 53, 0.12)",
          });
          const under = document.createElement("div");
          Object.assign(under.style, {
            position: "absolute",
            left: "0px",
            top: (fragHeight + 2) + "px",
            width: "100%",
            height: "4px",
            background: "#e53935",
            borderRadius: "2px",
          });
          mark.appendChild(under);
          nodes.push(mark);
        }
      }
    }

    overlay.replaceChildren(...nodes);
    return regionsOut;
  }

  function syncPositions() {
    for (const [id, entry] of overlays) {
      const { el, canvas } = entry;
      if (!canvas.isConnected) {
        el.remove();
        overlays.delete(id);
        continue;
      }
      const parent = canvas.parentElement;
      if (!parent) {
        el.remove();
        overlays.delete(id);
        continue;
      }
      // Re-insert if Kix yanked our overlay out of the tree (tile
      // recycling), or if the canvas moved to a new parent.
      if (!el.isConnected || parent !== entry.parent) {
        entry.parent = parent;
        if (canvas.nextSibling) parent.insertBefore(el, canvas.nextSibling);
        else parent.appendChild(el);
      }
      // offsetLeft/Top/Width/Height are relative to the canvas's
      // offsetParent, and our overlay sits in the same parent flow, so
      // these values place the overlay exactly where the canvas is —
      // and they scroll together on the compositor without any per-
      // scroll JS.
      const left = canvas.offsetLeft;
      const top = canvas.offsetTop;
      const width = canvas.offsetWidth;
      const height = canvas.offsetHeight;
      if (width === 0 || height === 0) {
        if (entry.lastWidth !== 0) {
          el.style.display = "none";
          entry.lastWidth = 0;
        }
        continue;
      }
      if (entry.lastWidth === 0) el.style.display = "";
      if (entry.lastLeft !== left) { el.style.left = left + "px"; entry.lastLeft = left; }
      if (entry.lastTop !== top) { el.style.top = top + "px"; entry.lastTop = top; }
      if (entry.lastWidth !== width) { el.style.width = width + "px"; entry.lastWidth = width; }
      if (entry.lastHeight !== height) { el.style.height = height + "px"; entry.lastHeight = height; }
    }
  }

  // ------------------------------------------------------------------
  // Hover popup — shows "Compile" above a green math region. Click
  // writes the compiled Unicode to the clipboard so the user can paste
  // it in place. (Google Docs' Kix editor rejects synthetic mouse/
  // keyboard events, so a fully automatic replacement is not viable
  // from a plain content script.)
  // ------------------------------------------------------------------

  function ensurePopup() {
    if (popupHost && popupHost.isConnected) return;
    const host = document.createElement("div");
    host.id = POPUP_ID;
    Object.assign(host.style, {
      position: "fixed",
      left: "0px",
      top: "-9999px",
      zIndex: "2147483647",
      display: "none",
      pointerEvents: "auto",
    });
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          background: #43a047;
          color: #fff;
          border: 0;
          border-radius: 6px;
          font: 500 12px/1 'Google Sans', Roboto, Arial, sans-serif;
          letter-spacing: 0.04em;
          box-shadow: 0 2px 10px rgba(0,0,0,0.22), 0 0 0 1px rgba(0,0,0,0.04);
          cursor: pointer;
          user-select: none;
          white-space: nowrap;
          transition: background 150ms ease, transform 150ms ease;
        }
        .btn:hover { background: #388e3c; transform: translateY(-1px); }
        .btn:active { transform: translateY(0); }
        .btn.is-toast {
          background: #1a1a1a;
          cursor: default;
        }
        .btn.is-toast:hover { background: #1a1a1a; transform: none; }
        .dot {
          width: 6px; height: 6px;
          border-radius: 50%;
          background: rgba(255,255,255,0.9);
          box-shadow: 0 0 0 2px rgba(255,255,255,0.18);
        }
        .btn.is-toast .dot { display: none; }
      </style>
      <button class="btn" type="button">
        <span class="dot"></span>
        <span class="label">Compile</span>
      </button>
    `;
    const btn = shadow.querySelector(".btn");
    const label = shadow.querySelector(".label");
    // mousedown preventDefault keeps focus inside Docs' hidden input
    // iframe, so the selection the user made survives the click.
    const keepFocus = (e) => { e.preventDefault(); };
    btn.addEventListener("mousedown", keepFocus);
    btn.addEventListener("pointerdown", keepFocus);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      onCompileClick();
    });
    host.addEventListener("mousedown", keepFocus);
    host.addEventListener("pointerdown", keepFocus);
    host.addEventListener("mouseenter", () => clearTimeout(popupHideTimer));
    host.addEventListener("mouseleave", schedulePopupHide);
    document.body.appendChild(host);
    popupHost = host;
    popupShadow = shadow;
    popupBtn = btn;
    popupLabel = label;
  }

  function hidePopupImmediately() {
    clearTimeout(popupHideTimer);
    if (popupHost) popupHost.style.display = "none";
    hoveredRegion = null;
  }

  function schedulePopupHide() {
    clearTimeout(popupHideTimer);
    popupHideTimer = setTimeout(hidePopupImmediately, 140);
  }

  function showPopupFor(region) {
    ensurePopup();
    clearTimeout(popupHideTimer);
    popupBtn.classList.remove("is-toast");
    popupLabel.textContent = "Compile";
    popupHost.style.display = "block";
    repositionPopup();
  }

  function regionUnion(region) {
    let minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
    const vr = region.viewportRects || [];
    for (const r of vr) {
      if (r.left < minL) minL = r.left;
      if (r.top < minT) minT = r.top;
      if (r.right > maxR) maxR = r.right;
      if (r.bottom > maxB) maxB = r.bottom;
    }
    return { left: minL, top: minT, right: maxR, bottom: maxB };
  }

  function repositionPopup() {
    if (!popupHost || !hoveredRegion) return;
    const u = regionUnion(hoveredRegion);
    if (!isFinite(u.left)) return;
    const pw = popupHost.offsetWidth || 90;
    const ph = popupHost.offsetHeight || 30;
    let left = u.left + (u.right - u.left) / 2 - pw / 2;
    let top = u.top - ph - 8;
    if (top < 8) top = u.bottom + 8;
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    popupHost.style.left = left + "px";
    popupHost.style.top = top + "px";
  }

  function syncRegionViewportRects() {
    for (const region of greenRegions) {
      const canvas = region.canvas;
      if (!canvas || !canvas.isConnected) {
        region.viewportRects = [];
        continue;
      }
      const cr = canvas.getBoundingClientRect();
      region.viewportRects = region.rects.map((r) => ({
        left: cr.left + r.cssLeft,
        top: cr.top + r.cssTop,
        right: cr.left + r.cssLeft + r.cssWidth,
        bottom: cr.top + r.cssTop + r.cssHeight,
      }));
    }
  }

  function regionAtPoint(x, y) {
    for (const region of greenRegions) {
      for (const r of region.viewportRects || []) {
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          return region;
        }
      }
    }
    return null;
  }

  function onMouseMove(e) {
    if (!enabled) return;
    const x = e.clientX, y = e.clientY;
    // If the pointer is on the popup itself, keep it open.
    if (popupHost && popupHost.style.display !== "none") {
      const r = popupHost.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        clearTimeout(popupHideTimer);
        return;
      }
    }
    const match = regionAtPoint(x, y);
    if (match) {
      if (match !== hoveredRegion) {
        hoveredRegion = match;
        showPopupFor(match);
      } else {
        clearTimeout(popupHideTimer);
      }
    } else if (hoveredRegion) {
      schedulePopupHide();
    }
  }

  // --- In-place replacement via a synthetic paste on Docs' hidden text
  // iframe ---------------------------------------------------------------
  //
  // Google Docs routes all keyboard/clipboard input through a hidden
  // <iframe class="docs-texteventtarget-iframe"> whose body is content-
  // editable. Kix listens for `paste` events on that body and inserts
  // the pasted text into the document, replacing whatever selection
  // exists. Crucially, it doesn't check `event.isTrusted`, so we can
  // build a paste event ourselves with the compiled Unicode as its
  // clipboardData and dispatch it there. No dialog, no clipboard
  // pollution, no UI.
  //
  // Requirement: the user has to have the LaTeX equation selected in
  // the document before clicking Compile. Kix's selection lives inside
  // its canvas model and we can't read or set it from a content script.

  const LOG = (...args) => console.warn("[docslatex]", ...args);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function findDocsIframe() {
    const iframes = document.querySelectorAll("iframe");
    LOG("scanning", iframes.length, "iframes");
    const editableFrames = [];
    for (const f of iframes) {
      let body = null;
      try { body = f.contentDocument && f.contentDocument.body; } catch (_) {}
      const cls = f.className || "(no class)";
      if (!body) {
        LOG(" iframe", cls, "— no body accessible");
        continue;
      }
      const ce = body.isContentEditable || body.contentEditable === "true";
      LOG(" iframe", cls, "contentEditable:", ce, "bodyTag:", body.tagName);
      if (cls.includes("texteventtarget") || ce) {
        editableFrames.push(f);
      }
    }
    return editableFrames[0] || null;
  }

  function dispatchPaste(target, text) {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    const evt = new ClipboardEvent("paste", {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    try {
      if (!evt.clipboardData) {
        Object.defineProperty(evt, "clipboardData", { value: dt });
      }
    } catch (_) {}
    LOG(
      "paste event clipboardData present?",
      !!evt.clipboardData,
      "types:",
      evt.clipboardData && evt.clipboardData.types
    );
    target.dispatchEvent(evt);
    return !evt.defaultPrevented;
  }

  function dispatchBeforeInput(target, text) {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    const evt = new InputEvent("beforeinput", {
      inputType: "insertFromPaste",
      data: text,
      dataTransfer: dt,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    target.dispatchEvent(evt);
    target.dispatchEvent(
      new InputEvent("input", {
        inputType: "insertFromPaste",
        data: text,
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
        composed: true,
      })
    );
    return !evt.defaultPrevented;
  }

  async function selectRegionOnCanvas(region) {
    const canvas = region.canvas;
    if (!canvas || !canvas.isConnected) { LOG("region canvas missing"); return false; }
    const rects = region.viewportRects || [];
    if (!rects.length) { LOG("region has no viewport rects"); return false; }

    // Drag from the first rect's left edge to the last rect's right edge.
    // Insetting by a hair keeps the hits inside the glyph boxes.
    const first = rects[0];
    const last = rects[rects.length - 1];
    const x1 = first.left + 0.5;
    const y1 = (first.top + first.bottom) / 2;
    const x2 = last.right - 0.5;
    const y2 = (last.top + last.bottom) / 2;
    LOG("dragging selection", { x1, y1, x2, y2 });

    const common = {
      bubbles: true, cancelable: true, composed: true, view: window,
      button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true,
    };
    const send = (type, x, y, buttons) => {
      const init = { ...common, clientX: x, clientY: y, buttons };
      try {
        const E = type.startsWith("pointer") ? PointerEvent : MouseEvent;
        canvas.dispatchEvent(new E(type, init));
      } catch (_) {}
    };

    send("pointerdown", x1, y1, 1);
    send("mousedown",   x1, y1, 1);
    await sleep(30);
    // A couple of intermediate moves help drag-selection handlers that
    // only kick in once motion is detected.
    send("pointermove", (x1 + x2) / 2, (y1 + y2) / 2, 1);
    send("mousemove",   (x1 + x2) / 2, (y1 + y2) / 2, 1);
    await sleep(10);
    send("pointermove", x2, y2, 1);
    send("mousemove",   x2, y2, 1);
    await sleep(30);
    send("pointerup",   x2, y2, 0);
    send("mouseup",     x2, y2, 0);
    await sleep(60);
    return true;
  }

  async function replaceInDoc(region) {
    // Drag-select the LaTeX on the canvas so the forthcoming paste
    // replaces it instead of inserting alongside it.
    await selectRegionOnCanvas(region);

    const iframe = findDocsIframe();
    if (!iframe) {
      LOG("no Docs text-input iframe found");
      return false;
    }
    const doc = iframe.contentDocument;
    const body = doc && doc.body;
    if (!body) { LOG("iframe has no body"); return false; }

    const targets = [doc.activeElement, body, doc.documentElement].filter(
      (t, i, arr) => t && arr.indexOf(t) === i
    );
    LOG("paste targets:", targets.map((t) => t.tagName || "(?)"));

    let anyOk = false;
    for (const target of targets) {
      const pasteOk = dispatchPaste(target, region.compiled);
      const inputOk = dispatchBeforeInput(target, region.compiled);
      LOG(
        "  →",
        target.tagName,
        "paste notPrevented:",
        pasteOk,
        "beforeinput notPrevented:",
        inputOk
      );
      anyOk = anyOk || pasteOk || inputOk;
    }
    return anyOk;
  }

  let popupBusy = false;

  async function onCompileClick() {
    LOG("Compile clicked");
    if (!hoveredRegion || popupBusy) {
      LOG("skip: hovered=", !!hoveredRegion, "busy=", popupBusy);
      return;
    }
    const region = hoveredRegion;
    popupBusy = true;
    flashToast("Typing…", true);
    let ok = false;
    try {
      ok = await replaceInDoc(region);
    } catch (err) {
      LOG("replaceInDoc threw:", err);
      ok = false;
    }
    popupBusy = false;
    if (ok) {
      compile();
      flashToast("Done");
    } else {
      flashToast("Failed — see console");
    }
  }

  function flashToast(text, keepOpen) {
    if (!popupBtn || !popupLabel) return;
    popupBtn.classList.add("is-toast");
    popupLabel.textContent = text;
    clearTimeout(popupHideTimer);
    if (!keepOpen) {
      popupHideTimer = setTimeout(hidePopupImmediately, 1400);
    }
  }

  document.addEventListener(FLUSH_EVENT, (ev) => {
    latest = ev.detail || [];
    if (enabled) rebuild();
  });

  window.addEventListener("resize", syncPositions, { passive: true });

  // Kix renders each text caret (local + any collaborators) as a
  // `.kix-cursor-caret` element. In the common single-user case there's
  // only one; just return the first visible one.
  function findUserCaretRect() {
    const carets = document.querySelectorAll(".kix-cursor-caret");
    for (const caret of carets) {
      const r = caret.getBoundingClientRect();
      if (r.height > 0) return r;
    }
    return null;
  }

  // Horizontal slack so the caret counts as "touching" even when it
  // sits just outside the glyph's reported right edge (sub-pixel
  // measurement vs. Kix's caret placement).
  const CARET_TOUCH_SLOP = 4;

  function regionAtCaret(caretRect) {
    if (!caretRect) return null;
    for (const region of greenRegions) {
      for (const r of region.viewportRects || []) {
        if (
          caretRect.left <= r.right + CARET_TOUCH_SLOP &&
          caretRect.right >= r.left - CARET_TOUCH_SLOP &&
          caretRect.top <= r.bottom &&
          caretRect.bottom >= r.top
        ) {
          return region;
        }
      }
    }
    return null;
  }

  function updateCaretHighlight() {
    const match = regionAtCaret(findUserCaretRect());
    if (match === caretRegion) return;
    const previous = caretRegion;
    if (caretRegion) paintRegion(caretRegion, false);
    caretRegion = match;
    if (match) paintRegion(match, true);
    // Auto-compile on the "leaving" transition (dark → normal), but
    // only if the previous region still exists — otherwise rebuild
    // already dropped it, which isn't a user-initiated leave.
    if (previous && previous !== match && autocompile &&
        greenRegions.includes(previous)) {
      triggerAutoCompile(previous);
    }
  }

  async function triggerAutoCompile(region) {
    if (popupBusy) return;
    popupBusy = true;
    try {
      const ok = await replaceInDoc(region);
      if (ok) compile();
    } catch (err) {
      LOG("auto-compile threw:", err);
    }
    popupBusy = false;
  }

  // rAF loop catches layout changes (zoom, Kix re-layout, canvas pool
  // churn) that don't fire resize. Scroll itself no longer needs syncing
  // because the overlay lives in the same DOM subtree as the canvas.
  function tick() {
    if (enabled) {
      syncPositions();
      syncRegionViewportRects();
      updateCaretHighlight();
      if (hoveredRegion) repositionPopup();
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // ------------------------------------------------------------------
  // Enable/disable wiring.
  // ------------------------------------------------------------------

  function signalPageWorld(on) {
    document.dispatchEvent(new CustomEvent(SET_ENABLED_EVENT, { detail: on }));
  }

  function startPoll() {
    if (pollTimer) return;
    enabled = true;
    injectAll();
    pollTimer = setInterval(injectAll, 2000);
    signalPageWorld(true);
    document.addEventListener("mousemove", onMouseMove, { passive: true });
    rebuild();
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    enabled = false;
    removeAll();
    clearOverlays();
    document.removeEventListener("mousemove", onMouseMove);
    hidePopupImmediately();
    caretRegion = null;
    greenRegions = [];
    signalPageWorld(false);
  }

  chrome.storage.local.get(
    { enabled: false, autocompile: false, debug_mode: false },
    (data) => {
      autocompile = !!data.autocompile;
      debugMode = !!data.debug_mode;
      if (data.enabled) startPoll();
    }
  );

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.enabled) {
      if (changes.enabled.newValue) startPoll();
      else stopPoll();
    }
    if (changes.autocompile) {
      autocompile = !!changes.autocompile.newValue;
    }
    if (changes.debug_mode) {
      debugMode = !!changes.debug_mode.newValue;
      if (enabled) rebuild();
    }
  });
})();
