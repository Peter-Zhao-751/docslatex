(function (global) {
  "use strict";

  const SYMBOLS = {
    alpha: "α", beta: "β", gamma: "γ", delta: "δ",
    epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η",
    theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", varkappa: "ϰ",
    lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", omicron: "ο",
    pi: "π", varpi: "ϖ", rho: "ρ", varrho: "ϱ",
    sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ",
    phi: "φ", varphi: "ϕ", chi: "χ", psi: "ψ", omega: "ω",

    Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ",
    Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ",
    Phi: "Φ", Psi: "Ψ", Omega: "Ω",

    to: "→", gets: "←",
    rightarrow: "→", leftarrow: "←",
    Rightarrow: "⇒", Leftarrow: "⇐",
    leftrightarrow: "↔", Leftrightarrow: "⇔",
    uparrow: "↑", downarrow: "↓", updownarrow: "↕",
    Uparrow: "⇑", Downarrow: "⇓", Updownarrow: "⇕",
    mapsto: "↦", longmapsto: "⟼",
    longrightarrow: "⟶", longleftarrow: "⟵",
    longleftrightarrow: "⟷",
    Longrightarrow: "⟹", Longleftarrow: "⟸",
    Longleftrightarrow: "⟺",
    hookrightarrow: "↪", hookleftarrow: "↩",
    nearrow: "↗", searrow: "↘", swarrow: "↙", nwarrow: "↖",
    rightharpoonup: "⇀", leftharpoonup: "↼",
    implies: "⟹", impliedby: "⟸", iff: "⟺",

    pm: "±", mp: "∓", times: "×", div: "÷",
    cdot: "·", ast: "∗", star: "⋆", circ: "∘",
    bullet: "•", oplus: "⊕", ominus: "⊖", otimes: "⊗",
    oslash: "⊘", odot: "⊙", dagger: "†", ddagger: "‡",

    le: "≤", leq: "≤", ge: "≥", geq: "≥",
    neq: "≠", ne: "≠", approx: "≈", equiv: "≡",
    sim: "∼", simeq: "≃", cong: "≅", doteq: "≐",
    ll: "≪", gg: "≫", prec: "≺", succ: "≻",
    preceq: "⪯", succeq: "⪰", propto: "∝",
    models: "⊨", vdash: "⊢", dashv: "⊣",

    subset: "⊂", supset: "⊃", subseteq: "⊆", supseteq: "⊇",
    subsetneq: "⊊", supsetneq: "⊋",
    in: "∈", notin: "∉", ni: "∋",
    cup: "∪", cap: "∩",
    emptyset: "∅", varnothing: "∅", setminus: "∖",

    forall: "∀", exists: "∃", nexists: "∄",
    neg: "¬", lnot: "¬",
    wedge: "∧", land: "∧", vee: "∨", lor: "∨",
    therefore: "∴", because: "∵", blacksquare: "∎",

    sum: "∑", prod: "∏", coprod: "∐",
    int: "∫", oint: "∮", iint: "∬", iiint: "∭",
    bigcup: "⋃", bigcap: "⋂",
    bigoplus: "⨁", bigotimes: "⨂", bigodot: "⨀",

    infty: "∞", partial: "∂", nabla: "∇",
    angle: "∠", measuredangle: "∡", sphericalangle: "∢",
    perp: "⊥", parallel: "∥", nparallel: "∦",
    top: "⊤", bot: "⊥",
    aleph: "ℵ", beth: "ℶ", gimel: "ℷ", daleth: "ℸ",
    hbar: "ℏ", ell: "ℓ",
    Re: "ℜ", Im: "ℑ", wp: "℘",
    degree: "°",

    cdots: "⋯", ldots: "…", dots: "…", vdots: "⋮", ddots: "⋱",

    langle: "⟨", rangle: "⟩",
    lceil: "⌈", rceil: "⌉", lfloor: "⌊", rfloor: "⌋",
    lbrace: "{", rbrace: "}", lbrack: "[", rbrack: "]",

    prime: "′", backprime: "‵",
  };

  const TEXT_OPS = [
    "sin", "cos", "tan", "sec", "csc", "cot",
    "arcsin", "arccos", "arctan",
    "sinh", "cosh", "tanh", "coth",
    "log", "ln", "lg", "exp",
    "lim", "limsup", "liminf", "sup", "inf",
    "max", "min", "arg",
    "det", "dim", "ker", "hom", "deg",
    "gcd", "lcm", "mod", "bmod", "pmod",
  ];

  const SPACING_WORDS = ["quad", "qquad", "thinspace", "medspace", "thickspace"];

  const SIZING_WORDS = [
    "big", "Big", "bigg", "Bigg",
    "bigl", "Bigl", "biggl", "Biggl",
    "bigr", "Bigr", "biggr", "Biggr",
    "bigm", "Bigm", "biggm", "Biggm",
  ];

  const STRIP_WRAPPERS = [
    "text", "textrm", "textbf", "textit", "textsf", "texttt",
    "mathrm", "mathbf", "mathit", "mathsf", "mathtt",
    "mathcal", "mathfrak", "mathscr", "operatorname",
  ];

  const SUPERSCRIPTS = {
    "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
    "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
    "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
    "a": "ᵃ", "b": "ᵇ", "c": "ᶜ", "d": "ᵈ", "e": "ᵉ",
    "f": "ᶠ", "g": "ᵍ", "h": "ʰ", "i": "ⁱ", "j": "ʲ",
    "k": "ᵏ", "l": "ˡ", "m": "ᵐ", "n": "ⁿ", "o": "ᵒ",
    "p": "ᵖ", "r": "ʳ", "s": "ˢ", "t": "ᵗ", "u": "ᵘ",
    "v": "ᵛ", "w": "ʷ", "x": "ˣ", "y": "ʸ", "z": "ᶻ",
    "A": "ᴬ", "B": "ᴮ", "D": "ᴰ", "E": "ᴱ", "G": "ᴳ",
    "H": "ᴴ", "I": "ᴵ", "J": "ᴶ", "K": "ᴷ", "L": "ᴸ",
    "M": "ᴹ", "N": "ᴺ", "O": "ᴼ", "P": "ᴾ", "R": "ᴿ",
    "T": "ᵀ", "U": "ᵁ", "V": "ⱽ", "W": "ᵂ",
  };

  const SUBSCRIPTS = {
    "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
    "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
    "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
    "a": "ₐ", "e": "ₑ", "h": "ₕ", "i": "ᵢ", "j": "ⱼ",
    "k": "ₖ", "l": "ₗ", "m": "ₘ", "n": "ₙ", "o": "ₒ",
    "p": "ₚ", "r": "ᵣ", "s": "ₛ", "t": "ₜ", "u": "ᵤ",
    "v": "ᵥ", "x": "ₓ",
  };

  const ACCENTS = {
    hat: "̂", widehat: "̂",
    bar: "̄", overline: "̄",
    tilde: "̃", widetilde: "̃",
    dot: "̇", ddot: "̈",
    vec: "⃗",
    check: "̌", breve: "̆",
    acute: "́", grave: "̀",
    mathring: "̊",
  };

  const MATHBB = {
    A: "𝔸", B: "𝔹", C: "ℂ", D: "𝔻", E: "𝔼", F: "𝔽",
    G: "𝔾", H: "ℍ", I: "𝕀", J: "𝕁", K: "𝕂", L: "𝕃",
    M: "𝕄", N: "ℕ", O: "𝕆", P: "ℙ", Q: "ℚ", R: "ℝ",
    S: "𝕊", T: "𝕋", U: "𝕌", V: "𝕍", W: "𝕎", X: "𝕏",
    Y: "𝕐", Z: "ℤ",
  };

  function findMatchingBrace(s, openIdx) {
    let depth = 1;
    for (let i = openIdx + 1; i < s.length; i++) {
      if (s[i] === "\\") { i++; continue; }
      if (s[i] === "{") depth++;
      else if (s[i] === "}") {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function mapChars(str, table) {
    let out = "";
    let allMapped = true;
    for (const ch of str) {
      if (table[ch] !== undefined) out += table[ch];
      else { out += ch; allMapped = false; }
    }
    return { text: out, allMapped };
  }

  function expandFrac(s) {
    let idx;
    while ((idx = s.indexOf("\\frac{")) >= 0) {
      const aStart = idx + "\\frac{".length;
      const aEnd = findMatchingBrace(s, aStart - 1);
      if (aEnd < 0) break;
      if (s[aEnd + 1] !== "{") break;
      const bStart = aEnd + 2;
      const bEnd = findMatchingBrace(s, bStart - 1);
      if (bEnd < 0) break;
      const num = s.substring(aStart, aEnd);
      const den = s.substring(bStart, bEnd);
      s = s.substring(0, idx) + "(" + num + ")/(" + den + ")" + s.substring(bEnd + 1);
    }
    return s;
  }

  function expandSqrt(s) {
    let idx;
    while ((idx = s.indexOf("\\sqrt{")) >= 0) {
      const start = idx + "\\sqrt{".length;
      const end = findMatchingBrace(s, start - 1);
      if (end < 0) break;
      const inner = s.substring(start, end);
      s = s.substring(0, idx) + "√(" + inner + ")" + s.substring(end + 1);
    }
    return s;
  }

  function expandAccents(s) {
    for (const name of Object.keys(ACCENTS)) {
      const marker = "\\" + name + "{";
      let idx;
      while ((idx = s.indexOf(marker)) >= 0) {
        const start = idx + marker.length;
        const end = findMatchingBrace(s, start - 1);
        if (end < 0) break;
        const inner = s.substring(start, end);
        let combined = "";
        for (const ch of inner) combined += ch + ACCENTS[name];
        s = s.substring(0, idx) + combined + s.substring(end + 1);
      }
    }
    return s;
  }

  function expandMathbb(s) {
    const marker = "\\mathbb{";
    let idx;
    while ((idx = s.indexOf(marker)) >= 0) {
      const start = idx + marker.length;
      const end = findMatchingBrace(s, start - 1);
      if (end < 0) break;
      const inner = s.substring(start, end);
      let out = "";
      for (const ch of inner) out += MATHBB[ch] !== undefined ? MATHBB[ch] : ch;
      s = s.substring(0, idx) + out + s.substring(end + 1);
    }
    return s;
  }

  function stripWrappers(s) {
    for (const name of STRIP_WRAPPERS) {
      const marker = "\\" + name + "{";
      let idx;
      while ((idx = s.indexOf(marker)) >= 0) {
        const start = idx + marker.length;
        const end = findMatchingBrace(s, start - 1);
        if (end < 0) break;
        const inner = s.substring(start, end);
        s = s.substring(0, idx) + inner + s.substring(end + 1);
      }
    }
    return s;
  }

  function processScripts(s) {
    let out = "";
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if ((ch === "^" || ch === "_") && i + 1 < s.length) {
        const table = ch === "^" ? SUPERSCRIPTS : SUBSCRIPTS;
        let arg;
        let nextI;
        if (s[i + 1] === "{") {
          const end = findMatchingBrace(s, i + 1);
          if (end < 0) { out += ch; i++; continue; }
          arg = s.substring(i + 2, end);
          nextI = end + 1;
        } else {
          arg = s[i + 1];
          nextI = i + 2;
        }
        const res = mapChars(arg, table);
        if (res.allMapped) {
          out += res.text;
        } else {
          out += ch + (arg.length > 1 ? "(" + arg + ")" : arg);
        }
        i = nextI;
      } else {
        out += ch;
        i++;
      }
    }
    return out;
  }

  function expandStructures(s) {
    let prev;
    do {
      prev = s;
      s = stripWrappers(s);
      s = expandMathbb(s);
      s = expandAccents(s);
      s = expandFrac(s);
      s = expandSqrt(s);
    } while (s !== prev);
    return s;
  }

  function latexToUnicode(input) {
    if (typeof input !== "string") return "";
    let s = input;

    s = s.replace(/\\\[|\\\]|\\\(|\\\)/g, "");
    s = s.replace(/\$\$/g, "");
    s = s.replace(/\$/g, "");

    s = s.replace(/\\\\/g, "\n");

    s = s.replace(/\\left\./g, "").replace(/\\right\./g, "");
    s = s.replace(/\\left(?![a-zA-Z])/g, "").replace(/\\right(?![a-zA-Z])/g, "");
    for (const w of SIZING_WORDS) {
      s = s.replace(new RegExp("\\\\" + w + "(?![a-zA-Z])", "g"), "");
    }

    s = expandStructures(s);

    const commands = [
      ...Object.keys(SYMBOLS),
      ...TEXT_OPS,
      ...SPACING_WORDS,
    ].sort((a, b) => b.length - a.length);

    for (const name of commands) {
      const re = new RegExp("\\\\" + name + "(?![a-zA-Z])", "g");
      if (name in SYMBOLS) {
        s = s.replace(re, SYMBOLS[name]);
      } else if (TEXT_OPS.indexOf(name) >= 0) {
        s = s.replace(re, name);
      } else {
        s = s.replace(re, "");
      }
    }

    s = s.replace(/\\[,:;!]/g, "");
    s = s.replace(/\\ /g, " ");

    s = s.replace(/\\\{/g, "{").replace(/\\\}/g, "}");
    s = s.replace(/\\%/g, "%").replace(/\\&/g, "&").replace(/\\#/g, "#");
    s = s.replace(/\\_/g, "_").replace(/\\\^/g, "^");

    s = processScripts(s);

    s = s.replace(/[{}]/g, "");
    s = s.replace(/ /g, "");
    return s;
  }

  const api = { latexToUnicode };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.latexToUnicode = latexToUnicode;
    global.LatexCompiler = api;
  }
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this));
