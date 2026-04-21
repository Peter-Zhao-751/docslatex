(() => {
  const btn = document.getElementById("greet");
  const counter = document.getElementById("counter");
  const dateEl = document.getElementById("date");
  const label = btn.querySelector(".btn__label");
  const autocompileInput = document.getElementById("autocompile");
  const debugInput = document.getElementById("debug");
  const longpressMenu = document.getElementById("longpress-menu");
  const lpWith = document.getElementById("lp-with");
  const lpWithout = document.getElementById("lp-without");

  // Date in the meta line — tasteful, abbreviated.
  if (dateEl) {
    const fmt = new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    dateEl.textContent = fmt.format(new Date()).toUpperCase();
  }

  // Pointer-tracked accent glow on the button.
  btn.addEventListener("pointermove", (e) => {
    const r = btn.getBoundingClientRect();
    btn.style.setProperty("--mx", `${e.clientX - r.left}px`);
    btn.style.setProperty("--my", `${e.clientY - r.top}px`);
  });

  // ---------------------------------------------------------------------
  // Persistent storage. Use chrome.storage.local in the extension context,
  // fall back to localStorage when previewed as a plain web page.
  // ---------------------------------------------------------------------
  const hasChromeStorage =
    typeof chrome !== "undefined" &&
    chrome.storage &&
    chrome.storage.local;

  const store = {
    get(keys) {
      if (hasChromeStorage) {
        return new Promise((resolve) =>
          chrome.storage.local.get(keys, (v) => resolve(v || {}))
        );
      }
      const out = {};
      for (const k of Object.keys(keys)) {
        const raw = localStorage.getItem(k);
        out[k] = raw === null ? keys[k] : JSON.parse(raw);
      }
      return Promise.resolve(out);
    },
    set(obj) {
      if (hasChromeStorage) {
        return new Promise((resolve) =>
          chrome.storage.local.set(obj, resolve)
        );
      }
      for (const [k, v] of Object.entries(obj)) {
        localStorage.setItem(k, JSON.stringify(v));
      }
      return Promise.resolve();
    },
  };

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  let enabled = false;
  let autocompile = false;
  let debugMode = false;
  let count = 0;

  const renderCounter = () => {
    const word = count === 1 ? "equation" : "equations";
    counter.textContent = `${count.toLocaleString()} ${word} compiled`;
    counter.classList.toggle("is-active", count > 0);
  };

  const renderToggle = () => {
    btn.classList.toggle("is-on", enabled);
    btn.setAttribute("aria-pressed", String(enabled));
    label.textContent = enabled ? "Enabled" : "Enable";
  };

  const renderAutocompile = () => {
    autocompileInput.checked = autocompile;
  };

  const renderDebug = () => {
    debugInput.checked = debugMode;
  };

  // Boot
  store
    .get({
      enabled: false,
      autocompile: false,
      debug_mode: false,
      equations_compiled: 0,
    })
    .then(
      ({
        enabled: e,
        autocompile: a,
        debug_mode: d,
        equations_compiled: n,
      }) => {
        enabled = !!e;
        autocompile = !!a;
        debugMode = !!d;
        count = Number(n) || 0;
        renderToggle();
        renderAutocompile();
        renderDebug();
        renderCounter();
      }
    );

  // ---------------------------------------------------------------------
  // Long-press logic
  // ---------------------------------------------------------------------
  let longPressTimer = null;
  let longPressTriggered = false;
  const LONG_PRESS_MS = 500;

  const showMenu = () => {
    longpressMenu.classList.add("is-visible");
    longpressMenu.setAttribute("aria-hidden", "false");
  };

  const hideMenu = () => {
    longpressMenu.classList.remove("is-visible");
    longpressMenu.setAttribute("aria-hidden", "true");
  };

  btn.addEventListener("pointerdown", () => {
    longPressTriggered = false;
    longPressTimer = setTimeout(() => {
      longPressTriggered = true;
      showMenu();
    }, LONG_PRESS_MS);
  });

  btn.addEventListener("pointerup", () => {
    clearTimeout(longPressTimer);
  });

  btn.addEventListener("pointerleave", () => {
    clearTimeout(longPressTimer);
  });

  // Normal click — only fires if long press did NOT trigger
  btn.addEventListener("click", () => {
    if (longPressTriggered) {
      longPressTriggered = false;
      return;
    }
    enabled = !enabled;
    renderToggle();

    btn.classList.remove("is-pressed");
    void btn.offsetWidth;
    btn.classList.add("is-pressed");

    store.set({ enabled });
  });

  // Long-press menu options
  lpWith.addEventListener("click", () => {
    enabled = true;
    autocompile = true;
    renderToggle();
    renderAutocompile();
    store.set({ enabled, autocompile });
    hideMenu();

    btn.classList.remove("is-pressed");
    void btn.offsetWidth;
    btn.classList.add("is-pressed");
  });

  lpWithout.addEventListener("click", () => {
    enabled = true;
    autocompile = false;
    renderToggle();
    renderAutocompile();
    store.set({ enabled, autocompile });
    hideMenu();

    btn.classList.remove("is-pressed");
    void btn.offsetWidth;
    btn.classList.add("is-pressed");
  });

  // Dismiss menu on outside click
  document.addEventListener("pointerdown", (e) => {
    if (
      longpressMenu.classList.contains("is-visible") &&
      !longpressMenu.contains(e.target) &&
      e.target !== btn
    ) {
      hideMenu();
    }
  });

  // ---------------------------------------------------------------------
  // Autocompile toggle
  // ---------------------------------------------------------------------
  autocompileInput.addEventListener("change", () => {
    autocompile = autocompileInput.checked;
    store.set({ autocompile });
  });

  debugInput.addEventListener("change", () => {
    debugMode = debugInput.checked;
    store.set({ debug_mode: debugMode });
  });

  // Keep the popup in sync if storage changes elsewhere (e.g. a content
  // script bumps the equation count while the popup is open).
  if (hasChromeStorage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.equations_compiled) {
        count = Number(changes.equations_compiled.newValue) || 0;
        renderCounter();
      }
      if (changes.enabled) {
        enabled = !!changes.enabled.newValue;
        renderToggle();
      }
      if (changes.autocompile) {
        autocompile = !!changes.autocompile.newValue;
        renderAutocompile();
      }
      if (changes.debug_mode) {
        debugMode = !!changes.debug_mode.newValue;
        renderDebug();
      }
    });
  }
})();
