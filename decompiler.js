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

    leq: "≤", geq: "≥",
    neq: "≠", approx: "≈", equiv: "≡",
    sim: "∼", simeq: "≃", cong: "≅", doteq: "≐",
    ll: "≪", gg: "≫", prec: "≺", succ: "≻",
    preceq: "⪯", succeq: "⪰", propto: "∝",
    models: "⊨", vdash: "⊢", dashv: "⊣",

    subset: "⊂", supset: "⊃", subseteq: "⊆", supseteq: "⊇",
    subsetneq: "⊊", supsetneq: "⊋",
    in: "∈", notin: "∉", ni: "∋",
    cup: "∪", cap: "∩",
    emptyset: "∅", setminus: "∖",

    forall: "∀", exists: "∃", nexists: "∄",
    neg: "¬",
    wedge: "∧", vee: "∨",
    therefore: "∴", because: "∵", blacksquare: "∎",

    sum: "∑", prod: "∏", coprod: "∐",
    int: "∫", oint: "∮", iint: "∬", iiint: "∭",
    bigcup: "⋃", bigcap: "⋂",
    bigoplus: "⨁", bigotimes: "⨂", bigodot: "⨀",

    infty: "∞", partial: "∂", nabla: "∇",
    angle: "∠", measuredangle: "∡", sphericalangle: "∢",
    perp: "⊥", parallel: "∥", nparallel: "∦",
    top: "⊤",
    aleph: "ℵ", beth: "ℶ", gimel: "ℷ", daleth: "ℸ",
    hbar: "ℏ", ell: "ℓ",
    Re: "ℜ", Im: "ℑ", wp: "℘",
    degree: "°",

    cdots: "⋯", ldots: "…", vdots: "⋮", ddots: "⋱",

    langle: "⟨", rangle: "⟩",
    lceil: "⌈", rceil: "⌉", lfloor: "⌊", rfloor: "⌋",

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
    hat: "̂",
    bar: "̄",
    tilde: "̃",
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

  const SYMBOL_TO_NAME = {};
  for (const name of Object.keys(SYMBOLS)) {
    const ch = SYMBOLS[name];
    if (!(ch in SYMBOL_TO_NAME)) SYMBOL_TO_NAME[ch] = name;
  }

  const SUPER_TO_CHAR = {};
  for (const k of Object.keys(SUPERSCRIPTS)) {
    const ch = SUPERSCRIPTS[k];
    if (!(ch in SUPER_TO_CHAR)) SUPER_TO_CHAR[ch] = k;
  }

  const SUB_TO_CHAR = {};
  for (const k of Object.keys(SUBSCRIPTS)) {
    const ch = SUBSCRIPTS[k];
    if (!(ch in SUB_TO_CHAR)) SUB_TO_CHAR[ch] = k;
  }

  const MATHBB_INV = {};
  for (const k of Object.keys(MATHBB)) MATHBB_INV[MATHBB[k]] = k;

  const ACCENT_INV = {};
  for (const name of Object.keys(ACCENTS)) {
    const combining = ACCENTS[name];
    if (!(combining in ACCENT_INV)) ACCENT_INV[combining] = name;
  }

  function codePoints(str) {
    return Array.from(str);
  }

  function isLetter(ch) {
    return ch !== undefined && /^[a-zA-Z]$/.test(ch);
  }

  // Fold combining accents: "x̂" (x + U+0302) → "\hat{x}".
  function convertAccents(s) {
    const chars = codePoints(s);
    const out = [];
    for (let i = 0; i < chars.length; i++) {
      const next = chars[i + 1];
      if (next && ACCENT_INV[next]) {
        out.push("\\" + ACCENT_INV[next] + "{" + chars[i] + "}");
        i++;
      } else {
        out.push(chars[i]);
      }
    }
    return out.join("");
  }

  // Consecutive mathbb chars collapse into a single \mathbb{...}.
  function convertMathbb(s) {
    const chars = codePoints(s);
    let out = "";
    let i = 0;
    while (i < chars.length) {
      if (MATHBB_INV[chars[i]]) {
        let run = "";
        while (i < chars.length && MATHBB_INV[chars[i]]) {
          run += MATHBB_INV[chars[i]];
          i++;
        }
        out += "\\mathbb{" + run + "}";
      } else {
        out += chars[i];
        i++;
      }
    }
    return out;
  }

  function findMatchingParen(s, openIdx) {
    let depth = 1;
    for (let i = openIdx + 1; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")") {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  // √( … ) folds via paren matching. Bare √x (no parens) — produced
  // when the canvas reads back the compiler's [√ | radicand] HTML
  // table as two adjacent glyphs — folds the next single Unicode
  // codepoint or {…} group as the radicand. A multi-char alphanum
  // run is also captured greedily so √x²+1 yields \sqrt{x²+1}; this
  // matches the compiler's HTML rendering where the entire radicand
  // sits in one cell under the vinculum.
  function convertSqrt(s) {
    let out = "";
    let i = 0;
    while (i < s.length) {
      if (s[i] === "√") {
        let j = i + 1;
        while (j < s.length && s[j] === " ") j++;
        if (s[j] === "(") {
          const end = findMatchingParen(s, j);
          if (end > 0) {
            const inner = s.substring(j + 1, end);
            out += "\\sqrt{" + convertSqrt(inner) + "}";
            i = end + 1;
            continue;
          }
        } else if (s[j] === "{") {
          let depth = 1;
          let k = j + 1;
          while (k < s.length && depth > 0) {
            if (s[k] === "\\") { k += 2; continue; }
            if (s[k] === "{") depth++;
            else if (s[k] === "}") depth--;
            if (depth > 0) k++;
          }
          if (depth === 0) {
            const inner = s.substring(j + 1, k);
            out += "\\sqrt{" + convertSqrt(inner) + "}";
            i = k + 1;
            continue;
          }
        } else if (j < s.length && !/\s/.test(s[j])) {
          // Greedy: consume an alphanum/script run as the radicand.
          // Matches what the compiler produces — the full radicand
          // sits in one cell — without overrunning into following
          // operators (= + − etc.) or punctuation.
          const RAD_CHAR = /[\p{L}\p{N}̀-ͯ⁰-₟₀-ₜ]/u;
          let k = j;
          // Always take at least one codepoint, then keep going as
          // long as we're inside an alphanum/scripted run.
          const cps = Array.from(s.substring(j));
          if (cps.length) {
            let consumed = cps[0].length;
            for (let m = 1; m < cps.length; m++) {
              if (!RAD_CHAR.test(cps[m])) break;
              consumed += cps[m].length;
            }
            const inner = s.substring(j, j + consumed);
            out += "\\sqrt{" + convertSqrt(inner) + "}";
            i = j + consumed;
            continue;
          }
        }
      }
      out += s[i];
      i++;
    }
    return out;
  }

  // C(n,k) → \binom{n}{k}. Mirrors the compiler's plain-text fallback
  // for \binom{n}{k} (`expandBinom` emits "C(n,k)" when no HTML cell
  // structure is in play). The leading `C` only matches when it isn't
  // itself part of a longer identifier ("ABC(x,y)" stays a function
  // call) and the comma split is at top-level paren depth so nested
  // parens in either argument survive.
  function convertBinom(s) {
    let out = "";
    let i = 0;
    while (i < s.length) {
      if (s[i] === "C" && (i === 0 || !/[a-zA-Z\\]/.test(s[i - 1]))) {
        let j = i + 1;
        while (j < s.length && s[j] === " ") j++;
        if (s[j] === "(") {
          const end = findMatchingParen(s, j);
          if (end > 0) {
            const inner = s.substring(j + 1, end);
            let depth = 0, splitIdx = -1;
            for (let k = 0; k < inner.length; k++) {
              const ch = inner[k];
              if (ch === "(") depth++;
              else if (ch === ")") depth--;
              else if (ch === "," && depth === 0) { splitIdx = k; break; }
            }
            if (splitIdx >= 0) {
              const num = inner.substring(0, splitIdx).trim();
              const den = inner.substring(splitIdx + 1).trim();
              out += "\\binom{" + convertBinom(num) +
                     "}{" + convertBinom(den) + "}";
              i = end + 1;
              continue;
            }
          }
        }
      }
      out += s[i];
      i++;
    }
    return out;
  }

  function convertFrac(s) {
    let out = "";
    let i = 0;
    while (i < s.length) {
      if (s[i] === "(") {
        const end = findMatchingParen(s, i);
        if (end > 0 && s[end + 1] === "/" && s[end + 2] === "(") {
          const end2 = findMatchingParen(s, end + 2);
          if (end2 > 0) {
            const num = s.substring(i + 1, end);
            const den = s.substring(end + 3, end2);
            out += "\\frac{" + convertFrac(num) + "}{" + convertFrac(den) + "}";
            i = end2 + 1;
            continue;
          }
        }
      }
      out += s[i];
      i++;
    }
    return out;
  }

  // Runs of super/sub chars → ^{...} / _{...}.
  function convertScripts(s) {
    const chars = codePoints(s);
    let out = "";
    let i = 0;
    while (i < chars.length) {
      const ch = chars[i];
      if (SUPER_TO_CHAR[ch]) {
        let run = "";
        while (i < chars.length && SUPER_TO_CHAR[chars[i]]) {
          run += SUPER_TO_CHAR[chars[i]];
          i++;
        }
        out += run.length === 1 ? "^" + run : "^{" + run + "}";
      } else if (SUB_TO_CHAR[ch]) {
        let run = "";
        while (i < chars.length && SUB_TO_CHAR[chars[i]]) {
          run += SUB_TO_CHAR[chars[i]];
          i++;
        }
        out += run.length === 1 ? "_" + run : "_{" + run + "}";
      } else {
        out += ch;
        i++;
      }
    }
    return out;
  }

  // Replace any single-char Unicode symbol with \name. Append a trailing
  // space only when the following char is an ASCII letter, so \alphax
  // (which LaTeX reads as an undefined \alphax command) can't happen.
  function convertSymbols(s) {
    const chars = codePoints(s);
    let out = "";
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (SYMBOL_TO_NAME[ch]) {
        const name = SYMBOL_TO_NAME[ch];
        const sep = isLetter(chars[i + 1]) ? " " : "";
        out += "\\" + name + sep;
      } else {
        out += ch;
      }
    }
    return out;
  }

  // Backslash standalone function names (sin, cos, log, ...). Only match
  // when the word isn't touching a letter or existing \command.
  function convertTextOps(s) {
    const sorted = [...TEXT_OPS].sort((a, b) => b.length - a.length);
    for (const op of sorted) {
      const re = new RegExp("(^|[^a-zA-Z\\\\])" + op + "(?![a-zA-Z])", "g");
      s = s.replace(re, "$1\\" + op);
    }
    return s;
  }

  function unicodeToLatex(input) {
    if (typeof input !== "string") return "";
    let s = input;
    s = convertAccents(s);
    s = convertMathbb(s);
    s = convertSqrt(s);
    // convertBinom must run before convertFrac. Both consume `(...)`
    // groups, but `C(n,k)` doesn't contain `/` so the frac scanner
    // skips it on its own — the order matters only because we want
    // the binom name to win over any future numeric-context paren
    // rewriting. (Frac still scans for `(...)/(...)` after.)
    s = convertBinom(s);
    s = convertFrac(s);
    s = convertScripts(s);
    s = convertSymbols(s);
    s = convertTextOps(s);
    s = s.replace(/\n/g, "\\\\\n");
    return s;
  }

  // Quick test used by content.js to decide whether a run of canvas
  // text is worth offering a Decompile popup on. The bar is low: a
  // single convertible glyph anywhere in the string is enough. Accent
  // combining marks never appear on their own, so excluding them here
  // avoids creating noisy single-combining-char regions.
  function isDecompileable(ch) {
    return (
      SYMBOL_TO_NAME[ch] !== undefined ||
      SUPER_TO_CHAR[ch] !== undefined ||
      SUB_TO_CHAR[ch] !== undefined ||
      MATHBB_INV[ch] !== undefined ||
      ch === "√"
    );
  }

  function hasDecompileable(text) {
    if (typeof text !== "string") return false;
    // for..of walks by Unicode codepoint, so surrogate-pair glyphs
    // like 𝔸 are tested as single chars.
    for (const ch of text) {
      if (isDecompileable(ch)) return true;
    }
    return false;
  }

  const api = { unicodeToLatex, hasDecompileable };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.unicodeToLatex = unicodeToLatex;
    global.hasDecompileable = hasDecompileable;
    global.LatexDecompiler = api;
  }
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this));
