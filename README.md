<p align="center">
  <img src="assets/logo.png" alt="docslatex" width="100" />
</p>

<h1 align="center" style="font-size: 3em;">docslatex</h1>

<p align="center">
  <a href="#usage">Usage</a> · <a href="#getting-started">Getting Started</a> · <a href="https://github.com/Peter-Zhao-751/docslatex/archive/refs/heads/main.zip">Download ZIP</a> · <a href="LICENSE">License</a>
</p>

<p align="center">
  <strong>Native LaTeX math in Google Docs — no images, no servers, no compromises.</strong>
</p>

---

### The problem
Other LaTeX extensions for Google Docs render your equations on a remote server and paste them back as **images**. This means:

- Equations don't scale with your text
- Font sizes and line heights are never quite right
- You're sending your work to someone else's server
- Editing means re-rendering the whole image

### The solution
**docslatex** compiles LaTeX directly into native Google Docs characters and symbols. Your math is real text — it scales, copies, and lives inside your document like everything else.

---

### Usage
Wrap your LaTeX in delimiters and let docslatex handle the rest:

| Delimiter | Type |
|-----------|------|
| `\( ... \)` | Inline math |
| `\[ ... \]` | Display math |

### Two modes
**Autocompile**  Intelligently detects when you've finished typing an equation and converts it on the fly. Just write and keep going.

**Manual compile**  Press the compile button when you're ready. Available both in the Google Docs toolbar and in the extension popup.

---

### Getting started
1. [Download the ZIP](https://github.com/Peter-Zhao-751/docslatex/archive/refs/heads/main.zip) and unzip it
2. In Chrome, go to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the unzipped folder
3. Open any Google Doc
4. Click the docslatex icon and hit **Enable**
5. Write LaTeX between `\( \)` or `\[ \]`
6. Toggle **Autocompile** for hands-free conversion, or use the compile button
