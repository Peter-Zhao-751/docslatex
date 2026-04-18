(() => {
  const FLOAT_ID = "docslatex-float-btn";
  const TOOLBAR_ID = "docslatex-toolbar-btn";
  const LABEL_ID = "docslatex-label";
  const logoURL = chrome.runtime.getURL("logo.png");

  let pollTimer = null;

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
      <button title="Compile LaTeX" aria-label="Compile LaTeX">
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
    wrapper.setAttribute("aria-label", "Compile LaTeX");
    wrapper.setAttribute("data-tooltip", "Compile LaTeX");
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

  // -- Poll to keep all three injected --
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

  function startPoll() {
    if (pollTimer) return;
    injectAll();
    pollTimer = setInterval(injectAll, 2000);
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    removeAll();
  }

  chrome.storage.local.get({ enabled: false }, (data) => {
    if (data.enabled) startPoll();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.enabled) {
      if (changes.enabled.newValue) startPoll();
      else stopPoll();
    }
  });
})();
