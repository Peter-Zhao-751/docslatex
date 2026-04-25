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

  // Purple palette for "decompile" regions — runs of Unicode math
  // glyphs (α, β, ², ₁, ⊂, →, 𝔸, …) that we can round-trip back to
  // LaTeX source. Same pattern as green: underline always visible,
  // background tint only in debug mode, darker shade when the region
  // is the current hover target.
  const PURPLE_BG = "rgba(156, 39, 176, 0.14)";
  const PURPLE_BORDER = "#9c27b0";
  const PURPLE_BG_HOVER = "rgba(106, 27, 154, 0.34)";
  const PURPLE_BORDER_HOVER = "#6a1b9a";

  // Picks the right palette for a region based on its .type. Keeps
  // paintRegion and populateMarks from sprouting parallel if/else
  // trees everywhere we need a color.
  function regionPalette(region) {
    if (region && region.type === "decompile") {
      return {
        bg: PURPLE_BG,
        border: PURPLE_BORDER,
        bgHover: PURPLE_BG_HOVER,
        borderHover: PURPLE_BORDER_HOVER,
      };
    }
    return {
      bg: GREEN_BG,
      border: GREEN_BORDER,
      bgHover: GREEN_BG_HOVER,
      borderHover: GREEN_BORDER_HOVER,
    };
  }

  function paintRegion(region, hovered) {
    if (!region || !region.marks) return;
    const p = regionPalette(region);
    let bg, border;
    if (hovered) {
      // Caret-touched: dark underline always; dark highlight only in
      // debug mode.
      border = p.borderHover;
      bg = debugMode ? p.bgHover : "transparent";
    } else {
      // Not touched: underline always visible; highlight only in debug.
      border = p.border;
      bg = debugMode ? p.bg : "transparent";
    }
    for (const mark of region.marks) {
      if (!mark) continue;
      mark.box.style.background = bg;
      mark.under.style.background = border;
    }
  }

  // Rich compile: produces either a plain Unicode string or a structured
  // { kind: "fraction" | "matrix", ... } object that the paste path turns
  // into a native Docs table via text/html.
  function compileRich(latex) {
    if (typeof window.latexToRich === "function") {
      return window.latexToRich(latex);
    }
    if (typeof window.latexToUnicode === "function") {
      return { kind: "text", value: window.latexToUnicode(latex) };
    }
    return { kind: "text", value: latex };
  }

  // Canvas scratch for width measurement. Font is set fresh per render
  // call so measurements track the final cell font size.
  const richScratch = document.createElement("canvas").getContext("2d");
  const richMeasure = (text) =>
    Math.ceil(richScratch.measureText(String(text)).width);

  // Content may now include HTML like "a<sub>b</sub>c". Canvas can't
  // measure that directly — strip tags first and measure the visible
  // text. Subscripts/superscripts render narrower than full-size glyphs,
  // so the stripped-text measurement slightly overestimates the true
  // width, which errs on the side of "cell is a bit wider" rather than
  // "text wraps".
  const stripHTMLTags = (s) => String(s).replace(/<[^>]*>/g, "");

  // CSS points → CSS pixels at the standard 96 DPI web resolution.
  // Canvas measureText returns CSS pixels when font is set in pt, so
  // this is the conversion we need when we combine a pt-based padding
  // budget with a px-based content width.
  const PT_TO_PX = 96 / 72;

  // Safety slack in ems for cells whose neighbors aren't adjacent
  // math content. Canvas measureText reports widths in *our*
  // browser's Arial; after paste, Docs renders with a slightly
  // different font stack, so real widths can drift a few percent
  // wider than measured. Matrix and text cells absorb that drift
  // with this budget.
  const CELL_SAFETY_EM = 0.15;

  // Total horizontal padding per side of each cell kind. Fraction
  // cells are tighter than the others — the bar ends nearly flush
  // with the widest digit, which reads cleanest for inline math.
  const FRAC_SIDE_PAD_EM = 0.075;
  // \binom{n}{k} content cells get a bit more horizontal slack than a
  // bare fraction. The enclosing `(` and `)` glyphs sit tight against
  // the inner column's left/right edges — fractions have only the
  // horizontal bar above/below, so they tolerate a narrower column
  // without looking cramped. This constant is only used by
  // buildChooseHTML; fractions stay on FRAC_SIDE_PAD_EM.
  const CHOOSE_SIDE_PAD_EM = 0.2;
  // Matrix has two spacing knobs the other structures don't need:
  //
  // MATRIX_SIDE_PAD_EM — horizontal slack inside each matrix column
  // cell. Multi-char content with superscripts (`-2a`, `3a^2`) renders
  // a hair wider in Docs than it measures on the Arial scratch canvas,
  // so the column pad is ~1.3× the baseline 0.25em to keep content
  // inside its cell without collisions.
  const MATRIX_SIDE_PAD_EM = 0.325;
  // MATRIX_TEXT_SIBLING_PAD_EM — slack around a text cell that sits
  // directly next to a matrix (or a cases block). Zero would leave the
  // `+`/`=` glyph touching the bracket/brace, which reads cramped;
  // this pad unsticks them and gives leading/trailing text in a
  // nested sequence (e.g. "x = " before a √ or a \binom) a visible
  // breathing room.
  // Non-matrix sequences stick with SEQ_TEXT_PAD_EM (=0) since their
  // text sits next to a fraction bar / open space, not a bracket edge.
  const MATRIX_TEXT_SIBLING_PAD_EM = 0.2;
  const TEXT_SIDE_PAD_EM = 0.15 + CELL_SAFETY_EM;
  // Text cells in any sequence builder are measured to their exact
  // rendered width — no side slack. Keeps text flush against adjacent
  // structural blocks (matrix bracket, fraction bar, cases brace) and
  // matches what structural cells do (parseW → inner table's declared
  // width, no extra), so every cell type follows the same "natural
  // width" rule instead of each kind having its own gutter constant.
  const SEQ_TEXT_PAD_EM = 0;

  // Font-family pinned on every cell we emit. Measurements happen in
  // Arial on our scratch canvas, so forcing the rendered font to Arial
  // keeps Docs' actual layout in lockstep with our predicted widths.
  const CELL_FONT_FAMILY = "Arial,sans-serif";

  // Rendered math renders at the same size as the surrounding text.
  const SIZE_FACTOR = 1.0;

  // When Debug is on in the popup, every cell we emit draws a dashed
  // outline so we can see what Docs' paste importer actually keeps
  // (widths, cell boundaries, rowspan) vs. flattens. Color-coded by
  // role:
  //   cyan   — sequence text cell (rowspan=2 across num/den rows)
  //   red    — fraction num/den cell (standalone or in a sequence)
  //   orange — matrix cell
  const dbg = (color) =>
    debugMode ? `border:1px dashed ${color};` : `border:0;`;

  function setRichFont(pt) {
    richScratch.font = pt + "pt Arial, sans-serif";
  }

  // Inline <span>, not <p>: Docs treats pasted <p> as a full paragraph
  // and stacks its own before/after paragraph spacing on top of our
  // margin:0, which was inflating row height. A <span> is inline-only
  // and doesn't trigger paragraph formatting on paste. Horizontal
  // centering now falls to the cell's align="center" attribute.
  function richPara(pt, c) {
    return (
      `<span style="font-size:${pt}pt;line-height:1;">` +
      c +
      `</span>`
    );
  }

  function resolveRenderPt(sourcePt) {
    return Math.max(4, (sourcePt || 11) * SIZE_FACTOR);
  }

  // Cell width calculation, one place for everyone.
  //
  // Content is measured on the Arial scratch canvas at the exact pt
  // we'll render at, so contentPx is the true rendered width in CSS
  // pixels. The slack is a font-proportional em value converted to
  // CSS pixels (side-padding × 2 for both sides). No magic
  // multipliers — if measurement and render fonts match, the cell is
  // exactly wide enough for the content plus the requested gutter.
  function cellWidthPx(contentPx, pt, sidePadEm) {
    return Math.ceil(contentPx + pt * PT_TO_PX * sidePadEm * 2);
  }

  // Shared style for a cell that renders math at `pt`. Font-family
  // and font-size are pinned ON THE <td> (not just the inner <span>)
  // because Docs' paste importer is liberal about stripping styles
  // from inline elements inside cells — without an explicit cell
  // font-size, content can end up rendering at the cursor paragraph's
  // default size (11pt or whatever heading is active) instead of the
  // 7pt we intended. line-height:1 + padding:0 keeps the row height
  // tight. text-align:center in CSS (not just align="center" on the
  // <td>) because Docs respects the CSS property but frequently drops
  // the legacy HTML attribute.
  function mathCellStyle(pt, debugColor, textAlign) {
    return (
      `padding:0 !important;` +
      `border:none;` +
      `line-height:1;` +
      `white-space:nowrap;` +
      `text-align:${textAlign || "center"};` +
      `vertical-align:middle;` +
      `font-family:${CELL_FONT_FAMILY};` +
      `font-size:${pt}pt;` +
      `font-weight:normal;` +
      dbg(debugColor)
    );
  }

  // The inner fraction table (no <meta>, no outer wrapper) so it can
  // be reused verbatim both as a top-level paste and as a nested cell
  // inside a sequence's outer row.
  //
  // numHTML/denHTML may contain native <sub>/<sup> tags; we strip
  // them for measurement but pass them through as cell content so
  // Docs' paste importer picks up the subscript/superscript formatting.
  function buildFractionInnerHTML(numHTML, denHTML, pt) {
    setRichFont(pt);
    const contentPx = Math.max(
      richMeasure(stripHTMLTags(numHTML)),
      richMeasure(stripHTMLTags(denHTML))
    );
    const w = cellWidthPx(contentPx, pt, FRAC_SIDE_PAD_EM);
    const baseStyle = mathCellStyle(pt, "#f00");
    const cell = (c, rule) =>
      `<td align="center" width="${w}" height="1" style="${baseStyle}` +
      (rule ? "border-top:0.75pt solid #000;" : "") +
      `">${richPara(pt, c)}</td>`;
    // Table width pinned explicitly to the cell width (both the HTML
    // attribute and the CSS property). The previous `width:1px`
    // shrink-to-fit trick works in a normal browser but Docs' paste
    // importer honored the `1px` literally — the table collapsed to
    // 1px and Docs char-broke the numerator ("324" → "32" / "4") to
    // fit. The sequence path has always pinned the outer table to
    // `totalW` for this reason.
    return (
      `<table width="${w}" style="border-collapse:collapse;border:none;` +
      `table-layout:auto;width:${w}px;">` +
      `<tr>${cell(numHTML, false)}</tr>` +
      `<tr>${cell(denHTML, true)}</tr>` +
      `</table>`
    );
  }

  function buildFractionHTML(numHTML, denHTML, sourcePt) {
    const pt = resolveRenderPt(sourcePt);
    return `<meta charset="utf-8">${buildFractionInnerHTML(numHTML, denHTML, pt)}`;
  }

  // Binomial coefficient `\binom{n}{k}` / `{n \choose k}`: a 3-col ×
  // 2-row table. Column 0 and column 2 are rowspan=2 cells holding an
  // enlarged `(` / `)`; column 1 splits into num (row 1) and den (row
  // 2) — same cell pair as a fraction, minus the dividing rule. No
  // visible borders anywhere.
  //
  // The paren font-size is bumped so the glyph reads as a bracket
  // enclosing both rows rather than a normal-sized character
  // centered between them. 1.9× the body pt lands close to what
  // LaTeX's `\big(` does visually without a dedicated extensible
  // glyph.
  function buildChooseHTML(numHTML, denHTML, sourcePt) {
    const pt = resolveRenderPt(sourcePt);
    setRichFont(pt);
    const contentPx = Math.max(
      richMeasure(stripHTMLTags(numHTML)),
      richMeasure(stripHTMLTags(denHTML))
    );
    const w = cellWidthPx(contentPx, pt, CHOOSE_SIDE_PAD_EM);
    const contentStyle = mathCellStyle(pt, "#f0f");
    const contentCell = (c) =>
      `<td align="center" width="${w}" height="1" style="${contentStyle}">` +
      richPara(pt, c) +
      `</td>`;

    const parenPt = pt * 1.9;
    const parenStyle =
      `padding:0 !important;border:none;line-height:1;white-space:nowrap;` +
      `text-align:center;vertical-align:middle;` +
      `font-family:${CELL_FONT_FAMILY};` +
      `font-size:${parenPt}pt;font-weight:normal;` +
      dbg("#f0f");
    // Measure both glyphs — `(` and `)` can differ by a pixel or two in
    // any given font, and Docs sometimes honors width on one rowspan
    // cell but not the other if the glyph it contains happens to fit
    // below the declared width. Taking max + a small em-based slack
    // makes the declared width visibly wider than either glyph so Docs
    // can't shrink either column.
    setRichFont(parenPt);
    const parenGlyphPx = Math.max(richMeasure("("), richMeasure(")"));
    const parenW = cellWidthPx(parenGlyphPx, parenPt, 0.0);
    const parenCell = (ch) =>
      `<td rowspan="2" valign="middle" align="center" width="${parenW}" ` +
      `style="${parenStyle}">` +
      `<span style="font-size:${parenPt}pt;line-height:1;">${ch}</span>` +
      `</td>`;

    const totalW = parenW * 2 + w;
    return (
      `<meta charset="utf-8">` +
      `<table width="${totalW}" style="border-collapse:collapse;border:none;` +
      `table-layout:fixed;width:${totalW}px;">` +
      `<tr>${parenCell("(")}${contentCell(numHTML)}${parenCell(")")}</tr>` +
      `<tr>${contentCell(denHTML)}</tr>` +
      `</table>`
    );
  }

  // Inline renderer for a single matrix/cases cell that may contain a
  // mix of text, \frac, and \binom parts. Returns `{ html, width,
  // structural }`:
  //   - `structural === false`: cell is pure text; `html` is a string
  //     of valueHTML parts and the outer cell can wrap it in richPara.
  //   - `structural === true`: cell has at least one \frac or \binom;
  //     `html` is a complete <table> — a flat 2-row mini-grid where
  //     text parts span both rows and fraction/choose parts split into
  //     top/bottom halves. The outer cell must emit this html directly,
  //     not wrapped in richPara/<span> (invalid to put <table> inside
  //     <span>).
  function buildCellInner(parts, pt) {
    if (!parts || !parts.length) {
      return { html: "", width: 0, structural: false };
    }
    // Single-sqrt fast path: emit the radical's own table directly so
    // `\sqrt{x}` as a matrix cell or as a sibling of a matrix renders
    // with a vinculum instead of degrading to the text form `√(x)`. The
    // 2-row outer wrapper below is shaped for fraction/choose layouts
    // and would just nest the sqrt table redundantly.
    if (parts.length === 1 && parts[0].kind === "sqrt") {
      const part = parts[0];
      const sqrtInner = buildSqrtInnerHTML(
        part.contentHTML || part.content || "",
        pt
      );
      const m = /<table\s+width="(\d+)"/.exec(sqrtInner);
      const w = m ? parseInt(m[1], 10) : 0;
      return { html: sqrtInner, width: w, structural: true };
    }
    const hasStructure = parts.some(
      (p) => p.kind === "fraction" || p.kind === "choose"
    );
    if (!hasStructure) {
      setRichFont(pt);
      let html = "";
      let plain = "";
      for (const p of parts) {
        let v = "";
        let plainV = "";
        if (p.kind === "text") {
          v = p.valueHTML || p.value || "";
          plainV = p.value || "";
        } else if (p.kind === "sqrt") {
          const c = p.contentHTML || p.content || "";
          v = "√(" + c + ")";
          plainV = "√(" + (p.content || "") + ")";
        }
        html += v;
        plain += plainV;
      }
      return { html, width: richMeasure(plain), structural: false };
    }

    const topCells = [];
    const bottomCells = [];
    let totalW = 0;
    for (const part of parts) {
      if (part.kind === "text") {
        const valueHTML = part.valueHTML || part.value || "";
        if (!valueHTML) continue;
        setRichFont(pt);
        const w = cellWidthPx(
          richMeasure(stripHTMLTags(valueHTML)),
          pt,
          TEXT_SIDE_PAD_EM
        );
        totalW += w;
        const style =
          `padding:0 !important;border:none;white-space:nowrap;` +
          `line-height:1.15;text-align:center;vertical-align:middle;` +
          `font-family:${CELL_FONT_FAMILY};font-size:${pt}pt;` +
          `font-weight:normal;${dbg("#0cc")}`;
        topCells.push(
          `<td rowspan="2" valign="middle" align="center" width="${w}" ` +
          `height="1" style="${style}">${valueHTML}</td>`
        );
      } else if (part.kind === "sqrt") {
        // Embed the radical's own mini-table inside a rowspan=2 cell so
        // it sits inline with sibling fraction/choose blocks while still
        // showing the vinculum (the text fallback `√(x)` was clobbering
        // it). valign:middle centers the fixed-height sqrt inside the
        // taller 2-row outer cell.
        const sqrtInner = buildSqrtInnerHTML(
          part.contentHTML || part.content || "",
          pt
        );
        const m = /<table\s+width="(\d+)"/.exec(sqrtInner);
        const w = m ? parseInt(m[1], 10) : 0;
        totalW += w;
        const style =
          `padding:0 !important;border:none;line-height:1;` +
          `text-align:center;vertical-align:middle;${dbg("#a0f")}`;
        topCells.push(
          `<td rowspan="2" valign="middle" align="center" width="${w}" ` +
          `height="1" style="${style}">${sqrtInner}</td>`
        );
      } else if (part.kind === "fraction") {
        const numHTML = part.numHTML || part.num;
        const denHTML = part.denHTML || part.den;
        setRichFont(pt);
        const contentPx = Math.max(
          richMeasure(stripHTMLTags(numHTML)),
          richMeasure(stripHTMLTags(denHTML))
        );
        const w = cellWidthPx(contentPx, pt, FRAC_SIDE_PAD_EM);
        totalW += w;
        const numStyle = mathCellStyle(pt, "#f00");
        const denStyle =
          mathCellStyle(pt, "#f00") + "border-top:0.75pt solid #000;";
        topCells.push(
          `<td align="center" width="${w}" height="1" style="${numStyle}">` +
          numHTML + `</td>`
        );
        bottomCells.push(
          `<td align="center" width="${w}" height="1" style="${denStyle}">` +
          denHTML + `</td>`
        );
      } else if (part.kind === "choose") {
        const numHTML = part.numHTML || part.num;
        const denHTML = part.denHTML || part.den;
        setRichFont(pt);
        const contentPx = Math.max(
          richMeasure(stripHTMLTags(numHTML)),
          richMeasure(stripHTMLTags(denHTML))
        );
        const contentW = cellWidthPx(contentPx, pt, CHOOSE_SIDE_PAD_EM);
        const parenPt = pt * 1.9;
        setRichFont(parenPt);
        const parenGlyphPx = Math.max(richMeasure("("), richMeasure(")"));
        const parenW = cellWidthPx(parenGlyphPx, parenPt, 0.05);
        totalW += parenW * 2 + contentW;
        const contentStyle = mathCellStyle(pt, "#f0f");
        const parenStyle =
          `padding:0 !important;border:none;line-height:1;` +
          `white-space:nowrap;text-align:center;vertical-align:middle;` +
          `font-family:${CELL_FONT_FAMILY};font-size:${parenPt}pt;` +
          `font-weight:normal;${dbg("#f0f")}`;
        topCells.push(
          `<td rowspan="2" valign="middle" align="center" width="${parenW}" ` +
          `style="${parenStyle}">` +
          `<span style="font-size:${parenPt}pt;line-height:1;">(</span></td>` +
          `<td align="center" width="${contentW}" height="1" style="${contentStyle}">` +
          numHTML + `</td>` +
          `<td rowspan="2" valign="middle" align="center" width="${parenW}" ` +
          `style="${parenStyle}">` +
          `<span style="font-size:${parenPt}pt;line-height:1;">)</span></td>`
        );
        bottomCells.push(
          `<td align="center" width="${contentW}" height="1" style="${contentStyle}">` +
          denHTML + `</td>`
        );
      }
    }

    const html =
      `<table width="${totalW}" style="border-collapse:collapse;border:none;` +
      `table-layout:fixed;width:${totalW}px;">` +
      `<tr>${topCells.join("")}</tr>` +
      `<tr>${bottomCells.join("")}</tr>` +
      `</table>`;
    return { html, width: totalW, structural: true };
  }

  // Proper M×N table: one <tr> per matrix row, one <td> per column
  // in that row. "plain" renders without brackets; every other style
  // gets a thin bracket cell on the left and right of every row, with
  // top/bottom borders on the first/last row to form the corner ticks
  // of a `[` / `]`. (CSS-based parens/braces don't survive Docs' paste
  // importer, so [] stands in for all delimited variants for now.)
  //
  // rowsHTML carries the same grid but with native <sub>/<sup> tags
  // baked in where a cell had `_`/`^`; rows (Unicode-only) is used
  // for width measurement since Canvas can't measure HTML.
  function buildMatrixHTML(rows, style, sourcePt, rowsHTML, rowsParts) {
    if (!Array.isArray(rows) || !rows.length) return "";
    const rowCount = rows.length;
    const cols = Math.max(...rows.map((r) => (r ? r.length : 0)));
    if (!cols) return "";

    const pt = resolveRenderPt(sourcePt);
    setRichFont(pt);

    const useHTML = Array.isArray(rowsHTML) && rowsHTML.length === rowCount;
    const useParts = Array.isArray(rowsParts) && rowsParts.length === rowCount;
    const cellHTML = (r, c) => {
      if (useHTML && rowsHTML[r] && rowsHTML[r][c] != null) return rowsHTML[r][c];
      return rows[r] && rows[r][c] != null ? rows[r][c] : "";
    };
    const cellPlain = (r, c) =>
      rows[r] && rows[r][c] != null ? rows[r][c] : "";
    const cellParts = (r, c) =>
      useParts && rowsParts[r] && rowsParts[r][c] ? rowsParts[r][c] : null;

    // Pre-render each cell. Structural cells (contain \frac/\binom)
    // come back as a nested <table>; plain cells come back as a text
    // string that still needs richPara wrapping.
    const cellInner = [];
    for (let r = 0; r < rowCount; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        const parts = cellParts(r, c);
        if (parts) {
          row.push(buildCellInner(parts, pt));
        } else {
          row.push({ html: cellHTML(r, c), width: richMeasure(cellPlain(r, c)), structural: false });
        }
      }
      cellInner.push(row);
    }

    const columnWidths = [];
    for (let c = 0; c < cols; c++) {
      let maxW = 0;
      for (let r = 0; r < rowCount; r++) {
        const inner = cellInner[r][c];
        const w = inner.structural
          ? inner.width
          : cellWidthPx(inner.width, pt, MATRIX_SIDE_PAD_EM);
        maxW = Math.max(maxW, w);
      }
      columnWidths.push(maxW);
    }

    const matrixCellStyle = mathCellStyle(pt, "#fa0");
    const bracketed = style !== "plain";
    const BRACKET = "1.25pt solid #000";
    const BRACKET_CELL_W = 3;

    // Left/right bracket cells: left/right border on every row (those
    // collapse into one continuous vertical stroke under
    // border-collapse), plus top/bottom borders only on the first and
    // last rows so the corners read as `[` / `]` ticks rather than a
    // closed rectangle. vmatrix ("bar") renders vertical strokes only
    // — no corner ticks — so the style reads as `|…|` rather than `[…]`.
    const isBar = style === "bar" || style === "doublebar";
    const bracketCellStyle = (r, side) => {
      let s =
        `padding:0 !important;` +
        `line-height:1;` +
        `font-size:${pt}pt;` +
        (side === "L"
          ? `border-left:${BRACKET};border-right:0;`
          : `border-right:${BRACKET};border-left:0;`) +
        (r === 0 && !isBar ? `border-top:${BRACKET};` : `border-top:0;`) +
        (r === rowCount - 1 && !isBar
          ? `border-bottom:${BRACKET};`
          : `border-bottom:0;`);
      return s;
    };

    const trHTML = [];
    for (let r = 0; r < rowCount; r++) {
      const tds = [];
      if (bracketed) {
        tds.push(
          `<td width="${BRACKET_CELL_W}" style="${bracketCellStyle(r, "L")}">&nbsp;</td>`
        );
      }
      for (let c = 0; c < cols; c++) {
        const inner = cellInner[r][c];
        const content = inner.structural ? inner.html : richPara(pt, inner.html);
        tds.push(
          `<td width="${columnWidths[c]}" style="${matrixCellStyle}">` +
          content + `</td>`
        );
      }
      if (bracketed) {
        tds.push(
          `<td width="${BRACKET_CELL_W}" style="${bracketCellStyle(r, "R")}">&nbsp;</td>`
        );
      }
      trHTML.push(`<tr>${tds.join("")}</tr>`);
    }

    // Pin the table to exactly the sum of its cell widths, same
    // defense against Docs stretching as the fraction/sequence paths.
    // Matrix tables specifically come out ~2px narrower than their
    // actual render — the per-row bracket borders (left/right 1.25pt
    // each, collapsed to a ~1px stroke) sit *on* the cell edge and eat
    // into the declared width, and Docs' importer appears to trim
    // another pixel off the right edge of bracketed tables on paste.
    // Everywhere else the inner tables have no outer border, so this
    // +2 is matrix-only. Without it, the right bracket gets clipped.
    const totalW =
      columnWidths.reduce((a, b) => a + b, 0) +
      (bracketed ? BRACKET_CELL_W * 2 : 0) +
      (bracketed ? 2 : 0);

    return (
      `<meta charset="utf-8">` +
      `<table width="${totalW}" style="border-collapse:collapse;` +
      `width:${totalW}px;">` +
      trHTML.join("") +
      `</table>`
    );
  }

  // `cases`: a left-brace wrapper around rows of left-aligned content.
  // Renders as a 2-column table: col 0 is a single rowspan=N cell
  // holding an oversized `{` glyph, col 1 stacks the row contents
  // one per row, left-aligned. Multi-column row bodies (the `&` in
  // `a & x > 0`) get joined with a wide gap in the single content
  // cell so the whole row reads naturally.
  // Decompose a cell's parts into a flat set of cell descriptors for
  // the two outer rows (top + optional bottom). Returned cells are raw
  // structs (not HTML strings) so the caller can stitch them into a
  // bigger table with the correct rowspans based on whether ANY row in
  // that bigger table has structure. Each cell:
  //   { html, width, style, align, rowspanStructural, isTop, isBottom }
  // rowspanStructural === 2 means "becomes rowspan=2 when any other
  // row has structure, otherwise rowspan=1".
  function buildValueSection(parts, pt) {
    const topCells = [];
    const bottomCells = [];
    let hasStructure = false;
    let totalW = 0;

    for (const part of parts) {
      if (!part) continue;
      if (part.kind === "text") {
        const valueHTML = part.valueHTML || part.value || "";
        if (!valueHTML) continue;
        setRichFont(pt);
        const w = cellWidthPx(
          richMeasure(stripHTMLTags(valueHTML)),
          pt,
          TEXT_SIDE_PAD_EM
        );
        totalW += w;
        const style =
          `padding:0 !important;border:none;white-space:nowrap;` +
          `line-height:1.15;text-align:left;vertical-align:middle;` +
          `font-family:${CELL_FONT_FAMILY};font-size:${pt}pt;` +
          `font-weight:normal;${dbg("#0cc")}`;
        topCells.push({
          html: richPara(pt, valueHTML),
          width: w,
          style,
          align: "left",
          rowspanStructural: 2,
        });
      } else if (part.kind === "sqrt") {
        const contentHTML = part.contentHTML || part.content || "";
        const v = "√(" + contentHTML + ")";
        setRichFont(pt);
        const w = cellWidthPx(
          richMeasure(stripHTMLTags(v)),
          pt,
          TEXT_SIDE_PAD_EM
        );
        totalW += w;
        const style =
          `padding:0 !important;border:none;white-space:nowrap;` +
          `line-height:1.15;text-align:left;vertical-align:middle;` +
          `font-family:${CELL_FONT_FAMILY};font-size:${pt}pt;` +
          `font-weight:normal;${dbg("#0cc")}`;
        topCells.push({
          html: richPara(pt, v),
          width: w,
          style,
          align: "left",
          rowspanStructural: 2,
        });
      } else if (part.kind === "fraction") {
        hasStructure = true;
        const numHTML = part.numHTML || part.num;
        const denHTML = part.denHTML || part.den;
        setRichFont(pt);
        const w = cellWidthPx(
          Math.max(
            richMeasure(stripHTMLTags(numHTML)),
            richMeasure(stripHTMLTags(denHTML))
          ),
          pt,
          FRAC_SIDE_PAD_EM
        );
        totalW += w;
        const numStyle = mathCellStyle(pt, "#f00");
        const denStyle =
          mathCellStyle(pt, "#f00") + "border-top:0.75pt solid #000;";
        topCells.push({
          html: richPara(pt, numHTML),
          width: w,
          style: numStyle,
          align: "center",
          rowspanStructural: 1,
        });
        bottomCells.push({
          html: richPara(pt, denHTML),
          width: w,
          style: denStyle,
          align: "center",
        });
      } else if (part.kind === "choose") {
        hasStructure = true;
        const numHTML = part.numHTML || part.num;
        const denHTML = part.denHTML || part.den;
        setRichFont(pt);
        const contentW = cellWidthPx(
          Math.max(
            richMeasure(stripHTMLTags(numHTML)),
            richMeasure(stripHTMLTags(denHTML))
          ),
          pt,
          CHOOSE_SIDE_PAD_EM
        );
        const parenPt = pt * 1.9;
        setRichFont(parenPt);
        const parenGlyphPx = Math.max(richMeasure("("), richMeasure(")"));
        const parenW = cellWidthPx(parenGlyphPx, parenPt, 0.05);
        totalW += parenW * 2 + contentW;
        const contentStyle = mathCellStyle(pt, "#f0f");
        const parenStyle =
          `padding:0 !important;border:none;line-height:1;` +
          `white-space:nowrap;text-align:center;vertical-align:middle;` +
          `font-family:${CELL_FONT_FAMILY};font-size:${parenPt}pt;` +
          `font-weight:normal;${dbg("#f0f")}`;
        topCells.push({
          html: `<span style="font-size:${parenPt}pt;line-height:1;">(</span>`,
          width: parenW,
          style: parenStyle,
          align: "center",
          rowspanStructural: 2,
        });
        topCells.push({
          html: richPara(pt, numHTML),
          width: contentW,
          style: contentStyle,
          align: "center",
          rowspanStructural: 1,
        });
        topCells.push({
          html: `<span style="font-size:${parenPt}pt;line-height:1;">)</span>`,
          width: parenW,
          style: parenStyle,
          align: "center",
          rowspanStructural: 2,
        });
        bottomCells.push({
          html: richPara(pt, denHTML),
          width: contentW,
          style: contentStyle,
          align: "center",
        });
      }
    }

    return { topCells, bottomCells, hasStructure, totalW };
  }

  // `cases`: fully flat table. brace | value sub-cells | condition.
  // Each cases-row expands to 1 outer row (if text-only) or 2 outer
  // rows (if it has a fraction/choose). We deliberately avoid nesting
  // a sub-table inside a cell because Docs' paste importer sometimes
  // flattens nested tables back into the outer one, which scrambles
  // column alignment across rows.
  function buildCasesHTML(rows, sourcePt, rowsHTML, rowsParts) {
    if (!Array.isArray(rows) || !rows.length) return "";
    const rowCount = rows.length;
    const pt = resolveRenderPt(sourcePt);
    setRichFont(pt);

    const useHTML = Array.isArray(rowsHTML) && rowsHTML.length === rowCount;
    const useParts = Array.isArray(rowsParts) && rowsParts.length === rowCount;
    const cellHTML = (r, c) => {
      const source = useHTML ? rowsHTML[r] : rows[r];
      if (!Array.isArray(source)) return "";
      const v = source[c];
      return v != null ? String(v) : "";
    };
    const cellPlain = (r, c) => {
      const source = rows[r];
      if (!Array.isArray(source)) return "";
      const v = source[c];
      return v != null ? String(v) : "";
    };
    const cellParts = (r, c) =>
      useParts && rowsParts[r] && rowsParts[r][c] ? rowsParts[r][c] : null;

    // Per cases-row, decompose value into top/bottom cell lists.
    const sections = [];
    for (let r = 0; r < rowCount; r++) {
      const parts = cellParts(r, 0);
      const effectiveParts =
        parts && parts.length
          ? parts
          : [
              {
                kind: "text",
                valueHTML: cellHTML(r, 0),
                value: cellPlain(r, 0),
              },
            ];
      sections.push(buildValueSection(effectiveParts, pt));
    }
    const anyStructure = sections.some((s) => s.hasStructure);

    // Value region total width = max across rows (each row's totalW).
    // And max column count across rows — rows with fewer subcells
    // will use colspan on a padding cell to reach this count, so every
    // row's condition lands in the same final column regardless of how
    // structurally wide that row's value is.
    let valueW = 0;
    let maxValueCols = 0;
    for (const s of sections) {
      if (s.totalW > valueW) valueW = s.totalW;
      if (s.topCells.length > maxValueCols) maxValueCols = s.topCells.length;
    }

    // Conditions — keep simple, text-only fallback (no nested tables
    // used here; conditions rarely contain structure in practice).
    const condParts = [];
    let condW = 0;
    for (let r = 0; r < rowCount; r++) {
      const cParts = cellParts(r, 1);
      if (cParts && cParts.length) {
        const sec = buildValueSection(cParts, pt);
        // Flatten section's top cells into a single HTML run (no
        // structural conditions supported).
        const html = sec.topCells.map((c) => c.html).join("");
        const w = sec.totalW;
        condParts.push({ html, width: w, style: null });
        if (w > condW) condW = w;
      } else {
        const html = cellHTML(r, 1);
        const plain = cellPlain(r, 1);
        if (!html) {
          condParts.push({ html: "", width: 0, style: null });
          continue;
        }
        setRichFont(pt);
        const w = cellWidthPx(
          richMeasure(stripHTMLTags(html)),
          pt,
          MATRIX_SIDE_PAD_EM
        );
        condParts.push({ html: richPara(pt, html), width: w, style: null });
        if (w > condW) condW = w;
      }
    }
    if (!condParts.some((c) => c.html && c.html.length > 0)) condW = 0;

    // Total outer rows = sum of per-section outer rows (1 or 2).
    let totalOuterRows = 0;
    for (const s of sections) totalOuterRows += s.hasStructure ? 2 : 1;

    // Single `{` glyph spanning all rows. Size it so its line-box
    // (font-size × line-height:1) equals the block height, so the
    // glyph's natural visual center lands at the line-box center —
    // which is also the cell's vertical midline under valign=middle.
    // Equivalent fill without relying on padding-top hacks (Docs's
    // paste importer strips cell padding on rowspan cells
    // unpredictably) or Unicode piece stacking (leaves visible seams
    // between cells).
    const bracePt = Math.max(pt * 1.8, pt * totalOuterRows * 1.15);
    setRichFont(bracePt);
    const braceW = cellWidthPx(richMeasure("{"), bracePt, 0);

    // Strut-kill the cell: font-size:0/line-height:0 zeros the implicit
    // text strut Docs otherwise inserts at the declared font-size of a
    // td. Without this, the rowspan region gets inflated to bracePt's
    // strut height and Docs splits the `{` glyph into disjoint top and
    // bottom halves. The inner <span> restores the visible glyph size.
    const braceStyle =
      `padding:0 !important;border:none;line-height:0;white-space:nowrap;` +
      `text-align:center;vertical-align:middle;` +
      `font-family:${CELL_FONT_FAMILY};` +
      `font-size:0;font-weight:normal;` +
      dbg("#fa0");
    const condStyle = mathCellStyle(pt, "#fa0", "left");

    const tdHTML = (cell, rowspan) => {
      const rs = rowspan > 1 ? ` rowspan="${rowspan}"` : "";
      return (
        `<td${rs} valign="middle" align="${cell.align || "left"}" ` +
        `width="${cell.width}" style="${cell.style}">${cell.html}</td>`
      );
    };

    const trHTML = [];
    for (let r = 0; r < rowCount; r++) {
      const s = sections[r];
      const rowOuterCount = s.hasStructure ? 2 : 1;
      // Structural: frac/choose parent cells want rowspan=1, text/parens
      // inside a structural row want rowspan=2. For a non-structural
      // row (text-only), cells use rowspan=1 (the row itself only
      // spans 1 outer row).
      const cellRowspan = (c) => {
        if (!s.hasStructure) return 1;
        return c.rowspanStructural || 1;
      };

      // TOP row
      const topTDs = [];
      if (r === 0) {
        topTDs.push(
          `<td rowspan="${totalOuterRows}" valign="middle" align="center" ` +
          `width="${braceW}" style="${braceStyle}">` +
          `<span style="font-size:${bracePt}pt;line-height:1;">{</span>` +
          `</td>`
        );
      }
      for (const cell of s.topCells) {
        topTDs.push(tdHTML(cell, cellRowspan(cell)));
      }
      // Padding cell: if this row's value has fewer sub-columns than
      // the widest row, a pad cell with colspan=(maxValueCols - N)
      // fills the missing columns so the condition lands at the same
      // final column across all rows. Width absorbs any remaining
      // pixel slack (valueW - s.totalW). No debug outline so the pad
      // reads as whitespace, not a cell.
      const padColspan = maxValueCols - s.topCells.length;
      if (padColspan > 0) {
        const padW = Math.max(0, valueW - s.totalW);
        topTDs.push(
          `<td rowspan="${rowOuterCount}" colspan="${padColspan}" ` +
          `width="${padW}" style="padding:0;border:none;"></td>`
        );
      }
      // Condition (rowspan covers entire cases-row).
      if (condW > 0) {
        const cond = condParts[r];
        topTDs.push(
          `<td rowspan="${rowOuterCount}" valign="middle" align="left" ` +
          `width="${condW}" style="${condStyle}">${cond.html}</td>`
        );
      }
      trHTML.push(`<tr>${topTDs.join("")}</tr>`);

      // BOTTOM row (only when this cases-row has structure).
      if (s.hasStructure) {
        const botTDs = [];
        for (const cell of s.bottomCells) {
          botTDs.push(tdHTML(cell, 1));
        }
        trHTML.push(`<tr>${botTDs.join("")}</tr>`);
      }
    }

    const totalW = braceW + valueW + condW;
    return (
      `<meta charset="utf-8">` +
      `<table width="${totalW}" style="border-collapse:collapse;border:none;` +
      `table-layout:auto;width:${totalW}px;">` +
      trHTML.join("") +
      `</table>`
    );
  }

  // Mixed text + fraction(s) on one line — a single flat 2-row table,
  // with text cells using rowspan="2" to span both rows and fraction
  // cells split into num (row 1) + den (row 2, with the fraction bar
  // as its top border).
  //
  // This replaces an earlier nested-table approach (outer row of
  // cells, each fraction a nested 2-row sub-table). Docs' paste
  // importer adds substantial padding around a nested table inside a
  // cell, which was the real cause of the big top/bottom whitespace
  // around every fraction. Flat → no nesting → no inflation.
  //
  // The original concern with rowspan (narrow cell + rowspan causing
  // the spanning text to char-wrap) is handled here by explicit
  // font-proportional widths plus white-space:nowrap on the text
  // cells.
  //
  // Returns null if the sequence has no fraction/choose (caller falls
  // back to plain text). Sequences that contain a matrix route to the
  // flat matrix-sequence builder below so the surrounding text stays
  // inline with the matrix instead of spilling into separate lines.
  function buildSequenceHTML(parts, sourcePt) {
    if (!parts || !parts.length) return null;
    if (parts.some((p) => p.kind === "matrix")) {
      const matrices = parts.filter((p) => p.kind === "matrix");
      // Single-matrix sequences prefer the flat layout — it keeps every
      // cell in one outer table, which avoids Docs' paste-importer
      // padding around nested tables. When there are two or more
      // structural blocks (e.g. `cases + bmatrix`) the flat builders
      // can't align differing row counts, so fall back to the nested
      // path that lays each structural block out as its own cell.
      // Cases sequences go through the nested path so the cases block
      // renders as its own mini-table in a cell (`buildCasesHTML`),
      // rather than being flattened into the outer sequence table by
      // `buildCasesSequenceHTML`. Flat was avoiding Docs' nested-table
      // padding tax, but that layout also drops the visible grouping:
      // the brace, the per-row value, and the condition column all
      // look like siblings of the surrounding text instead of one
      // cases block. A nested table keeps the cases visually bounded.
      if (matrices.length === 1 && matrices[0].style !== "cases") {
        const flat = buildMatrixSequenceHTML(parts, sourcePt);
        if (flat) return flat;
      }
      return buildNestedSequenceHTML(parts, sourcePt);
    }

    // Sqrt-in-sequence (no matrix): route to the nested builder so the
    // √ gets a real radical (buildSqrtInnerHTML's nested table with
    // vinculum) instead of falling through to the text path as "√(x)".
    // The main flat loop below handles text/fraction/choose only.
    if (parts.some((p) => p.kind === "sqrt")) {
      return buildNestedSequenceHTML(parts, sourcePt);
    }

    const textPt = sourcePt || 11;
    const mathPt = resolveRenderPt(sourcePt);

    let hasStructure = false;
    const topCells = [];
    const bottomCells = [];
    let totalW = 0;

    for (const part of parts) {
      if (part.kind === "text") {
        const valueHTML = part.valueHTML || part.value;
        if (!valueHTML) continue;
        setRichFont(textPt);
        const contentPx = richMeasure(stripHTMLTags(valueHTML));
        const w = cellWidthPx(contentPx, textPt, SEQ_TEXT_PAD_EM);
        totalW += w;
        // line-height:1.15 (not 1): Unicode subscript glyphs like ᵢ
        // sit below the baseline and get clipped by a cell bottom
        // set exactly to the font size. A small leading fixes that
        // without inflating the row much. Font-family and font-size
        // pinned on the <td> for the same reason as math cells (Docs
        // may strip inline span styles).
        const style =
          `padding:0 !important;border:none;white-space:nowrap;` +
          `line-height:1.15;` +
          `text-align:center;` +
          `vertical-align:middle;` +
          `font-family:${CELL_FONT_FAMILY};` +
          `font-size:${textPt}pt;` +
          `font-weight:normal;${dbg("#0cc")}`;
        topCells.push(
          `<td rowspan="2" valign="middle" align="center" width="${w}" ` +
          `height="1" style="${style}">${valueHTML}</td>`
        );
      } else if (part.kind === "fraction") {
        hasStructure = true;
        const numHTML = part.numHTML || part.num;
        const denHTML = part.denHTML || part.den;
        setRichFont(mathPt);
        const contentPx = Math.max(
          richMeasure(stripHTMLTags(numHTML)),
          richMeasure(stripHTMLTags(denHTML))
        );
        const w = cellWidthPx(contentPx, mathPt, FRAC_SIDE_PAD_EM);
        totalW += w;
        const numStyle = mathCellStyle(mathPt, "#f00");
        const denStyle =
          mathCellStyle(mathPt, "#f00") + "border-top:0.75pt solid #000;";
        topCells.push(
          `<td align="center" width="${w}" height="1" style="${numStyle}">` +
          numHTML +
          `</td>`
        );
        bottomCells.push(
          `<td align="center" width="${w}" height="1" style="${denStyle}">` +
          denHTML +
          `</td>`
        );
      } else if (part.kind === "choose") {
        hasStructure = true;
        const numHTML = part.numHTML || part.num;
        const denHTML = part.denHTML || part.den;
        setRichFont(mathPt);
        const contentPx = Math.max(
          richMeasure(stripHTMLTags(numHTML)),
          richMeasure(stripHTMLTags(denHTML))
        );
        const contentW = cellWidthPx(contentPx, mathPt, CHOOSE_SIDE_PAD_EM);
        const parenPt = mathPt * 1.9;
        setRichFont(parenPt);
        const parenGlyphPx = Math.max(richMeasure("("), richMeasure(")"));
        const parenW = cellWidthPx(parenGlyphPx, parenPt, 0.05);
        totalW += parenW * 2 + contentW;
        const contentStyle = mathCellStyle(mathPt, "#f0f");
        const parenStyle =
          `padding:0 !important;border:none;line-height:1;` +
          `white-space:nowrap;text-align:center;vertical-align:middle;` +
          `font-family:${CELL_FONT_FAMILY};font-size:${parenPt}pt;` +
          `font-weight:normal;${dbg("#f0f")}`;
        topCells.push(
          `<td rowspan="2" valign="middle" align="center" width="${parenW}" ` +
          `style="${parenStyle}">` +
          `<span style="font-size:${parenPt}pt;line-height:1;">(</span></td>` +
          `<td align="center" width="${contentW}" height="1" style="${contentStyle}">` +
          numHTML + `</td>` +
          `<td rowspan="2" valign="middle" align="center" width="${parenW}" ` +
          `style="${parenStyle}">` +
          `<span style="font-size:${parenPt}pt;line-height:1;">)</span></td>`
        );
        bottomCells.push(
          `<td align="center" width="${contentW}" height="1" style="${contentStyle}">` +
          denHTML + `</td>`
        );
      }
    }

    if (!hasStructure) return null;

    // Pin the table to the sum of cell widths so Docs' paste importer
    // doesn't stretch it to paragraph width and dump the excess into
    // whichever column has no content-width floor (the text cells).
    return (
      `<meta charset="utf-8">` +
      `<table width="${totalW}" style="border-collapse:collapse;border:none;width:${totalW}px;">` +
      `<tr>${topCells.join("")}</tr>` +
      `<tr>${bottomCells.join("")}</tr>` +
      `</table>`
    );
  }

  // Flat rendering for sequences with a matrix: the outer table grows to
  // matrix.rowCount rows, text parts span all rows via rowspan, and the
  // matrix's own cells (plus bracket ticks) fill the remaining columns.
  // Same approach as the fraction-sequence path — text sits inline with
  // the structural block instead of spilling onto its own line.
  // Fraction/choose/sqrt siblings get a rowspan=rowCount column each,
  // with the inner structural table rendered by buildCellInner.
  // Returns null for combinations this path doesn't handle (multi-matrix
  // or `cases`); caller then falls through to plain text.
  function buildMatrixSequenceHTML(parts, sourcePt) {
    const matrices = parts.filter((p) => p.kind === "matrix");
    if (matrices.length !== 1) return null;

    const matrix = matrices[0];
    if (matrix.style === "cases") return null;
    const rowCount = matrix.rows.length;
    if (!rowCount) return null;
    const cols = Math.max(...matrix.rows.map((r) => (r ? r.length : 0)));
    if (!cols) return null;

    const mathPt = resolveRenderPt(sourcePt);
    const textPt = sourcePt || 11;

    const useHTML =
      Array.isArray(matrix.rowsHTML) && matrix.rowsHTML.length === rowCount;
    const useParts =
      Array.isArray(matrix.rowsParts) && matrix.rowsParts.length === rowCount;
    const cellHTML = (r, c) => {
      if (useHTML && matrix.rowsHTML[r] && matrix.rowsHTML[r][c] != null) {
        return matrix.rowsHTML[r][c];
      }
      return matrix.rows[r] && matrix.rows[r][c] != null ? matrix.rows[r][c] : "";
    };
    const cellPlain = (r, c) =>
      matrix.rows[r] && matrix.rows[r][c] != null ? matrix.rows[r][c] : "";
    const cellPartsAt = (r, c) =>
      useParts && matrix.rowsParts[r] && matrix.rowsParts[r][c]
        ? matrix.rowsParts[r][c]
        : null;

    const cellInner = [];
    for (let r = 0; r < rowCount; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        const cp = cellPartsAt(r, c);
        if (cp) {
          row.push(buildCellInner(cp, mathPt));
        } else {
          setRichFont(mathPt);
          row.push({
            html: cellHTML(r, c),
            width: richMeasure(cellPlain(r, c)),
            structural: false,
          });
        }
      }
      cellInner.push(row);
    }

    const columnWidths = [];
    for (let c = 0; c < cols; c++) {
      let maxW = 0;
      for (let r = 0; r < rowCount; r++) {
        const inner = cellInner[r][c];
        const w = inner.structural
          ? inner.width
          : cellWidthPx(inner.width, mathPt, MATRIX_SIDE_PAD_EM);
        maxW = Math.max(maxW, w);
      }
      columnWidths.push(maxW);
    }

    const bracketed = matrix.style !== "plain";
    const isBar = matrix.style === "bar" || matrix.style === "doublebar";
    const BRACKET = "1.25pt solid #000";
    const BRACKET_CELL_W = 3;
    const matrixCellStyle = mathCellStyle(mathPt, "#fa0");
    const bracketCellStyle = (r, side) =>
      `padding:0 !important;line-height:1;font-size:${mathPt}pt;` +
      (side === "L"
        ? `border-left:${BRACKET};border-right:0;`
        : `border-right:${BRACKET};border-left:0;`) +
      (r === 0 && !isBar ? `border-top:${BRACKET};` : `border-top:0;`) +
      (r === rowCount - 1 && !isBar
        ? `border-bottom:${BRACKET};`
        : `border-bottom:0;`);

    const rowsCells = Array.from({ length: rowCount }, () => []);
    let totalW = 0;

    for (const part of parts) {
      if (part.kind === "text") {
        const valueHTML = part.valueHTML || part.value;
        if (!valueHTML) continue;
        setRichFont(textPt);
        const contentPx = richMeasure(stripHTMLTags(valueHTML));
        const w = cellWidthPx(contentPx, textPt, MATRIX_TEXT_SIBLING_PAD_EM);
        totalW += w;
        const style =
          `padding:0 !important;border:none;white-space:nowrap;` +
          `line-height:1.15;` +
          `text-align:center;` +
          `vertical-align:middle;` +
          `font-family:${CELL_FONT_FAMILY};` +
          `font-size:${textPt}pt;` +
          `font-weight:normal;${dbg("#0cc")}`;
        rowsCells[0].push(
          `<td rowspan="${rowCount}" valign="middle" align="center" ` +
          `width="${w}" height="1" style="${style}">${valueHTML}</td>`
        );
      } else if (part.kind === "matrix") {
        for (let r = 0; r < rowCount; r++) {
          if (bracketed) {
            rowsCells[r].push(
              `<td width="${BRACKET_CELL_W}" ` +
              `style="${bracketCellStyle(r, "L")}">&nbsp;</td>`
            );
          }
          for (let c = 0; c < cols; c++) {
            const inner = cellInner[r][c];
            const content = inner.structural
              ? inner.html
              : richPara(mathPt, inner.html);
            rowsCells[r].push(
              `<td width="${columnWidths[c]}" style="${matrixCellStyle}">` +
              content + `</td>`
            );
          }
          if (bracketed) {
            rowsCells[r].push(
              `<td width="${BRACKET_CELL_W}" ` +
              `style="${bracketCellStyle(r, "R")}">&nbsp;</td>`
            );
          }
        }
        totalW +=
          columnWidths.reduce((a, b) => a + b, 0) +
          (bracketed ? BRACKET_CELL_W * 2 : 0);
      } else if (
        part.kind === "fraction" ||
        part.kind === "choose" ||
        part.kind === "sqrt"
      ) {
        // Sibling structural part (e.g. `\frac{1}{2}` next to a matrix).
        // Render the inner 2-row / paren-wrapped / √(…) shape as its own
        // mini-table via buildCellInner and drop it into a single
        // rowspan=rowCount column so it sits inline with the matrix
        // instead of falling back to a plain-text `(1)/(2)` / `C(x,y)`.
        const inner = buildCellInner([part], mathPt);
        const w = inner.structural
          ? inner.width
          : cellWidthPx(inner.width, mathPt, TEXT_SIDE_PAD_EM);
        totalW += w;
        const content = inner.structural
          ? inner.html
          : richPara(mathPt, inner.html);
        const style = inner.structural
          ? `padding:0 !important;border:none;line-height:1;` +
            `text-align:center;vertical-align:middle;${dbg("#a0f")}`
          : `padding:0 !important;border:none;white-space:nowrap;` +
            `line-height:1.15;text-align:center;vertical-align:middle;` +
            `font-family:${CELL_FONT_FAMILY};font-size:${mathPt}pt;` +
            `font-weight:normal;${dbg("#0cc")}`;
        rowsCells[0].push(
          `<td rowspan="${rowCount}" valign="middle" align="center" ` +
          `width="${w}" height="1" style="${style}">${content}</td>`
        );
      }
    }

    const trHTML = rowsCells.map((tds) => `<tr>${tds.join("")}</tr>`).join("");
    return (
      `<meta charset="utf-8">` +
      `<table width="${totalW}" style="border-collapse:collapse;border:none;` +
      `width:${totalW}px;">` +
      trHTML +
      `</table>`
    );
  }

  // Flat rendering for sequences that contain a `cases` block: mirrors
  // buildMatrixSequenceHTML but assembles the brace glyph from Unicode
  // bracket pieces (⎧⎨⎪⎩) emitted per-row, same structural pattern as
  // the matrix's per-row bracket border cells. Using per-row brace
  // pieces instead of one rowspan=N cell avoids stacking two
  // rowspan=N cells (text + brace) in row 0, which Docs' paste
  // importer sometimes laid out as two stacked lines. Fraction/choose/
  // sqrt siblings outside the cases block get a rowspan=rowCount
  // column each, produced by buildCellInner.
  function buildCasesSequenceHTML(parts, sourcePt) {
    const casesList = parts.filter(
      (p) => p.kind === "matrix" && p.style === "cases"
    );
    if (casesList.length !== 1) {
      LOG("cases-seq: bail (not exactly one cases block)");
      return null;
    }
    if (parts.some((p) => p.kind === "matrix" && p.style !== "cases")) {
      LOG("cases-seq: bail (non-cases matrix mixed in)");
      return null;
    }

    const cases = casesList[0];
    const rowCount = cases.rows.length;
    if (!rowCount) {
      LOG("cases-seq: bail (empty cases)");
      return null;
    }

    const mathPt = resolveRenderPt(sourcePt);
    const textPt = sourcePt || 11;

    const useHTML =
      Array.isArray(cases.rowsHTML) && cases.rowsHTML.length === rowCount;
    const cellHTML = (r, c) => {
      const source = useHTML ? cases.rowsHTML[r] : cases.rows[r];
      if (!Array.isArray(source)) return "";
      const v = source[c];
      return v != null ? String(v) : "";
    };
    const cellPlain = (r, c) => {
      const row = cases.rows[r];
      if (!Array.isArray(row)) return "";
      const v = row[c];
      return v != null ? String(v) : "";
    };

    let valueW = 0;
    let condW = 0;
    for (let r = 0; r < rowCount; r++) {
      const vPlain = cellPlain(r, 0);
      if (vPlain) {
        setRichFont(mathPt);
        const w = cellWidthPx(
          richMeasure(vPlain),
          mathPt,
          MATRIX_SIDE_PAD_EM
        );
        if (w > valueW) valueW = w;
      }
      const cPlain = cellPlain(r, 1);
      if (cPlain) {
        setRichFont(mathPt);
        const w = cellWidthPx(
          richMeasure(cPlain),
          mathPt,
          MATRIX_SIDE_PAD_EM
        );
        if (w > condW) condW = w;
      }
    }
    const hasCondition = condW > 0;

    // Assemble the brace from Unicode bracket pieces, one per row:
    //   rowCount 1: single ⎰-ish glyph (rare; fall back to "{")
    //   rowCount 2: ⎰ ⎱ (upper + lower halves, no middle)
    //   rowCount 3+: ⎧ (top), ⎪ (extensions), ⎨ (middle), ⎪ ..., ⎩ (bottom)
    //
    // Pieces stack with line-height:1 so they join visually. Emitting
    // one cell per row (matching value/cond cell counts) keeps the
    // paste importer happy — it's the same structural pattern as the
    // matrix's per-row bracket cells, which Docs handles cleanly.
    const bracePiece = (r, n) => {
      if (n === 1) return "{";
      if (n === 2) return r === 0 ? "⎰" : "⎱";
      if (r === 0) return "⎧";
      if (r === n - 1) return "⎩";
      const middle = Math.floor((n - 1) / 2);
      if (r === middle) return "⎨";
      return "⎪";
    };

    const bracePt = Math.round(mathPt * 1.4);
    setRichFont(bracePt);
    const braceW = cellWidthPx(richMeasure("⎨"), bracePt, 0.05);

    const braceCellStyle =
      `padding:0 !important;border:none;line-height:1;white-space:nowrap;` +
      `text-align:center;vertical-align:middle;` +
      `font-family:${CELL_FONT_FAMILY};font-size:${bracePt}pt;` +
      `font-weight:normal;${dbg("#fa0")}`;
    const valueCellStyle = mathCellStyle(mathPt, "#fa0", "left");
    const condCellStyle = mathCellStyle(mathPt, "#fa0", "left");

    const rowsCells = Array.from({ length: rowCount }, () => []);
    let totalW = 0;

    for (const part of parts) {
      if (part.kind === "text") {
        const valueHTML = part.valueHTML || part.value;
        if (!valueHTML) continue;
        setRichFont(textPt);
        const contentPx = richMeasure(stripHTMLTags(valueHTML));
        const w = cellWidthPx(contentPx, textPt, MATRIX_TEXT_SIBLING_PAD_EM);
        totalW += w;
        const style =
          `padding:0 !important;border:none;white-space:nowrap;` +
          `line-height:1.15;text-align:center;vertical-align:middle;` +
          `font-family:${CELL_FONT_FAMILY};font-size:${textPt}pt;` +
          `font-weight:normal;${dbg("#0cc")}`;
        rowsCells[0].push(
          `<td rowspan="${rowCount}" valign="middle" align="center" ` +
          `width="${w}" height="1" style="${style}">${valueHTML}</td>`
        );
      } else if (part.kind === "matrix") {
        for (let r = 0; r < rowCount; r++) {
          const piece = bracePiece(r, rowCount);
          rowsCells[r].push(
            `<td width="${braceW}" align="center" ` +
            `style="${braceCellStyle}">` +
            `<span style="font-size:${bracePt}pt;line-height:1;">${piece}</span>` +
            `</td>`
          );
          const vHTML = cellHTML(r, 0);
          rowsCells[r].push(
            `<td width="${valueW}" style="${valueCellStyle}">` +
            (vHTML ? richPara(mathPt, vHTML) : "") +
            `</td>`
          );
          if (hasCondition) {
            const cHTML = cellHTML(r, 1);
            rowsCells[r].push(
              `<td width="${condW}" style="${condCellStyle}">` +
              (cHTML ? richPara(mathPt, cHTML) : "") +
              `</td>`
            );
          }
        }
        totalW += braceW + valueW + (hasCondition ? condW : 0);
      } else if (
        part.kind === "fraction" ||
        part.kind === "choose" ||
        part.kind === "sqrt"
      ) {
        // Sibling structural part outside the cases block
        // (e.g. `\begin{cases}…\end{cases} + \binom{x}{y}`). Same
        // rowspan=rowCount inline trick as buildMatrixSequenceHTML:
        // render the fraction/choose/sqrt as a nested mini-table via
        // buildCellInner and drop it into one column so it sits inline
        // with the cases block instead of falling back to the
        // plain-text `(n)/(d)` / `C(n,k)` form.
        const inner = buildCellInner([part], mathPt);
        const w = inner.structural
          ? inner.width
          : cellWidthPx(inner.width, mathPt, TEXT_SIDE_PAD_EM);
        totalW += w;
        const content = inner.structural
          ? inner.html
          : richPara(mathPt, inner.html);
        const style = inner.structural
          ? `padding:0 !important;border:none;line-height:1;` +
            `text-align:center;vertical-align:middle;${dbg("#a0f")}`
          : `padding:0 !important;border:none;white-space:nowrap;` +
            `line-height:1.15;text-align:center;vertical-align:middle;` +
            `font-family:${CELL_FONT_FAMILY};font-size:${mathPt}pt;` +
            `font-weight:normal;${dbg("#0cc")}`;
        rowsCells[0].push(
          `<td rowspan="${rowCount}" valign="middle" align="center" ` +
          `width="${w}" height="1" style="${style}">${content}</td>`
        );
      }
    }

    const trHTML = rowsCells.map((tds) => `<tr>${tds.join("")}</tr>`).join("");
    LOG("cases-seq: built HTML", { rowCount, totalW, hasCondition });
    return (
      `<meta charset="utf-8">` +
      `<table width="${totalW}" style="border-collapse:collapse;border:none;` +
      `width:${totalW}px;">` +
      trHTML +
      `</table>`
    );
  }

  // √x as a single-row nested table: [ √ glyph | radicand ]. The
  // vinculum is the radicand cell's border-top — no separate spacer
  // row, since Docs' paste importer refuses to collapse empty rows
  // below ~12px regardless of font-size:0/line-height:0.
  //
  // sqrtPt = pt * glyphScale. The √ glyph needs to be visibly taller
  // than the radicand so the hook sits above it and the diagonal
  // descends across the body. 1.4× matches what \sqrt does at
  // body-size in typical serif fonts without requiring an extensible
  // radical glyph.
  //
  // With vertical-align:middle on both cells, the (taller) √ glyph
  // pushes the row height to sqrtPt, and the radicand sits centered
  // inside that row. The vinculum (drawn at the cell top) thus lands
  // ~(sqrtPt-pt)/2 above the radicand content — the small gap you
  // expect above a radical's body — while connecting seamlessly to
  // the √ glyph's top-right corner.
  function buildSqrtInnerHTML(contentHTML, pt, glyphScale) {
    const sqrtPt = Math.max(4, pt * (glyphScale || 1.4));
    setRichFont(pt);
    const contentPx = richMeasure(stripHTMLTags(contentHTML));
    const contentW = cellWidthPx(contentPx, pt, FRAC_SIDE_PAD_EM) + 1;
    setRichFont(sqrtPt);
    const glyphW = cellWidthPx(richMeasure("√"), sqrtPt, 0);
    const totalW = glyphW + contentW;
    // Modeled on buildMatrixHTML's bracket cells, which draw `[` / `]`
    // via cell borders at the table edge. Key detail: don't call
    // dbg() here — dbg() emits `border:0;` in non-debug mode, and a
    // border shorthand AFTER a longhand wipes the longhand (CSS
    // cascade: later declaration wins). That was silently killing
    // the vinculum every attempt. Matrix bracket cells sidestep this
    // by simply not calling dbg() at all.
    // Vinculum only on the radicand cell, not on the √ glyph cell —
    // the horizontal bar should start at the √'s top-right and extend
    // over the radicand, not continue across the glyph itself.
    // 0.75pt matches the fraction bar's stroke weight.
    const VINCULUM = "0.75pt solid #000";
    const glyphStyle =
      `padding:0 !important;` +
      `border:0;` +
      `line-height:1;white-space:nowrap;` +
      `text-align:center;vertical-align:middle;` +
      `font-family:${CELL_FONT_FAMILY};` +
      `font-size:${sqrtPt}pt;font-weight:normal;`;
    const radStyle =
      `padding:0 !important;` +
      `border-top:${VINCULUM};border-left:0;border-right:0;border-bottom:0;` +
      `line-height:1;white-space:nowrap;` +
      `text-align:center;vertical-align:middle;` +
      `font-family:${CELL_FONT_FAMILY};` +
      `font-size:${pt}pt;font-weight:normal;`;
    return (
      `<table width="${totalW}" style="border-collapse:collapse;` +
      `width:${totalW}px;">` +
      `<tr>` +
      `<td valign="middle" align="center" width="${glyphW}" height="1" ` +
      `style="${glyphStyle}">` +
      `<span style="font-size:${sqrtPt}pt;line-height:1;">√</span></td>` +
      `<td valign="middle" align="center" width="${contentW}" height="1" ` +
      `style="${radStyle}">` +
      `<span style="font-size:${pt}pt;line-height:1;">${contentHTML}</span></td>` +
      `</tr></table>`
    );
  }

  // Nested fallback for sequences the flat builders can't handle —
  // typically 2+ structural blocks with differing row counts (cases +
  // bmatrix, bmatrix + bmatrix, etc). Renders each part as its own
  // cell in a 1-row outer table; structural parts embed their
  // standalone renderer's <table> verbatim (with the <meta> wrapper
  // stripped). This pays the "nested-table paste padding" tax Docs
  // adds around inner tables, so it's only used when flat layout is
  // impossible.
  function buildNestedSequenceHTML(parts, sourcePt) {
    const mathPt = resolveRenderPt(sourcePt);
    const textPt = sourcePt || 11;

    // buildMatrixHTML / buildCasesHTML / buildChooseHTML embed the
    // total table width as the first attribute — pluck it back out
    // instead of duplicating the width math inline.
    const stripMeta = (html) => html.replace(/^<meta[^>]*>/, "");
    const parseW = (html) => {
      const m = /<table\s+width="(\d+)"/.exec(html);
      return m ? parseInt(m[1], 10) : 0;
    };
    const countTR = (html) => (html.match(/<tr\b/gi) || []).length;

    // Pass 1: build each part's inner HTML + measured width, and record
    // its rendered pt-height. Single pass was losing the per-part height
    // info needed to compute outerH (the row's max content height) and
    // pad shorter cells to match.
    const built = [];
    for (const part of parts) {
      if (part.kind === "text") {
        const valueHTML = part.valueHTML || part.value;
        if (!valueHTML) continue;
        setRichFont(textPt);
        const contentPx = richMeasure(stripHTMLTags(valueHTML));
        const w = cellWidthPx(contentPx, textPt, MATRIX_TEXT_SIBLING_PAD_EM);
        // line-height:1.15 (set on the cell) makes the rendered text
        // strut 1.15× the font size — outerH math must match.
        built.push({
          kind: "text",
          inner: valueHTML, w, hPt: textPt * 1.15,
        });
      } else if (part.kind === "sqrt") {
        const inner = buildSqrtInnerHTML(
          part.contentHTML || part.content || "",
          mathPt
        );
        const w = parseW(inner);
        // Single row at sqrtPt (= mathPt × 1.4, matching the default
        // glyphScale in buildSqrtInnerHTML). The √ glyph sets the row
        // height; the radicand centers inside it below the vinculum.
        built.push({
          kind: "sqrt",
          inner, w, hPt: mathPt * 1.4,
        });
      } else if (part.kind === "fraction") {
        const inner = buildFractionInnerHTML(
          part.numHTML || part.num,
          part.denHTML || part.den,
          mathPt
        );
        const w = parseW(inner);
        // Fraction is 2 rows at line-height:1 × mathPt each.
        built.push({
          kind: "fraction",
          inner, w, hPt: mathPt * 2,
        });
      } else if (part.kind === "choose") {
        const full = buildChooseHTML(
          part.numHTML || part.num,
          part.denHTML || part.den,
          sourcePt
        );
        const inner = stripMeta(full);
        const w = parseW(full);
        built.push({
          kind: "choose",
          inner, w, hPt: mathPt * 2,
        });
      } else if (part.kind === "matrix") {
        const full = part.style === "cases"
          ? buildCasesHTML(part.rows, sourcePt, part.rowsHTML, part.rowsParts)
          : buildMatrixHTML(
              part.rows,
              part.style,
              sourcePt,
              part.rowsHTML,
              part.rowsParts
            );
        const inner = stripMeta(full);
        const baseW = parseW(full);
        const isMatrix = part.style !== "cases";
        // Count actual <tr> in the built HTML — cases mixes text rows
        // and fraction rows (2 outer rows per fraction), so inferring
        // from part.rows alone would miss that.
        const rows = countTR(inner);
        // Matrix value cells use line-height:1, so rows × mathPt is
        // exact. Cases value cells use line-height:1.15, plus the
        // oversized `{` brace can stretch the block past the row sum
        // (bracePt floor matches the formula in buildCasesHTML).
        let hPt;
        if (isMatrix) {
          hPt = rows * mathPt;
        } else {
          const rowsHeight = rows * mathPt * 1.15;
          // Mirrors the brace size in buildCasesHTML.
          const bracePt = Math.max(mathPt * 1.8, mathPt * rows * 1.1);
          hPt = Math.max(rowsHeight, bracePt);
        }
        built.push({
          kind: "matrix",
          isMatrix,
          inner,
          w: baseW + (isMatrix ? 3 : 2),
          hPt,
        });
      }
    }

    if (!built.length) return null;

    // outerH = tallest cell's content height. Shorter cells get vertical
    // padding to match, which — with !important — survives the Docs
    // paste importer's padding strip well enough to visibly center them
    // in the row next to a tall `cases` or `matrix` neighbor.
    const maxHpt = built.reduce((m, b) => Math.max(m, b.hPt), 0);
    const outerH = Math.ceil(maxHpt * PT_TO_PX);

    const cells = [];
    let totalW = 0;
    for (const b of built) {
      const ihpx = Math.ceil(b.hPt * PT_TO_PX);
      const tp = Math.max(0, Math.floor((outerH - ihpx) / 2));
      const bp = Math.max(0, outerH - ihpx - tp);

      if (b.kind === "text") {
        totalW += b.w;
        const style =
          `padding:${tp}px 0 ${bp}px 0 !important;border:none;white-space:nowrap;` +
          `line-height:1.15;text-align:center;vertical-align:middle;` +
          `font-family:${CELL_FONT_FAMILY};font-size:${textPt}pt;` +
          `font-weight:normal;${dbg("#0cc")}`;
        cells.push(
          `<td valign="middle" align="center" width="${b.w}" height="1" ` +
          `style="${style}">${b.inner}</td>`
        );
      } else if (b.kind === "sqrt") {
        totalW += b.w;
        // inner is a nested table now (strut-killed glyph row + vinculum
        // + radicand) — strut-kill the wrapper cell too so the outer's
        // text strut doesn't add extra vertical space around the sqrt.
        const style =
          `padding:${tp}px 0 ${bp}px 0 !important;border:none;line-height:0;` +
          `font-size:0;text-align:center;vertical-align:middle;${dbg("#0cc")}`;
        cells.push(
          `<td valign="middle" align="center" width="${b.w}" ` +
          `style="${style}">${b.inner}</td>`
        );
      } else if (b.kind === "fraction" || b.kind === "choose") {
        totalW += b.w;
        const style =
          `padding:${tp}px 0 ${bp}px 0 !important;border:none;line-height:1;` +
          `text-align:center;vertical-align:middle;${dbg("#a0f")}`;
        cells.push(
          `<td valign="middle" align="center" width="${b.w}" ` +
          `style="${style}">${b.inner}</td>`
        );
      } else if (b.kind === "matrix") {
        // True matrices (not cases) get nudged right inside their
        // purple wrapper cell via padding-left. Using padding on the
        // wrapper <td> (rather than a nested `[spacer | matrix]`
        // table) keeps the matrix table alone inside, so its bracket
        // borders render at full thickness. Cases keep natural
        // centering — brace-on-left already provides the visual offset
        // a bracketed matrix lacks.
        const MATRIX_LEFT_SHIFT = b.isMatrix ? 2 : 0;
        const MATRIX_RIGHT_SHIFT = b.isMatrix ? 2 : 0;
        totalW += b.w + MATRIX_LEFT_SHIFT + MATRIX_RIGHT_SHIFT;
        const padStyle =
          `padding:${tp}px ${MATRIX_RIGHT_SHIFT}px ${bp}px ` +
          `${MATRIX_LEFT_SHIFT}px !important;`;
        const style =
          `${padStyle}border:none;line-height:1;` +
          `text-align:center;vertical-align:middle;${dbg("#a0f")}`;
        cells.push(
          `<td valign="middle" align="center" width="${b.w}" ` +
          `style="${style}">${b.inner}</td>`
        );
      }
    }

    if (!cells.length) return null;

    // Outer table declares exactly the sum of cell widths — no extra
    // slack. Earlier versions padded this by +24 to avoid clipping the
    // last cell, but the extra appeared to get redistributed into
    // cells, inflating the apparent spacing around each structural
    // block. Same-total rule keeps every cell at its natural width.
    return (
      `<meta charset="utf-8">` +
      `<table width="${totalW}" style="border-collapse:collapse;border:none;` +
      `width:${totalW}px;">` +
      `<tr>${cells.join("")}</tr>` +
      `</table>`
    );
  }

  function richToPlainText(rich) {
    if (!rich) return "";
    switch (rich.kind) {
      case "text": return rich.value || "";
      case "fraction": return "(" + rich.num + ")/(" + rich.den + ")";
      case "choose": return "C(" + rich.num + "," + rich.den + ")";
      case "matrix": return rich.rows.map((r) => r.join("\t")).join("\n");
      case "sqrt": return "√(" + (rich.content || "") + ")";
      case "sequence": return rich.parts.map(richToPlainText).join("");
    }
    return "";
  }

  // Given a rich compile result, produce the text/plain + text/html pair
  // the paste dispatcher needs. Plain text is always set so pastes into
  // non-Docs targets degrade gracefully.
  function renderRich(rich, sourcePt) {
    if (!rich) return { text: "", html: null };
    let html = null;
    if (rich.kind === "fraction") {
      html = buildFractionHTML(
        rich.numHTML || rich.num,
        rich.denHTML || rich.den,
        sourcePt
      );
    } else if (rich.kind === "choose") {
      html = buildChooseHTML(
        rich.numHTML || rich.num,
        rich.denHTML || rich.den,
        sourcePt
      );
    } else if (rich.kind === "matrix") {
      if (rich.style === "cases") {
        html = buildCasesHTML(rich.rows, sourcePt, rich.rowsHTML, rich.rowsParts);
      } else {
        html = buildMatrixHTML(rich.rows, rich.style, sourcePt, rich.rowsHTML, rich.rowsParts);
      }
    } else if (rich.kind === "sqrt") {
      const pt = resolveRenderPt(sourcePt);
      html =
        `<meta charset="utf-8">` +
        buildSqrtInnerHTML(rich.contentHTML || rich.content || "", pt);
    } else if (rich.kind === "sequence") {
      html = buildSequenceHTML(rich.parts, sourcePt);
    } else if (rich.kind === "text") {
      // Pure text with no structural parts still needs an HTML
      // version when the LaTeX had `_` or `^` — the HTML variant
      // carries native <sub>/<sup> tags that Docs turns into real
      // subscript/superscript formatting (Cmd+, / Cmd+.). Without
      // this, the paste falls back to text/plain, which for
      // unmappable args like `_{\delta}` shows as a literal "_δ".
      const valueHTML = rich.valueHTML || "";
      if (valueHTML && valueHTML.indexOf("<") >= 0) {
        html = `<meta charset="utf-8">${valueHTML}`;
      }
    }
    return { text: richToPlainText(rich), html };
  }

  function compile() {
    chrome.storage.local.get({ equations_compiled: 0 }, (data) => {
      chrome.storage.local.set({
        equations_compiled: (Number(data.equations_compiled) || 0) + 1,
      });
    });
  }

  function showButtonToast(toast, text, keepOpen) {
    if (!toast) return () => {};
    clearTimeout(toast._hideTimer);
    toast.textContent = text;
    toast.style.opacity = "1";
    const hide = () => {
      clearTimeout(toast._hideTimer);
      toast.style.opacity = "0";
    };
    if (!keepOpen) toast._hideTimer = setTimeout(hide, 1200);
    return hide;
  }

  async function runCompileAll(toast) {
    if (autocompile) {
      showButtonToast(toast, "Autocompile is on");
      return;
    }
    if (popupBusy) return;
    // Snapshot and reverse: compile bottom-up so earlier replacements
    // don't shift later regions' canvas coordinates.
    const regions = greenRegions
      .filter((r) => r.type === "compile")
      .slice()
      .reverse();
    if (!regions.length) {
      showButtonToast(toast, "Nothing to compile");
      return;
    }
    popupBusy = true;
    const hide = showButtonToast(toast, "Compiling…", true);
    try {
      for (const region of regions) {
        try {
          const ok = await replaceInDoc(region);
          if (ok) compile();
        } catch (err) {
          LOG("compile-all replaceInDoc threw:", err);
        }
      }
    } finally {
      popupBusy = false;
      hide();
    }
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
        .toast {
          position: absolute;
          right: 0;
          bottom: 52px;
          padding: 6px 10px;
          background: #202124;
          color: #fff;
          font-family: 'Google Sans', Roboto, Arial, sans-serif;
          font-size: 12px;
          line-height: 1;
          border-radius: 4px;
          white-space: nowrap;
          pointer-events: none;
          opacity: 0;
          transition: opacity 0.15s ease;
        }
      </style>
      <div class="toast" aria-hidden="true"></div>
      <button title="Compile All LaTeX Equations" aria-label="Compile All LaTeX Equations">
        <img src="${logoURL}" alt="" />
      </button>
    `;

    const toast = shadow.querySelector(".toast");
    shadow.querySelector("button").addEventListener("click", () => runCompileAll(toast));
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
    wrapper.style.cssText = "user-select:none;cursor:pointer;position:relative;";

    wrapper.innerHTML = `
      <div class="goog-toolbar-button-outer-box goog-inline-block" style="user-select:none;">
        <div class="goog-toolbar-button-inner-box goog-inline-block" style="user-select:none;">
          <img src="${logoURL}" alt=""
            style="width:20px;height:20px;object-fit:contain;vertical-align:middle;pointer-events:none;-webkit-user-drag:none;"
          />
        </div>
      </div>
    `;

    const toast = document.createElement("div");
    toast.style.cssText =
      "position:absolute;top:100%;left:50%;transform:translateX(-50%);" +
      "margin-top:6px;padding:6px 10px;background:#202124;color:#fff;" +
      "font-family:'Google Sans',Roboto,Arial,sans-serif;font-size:12px;" +
      "line-height:1;border-radius:4px;white-space:nowrap;pointer-events:none;" +
      "opacity:0;transition:opacity 0.15s ease;z-index:9999;";
    wrapper.appendChild(toast);

    wrapper.addEventListener("click", () => runCompileAll(toast));

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
    //injectLabel();
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

    // Per-type identity key: compile regions are uniquely identified
    // by their LaTeX source, decompile regions by their Unicode text.
    // (canvas identity is part of the tuple so two identical glyphs on
    // separate pages don't alias.)
    const regionKey = (r) =>
      r.type === "decompile" ? r.text : r.latex;

    // If the currently hovered region vanished from this rebuild, drop
    // the popup so it doesn't point at stale geometry.
    if (hoveredRegion) {
      const wantKey = regionKey(hoveredRegion);
      const stillThere = newRegions.find(
        (r) => r.type === hoveredRegion.type &&
          regionKey(r) === wantKey &&
          r.canvas === hoveredRegion.canvas
      );
      if (stillThere) hoveredRegion = stillThere;
      else { hoveredRegion = null; hidePopupImmediately(); }
    }

    // Re-point the caret-touched region too, and reapply dark paint
    // since marks are recreated on every rebuild.
    if (caretRegion) {
      const wantKey = regionKey(caretRegion);
      const stillThere = newRegions.find(
        (r) => r.type === caretRegion.type &&
          regionKey(r) === wantKey &&
          r.canvas === caretRegion.canvas
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

    // Strip zero-width and bidi-control characters from fragment text.
    // Docs injects these at font-run boundaries (e.g. right after a
    // native sup), and they otherwise poison downstream tokenization
    // and paste output: a stuck U+200B before "=3" would keep the
    // decompile run from extending through the tail of the equation.
    const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g;

    // Dedupe by position+text so redundant fillTexts don't create
    // spurious extra math regions in the concatenated reading-order text.
    const deduped = [];
    const seenKey = new Set();
    for (const f of frags) {
      const cleanText = (f.text || "").replace(INVISIBLE_RE, "");
      if (!cleanText) continue;
      const cleaned = cleanText === f.text ? f : { ...f, text: cleanText };
      const key = Math.round(cleaned.x) + "," + Math.round(cleaned.y) + "," + cleaned.text;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      deduped.push(cleaned);
    }

    // Group fragments into logical lines, classify each one as
    // normal / sup / sub relative to the dominant font size on its
    // line. Native Cmd+./Cmd+, sup/sub rendering draws a smaller-font
    // fragment at a raised or lowered y — the canvas has no style
    // channel, so the only signal is the height and baseline relative
    // to the line's main run.
    const fontPx = (fnt) => {
      const m = /([\d.]+)px/.exec(fnt || "");
      return m ? parseFloat(m[1]) : 0;
    };
    const byY = [...deduped].sort((a, b) => a.y - b.y);
    const lines = [];
    for (const f of byY) {
      const fTop = f.y;
      const fBot = f.y + f.height;
      let placed = false;
      for (const line of lines) {
        const lineH = line.yBot - line.yTop;
        const overlap =
          Math.min(fBot, line.yBot) - Math.max(fTop, line.yTop);
        // Adaptive threshold:
        //   - Different heights (sup/sub vs base text): 25% — a raised
        //     superscript only dips into the baseline's bounding box
        //     by ~25%, so we keep that loose so sup/sub clusters with
        //     its base.
        //   - Same height (regular text vs regular text): 50% — needed
        //     for matrix-with-wrapper-prefix layouts. The prefix cell
        //     in `[T]=\begin{bmatrix}...` is rowspan-vertically-
        //     centered against the matrix's full height, so its
        //     y-range overlaps row 2 AND row 3 of the matrix (each by
        //     ~30-36%). The 25% threshold then transitively merges
        //     row 2 + prefix + row 3 into one line, scrambling matrix
        //     detection. With 50% for same-height content, the
        //     prefix's partial overlap doesn't bridge across rows.
        const sizeRatio = Math.min(f.height, lineH) /
          Math.max(f.height, lineH);
        const minH = Math.min(f.height, lineH);
        const threshold = sizeRatio > 0.85 ? 0.5 : 0.25;
        if (overlap > minH * threshold) {
          line.fragments.push(f);
          line.yTop = Math.min(line.yTop, fTop);
          line.yBot = Math.max(line.yBot, fBot);
          placed = true;
          break;
        }
      }
      if (!placed) {
        lines.push({ yTop: fTop, yBot: fBot, fragments: [f] });
      }
    }

    // Per-line baseline: the fragment with the largest font size is
    // the normal-text run. Meaningfully smaller fragments (<85% of
    // baseline size) offset vertically are sup/sub.
    for (const line of lines) {
      let baseSize = 0;
      let baseFrag = null;
      for (const f of line.fragments) {
        const s = fontPx(f.font);
        if (s > baseSize) { baseSize = s; baseFrag = f; }
      }
      for (const f of line.fragments) {
        const s = fontPx(f.font);
        if (!baseFrag || s === 0 || baseSize === 0 || s >= baseSize * 0.85) {
          f.script = "normal";
          continue;
        }
        const baseMid = baseFrag.y + baseFrag.height / 2;
        const fMid = f.y + f.height / 2;
        const tol = baseFrag.height * 0.1;
        if (fMid < baseMid - tol) f.script = "sup";
        else if (fMid > baseMid + tol) f.script = "sub";
        else f.script = "normal";
      }
      line.fragments.sort((a, b) => a.x - b.x);
    }
    // Sort lines by their bottom edge, so a superscript rising above
    // the baseline can't pull its line above the previous one.
    lines.sort((a, b) => a.yBot - b.yBot);

    const yOverlap = (a, b) => {
      const aTop = a.y;
      const aBot = a.y + a.height;
      const bTop = b.y;
      const bBot = b.y + b.height;
      return Math.max(0, Math.min(aBot, bBot) - Math.max(aTop, bTop));
    };

    const medianFragmentHeight = (frags, excludeTexts) => {
      const hs = frags
        .filter((f) => !f.pseudo && !excludeTexts.has(f.text))
        .map((f) => f.height)
        .filter((h) => h > 0)
        .sort((a, b) => a - b);
      return hs.length ? hs[Math.floor(hs.length / 2)] : 0;
    };

    // Recompute native sup/sub annotations in small horizontal islands
    // instead of against an entire structural row. In mixed rows like
    // `\binom{j-1}{i-1}(-a)^{j-i}`, the binom numerator/denominator sit
    // at different baselines from the following `(-a)` text; using the
    // whole row can turn a real superscript into a subscript.
    const redoScriptsLocal = (frags) => {
      const targets = frags.filter(
        (f) => !f.pseudo && f.script !== "binom" && f.script !== "sqrt"
      );
      if (!targets.length) return;
      for (const f of targets) f.script = "normal";

      const sorted = [...targets].sort((a, b) => a.x - b.x);
      const clusters = [];
      for (const f of sorted) {
        const last = clusters[clusters.length - 1];
        const gap = last ? f.x - last.maxX : Infinity;
        const joinGap = Math.max(7, fontPx(f.font) * 0.45);
        if (!last || gap > joinGap) {
          clusters.push({
            frags: [f],
            maxX: f.x + f.width,
          });
        } else {
          last.frags.push(f);
          last.maxX = Math.max(last.maxX, f.x + f.width);
        }
      }

      for (const cluster of clusters) {
        const sizeCounts = new Map();
        for (const f of cluster.frags) {
          const s = fontPx(f.font);
          if (!s) continue;
          sizeCounts.set(s, (sizeCounts.get(s) || 0) + 1);
        }
        let baseSize = 0;
        let baseCount = 0;
        for (const [s, c] of sizeCounts) {
          if (c > baseCount || (c === baseCount && s > baseSize)) {
            baseCount = c;
            baseSize = s;
          }
        }
        if (!baseSize) continue;
        let baseFrag = null;
        for (const f of cluster.frags) {
          if (fontPx(f.font) === baseSize) { baseFrag = f; break; }
        }
        if (!baseFrag) continue;
        const baseMid = baseFrag.y + baseFrag.height / 2;
        const tol = baseFrag.height * 0.1;
        for (const f of cluster.frags) {
          const s = fontPx(f.font);
          if (s === 0 || s >= baseSize * 0.85) continue;
          const fMid = f.y + f.height / 2;
          if (fMid < baseMid - tol) f.script = "sup";
          else if (fMid > baseMid + tol) f.script = "sub";
        }
      }
    };

    // Fold a compiler-rendered binomial wherever its two tall parens
    // and stacked contents appear in the same fragment collection. This
    // deliberately uses geometry rather than array adjacency because a
    // cases row can split the numerator and denominator across two
    // logical lines before the cases detector has rebuilt the row.
    const foldBinomsInFragments = (frags) => {
      const medianH = medianFragmentHeight(frags, new Set(["(", ")", "{"]));
      if (!medianH) return;
      const isTallParen = (f, ch) =>
        !f.pseudo && f.text === ch && f.height > medianH * 1.35;

      let idx = 0;
      while (idx < frags.length) {
        const open = frags[idx];
        if (!isTallParen(open, "(")) { idx++; continue; }

        let close = null;
        for (const g of frags) {
          if (!isTallParen(g, ")")) continue;
          if (g.x <= open.x) continue;
          const overlap = yOverlap(open, g);
          const minH = Math.min(open.height, g.height);
          if (minH > 0 && overlap < minH * 0.6) continue;
          if (!close || g.x < close.x) close = g;
        }
        if (!close) { idx++; continue; }

        const left = open.x + open.width / 2;
        const right = close.x + close.width / 2;
        const top = Math.min(open.y, close.y);
        const bot = Math.max(open.y + open.height, close.y + close.height);
        const middle = frags.filter((g) => {
          if (g.pseudo || g === open || g === close) return false;
          const cx = g.x + g.width / 2;
          const cy = g.y + g.height / 2;
          return cx > left && cx < right && cy >= top && cy <= bot;
        });
        if (middle.length < 2) { idx++; continue; }

        const byY = [...middle].sort(
          (a, b) => (a.y + a.height / 2) - (b.y + b.height / 2)
        );
        let splitAt = -1;
        let maxGap = 0;
        for (let k = 1; k < byY.length; k++) {
          const prev = byY[k - 1].y + byY[k - 1].height / 2;
          const curr = byY[k].y + byY[k].height / 2;
          const gap = curr - prev;
          if (gap > maxGap) {
            maxGap = gap;
            splitAt = k;
          }
        }
        if (splitAt <= 0 || maxGap < Math.max(2, medianH * 0.15)) {
          idx++;
          continue;
        }
        const topBand = byY.slice(0, splitAt);
        const botBand = byY.slice(splitAt);
        if (!topBand.length || !botBand.length) { idx++; continue; }

        topBand.sort((a, b) => a.x - b.x);
        botBand.sort((a, b) => a.x - b.x);
        for (const g of topBand) g.script = "binom";
        for (const g of botBand) g.script = "binom";
        open.text = "\\binom{";
        open.script = "binom";
        close.text = "}";
        close.script = "binom";

        const splitter = {
          text: "}{",
          x: (topBand[topBand.length - 1].x +
              topBand[topBand.length - 1].width +
              botBand[0].x) / 2,
          y: (top + bot) / 2,
          width: 0,
          height: 0,
          font: "",
          pseudo: true,
          script: "binom",
        };

        const content = new Set([...topBand, ...botBand]);
        const rebuilt = [];
        for (const f of frags) {
          if (!content.has(f)) rebuilt.push(f);
        }
        const openIdx = rebuilt.indexOf(open);
        if (openIdx < 0 || rebuilt.indexOf(close) < 0) { idx++; continue; }
        rebuilt.splice(openIdx + 1, 0, ...topBand, splitter, ...botBand);
        frags.splice(0, frags.length, ...rebuilt);
        idx = openIdx + topBand.length + botBand.length + 3;
      }
    };

    const foldSplitBinomsInRows = (rows) => {
      let changed = false;
      for (let r = 0; r < rows.length - 1; r++) {
        const row = rows[r];
        const next = rows[r + 1];
        const medianH = medianFragmentHeight(
          [...row, ...next],
          new Set(["(", ")", "{"])
        );
        if (!medianH) continue;
        const isTallParen = (f, ch) =>
          !f.pseudo && f.text === ch && f.height > medianH * 1.35;

        let idx = 0;
        while (idx < row.length) {
          const open = row[idx];
          if (!isTallParen(open, "(")) { idx++; continue; }
          let close = null;
          for (const f of row) {
            if (!isTallParen(f, ")")) continue;
            if (f.x <= open.x) continue;
            const overlap = yOverlap(open, f);
            const minH = Math.min(open.height, f.height);
            if (minH > 0 && overlap < minH * 0.6) continue;
            if (!close || f.x < close.x) close = f;
          }
          if (!close) { idx++; continue; }

          const left = open.x + open.width / 2;
          const right = close.x + close.width / 2;
          const parenTop = Math.min(open.y, close.y);
          const parenBot = Math.max(open.y + open.height, close.y + close.height);
          const inParens = (f) => {
            if (f.pseudo || f === open || f === close) return false;
            const cx = f.x + f.width / 2;
            return cx > left && cx < right;
          };
          const topBand = row.filter(inParens);
          const botBand = next.filter(inParens);
          if (!topBand.length || !botBand.length) { idx++; continue; }

          topBand.sort((a, b) => a.x - b.x);
          botBand.sort((a, b) => a.x - b.x);
          for (const f of topBand) f.script = "binom";
          for (const f of botBand) f.script = "binom";
          open.text = "\\binom{";
          open.script = "binom";
          close.text = "}";
          close.script = "binom";

          const splitter = {
            text: "}{",
            x: (topBand[topBand.length - 1].x +
                topBand[topBand.length - 1].width +
                botBand[0].x) / 2,
            y: (parenTop + parenBot) / 2,
            width: 0,
            height: 0,
            font: "",
            pseudo: true,
            script: "binom",
          };

          const content = new Set([...topBand, ...botBand]);
          const rebuilt = [];
          for (const f of row) {
            if (content.has(f)) continue;
            rebuilt.push(f);
            if (f === open) {
              rebuilt.push(...topBand, splitter, ...botBand);
            }
          }
          rows[r] = rebuilt;
          rows[r + 1] = next.filter((f) => !content.has(f));
          changed = true;
          idx = rebuilt.indexOf(close) + 1;
        }
      }

      for (let r = rows.length - 1; r >= 0; r--) {
        if (rows[r].some((f) => !f.pseudo)) continue;
        rows.splice(r, 1);
        changed = true;
      }
      return changed;
    };

    const foldStackedBinomsInFragments = (frags) => {
      if (frags.some((f) => f.text === "\\binom{")) return false;
      const medianH = medianFragmentHeight(frags, new Set(["(", ")", "{"]));
      if (!medianH) return false;

      const candidates = frags.filter((f) => {
        if (f.pseudo || f.script === "binom") return false;
        if (!/\S/.test(f.text || "")) return false;
        if (/^[+&=<>()[\]{}|,.;:]$/.test(f.text || "")) return false;
        return f.height >= medianH * 0.55;
      });
      if (candidates.length < 2) return false;

      const centerY = (f) => f.y + f.height / 2;
      const yBands = [];
      const yTol = Math.max(2, medianH * 0.3);
      for (const f of [...candidates].sort((a, b) => centerY(a) - centerY(b))) {
        const cy = centerY(f);
        const last = yBands[yBands.length - 1];
        if (!last || Math.abs(cy - last.cy) > yTol) {
          yBands.push({ frags: [f], cy, minY: f.y, maxY: f.y + f.height });
        } else {
          last.frags.push(f);
          last.cy =
            last.frags.reduce((sum, g) => sum + centerY(g), 0) /
            last.frags.length;
          last.minY = Math.min(last.minY, f.y);
          last.maxY = Math.max(last.maxY, f.y + f.height);
        }
      }
      if (yBands.length < 2) return false;

      const xClusters = (band) => {
        const clusters = [];
        for (const f of [...band.frags].sort((a, b) => a.x - b.x)) {
          const last = clusters[clusters.length - 1];
          const gap = last ? f.x - last.maxX : Infinity;
          if (!last || gap > Math.max(5, medianH * 0.45)) {
            clusters.push({
              frags: [f],
              minX: f.x,
              maxX: f.x + f.width,
              minY: f.y,
              maxY: f.y + f.height,
            });
          } else {
            last.frags.push(f);
            last.maxX = Math.max(last.maxX, f.x + f.width);
            last.minY = Math.min(last.minY, f.y);
            last.maxY = Math.max(last.maxY, f.y + f.height);
          }
        }
        for (const c of clusters) {
          c.cx = (c.minX + c.maxX) / 2;
          c.cy = (c.minY + c.maxY) / 2;
          c.w = Math.max(1, c.maxX - c.minX);
          c.h = Math.max(1, c.maxY - c.minY);
        }
        return clusters;
      };

      const bandClusters = yBands.map((band) => xClusters(band));
      let best = null;
      for (let ti = 0; ti < bandClusters.length - 1; ti++) {
        for (let bi = ti + 1; bi < bandClusters.length; bi++) {
          const yGap = yBands[bi].cy - yBands[ti].cy;
          if (yGap < Math.max(3, medianH * 0.35)) continue;
          for (const top of bandClusters[ti]) {
            for (const bot of bandClusters[bi]) {
              const xOverlap = Math.max(
                0,
                Math.min(top.maxX, bot.maxX) - Math.max(top.minX, bot.minX)
              );
              const minW = Math.min(top.w, bot.w);
              const maxW = Math.max(top.w, bot.w);
              const centerDelta = Math.abs(top.cx - bot.cx);
              if (xOverlap < minW * 0.25 && centerDelta > Math.max(4, maxW * 0.45)) {
                continue;
              }
              if (minW / maxW < 0.35) continue;
              const leftX = Math.min(top.minX, bot.minX);
              const score =
                xOverlap * 4 -
                centerDelta * 1.5 -
                Math.abs(top.w - bot.w) * 0.25 -
                leftX * 0.02 +
                yGap * 0.2;
              if (!best || score > best.score) {
                best = { top, bot, score };
              }
            }
          }
        }
      }
      if (!best) return false;

      const topBand = [...best.top.frags].sort((a, b) => a.x - b.x);
      const botBand = [...best.bot.frags].sort((a, b) => a.x - b.x);
      for (const f of topBand) f.script = "binom";
      for (const f of botBand) f.script = "binom";
      const leftX = Math.min(best.top.minX, best.bot.minX);
      const rightX = Math.max(best.top.maxX, best.bot.maxX);
      const open = {
        text: "\\binom{",
        x: leftX - 1,
        y: best.top.minY,
        width: 0,
        height: 0,
        font: "",
        pseudo: true,
        script: "binom",
      };
      const splitter = {
        text: "}{",
        x: (topBand[topBand.length - 1].x +
            topBand[topBand.length - 1].width +
            botBand[0].x) / 2,
        y: (best.top.cy + best.bot.cy) / 2,
        width: 0,
        height: 0,
        font: "",
        pseudo: true,
        script: "binom",
      };
      const close = {
        text: "}",
        x: rightX + 1,
        y: best.bot.maxY,
        width: 0,
        height: 0,
        font: "",
        pseudo: true,
        script: "binom",
      };

      const content = new Set([...topBand, ...botBand]);
      let insertIdx = Infinity;
      for (let i = 0; i < frags.length; i++) {
        if (content.has(frags[i])) insertIdx = Math.min(insertIdx, i);
      }
      if (!isFinite(insertIdx)) return false;
      const rebuilt = [];
      for (let i = 0; i < frags.length; i++) {
        if (i === insertIdx) {
          rebuilt.push(open, ...topBand, splitter, ...botBand, close);
        }
        if (!content.has(frags[i])) rebuilt.push(frags[i]);
      }
      frags.splice(0, frags.length, ...rebuilt);
      return true;
    };

    const foldLeadingFlatBinomInFragments = (frags) => {
      if (frags.some((f) => f.text === "\\binom{")) return false;
      const medianH = medianFragmentHeight(frags, new Set(["(", ")", "{"]));
      if (!medianH) return false;
      const real = frags
        .filter((f) => !f.pseudo && /\S/.test(f.text || ""))
        .sort((a, b) => a.x - b.x);
      if (real.length < 3) return false;

      const clusters = [];
      for (const f of real) {
        const last = clusters[clusters.length - 1];
        const gap = last ? f.x - last.maxX : Infinity;
        if (!last || gap > Math.max(4, medianH * 0.35)) {
          clusters.push({
            frags: [f],
            minX: f.x,
            maxX: f.x + f.width,
            minY: f.y,
            maxY: f.y + f.height,
          });
        } else {
          last.frags.push(f);
          last.maxX = Math.max(last.maxX, f.x + f.width);
          last.minY = Math.min(last.minY, f.y);
          last.maxY = Math.max(last.maxY, f.y + f.height);
        }
      }
      if (clusters.length < 3) return false;
      for (const c of clusters) {
        c.frags.sort((a, b) => a.x - b.x);
        c.text = c.frags.map((f) => f.text || "").join("").replace(/\s+/g, "");
        c.w = Math.max(1, c.maxX - c.minX);
      }

      const simpleIndexTerm = (text) =>
        /^[A-Za-z0-9]+(?:[-+][A-Za-z0-9]+)+$/.test(text);
      const suffix = (text) => {
        const m = /([+-][A-Za-z0-9]+)$/.exec(text);
        return m ? m[1] : "";
      };
      const top = clusters[0];
      const bot = clusters[1];
      if (!simpleIndexTerm(top.text) || !simpleIndexTerm(bot.text)) return false;
      if (suffix(top.text) && suffix(bot.text) && suffix(top.text) !== suffix(bot.text)) {
        return false;
      }
      if (Math.min(top.w, bot.w) / Math.max(top.w, bot.w) < 0.45) return false;

      const topBand = top.frags;
      const botBand = bot.frags;
      for (const f of topBand) f.script = "binom";
      for (const f of botBand) f.script = "binom";
      const leftX = Math.min(top.minX, bot.minX);
      const rightX = Math.max(top.maxX, bot.maxX);
      const open = {
        text: "\\binom{",
        x: leftX - 1,
        y: top.minY,
        width: 0,
        height: 0,
        font: "",
        pseudo: true,
        script: "binom",
      };
      const splitter = {
        text: "}{",
        x: (topBand[topBand.length - 1].x +
            topBand[topBand.length - 1].width +
            botBand[0].x) / 2,
        y: (top.maxY + bot.minY) / 2,
        width: 0,
        height: 0,
        font: "",
        pseudo: true,
        script: "binom",
      };
      const close = {
        text: "}",
        x: rightX + 1,
        y: bot.maxY,
        width: 0,
        height: 0,
        font: "",
        pseudo: true,
        script: "binom",
      };

      const content = new Set([...topBand, ...botBand]);
      let insertIdx = Infinity;
      for (let i = 0; i < frags.length; i++) {
        if (content.has(frags[i])) insertIdx = Math.min(insertIdx, i);
      }
      if (!isFinite(insertIdx)) return false;
      const rebuilt = [];
      for (let i = 0; i < frags.length; i++) {
        if (i === insertIdx) {
          rebuilt.push(open, ...topBand, splitter, ...botBand, close);
        }
        if (!content.has(frags[i])) rebuilt.push(frags[i]);
      }
      frags.splice(0, frags.length, ...rebuilt);
      return true;
    };

    const refreshLineBounds = (line) => {
      let yTop = Infinity;
      let yBot = -Infinity;
      for (const f of line.fragments) {
        if (f.pseudo) continue;
        yTop = Math.min(yTop, f.y);
        yBot = Math.max(yBot, f.y + f.height);
      }
      if (isFinite(yTop)) {
        line.yTop = yTop;
        line.yBot = yBot;
      }
    };

    // Sqrt structural detection. The compiler renders \sqrt{x} as a
    // 1-row table [√ glyph (1.4× pt) | radicand cell (pt) with
    // border-top vinculum]; canvas reads √ and the radicand as
    // separate fragments at similar y. The textual decompiler can
    // only undo the `√(x)` parens form, so without folding here a
    // bare "√x" leaks through as `\sqrt{x}` (now via the bare-form
    // fallback in decompiler.js) but multi-glyph radicands (`x²+1`,
    // anything Docs splits across fillTexts) drop the trailing
    // glyphs out of the radicand. Repurpose the √ glyph's text to
    // `\sqrt{` and bracket the next adjacent fragment with a `}`
    // pseudo so the whole radicand cell ends up inside the braces.
    for (const line of lines) {
      let i = 0;
      while (i < line.fragments.length) {
        const f = line.fragments[i];
        if (!f.pseudo && f.text === "√") {
          let j = i + 1;
          while (j < line.fragments.length && line.fragments[j].pseudo) j++;
          if (j < line.fragments.length) {
            const sqrtRight = f.x + (f.width || 0);
            const sqrtFontPx = fontPx(f.font);
            const allowedGap = Math.max(sqrtFontPx * 0.5, 8);
            let bestIdx = -1;
            let bestScore = -Infinity;
            for (let k = j; k < line.fragments.length; k++) {
              const cand = line.fragments[k];
              if (cand.pseudo) continue;
              const candIsOpenParen =
                cand.text === "(" || cand.text.startsWith("(");
              if (candIsOpenParen) {
                bestIdx = k;
                bestScore = Infinity;
                break;
              }
              const gap = cand.x - sqrtRight;
              if (gap > allowedGap) break;
              const overlap = yOverlap(f, cand);
              const centerPenalty = Math.abs(
                (f.y + f.height / 2) - (cand.y + cand.height / 2)
              );
              const score = overlap - centerPenalty * 0.25;
              if (score > bestScore) {
                bestScore = score;
                bestIdx = k;
              }
            }
            if (bestIdx < 0) { i++; continue; }
            const r = line.fragments[bestIdx];
            // Skip folding when the next fragment is `(` — that's
            // the textual `√(x)` form and the decompiler's
            // convertSqrt handles it natively. Folding here would
            // mis-bracket the open paren as the radicand.
            const nextIsOpenParen = r.text === "(" || r.text.startsWith("(");
            // Only fold when the next fragment sits flush against
            // the √ — the compiler's HTML table places them in
            // adjacent cells with no gap. Allow a few pixels of
            // measurement slack relative to the √'s font size.
            const gap = r.x - sqrtRight;
            if (!nextIsOpenParen && gap <= allowedGap) {
              f.text = "\\sqrt{";
              f.script = "sqrt";
              r.script = "sqrt";
              const closer = {
                text: "}",
                x: r.x + (r.width || 0),
                y: r.y,
                width: 0,
                height: 0,
                font: "",
                pseudo: true,
                script: "sqrt",
              };
              line.fragments.splice(bestIdx + 1, 0, closer);
              i = bestIdx + 2;
              continue;
            }
          }
        }
        i++;
      }
    }

    // Binom structural detection (inline). The compiler renders
    // \binom{n}{k} as a 3-col 2-row table with rowspan=2 paren cells
    // at parenPt = pt × 1.9 wrapping stacked num/den at body pt.
    // Canvas line clustering folds the four glyphs into one line —
    // the tall parens vertically overlap both content rows — and the
    // per-line sup/sub pass tags `n` as sup and `k` as sub purely on
    // the basis of vertical offset. Without folding here the decompile
    // source spells the binom as `(^{n}_{k})`, valid but ugly. Scan
    // every line for ANY tall-paren pair (not just at first/last
    // position) and fold to `\binom{n}{k}` pseudos. Inline scanning
    // catches binoms in a sequence with surrounding text and binoms
    // inside a cases body, both of which are common.
    //
    // Tall-paren key: paren height ≥ 1.4× the line's median
    // non-paren fragment height. Compiler binom parens (1.9×) easily
    // clear it; a fraction with paren-wrapped numerator (parens at
    // body pt) does not.
    for (const line of lines) {
      foldBinomsInFragments(line.fragments);
    }
    for (let li = 0; li < lines.length - 1; li++) {
      const rows = [lines[li].fragments, lines[li + 1].fragments];
      if (!foldSplitBinomsInRows(rows)) continue;
      lines[li].fragments = rows[0] || [];
      refreshLineBounds(lines[li]);
      if (rows.length > 1 && rows[1].length) {
        lines[li + 1].fragments = rows[1];
        refreshLineBounds(lines[li + 1]);
      } else {
        lines.splice(li + 1, 1);
        li--;
      }
    }

    // Cases structural detection. The compiler renders \begin{cases}
    // with a single rowspan=N `{` glyph at bracePt = max(pt × 1.8,
    // pt × N × 1.15) on the left, with N value/condition rows to its
    // right (and any sequence prefix text on a sibling rowspan cell).
    // Canvas line clustering puts the brace + prefix text + first
    // cases row together on one logical line (the brace's tall y-span
    // overlaps row 1) but later rows fall onto separate lines, so the
    // decompile-range builder breaks the equation into one piece per
    // row. Merge every line whose y-range overlaps the brace's tall
    // span into one logical line, partition the body into rows by y
    // and into columns by x-gap, and emit `\begin{cases}`,
    // `\end{cases}`, `\\` between rows, and `&` between columns as
    // pseudos so the entire equation decompiles as a single region
    // instead of separate-row fragments.
    //
    // Detection key: a `{` glyph whose height is ≥ 1.5× the median
    // height of the line's other (non-brace) fragments. A regular `{`
    // (literal brace, no rowspan) renders at body pt and never trips
    // this threshold. Brace-pieces rendering (⎧⎨⎪⎩) from the inline
    // sequence path is not handled here.
    {
      let li = 0;
      while (li < lines.length) {
        const line = lines[li];
        const real = line.fragments.filter((f) => !f.pseudo);
        if (real.length < 2) { li++; continue; }
        const otherHs = real
          .filter((f) => f.text !== "{")
          .map((f) => f.height)
          .sort((a, b) => a - b);
        if (!otherHs.length) { li++; continue; }
        const medianH = otherHs[Math.floor(otherHs.length / 2)];
        const brace = real.find(
          (f) => f.text === "{" && f.height > medianH * 1.5
        );
        if (!brace) { li++; continue; }

        const braceTop = brace.y;
        const braceBot = brace.y + brace.height;

        let lj = li;
        while (lj + 1 < lines.length) {
          if (lines[lj + 1].yTop >= braceBot) break;
          lj++;
        }
        // No early bail when lj === li: even when every cases glyph
        // already y-clusters into one line (the brace's tall y-range
        // can pull subsequent rows into the same line at the line-
        // clustering pass), we still need to run cases detection on
        // that single line — partitioning the body by y, inserting
        // \\, &, \begin{cases}, \end{cases} pseudos.

        const allFrags = [];
        for (let k = li; k <= lj; k++) {
          for (const f of lines[k].fragments) allFrags.push(f);
        }

        const splitX = brace.x + brace.width / 2;
        // Cases body x-cap at brace.x + 2.5 × brace.height. The
        // brace's y-range can overlap content FAR to the right of
        // the cases sub-table (matrices, binoms following the cases
        // in a sequence), so without a cap that content gets pulled
        // into the cases body. Gap-based detection doesn't work
        // here: the value-to-condition gap inside cases (∼24 px,
        // from cell padding around a wide value cell + small cond
        // cell padding) is actually LARGER than the cases-to-next-
        // sequence-cell gap (∼10 px), so any gap threshold catches
        // the wrong boundary. A geometric cap of 2.5 × brace.height
        // covers a typical cases sub-table (brace cell + value cell
        // + cond cell ≈ 1.2× the brace's height worth of width per
        // outer row) without reaching far enough to grab a
        // following matrix or binom in a sequence. Items past the
        // cap go to `postFrags`, emitted after `\end{cases}` so
        // matrix detection still gets a crack at them.
        const xCapRight = brace.x + brace.height * 2.5;
        // Include pseudos in the prefix too — sqrt's closer `}` and
        // any other earlier-detection pseudos that sit at x positions
        // left of the cases brace (e.g. a `\sqrt{...}` before the
        // cases in a sequence) would otherwise be lost when we
        // rebuild the line, leaving the outer LaTeX with unmatched
        // `\sqrt{` / `\binom{` openers. Don't sort by x: detection
        // passes set pseudo positions relative to their adjacent real
        // fragments (e.g. `}{` between binom num and den at midpoint
        // x), and an x-sort can move them past their anchors when
        // num/den share an x position.
        const prefix = allFrags.filter(
          (f) => f !== brace &&
            (f.x + f.width / 2) < splitX
        );
        // bodyAll keeps pseudos so binom's `}{` splitter and other
        // pre-existing pseudos survive the cases rebuild. Use the
        // fragment's left edge for the right cap: a long condition can
        // start inside the cases table while its center falls past the
        // cap. Center-based clipping drops that whole condition into
        // post-cases content, where fraction detection later turns it
        // into stray ^{...}_{...}.
        const bodyAll = allFrags.filter(
          (f) => f !== brace &&
            (f.x + f.width / 2) >= splitX &&
            f.x <= xCapRight
        );
        const bodyReal = bodyAll.filter((f) => !f.pseudo);
        // Items past the cap belong to the post-cases content stream
        // (binom, matrix, etc., that follow the cases in a sequence).
        const postFrags = allFrags.filter(
          (f) => f !== brace &&
            (f.x + f.width / 2) >= splitX &&
            f.x > xCapRight
        );
        const postSet = new Set(postFrags);
        const postLines = [];
        if (postSet.size) {
          for (let k = li; k <= lj; k++) {
            const kept = lines[k].fragments.filter((f) => postSet.has(f));
            if (!kept.length) continue;
            let yTop = Infinity;
            let yBot = -Infinity;
            for (const f of kept) {
              if (f.pseudo) continue;
              yTop = Math.min(yTop, f.y);
              yBot = Math.max(yBot, f.y + f.height);
            }
            if (!isFinite(yTop)) {
              yTop = lines[k].yTop;
              yBot = lines[k].yBot;
            }
            postLines.push({
              yTop,
              yBot,
              fragments: kept,
              joinPrev: postLines.length === 0,
            });
          }
        }
        if (!bodyReal.length) { li++; continue; }

        // Cluster real body fragments into rows by y-range overlap
        // (>25% of the smaller fragment's height). Same pattern as
        // the outer line clustering. More forgiving than midpoint
        // distance for rows that contain a tall nested structure
        // (e.g. a `\binom` inside a cases row): the binom's tall
        // paren glyph overlaps both num and den by ~95% of the
        // smaller height, so all three cluster into one cases row,
        // while the next cases row's shorter text only overlaps the
        // binom's bottom by ~10–15% and falls into its own row.
        const rows = [];
        const bodyByY = [...bodyReal].sort((a, b) => a.y - b.y);
        for (const f of bodyByY) {
          const fTop = f.y;
          const fBot = f.y + f.height;
          let placed = false;
          for (const row of rows) {
            const oTop = Math.max(row.yMin, fTop);
            const oBot = Math.min(row.yMax, fBot);
            const overlap = Math.max(0, oBot - oTop);
            const minH = Math.min(row.yMax - row.yMin, f.height);
            if (minH > 0 && overlap > minH * 0.25) {
              row.frags.push(f);
              row.yMin = Math.min(row.yMin, fTop);
              row.yMax = Math.max(row.yMax, fBot);
              placed = true;
              break;
            }
          }
          if (!placed) {
            rows.push({ frags: [f], yMin: fTop, yMax: fBot });
          }
        }
        rows.sort((a, b) => a.yMin - b.yMin);

        // Map each real frag to its row index, then walk bodyAll in
        // original order to place real and pseudo fragments into
        // ordered rows. Pseudos inherit the previous real fragment's
        // row — this is what keeps the binom's `}{` splitter
        // (inserted by inline binom detection earlier) inside the
        // cases row that contains the binom, instead of being lost.
        const fragRowMap = new Map();
        for (let r = 0; r < rows.length; r++) {
          for (const f of rows[r].frags) fragRowMap.set(f, r);
        }
        const orderedRows = rows.map(() => []);
        let lastRowIdx = 0;
        for (const f of bodyAll) {
          let rowIdx;
          if (f.pseudo) {
            rowIdx = lastRowIdx;
          } else {
            const lookup = fragRowMap.get(f);
            rowIdx = lookup != null ? lookup : lastRowIdx;
          }
          orderedRows[rowIdx].push(f);
          lastRowIdx = rowIdx;
        }
        foldSplitBinomsInRows(orderedRows);
        for (const rowFrags of orderedRows) {
          foldBinomsInFragments(rowFrags);
          if (!foldStackedBinomsInFragments(rowFrags)) {
            foldLeadingFlatBinomInFragments(rowFrags);
          }
        }

        // Redo sup/sub in local x-clusters, not the whole cases row.
        // Structural rows can have a binom numerator/denominator and a
        // separate scripted expression on different baselines.
        const redoScripts = redoScriptsLocal;
        redoScripts(prefix);
        for (const rowFrags of orderedRows) redoScripts(rowFrags);

        // Tag whatever's left as "cases" so it stays in the decompile
        // run. decompileSource treats "cases" the same as "normal"
        // (no ^/_ wrapping); only "sup"/"sub" trigger script wrapping.
        // Skip pseudos — they already carry their own structural
        // script tags (sqrt, matrix, binom, …) from earlier
        // detection passes; overwriting them to "cases" loses no
        // decompile information but the conceptual association
        // matters if downstream code ever inspects the tag.
        for (const f of [...prefix, ...bodyReal]) {
          if (f.pseudo) continue;
          if (f.script !== "sup" && f.script !== "sub" && f.script !== "binom") {
            f.script = "cases";
          }
        }
        // Repurpose the brace glyph as `\begin{cases}`. Geometry
        // stays put — pushBlockUnified reads f.x/f.width/f.height
        // regardless of f.text — so the visible highlight still
        // covers the brace's drawn area.
        brace.text = "\\begin{cases}";
        brace.script = "cases";

        const pseudo = (text, x, y) => ({
          text, x, y, width: 0, height: 0, font: "",
          pseudo: true, script: "cases",
        });

        // Build new line.fragments. Cases is normally two-column —
        // value & condition — but the widest gap in a structural value
        // can be the space after a stacked choose, not the condition
        // boundary. Collect gap candidates per row, ignore gaps inside
        // \binom{...}, and prefer a boundary whose x-position is shared
        // by multiple rows. If no shared boundary exists, fall back to
        // the row's largest gap.
        const rowGapCandidates = (rowFrags) => {
          const out = [];
          let prevRight = -Infinity;
          let binomDepth = 0;
          for (let i = 0; i < rowFrags.length; i++) {
            const f = rowFrags[i];
            if (f.text === "\\binom{") {
              binomDepth++;
              continue;
            }
            if (f.text === "}" && binomDepth > 0) {
              binomDepth--;
              continue;
            }
            if (f.pseudo) continue;
            if (binomDepth === 0 && prevRight !== -Infinity) {
              const gap = f.x - prevRight;
              if (gap >= 4) out.push({ idx: i, x: f.x, gap });
            }
            prevRight = f.x + f.width;
          }
          return out;
        };
        const gapRows = orderedRows.map(rowGapCandidates);
        const sharedGap = (() => {
          const all = [];
          for (let r = 0; r < gapRows.length; r++) {
            for (const g of gapRows[r]) all.push({ ...g, row: r });
          }
          if (all.length < 2) return null;
          all.sort((a, b) => a.x - b.x);
          const clusters = [];
          const tol = Math.max(10, medianH * 0.8);
          for (const g of all) {
            const last = clusters[clusters.length - 1];
            if (!last || Math.abs(g.x - last.xAvg) > tol) {
              clusters.push({ items: [g], rows: new Set([g.row]), xAvg: g.x, gap: g.gap });
            } else {
              last.items.push(g);
              last.rows.add(g.row);
              last.xAvg =
                last.items.reduce((sum, item) => sum + item.x, 0) /
                last.items.length;
              last.gap += g.gap;
            }
          }
          clusters.sort((a, b) => {
            if (b.rows.size !== a.rows.size) return b.rows.size - a.rows.size;
            if (b.gap !== a.gap) return b.gap - a.gap;
            return b.xAvg - a.xAvg;
          });
          return clusters[0] && clusters[0].rows.size >= 2 ? clusters[0] : null;
        })();

        const newFrags = [...prefix, brace];
        for (let r = 0; r < orderedRows.length; r++) {
          const rowFrags = orderedRows[r];
          const gaps = gapRows[r] || [];
          const aligned = sharedGap
            ? gaps
                .filter((g) => Math.abs(g.x - sharedGap.xAvg) <= Math.max(10, medianH * 0.8))
                .sort((a, b) => Math.abs(a.x - sharedGap.xAvg) - Math.abs(b.x - sharedGap.xAvg))[0]
            : null;
          const largest = gaps
            .slice()
            .sort((a, b) => b.gap - a.gap)[0];
          const gapChoice = aligned || largest || null;
          // Minimum gap for a column boundary. 4px is wider than
          // any glyph-to-glyph gap inside a single cell (those are
          // 0–3px from font kerning) and narrower than even the
          // tightest cell-boundary gap.
          const insertAndAt = gapChoice && gapChoice.gap >= 4 ? gapChoice.idx : -1;
          // Second pass: emit fragments, inserting `&` at the
          // chosen position.
          for (let i = 0; i < rowFrags.length; i++) {
            if (i === insertAndAt) {
              const f = rowFrags[i];
              newFrags.push(pseudo("&", f.x - 1, f.y));
            }
            newFrags.push(rowFrags[i]);
          }
          if (r < orderedRows.length - 1) {
            // Position `\\` after the last real fragment in this row.
            let lastReal = null;
            for (let k = rowFrags.length - 1; k >= 0; k--) {
              if (!rowFrags[k].pseudo) { lastReal = rowFrags[k]; break; }
            }
            if (lastReal) {
              newFrags.push(pseudo(
                "\\\\",
                lastReal.x + lastReal.width,
                lastReal.y
              ));
            }
          }
        }
        // \end{cases} after the last real fragment of the last row.
        const lastRowFrags = orderedRows[orderedRows.length - 1];
        let lastRealOverall = null;
        for (let k = lastRowFrags.length - 1; k >= 0; k--) {
          if (!lastRowFrags[k].pseudo) { lastRealOverall = lastRowFrags[k]; break; }
        }
        if (lastRealOverall) {
          newFrags.push(pseudo(
            "\\end{cases}",
            lastRealOverall.x + lastRealOverall.width,
            lastRealOverall.y + lastRealOverall.height
          ));
        }
        const merged = {
          yTop: lines[li].yTop,
          yBot: lines[lj].yBot,
          fragments: newFrags,
        };
        lines.splice(li, lj - li + 1, merged, ...postLines);
        li++;
      }
    }

    // Matrix detection runs BEFORE fraction detection. A 2×2 matrix
    // shares the "tight gap, matching x-centers, similar widths" shape
    // of a fraction, so leaving fraction detection to run first would
    // fold any small matrix into `(a b)/(c d)` and break the round-trip.
    // By catching aligned-column groups first, only true single-column
    // stacks (compiled \frac pairs) survive to the fraction pass below.
    //
    // Pseudos tagged script:"matrix" are non-"normal" but not sup/sub,
    // so tokenHasDecomp treats the matrix range as decompileable even
    // when every cell is plain ASCII digits, while decompileSource
    // leaves them unwrapped.
    {
      // Bracket cells in buildMatrixHTML contain `&nbsp;` so the left/
      // right bracket columns get a real rendered glyph on canvas at a
      // minimal width. Those nbsp fragments would otherwise count as
      // extra columns and corrupt both the column match and the
      // generated LaTeX ("nbsp & 1 & 2 & nbsp"). Skip pure-whitespace
      // fragments — \s in JS covers ASCII spaces, tabs, and U+00A0.
      const realFrags = (line) =>
        line.fragments.filter((f) => !f.pseudo && /\S/.test(f.text));
      const matrixCandidateFrags = (line) =>
        realFrags(line).filter((f) =>
          f.script !== "binom" && !/^[+=]$/.test(f.text)
        );
      // Column centers via x-gap clustering — NOT per-fragment.
      // A cell with a superscript (`a²`, `-a³`, `3a²`) renders as
      // multiple canvas fragments (base char at body pt, sup glyph
      // at smaller pt) sitting flush against each other. Counting
      // fragments per row would give different totals across rows
      // (e.g. row 1 has 6 frags from 4 cells with sups, row 4 has
      // 4 frags from 4 plain digit cells), and colsMatch would
      // reject the mismatch — matrix detection bails and fraction
      // detection folds row pairs instead. Cluster fragments whose
      // x-edges sit within 5px of each other into one column
      // position so a cell's base + sup count as one position
      // regardless of how Docs split it across fillTexts. 5px
      // clears the tightest within-cell gap (sup adjacent to base,
      // gap ≈ 0) and stays well under the cell-to-cell gap in
      // matrix rendering (≥10–30px from cell padding around
      // centered content).
      const colsMatch = (a, b) => {
        if (a.length !== b.length || a.length < 2) return false;
        for (let k = 0; k < a.length; k++) {
          if (Math.abs(a[k] - b[k]) > 10) return false;
        }
        return true;
      };
      // Cluster centers, restricted to fragments whose x-center sits
      // within [xMin, xMax]. Used to filter out wrapper-prefix
      // content (a sequence's text cell to the left of the matrix)
      // that line clustering folded into the same y-band as one of
      // the matrix rows because the prefix cell is rowspan-vertical-
      // centered against the matrix's full height — its y-range
      // overlaps row 2 (or wherever the vertical center lands) by
      // well over the 25% line-clustering threshold.
      const centersInRange = (line, xMin, xMax) => {
        const frags = matrixCandidateFrags(line).filter((f) => {
          const cx = f.x + f.width / 2;
          return cx >= xMin && cx <= xMax;
        });
        if (!frags.length) return [];
        const sorted = [...frags].sort((a, b) => a.x - b.x);
        const out = [];
        let curr = {
          minX: sorted[0].x,
          maxX: sorted[0].x + sorted[0].width,
        };
        for (let k = 1; k < sorted.length; k++) {
          const f = sorted[k];
          if (f.x - curr.maxX < 5) {
            if (f.x + f.width > curr.maxX) curr.maxX = f.x + f.width;
          } else {
            out.push((curr.minX + curr.maxX) / 2);
            curr = { minX: f.x, maxX: f.x + f.width };
          }
        }
        out.push((curr.minX + curr.maxX) / 2);
        return out;
      };
      const centerClustersInRange = (line, xMin, xMax) => {
        const frags = matrixCandidateFrags(line).filter((f) => {
          const cx = f.x + f.width / 2;
          return cx >= xMin && cx <= xMax;
        });
        if (!frags.length) return [];
        const sorted = [...frags].sort((a, b) => a.x - b.x);
        const out = [];
        let curr = {
          minX: sorted[0].x,
          maxX: sorted[0].x + sorted[0].width,
        };
        for (let k = 1; k < sorted.length; k++) {
          const f = sorted[k];
          if (f.x - curr.maxX < 5) {
            curr.maxX = Math.max(curr.maxX, f.x + f.width);
          } else {
            out.push({ ...curr, cx: (curr.minX + curr.maxX) / 2 });
            curr = { minX: f.x, maxX: f.x + f.width };
          }
        }
        out.push({ ...curr, cx: (curr.minX + curr.maxX) / 2 });
        return out;
      };
      const splitCenterGroups = (clusters) => {
        if (clusters.length < 2) return [];
        const gaps = [];
        for (let k = 0; k < clusters.length - 1; k++) {
          gaps.push(Math.max(0, clusters[k + 1].minX - clusters[k].maxX));
        }
        const sortedGaps = [...gaps].sort((a, b) => a - b);
        const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)] || 0;
        const splitGap = Math.max(28, medianGap * 1.8);
        const groups = [];
        let curr = [clusters[0]];
        for (let k = 0; k < gaps.length; k++) {
          if (gaps[k] > splitGap) {
            if (curr.length >= 2) groups.push(curr);
            curr = [clusters[k + 1]];
          } else {
            curr.push(clusters[k + 1]);
          }
        }
        if (curr.length >= 2) groups.push(curr);
        return groups;
      };
      const splitGroupsAtOperators = (groups, clusters, start) => {
        if (groups.length !== 1 || clusters.length < 4) return groups;
        const scanEnd = Math.min(lines.length - 1, start + 5);
        for (let r = start; r <= scanEnd; r++) {
          for (const f of realFrags(lines[r])) {
            if (!/^[+=]$/.test(f.text)) continue;
            const cx = f.x + f.width / 2;
            for (let k = 0; k < clusters.length - 1; k++) {
              if (cx <= clusters[k].maxX || cx >= clusters[k + 1].minX) {
                continue;
              }
              const left = clusters.slice(0, k + 1);
              const right = clusters.slice(k + 1);
              if (left.length >= 2 && right.length >= 2) {
                return [left, right];
              }
            }
          }
        }
        return groups;
      };

      let i = 0;
      while (i < lines.length) {
        const start = i;
        if (lines[start].fragments.some(
          (f) => f.script === "cases" ||
            f.text === "\\begin{cases}" ||
            f.text === "\\end{cases}"
        )) {
          i++;
          continue;
        }
        const baseClusters = centerClustersInRange(
          lines[start],
          -Infinity,
          Infinity
        );
        const baseGroups = splitGroupsAtOperators(
          splitCenterGroups(baseClusters),
          baseClusters,
          start
        );
        if (!baseGroups.length) { i++; continue; }

        const candidates = [];
        for (let gi = 0; gi < baseGroups.length; gi++) {
          const group = baseGroups[gi];
          const baseCenters = group.map((c) => c.cx);
          // Establish each matrix's x-range from one horizontal group.
          // When two matrices are siblings in a wrapper table, the top
          // row exposes both sets of columns; the large inter-block gap
          // splits them so the plus sign between them stays outside.
          const prev = baseGroups[gi - 1];
          const next = baseGroups[gi + 1];
          const leftGap = prev
            ? group[0].minX - prev[prev.length - 1].maxX
            : Infinity;
          const rightGap = next
            ? next[0].minX - group[group.length - 1].maxX
            : Infinity;
          const leftPad = prev ? Math.min(18, leftGap / 3) : 30;
          const rightPad = next ? Math.min(18, rightGap / 3) : 30;
          const xMin = group[0].minX - leftPad;
          const xMax = group[group.length - 1].maxX + rightPad;
          let end = start;
          while (end + 1 < lines.length) {
            const B = lines[end + 1];
            let lastMatrixLine = lines[end];
            for (let k = end; k >= start; k--) {
              const c = centersInRange(lines[k], xMin, xMax);
              if (c.length > 0) { lastMatrixLine = lines[k]; break; }
            }
            const gap = B.yTop - lastMatrixLine.yBot;
            if (gap > 30) break;
            const bCenters = centersInRange(B, xMin, xMax);
            if (bCenters.length === 0) {
              end++;
              continue;
            }
            if (!colsMatch(baseCenters, bCenters)) break;
            end++;
          }
          if (end > start) {
            candidates.push({ xMin, xMax, start, end, baseCenters });
          }
        }
        if (!candidates.length) { i++; continue; }

        candidates.sort((a, b) => a.xMin - b.xMin);
        const overallEnd = candidates.reduce(
          (m, c) => Math.max(m, c.end),
          start
        );
        const pseudo = (text, x, y) => ({
          text, x, y, width: 0, height: 0, font: "",
          pseudo: true, script: "matrix",
        });
        const inCandidate = (cand, f) => {
          const cx = f.x + f.width / 2;
          return cx >= cand.xMin && cx <= cand.xMax;
        };
        const clusterRow = (frags) => {
          if (!frags.length) return [];
          const sorted = [...frags].sort((a, b) => a.x - b.x);
          const out = [];
          let curr = null;
          let lastRight = -Infinity;
          for (const f of sorted) {
            if (f.pseudo) {
              if (!curr) { curr = []; out.push(curr); }
              curr.push(f);
              continue;
            }
            if (!curr || f.x - lastRight >= 5) {
              curr = [f];
              out.push(curr);
            } else {
              curr.push(f);
            }
            lastRight = Math.max(lastRight, f.x + f.width);
          }
          return out;
        };
        const buildMatrixFlat = (cand) => {
          const matrixRowsAll = [];
          for (let r = cand.start; r <= cand.end; r++) {
            const rowAll = lines[r].fragments.filter(
              (f) => inCandidate(cand, f) &&
                (f.pseudo || /\S/.test(f.text))
            );
            const rowReal = rowAll.filter((f) => !f.pseudo);
            if (!rowReal.length) continue;
            const sortedY = [...rowReal].sort((a, b) => a.y - b.y);
            const rowYGroups = [];
            for (const f of sortedY) {
              const fTop = f.y;
              const fBot = f.y + f.height;
              let placed = false;
              for (const g of rowYGroups) {
                const oTop = Math.max(g.yMin, fTop);
                const oBot = Math.min(g.yMax, fBot);
                const overlap = Math.max(0, oBot - oTop);
                const minH = Math.min(g.yMax - g.yMin, f.height);
                if (minH > 0 && overlap > minH * 0.25) {
                  g.frags.push(f);
                  g.yMin = Math.min(g.yMin, fTop);
                  g.yMax = Math.max(g.yMax, fBot);
                  placed = true;
                  break;
                }
              }
              if (!placed) {
                rowYGroups.push({ frags: [f], yMin: fTop, yMax: fBot });
              }
            }
            const fragToRow = new Map();
            for (let y = 0; y < rowYGroups.length; y++) {
              for (const f of rowYGroups[y].frags) fragToRow.set(f, y);
            }
            const ordered = rowYGroups.map(() => []);
            let lastRow = 0;
            for (const f of rowAll) {
              let rowIdx;
              if (f.pseudo) {
                let best = lastRow;
                let bestDist = Infinity;
                const fy = f.y || (rowYGroups[lastRow] || {}).yMin || 0;
                for (let y = 0; y < rowYGroups.length; y++) {
                  const mid = (rowYGroups[y].yMin + rowYGroups[y].yMax) / 2;
                  const dist = Math.abs(fy - mid);
                  if (dist < bestDist) { bestDist = dist; best = y; }
                }
                rowIdx = best;
              } else {
                rowIdx = fragToRow.get(f);
                if (rowIdx == null) rowIdx = lastRow;
              }
              ordered[rowIdx].push(f);
              lastRow = rowIdx;
            }
            for (const row of ordered) matrixRowsAll.push(row);
          }
          const out = [
            pseudo("\\begin{bmatrix}", cand.xMin, lines[cand.start].yTop),
          ];
          let lastRowClusters = [];
          for (let mr = 0; mr < matrixRowsAll.length; mr++) {
            const cells = clusterRow(matrixRowsAll[mr]);
            for (let c = 0; c < cells.length; c++) {
              if (c > 0) {
                const cell = cells[c];
                out.push(pseudo("&", cell[0].x, cell[0].y));
              }
              redoScriptsLocal(cells[c]);
              for (const f of cells[c]) {
                if (f.script !== "sup" && f.script !== "sub") {
                  f.script = "matrix";
                }
                out.push(f);
              }
            }
            if (mr < matrixRowsAll.length - 1 && cells.length > 0) {
              const lastCell = cells[cells.length - 1];
              const lastFrag = lastCell[lastCell.length - 1];
              out.push(pseudo(
                "\\\\",
                lastFrag.x + (lastFrag.width || 0),
                lastFrag.y
              ));
            }
            if (mr === matrixRowsAll.length - 1) lastRowClusters = cells;
          }
          const tailX = lastRowClusters.length
            ? (() => {
                const lastCell = lastRowClusters[lastRowClusters.length - 1];
                const lastFrag = lastCell[lastCell.length - 1];
                return lastFrag.x + (lastFrag.width || 0);
              })()
            : cand.xMax;
          out.push(pseudo("\\end{bmatrix}", tailX, lines[cand.end].yBot));
          return out;
        };
        const flat = [];
        const emitLoose = (left, right) => {
          const loose = [];
          for (let r = start; r <= overallEnd; r++) {
            for (const f of lines[r].fragments) {
              const cx = f.x + f.width / 2;
              if (cx < left || cx >= right) continue;
              if (candidates.some((cand) => inCandidate(cand, f))) continue;
              loose.push(f);
            }
          }
          if (!loose.length) return;
          redoScriptsLocal(loose);
          for (const f of loose) {
            if (!f.pseudo && f.script !== "sup" && f.script !== "sub") {
              f.script = "matrix";
            }
            flat.push(f);
          }
        };

        let cursorX = -Infinity;
        for (const cand of candidates) {
          emitLoose(cursorX, cand.xMin);
          flat.push(...buildMatrixFlat(cand));
          cursorX = cand.xMax;
        }
        emitLoose(cursorX, Infinity);

        const merged = {
          yTop: lines[start].yTop,
          yBot: lines[overallEnd].yBot,
          fragments: flat,
          joinPrev: !!lines[start].joinPrev,
        };
        lines.splice(start, overallEnd - start + 1, merged);
        i = start + 1;
      }
    }

    // Inline fractions inside a tall wrapper row (for example
    // `cases + \frac{2}{2} + 3`) come back as two physical rows, but the
    // top row also contains the loose siblings (`+` and `+3`). The generic
    // whole-line fraction detector below rejects that because the top
    // row's center/width no longer matches the denominator. Match just
    // the centered numerator/denominator clusters and leave the loose
    // siblings in place.
    const hasStructuralFragments = (line) =>
      line.fragments.some((f) =>
        f.script === "cases" ||
        f.script === "matrix" ||
        f.script === "binom" ||
        f.text === "\\begin{cases}" ||
        f.text === "\\end{cases}" ||
        f.text === "\\begin{bmatrix}" ||
        f.text === "\\end{bmatrix}"
      );
    const clusterPlainRuns = (frags) => {
      const out = [];
      const real = frags
        .filter((f) => !f.pseudo && /\S/.test(f.text || ""))
        .sort((a, b) => a.x - b.x);
      let curr = null;
      let lastRight = -Infinity;
      const isOperator = (f) => /^[+=]$/.test(f.text || "");
      for (const f of real) {
        if (isOperator(f)) {
          curr = null;
          lastRight = -Infinity;
          continue;
        }
        const gap = curr ? f.x - lastRight : Infinity;
        if (!curr || gap > Math.max(5, fontPx(f.font) * 0.4)) {
          curr = {
            frags: [f],
            minX: f.x,
            maxX: f.x + f.width,
            minY: f.y,
            maxY: f.y + f.height,
          };
          out.push(curr);
        } else {
          curr.frags.push(f);
          curr.maxX = Math.max(curr.maxX, f.x + f.width);
          curr.minY = Math.min(curr.minY, f.y);
          curr.maxY = Math.max(curr.maxY, f.y + f.height);
        }
        lastRight = Math.max(lastRight, f.x + f.width);
      }
      for (const c of out) {
        c.cx = (c.minX + c.maxX) / 2;
        c.cy = (c.minY + c.maxY) / 2;
        c.w = Math.max(1, c.maxX - c.minX);
        c.frags.sort((a, b) => a.x - b.x);
        c.text = c.frags.map((f) => f.text || "").join("").replace(/\s+/g, "");
      }
      return out;
    };
    const plainFractionText = (text) =>
      /^[A-Za-z0-9]+(?:[-+][A-Za-z0-9]+)*$/.test(text || "");
    const foldSameLineInlineFraction = (line) => {
      if (hasStructuralFragments(line)) return false;
      const topFrags = line.fragments.filter((f) => !f.pseudo && f.script === "sup");
      const botFrags = line.fragments.filter((f) => !f.pseudo && f.script === "sub");
      if (!topFrags.length || !botFrags.length) return false;

      const topClusters = clusterPlainRuns(topFrags).filter((c) => plainFractionText(c.text));
      const botClusters = clusterPlainRuns(botFrags).filter((c) => plainFractionText(c.text));
      let best = null;
      for (const top of topClusters) {
        for (const bot of botClusters) {
          const centerDelta = Math.abs(top.cx - bot.cx);
          const centerTol = Math.max(8, Math.max(top.w, bot.w) * 0.45);
          if (centerDelta > centerTol) continue;
          const wr = Math.max(top.w, 1) / Math.max(bot.w, 1);
          if (wr < 0.2 || wr > 5) continue;
          const score = centerDelta + Math.abs(Math.log(wr)) * 4;
          if (!best || score < best.score) best = { top, bot, score };
        }
      }
      if (!best) return false;

      const pseudo = (text, x, y) => ({
        text, x, y, width: 0, height: 0, font: "",
        pseudo: true, script: "fraction",
      });
      for (const f of [...best.top.frags, ...best.bot.frags]) {
        f.script = "fraction";
      }
      const matchedTop = new Set(best.top.frags);
      const matchedBot = new Set(best.bot.frags);
      const rebuilt = [];
      let inserted = false;
      for (const f of line.fragments) {
        if (matchedTop.has(f)) {
          if (!inserted) {
            rebuilt.push(
              pseudo("(", best.top.minX, best.top.minY),
              ...best.top.frags,
              pseudo(")/(", best.bot.minX, (best.top.maxY + best.bot.minY) / 2),
              ...best.bot.frags,
              pseudo(")", best.bot.maxX, best.bot.maxY)
            );
            inserted = true;
          }
          continue;
        }
        if (matchedBot.has(f)) continue;
        if (!f.pseudo &&
            (f.script === "sup" || f.script === "sub") &&
            (/^[+=]/.test(f.text || "") || /^[0-9]+$/.test(f.text || ""))) {
          f.script = "normal";
        }
        rebuilt.push(f);
      }
      if (!inserted) return false;
      line.fragments = rebuilt;
      refreshLineBounds(line);
      return true;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const prev = i > 0 ? lines[i - 1] : null;
      const nearCases =
        !!line.joinPrev ||
        !!(prev && prev.fragments.some((f) => f.text === "\\end{cases}"));
      if (nearCases) foldSameLineInlineFraction(line);
    }

    for (let i = 0; i < lines.length - 1; i++) {
      const A = lines[i];
      const B = lines[i + 1];
      const prev = i > 0 ? lines[i - 1] : null;
      const nearCases =
        !!A.joinPrev ||
        !!(prev && prev.fragments.some((f) => f.text === "\\end{cases}"));
      if (!nearCases) continue;
      if (B.yTop - A.yBot > 18) continue;
      if (hasStructuralFragments(A) || hasStructuralFragments(B)) continue;

      const topClusters = clusterPlainRuns(A.fragments).filter((c) => plainFractionText(c.text));
      const botClusters = clusterPlainRuns(B.fragments).filter((c) => plainFractionText(c.text));
      let best = null;
      for (const top of topClusters) {
        for (const bot of botClusters) {
          const centerDelta = Math.abs(top.cx - bot.cx);
          const centerTol = Math.max(8, Math.max(top.w, bot.w) * 0.45);
          if (centerDelta > centerTol) continue;
          const wr = Math.max(top.w, 1) / Math.max(bot.w, 1);
          if (wr < 0.2 || wr > 5) continue;
          const score = centerDelta + Math.abs(Math.log(wr)) * 4;
          if (!best || score < best.score) best = { top, bot, score };
        }
      }
      if (!best) continue;

      const pseudo = (text, x, y) => ({
        text, x, y, width: 0, height: 0, font: "",
        pseudo: true, script: "fraction",
      });
      for (const f of [...best.top.frags, ...best.bot.frags]) {
        f.script = "fraction";
      }
      const matchedTop = new Set(best.top.frags);
      const matchedBot = new Set(best.bot.frags);
      const rebuilt = [];
      let inserted = false;
      for (const f of A.fragments) {
        if (matchedTop.has(f)) {
          if (!inserted) {
            rebuilt.push(
              pseudo("(", best.top.minX, best.top.minY),
              ...best.top.frags,
              pseudo(")/(", best.bot.minX, (A.yBot + B.yTop) / 2),
              ...best.bot.frags,
              pseudo(")", best.bot.maxX, best.bot.maxY)
            );
            inserted = true;
          }
          continue;
        }
        if (!f.pseudo && f.script !== "fraction") f.script = "normal";
        rebuilt.push(f);
      }
      if (!inserted) continue;

      const remainingB = B.fragments.filter((f) => !matchedBot.has(f));
      A.fragments = rebuilt;
      A.yTop = Math.min(A.yTop, B.yTop);
      A.yBot = Math.max(A.yBot, B.yBot);
      if (remainingB.some((f) => !f.pseudo)) {
        B.fragments = remainingB;
        refreshLineBounds(B);
      } else {
        lines.splice(i + 1, 1);
      }
      refreshLineBounds(A);
    }

    // Fraction detection: two adjacent lines with a near-zero vertical
    // gap, matching horizontal centers, and similar widths are the
    // numerator/denominator halves of a compiled fraction. Fold each
    // such pair into a single line whose fragment sequence is
    // `( num )/( den )`, so concat and decompileSource hand the
    // decompiler a "(…)/(…)" form that convertFrac turns back into
    // \frac{num}{den} on click. Pseudo-fragments are tagged so the
    // rect-emitting paths (pushBlock, findRegionSourcePt, spell-check)
    // ignore them — they exist only to shape the concat string.
    // Matrices have already been folded above, so any surviving
    // adjacent-centered-lines pair is a real fraction.
    const lineBounds = (line) => {
      let minX = Infinity, maxX = -Infinity;
      for (const f of line.fragments) {
        if (f.pseudo) continue;
        if (f.x < minX) minX = f.x;
        if (f.x + f.width > maxX) maxX = f.x + f.width;
      }
      return {
        minX, maxX,
        cx: (minX + maxX) / 2,
        w: Math.max(0, maxX - minX),
      };
    };
    for (let i = 0; i < lines.length - 1; i++) {
      const A = lines[i];
      const B = lines[i + 1];
      if (hasStructuralFragments(A) || hasStructuralFragments(B)) continue;
      const gap = B.yTop - A.yBot;
      // Prose line-spacing at 11pt Arial runs 8–12 CSS px of
      // glyph-bottom-to-next-glyph-top once you account for actual
      // bounding-box ascent/descent (canvas measureText gives tight
      // glyph boxes, not the font's full em height). A compiled
      // fraction uses line-height:1 and border:0.75pt so it runs
      // tighter than prose, but the matching x-center signal does the
      // real work here — 12px still excludes normal paragraph
      // spacing (14–18px) without missing a slightly looser fraction.
      if (gap > 12) continue;
      const bA = lineBounds(A);
      const bB = lineBounds(B);
      if (!isFinite(bA.cx) || !isFinite(bB.cx)) continue;
      // Matching x-center is the primary signal. A superscript in the
      // denominator (`\frac{1}{2^2}`) can shift that cell's measured
      // center right by half its sup width — so 6px tolerance covers
      // an 11pt sup char without letting unrelated left-aligned prose
      // match.
      if (Math.abs(bA.cx - bB.cx) > 6) continue;
      // Width ratio is a weak backstop — "1" over "2²" lands around
      // 0.4, "x" over "y+1" around 0.2. Keep the bounds wide.
      const wr = Math.max(bA.w, 1) / Math.max(bB.w, 1);
      if (wr < 0.2 || wr > 5) continue;

      // Tag both pseudos and real cell frags with script:"fraction".
      // tokenHasDecomp keys off annotations, so an all-ASCII numerator
      // like "abc" (none of sin/cos/digits/ops) still counts as mathy
      // and stays inside the decompile run. decompileSource treats any
      // non-sup/non-sub annotation as "normal", so no bracing leaks
      // around the literal `(…)/(…)` output the pseudos already spell.
      const pseudo = (text, x, y) => ({
        text, x, y, width: 0, height: 0, font: "",
        pseudo: true, script: "fraction",
      });
      for (const f of A.fragments) {
        if (f.script !== "sup" && f.script !== "sub") f.script = "fraction";
      }
      for (const f of B.fragments) {
        if (f.script !== "sup" && f.script !== "sub") f.script = "fraction";
      }
      const merged = {
        yTop: A.yTop,
        yBot: B.yBot,
        fragments: [
          pseudo("(", bA.minX, A.yTop),
          ...A.fragments,
          pseudo(")/(", bB.minX, (A.yBot + B.yTop) / 2),
          ...B.fragments,
          pseudo(")", bB.maxX, B.yBot),
        ],
      };
      lines.splice(i, 2, merged);
      // Don't rewind — single-level fraction only. Nested fractions
      // would need recursive detection plus special handling so
      // convertFrac's paren-matching still pairs correctly.
    }

    // Flatten back into the in-order list downstream code expects,
    // remembering which fragment indices sit at the start of a new
    // logical line. Fractions and matrices are already folded into
    // single lines above, so these boundaries are real paragraph/line
    // breaks — purple decompile runs get flushed on crossing one so a
    // mathy token on line N doesn't drag a run across into line N+1.
    deduped.length = 0;
    const lineBoundaryFrags = new Set();
    for (const line of lines) {
      if (deduped.length > 0 && !line.joinPrev) {
        lineBoundaryFrags.add(deduped.length);
      }
      for (const f of line.fragments) deduped.push(f);
    }

    // Build concat with per-char script annotations (parallel arrays
    // indexed by UTF-16 code unit, same as concat itself). Separator
    // is a newline across a line boundary and a space within one — both
    // satisfy /\s/ for tokenization, but the newline is also the signal
    // the purple-run builder uses to break runs at line ends.
    const fragStarts = new Array(deduped.length);
    const parts = [];
    const annoParts = [];
    let pos = 0;
    for (let i = 0; i < deduped.length; i++) {
      if (i > 0) {
        const sep = lineBoundaryFrags.has(i) ? "\n" : " ";
        parts.push(sep);
        // Separator annotations are deferred — a SEP between two
        // sup fragments should bridge into a single ^{…} run, but we
        // don't know the neighbors yet. Fill in a second pass below.
        for (let k = 0; k < sep.length; k++) annoParts.push(null);
        pos += sep.length;
      }
      fragStarts[i] = pos;
      parts.push(deduped[i].text);
      const ann = deduped[i].script || "normal";
      for (let k = 0; k < deduped[i].text.length; k++) annoParts.push(ann);
      pos += deduped[i].text.length;
    }
    const concat = parts.join("");
    // Resolve deferred SEP annotations: a separator whose left and
    // right neighbors share the same sup/sub annotation inherits it,
    // so "a"/"b"/"c" sup fragments separated by SEPs collapse into one
    // ^{abc} rather than three ^{a}^{b}^{c} during decompile.
    {
      const leftAnn = new Array(annoParts.length);
      const rightAnn = new Array(annoParts.length);
      let last = "normal";
      for (let i = 0; i < annoParts.length; i++) {
        if (annoParts[i] != null) last = annoParts[i];
        leftAnn[i] = last;
      }
      last = "normal";
      for (let i = annoParts.length - 1; i >= 0; i--) {
        if (annoParts[i] != null) last = annoParts[i];
        rightAnn[i] = last;
      }
      for (let i = 0; i < annoParts.length; i++) {
        if (annoParts[i] == null) {
          annoParts[i] = leftAnn[i] === rightAnn[i] ? leftAnn[i] : "normal";
        }
      }
    }
    const annotations = annoParts;

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
        // Pseudo-fragments (fraction parens/rules, etc.) exist only to
        // shape concat for decompile. They have no drawn geometry, so
        // emitting a rect for them would produce a zero-width box or
        // misuse the scratch canvas font from the previous iteration.
        if (f.pseudo) continue;
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

    // Decompile-region variant of pushBlock. Emits ONE visual mark per
    // logical line (no matter how many fragments / matrix cells it
    // contains) so a 2×2 matrix shows a single underline beneath the
    // whole table instead of four under-each-cell underlines.
    //
    // For hit-testing and selection-drag (regionAtPoint /
    // selectRegionOnCanvas), per-physical-row rects are still pushed
    // to rectsOut. Within a merged-line segment (e.g. one matrix),
    // fragments are clustered by y-overlap into rows; each row's
    // bounding rect covers the entire row width so gaps between cells
    // count as part of the region, and the first/last rects in
    // rectsOut span from the top row to the bottom row so the drag
    // selection covers the whole matrix.
    function pushBlockUnified(ra, rb, bg, border, rectsOut, marksOut) {
      const segments = [];
      let curr = null;

      const overlapsRow = (row, fTop, fBot) => {
        const oTop = Math.max(row.minY, fTop);
        const oBot = Math.min(row.maxY, fBot);
        if (oBot <= oTop) return false;
        return (oBot - oTop) >
          0.25 * Math.min(row.maxY - row.minY, fBot - fTop);
      };

      const closeSegment = () => {
        if (curr && curr.rows.length) segments.push(curr);
        curr = null;
      };

      for (let fi = 0; fi < deduped.length; fi++) {
        const fs = fragStarts[fi];
        const f = deduped[fi];
        if (f.pseudo) continue;
        const L = f.text.length;
        const localStart = Math.max(0, ra - fs);
        const localEnd = Math.min(L, rb - fs);
        if (localStart >= localEnd) continue;

        if (lineBoundaryFrags.has(fi)) closeSegment();

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

        if (!curr) curr = { rows: [] };

        let row = null;
        for (const r of curr.rows) {
          if (overlapsRow(r, cssTop, cssTop + cssHeight)) { row = r; break; }
        }
        if (!row) {
          curr.rows.push({
            minX: cssLeft,
            minY: cssTop,
            maxX: cssLeft + cssWidth,
            maxY: cssTop + cssHeight,
          });
        } else {
          if (cssLeft < row.minX) row.minX = cssLeft;
          if (cssTop < row.minY) row.minY = cssTop;
          if (cssLeft + cssWidth > row.maxX) row.maxX = cssLeft + cssWidth;
          if (cssTop + cssHeight > row.maxY) row.maxY = cssTop + cssHeight;
        }
      }
      closeSegment();

      for (const seg of segments) {
        seg.rows.sort((a, b) => a.minY - b.minY);

        let bMinX = Infinity, bMinY = Infinity;
        let bMaxX = -Infinity, bMaxY = -Infinity;
        for (const r of seg.rows) {
          if (r.minX < bMinX) bMinX = r.minX;
          if (r.minY < bMinY) bMinY = r.minY;
          if (r.maxX > bMaxX) bMaxX = r.maxX;
          if (r.maxY > bMaxY) bMaxY = r.maxY;
        }
        const cssLeft = bMinX;
        const cssTop = bMinY;
        const cssWidth = bMaxX - bMinX;
        const cssHeight = bMaxY - bMinY;

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
        if (marksOut) marksOut.push({ box: mark, under });

        if (rectsOut) {
          for (const r of seg.rows) {
            rectsOut.push({
              cssLeft: r.minX,
              cssTop: r.minY,
              cssWidth: r.maxX - r.minX,
              cssHeight: r.maxY - r.minY,
            });
          }
        }
      }
    }

    // Fragment fonts come from the MAIN-world highlighter as canvas
    // font strings ("Npx Family…"). We need the source pt size so
    // fractions/matrices can be rendered proportionally to it.
    const findRegionSourcePt = (ra, rb) => {
      for (let fi = 0; fi < deduped.length; fi++) {
        const fs = fragStarts[fi];
        const f = deduped[fi];
        if (f.pseudo) continue;
        const localStart = Math.max(0, ra - fs);
        const localEnd = Math.min(f.text.length, rb - fs);
        if (localStart >= localEnd) continue;
        const fnt = f.font || "";
        const ptM = /(\d+(?:\.\d+)?)pt/.exec(fnt);
        if (ptM) return parseFloat(ptM[1]);
        const pxM = /(\d+(?:\.\d+)?)px/.exec(fnt);
        if (pxM) return parseFloat(pxM[1]) * (72 / 96);
      }
      return 11;
    };

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
          type: "compile",
          rects,
          latex,
          rich: compileRich(latex),
          canvas,
          marks,
          sourcePt: findRegionSourcePt(ra, rb),
        });
      }
    }

    // Purple (decompile) regions: contiguous non-whitespace runs in
    // the concatenated canvas text that contain at least one glyph we
    // can turn back into a LaTeX command (Greek, super/subscripts,
    // math operators, blackboard bold, …). These cover both content
    // we previously pasted as compile output AND any Unicode math the
    // user typed or pasted in directly — we don't care where it came
    // from, only that there's a round-trip name for it.
    //
    // Anything that overlaps a green \(...\) / \[...\] region or an
    // unclosed opener is already LaTeX source, not output, and is
    // excluded so we don't offer to "decompile" a literal \alpha.
    const hasDecompileableFn =
      typeof window.hasDecompileable === "function"
        ? window.hasDecompileable
        : () => false;
    const canDecompile = typeof window.unicodeToLatex === "function";

    // Token-level decompile range detection. Split concat on
    // whitespace, classify each token, and join consecutive
    // math-looking tokens into one run — so "α + β = γ" underlines
    // as one continuous region instead of three. A run is only
    // emitted if it contains at least one glyph we can actually
    // convert, or a sup/sub-annotated char (native Cmd+./Cmd+,
    // formatting round-trips as ^{…}/_{…} even when the base
    // characters are plain ASCII).
    const TEXT_OPS_SET = new Set([
      "sin","cos","tan","sec","csc","cot",
      "arcsin","arccos","arctan",
      "sinh","cosh","tanh","coth",
      "log","ln","lg","exp",
      "lim","limsup","liminf","sup","inf",
      "max","min","arg","det","dim","ker","hom",
      "gcd","lcm",
    ]);
    const hasScriptInRange = (a, b) => {
      for (let i = a; i < b; i++) {
        if (annotations[i] && annotations[i] !== "normal") return true;
      }
      return false;
    };
    // Docs occasionally sprinkles invisible control characters — zero-
    // width spaces, joiners, bidi markers — at font-run boundaries
    // (e.g. between a native sup fragment and the normal text that
    // follows it). These are not matched by /\s/, so the token parser
    // would glue them to the adjacent text and fail the math-char
    // whitelist, cutting the decompile run short right before the tail
    // of the equation. Treat them as whitespace for tokenization so a
    // stuck invisible can't orphan the "=3" after "α²".
    //   U+200B–U+200F: ZWSP, ZWNJ, ZWJ, LRM, RLM
    //   U+202A–U+202E: embedding/override bidi controls
    //   U+2060      : word joiner
    //   U+FEFF      : zero-width NBSP / BOM
    const TOKEN_SEP = /[\s\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/;
    const tokens = [];
    {
      let p = 0;
      while (p < concat.length) {
        while (p < concat.length && TOKEN_SEP.test(concat[p])) p++;
        if (p >= concat.length) break;
        const s = p;
        while (p < concat.length && !TOKEN_SEP.test(concat[p])) p++;
        tokens.push({ start: s, end: p, text: concat.substring(s, p) });
      }
    }
    const tokenHasDecomp = (tk) =>
      hasDecompileableFn(tk.text) || hasScriptInRange(tk.start, tk.end);
    const isMathyToken = (tk) => {
      const t = tk.text;
      if (tokenHasDecomp(tk)) return true;
      if (TEXT_OPS_SET.has(t.toLowerCase())) return true;
      const cp = Array.from(t);
      // Single-char variable or digit — common ingredient of inline
      // math. Multi-letter tokens without any digit/operator look
      // like prose and are excluded.
      if (cp.length === 1 && /[a-zA-Z0-9]/.test(cp[0])) return true;
      if (/^[+\-*=<>()[\]|.,:;/]+$/.test(t)) return true;
      if (/^[a-zA-Z0-9+\-*=<>()[\]|.,:;/]+$/.test(t) &&
          /[0-9+\-*=<>()[\]|/]/.test(t)) return true;
      return false;
    };
    const decompileRanges = [];
    if (canDecompile) {
      let run = null;
      const flushRun = () => {
        if (run && run.hasDecomp) decompileRanges.push([run.start, run.end]);
        run = null;
      };
      for (const tk of tokens) {
        if (isMathyToken(tk)) {
          const d = tokenHasDecomp(tk);
          // A newline in the gap since the last token means we've
          // crossed a logical line boundary. Decompile runs are not
          // allowed to straddle lines — "α² + 1" on line 1 and "β = 2"
          // on line 2 should be two separate purple regions, not one.
          const crossesLine =
            run && concat.substring(run.end, tk.start).includes("\n");
          if (!run || crossesLine) {
            flushRun();
            run = { start: tk.start, end: tk.end, hasDecomp: d };
          } else {
            run.end = tk.end;
            if (d) run.hasDecomp = true;
          }
        } else {
          flushRun();
        }
      }
      flushRun();
      // Drop ranges that overlap \[…\] / \(…\) or unclosed openers —
      // those are LaTeX source, not rendered output.
      for (let i = decompileRanges.length - 1; i >= 0; i--) {
        if (isCovered(decompileRanges[i][0], decompileRanges[i][1])) {
          decompileRanges.splice(i, 1);
        }
      }
    }

    // Build the decompile-source text for a concat range, folding
    // sup/sub annotated runs into ^{…}/_{…} before the caller hands
    // it to unicodeToLatex. Natively-formatted scripts (Cmd+./Cmd+,)
    // have no ^ or _ markers on the canvas; the annotations we built
    // from line geometry restore that structural info for LaTeX.
    const decompileSource = (ra, rb) => {
      let out = "";
      let state = "normal";
      for (let i = ra; i < rb; i++) {
        const raw = annotations[i] || "normal";
        // Only sup/sub annotations drive the ^{…}/_{…} wrapping.
        // Other non-"normal" values (e.g. "matrix") exist so that
        // tokenHasDecomp treats the region as decompileable, but
        // shouldn't bracket the output — the pseudo-fragments already
        // spell out their own LaTeX structure.
        const ann = raw === "sup" || raw === "sub" ? raw : "normal";
        if (ann !== state) {
          if (state !== "normal") out += "}";
          if (ann === "sup") out += "^{";
          else if (ann === "sub") out += "_{";
          state = ann;
        }
        out += concat[i];
      }
      if (state !== "normal") out += "}";
      return out;
    };

    const decompileBg = debugMode ? PURPLE_BG : "transparent";
    const decompileBorder = PURPLE_BORDER;
    for (const [ra, rb] of decompileRanges) {
      const rects = [];
      const marks = [];
      pushBlockUnified(ra, rb, decompileBg, decompileBorder, rects, marks);
      if (rects.length) {
        regionsOut.push({
          type: "decompile",
          rects,
          // Pre-wrapped with ^{…}/_{…} for sup/sub runs. The click
          // handler feeds this through unicodeToLatex to fold Greek /
          // blackboard / unicode script glyphs into LaTeX names.
          text: decompileSource(ra, rb),
          canvas,
          marks,
          sourcePt: findRegionSourcePt(ra, rb),
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
        if (f.pseudo) continue;
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
        /* Purple variant for decompile regions. Listed before .is-toast
           so the toast state (black) still wins when both classes are
           present — same-specificity rules fall back to source order. */
        .btn.is-purple { background: #9c27b0; }
        .btn.is-purple:hover { background: #7b1fa2; }
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
    const isDecompile = region && region.type === "decompile";
    popupBtn.classList.toggle("is-purple", isDecompile);
    popupLabel.textContent = isDecompile ? "Decompile" : "Compile";
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

  function dispatchPaste(target, text, html) {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    if (html) dt.setData("text/html", html);
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

  function dispatchBeforeInput(target, text, html) {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    if (html) dt.setData("text/html", html);
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

    // Drag from the region's left edge to its right edge. For compile
    // (green) regions and inline decompile, insetting by a hair keeps
    // the hits inside the glyph boxes.
    //
    // For decompile regions covering structural blocks (matrix, frac,
    // binom, sqrt, cases — and the outer buildNestedSequenceHTML
    // wrapper that holds a prefix-text cell next to the structural
    // block) the canvas glyph rects only mark cell text. Bracket
    // borders, paren glyphs (when CSS), fraction bars, vinculum
    // strokes, and the wrapper table chrome are non-glyph CSS, so a
    // drag bounded by cell text alone makes Docs treat the paste as
    // a within-cell content replacement — the inner table's content
    // gets overwritten but the wrapper table persists, leaving the
    // LaTeX source split across two cells.
    //
    // To make the paste delete the entire structure (wrapper and
    // all), overshoot the envelope horizontally well past the
    // wrapper's left/right edges AND vertically well past its
    // top/bottom — even a single-row pushBlockUnified output (which
    // happens when a tall structural glyph like the cases brace
    // y-bridges multiple visual rows during clustering) needs the
    // drag to span the full vertical extent or the cursor never
    // crosses out of the inner cell. Compute the envelope across
    // ALL rects and ALWAYS use envTop/envBottom for table regions —
    // not the row-center fallback that's appropriate only for inline
    // text decompile.
    const isDecompile = region.type === "decompile";
    const text = (region.text || "");
    const containsTable = isDecompile &&
      /\\begin\{|\\binom\{|\\frac\{|\\sqrt\{/.test(text);
    const xPad = containsTable ? 40 : 0;
    const yPad = containsTable ? 20 : 0;

    let envLeft = Infinity, envRight = -Infinity;
    let envTop = Infinity, envBottom = -Infinity;
    for (const r of rects) {
      if (r.left < envLeft) envLeft = r.left;
      if (r.right > envRight) envRight = r.right;
      if (r.top < envTop) envTop = r.top;
      if (r.bottom > envBottom) envBottom = r.bottom;
    }

    const first = rects[0];
    const last = rects[rects.length - 1];
    const x1 = envLeft + 0.5 - xPad;
    const y1 = containsTable
      ? envTop - yPad
      : (first.top + first.bottom) / 2;
    const x2 = envRight - 0.5 + xPad;
    const y2 = containsTable
      ? envBottom + yPad
      : (last.top + last.bottom) / 2;
    LOG("dragging selection", { x1, y1, x2, y2, containsTable });

    const common = {
      bubbles: true, cancelable: true, composed: true, view: window,
      button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true,
    };
    const send = (type, x, y, buttons, detail) => {
      const init = { ...common, clientX: x, clientY: y, buttons };
      if (detail != null) init.detail = detail;
      try {
        const E = type.startsWith("pointer") ? PointerEvent : MouseEvent;
        canvas.dispatchEvent(new E(type, init));
      } catch (_) {}
    };

    if (containsTable) {
      // Double-click + drag = word-by-word selection mode in Docs,
      // which treats entire tables (including the outer
      // buildNestedSequenceHTML wrapper) as units. Dragging across
      // the table's area then selects the table as a whole —
      // confirmed empirically: this is the gesture the user uses
      // manually to delete a wrapper table.
      //
      // Critical: synthetic mousedown/mouseup do NOT auto-fire
      // `click`/`dblclick` events the way real input does (Chrome
      // suppresses this for security). So we have to dispatch
      // `click` and `dblclick` explicitly — without them Docs only
      // sees a stream of single mousedown/mouseup pairs and never
      // engages word-selection mode. detail increments (1, 2, 3)
      // so any listener gating on click count also picks it up.
      //
      // Sequence: full single-click → pause → full double-click
      // (with explicit `dblclick` event) → pause → triple-click's
      // mousedown without release; the drag-and-release continues
      // from there.
      send("pointerdown", x1, y1, 1, 1);
      send("mousedown",   x1, y1, 1, 1);
      send("pointerup",   x1, y1, 0, 1);
      send("mouseup",     x1, y1, 0, 1);
      send("click",       x1, y1, 0, 1);
      await sleep(40);

      send("pointerdown", x1, y1, 1, 2);
      send("mousedown",   x1, y1, 1, 2);
      send("pointerup",   x1, y1, 0, 2);
      send("mouseup",     x1, y1, 0, 2);
      send("click",       x1, y1, 0, 2);
      send("dblclick",    x1, y1, 0, 2);
      await sleep(40);

      // Triple click — Docs sometimes promotes word selection to
      // paragraph (which contains the whole table block) on the
      // third click. The drag continues from this third mousedown
      // without releasing.
      send("pointerdown", x1, y1, 1, 3);
      send("mousedown",   x1, y1, 1, 3);
      await sleep(30);
    } else {
      // Collapse any pre-existing selection with a bare click. Docs
      // treats pointerdown-inside-an-active-selection as the start of a
      // text drag-and-drop, not a new selection — so if the user had
      // part of this region highlighted when they clicked Compile, the
      // drag below wouldn't change the selection and the paste would
      // replace only their partial highlight. The 550ms sleep keeps
      // the drag-start from being coalesced into a double-click,
      // which would select by word instead of by character.
      send("pointerdown", x1, y1, 1, 1);
      send("mousedown",   x1, y1, 1, 1);
      send("pointerup",   x1, y1, 0, 1);
      send("mouseup",     x1, y1, 0, 1);
      await sleep(550);

      send("pointerdown", x1, y1, 1, 1);
      send("mousedown",   x1, y1, 1, 1);
      await sleep(30);
    }
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
    // Select the target on the canvas so the forthcoming paste replaces
    // it instead of inserting alongside it. Same mechanism for compile
    // (select the \(...\) source) and decompile (select the Unicode math
    // run).
    await selectRegionOnCanvas(region);

    const iframe = findDocsIframe();
    if (!iframe) {
      LOG("no Docs text-input iframe found");
      return false;
    }
    const doc = iframe.contentDocument;
    const body = doc && doc.body;
    if (!body) { LOG("iframe has no body"); return false; }

    let text, html;
    if (region.type === "decompile") {
      // Unicode → LaTeX source, wrapped in \(...\) so the resulting
      // text is immediately eligible to compile again. Pair the
      // text/plain with a block-level `<p>` text/html variant —
      // Docs' paste importer treats a `<p>` paste as a paragraph
      // replacement, which flushes any wrapper table the cursor was
      // sitting inside (the buildNestedSequenceHTML wrapper around a
      // cases / matrix block, and the inner structural table). A
      // plain-text paste over a multi-cell selection only replaces
      // cell content and leaves the wrapper standing.
      const src = region.text || "";
      const toLatex =
        typeof window.unicodeToLatex === "function"
          ? window.unicodeToLatex
          : (x) => x;
      text = "\\(" + toLatex(src) + "\\)";
      const escapeHTML = (s) => s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      // `<p>` makes Docs treat the paste as a paragraph-level
      // replacement (which is what flushes the wrapping table),
      // but Docs' default paragraph styling adds space-before that
      // pushes any subsequently-pasted matrix's first row down,
      // making it look "tall". Inline margin:0 / line-height:1 /
      // padding:0 on the paragraph asks Docs to honor no extra
      // spacing — the recompile then renders into a tight
      // paragraph and the matrix sits flush with the surrounding
      // line.
      html = `<meta charset="utf-8"><p style="margin:0;padding:0;line-height:1;">${escapeHTML(text)}</p>`;
      LOG("decompiling:", JSON.stringify(src), "→", JSON.stringify(text));
    } else {
      const rendered = renderRich(region.rich, region.sourcePt);
      text = rendered.text;
      html = rendered.html;
      LOG(
        "rich kind:",
        region.rich && region.rich.kind,
        "sourcePt:",
        region.sourcePt,
        "html?",
        !!html
      );
    }

    const targets = [doc.activeElement, body, doc.documentElement].filter(
      (t, i, arr) => t && arr.indexOf(t) === i
    );
    LOG("paste targets:", targets.map((t) => t.tagName || "(?)"));

    // For decompile regions on tables, dispatch a Delete keypress
    // before the paste — explicitly mirrors the user's manual
    // gesture: double-click on one edge, drag to the other, press
    // Delete. With the drag-selection covering the table block,
    // Delete removes it structurally; paste then inserts the LaTeX
    // text at the resulting cursor position. Paste alone over a
    // multi-cell selection only replaces cell content and leaves
    // the wrapper standing, so without Delete the table chrome
    // never goes away.
    const decompileTable = region.type === "decompile" &&
      /\\begin\{|\\binom\{|\\frac\{|\\sqrt\{/.test(region.text || "");
    if (decompileTable) {
      const sendKeyAll = (key, code, keyCode) => {
        for (const target of targets) {
          for (const evType of ["keydown", "keypress", "keyup"]) {
            const evt = new KeyboardEvent(evType, {
              key, code, keyCode, which: keyCode,
              bubbles: true, cancelable: true, composed: true,
              view: window,
            });
            target.dispatchEvent(evt);
          }
        }
        // Also dispatch input event with deleteContent inputType so
        // input-event-driven editors (Docs included) see a clear
        // delete signal even if their click handlers ignored the
        // synthetic key path.
        for (const target of targets) {
          target.dispatchEvent(new InputEvent("beforeinput", {
            inputType: "deleteContentBackward",
            bubbles: true, cancelable: true, composed: true,
          }));
          target.dispatchEvent(new InputEvent("input", {
            inputType: "deleteContentBackward",
            bubbles: true, cancelable: true, composed: true,
          }));
        }
      };
      sendKeyAll("Backspace", "Backspace", 8);
      await sleep(40);
    }

    let anyOk = false;
    for (const target of targets) {
      const pasteOk = dispatchPaste(target, text, html);
      const inputOk = dispatchBeforeInput(target, text, html);
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
    LOG("popup action clicked");
    if (!hoveredRegion || popupBusy) {
      LOG("skip: hovered=", !!hoveredRegion, "busy=", popupBusy);
      return;
    }
    const region = hoveredRegion;
    const isDecompile = region.type === "decompile";
    popupBusy = true;
    flashToast(isDecompile ? "Decompiling…" : "Typing…", true);
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
      // Caret-follow highlight and auto-compile only make sense for
      // compile (green) regions — landing the cursor in the middle of
      // a Unicode math run shouldn't offer to auto-decompile it.
      if (region.type !== "compile") continue;
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

  const AUTOCOMPILE_MIN_INTERVAL_MS = 1000;
  let autoCompileLastRun = 0;
  let autoCompilePendingTimer = null;
  let autoCompilePendingRegion = null;

  async function triggerAutoCompile(region) {
    if (popupBusy) return;
    const now = Date.now();
    const elapsed = now - autoCompileLastRun;
    if (elapsed < AUTOCOMPILE_MIN_INTERVAL_MS) {
      // Coalesce rapid triggers: keep only the latest region and fire
      // once the cooldown expires.
      autoCompilePendingRegion = region;
      if (!autoCompilePendingTimer) {
        autoCompilePendingTimer = setTimeout(() => {
          autoCompilePendingTimer = null;
          const r = autoCompilePendingRegion;
          autoCompilePendingRegion = null;
          if (r && greenRegions.includes(r)) triggerAutoCompile(r);
        }, AUTOCOMPILE_MIN_INTERVAL_MS - elapsed);
      }
      return;
    }
    autoCompileLastRun = now;
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
