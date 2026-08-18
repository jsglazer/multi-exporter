# Multi Exporter

Export Obsidian notes to PDF with **CSS Paged Media**. The live preview *is* the paginated output, so it cannot drift from the file you get.

Obsidian desktop only. macOS is the development and primary target.

## Why

Three kinds of document need exporting from a real vault, and no existing tool handles all three:

1. **Clipped articles** — remote and local images, `cssclasses` frontmatter, prose typography.
2. **Dataview / Datacore pages** — content produced by JavaScript executing against the vault at render time.
3. **Dissertation chapters** — citations, a formatted bibliography, and LaTeX-grade running heads, footers and page numbers.

Pandoc-based exporters parse markdown *text*, so they can never render DataviewJS output. Chromium's `printToPDF` header/footer API is a template string with about five usable classes and honours no CSS margin boxes at all — which puts running heads that track the current section, recto/verso furniture, and suppressed first-page headers permanently out of reach.

## How it works

Obsidian renders the note, so everything a plugin contributes survives. The rendered DOM is then paginated with paged.js inside a `<webview>`, and after pagination **the headers and footers are real elements in the document** — so the export runs `printToPDF` at zero margins and Chromium simply prints what was already on screen.

```
  Note.md  ·  or a folder (bulk export)
      │
      ▼
  Obsidian MarkdownRenderer     Dataview, Datacore, Mermaid, callouts, embeds, gutters
      │
      ▼
  Citation pass                 zotero-manager .api → inline cites + bibliography
      │
      ▼
  Image inlining                remote + local images → data URIs
      │
      ▼
  paged.js  (in webview)        @page, margin boxes, counters, recto/verso
      │
      ├──────────────────────►  live preview  (this same container)
      ▼
  webview.printToPDF()          margin: 0 — the furniture is already in the DOM
      │
      ▼
  pdf-lib                       outline / bookmarks from paged.js's page map
      │
      ▼
  PDF Squeezer  (optional)      `pdfs <file> [--profile …]` when installed
```

One paginated DOM feeds both the preview and the PDF writer. That property is structural, not a feature to be maintained.

## Features

- **Export profiles — data, not code.** A profile is `{ name, stylesheet, backend, page, flags }`. There is no fixed set: create, duplicate, rename and delete them freely. `Article`, `Dataview` and `Manuscript` ship as *starting examples*, not as an enum the code branches on. Every behavioural difference reads a flag, so a profile you create is indistinguishable from one that shipped.
- **Live preview that is the export.** Change the profile, the stylesheet, a margin or a running head and the preview re-paginates in place.
- **Real page furniture.** `@page` margin boxes, `counter(page)` / `counter(pages)`, `@page :first`, `@page :left` / `:right` for recto/verso, `orphans` / `widows` / `break-*`.
- **Bulk folder export**, recursive, markdown-only, ordered alphabetically by folder hierarchy then file name:
  - **Separate** — one PDF per note, reproducing the source hierarchy on disk.
  - **Merged** — a single PDF with continuous page numbering, a combined outline, and running heads that carry across note boundaries.
- **PDF bookmarks** built from paged.js's page map, nested by heading level.
- **Citations and bibliography** via [`zotero-manager`](https://github.com/jsglazer/zotero-manager)'s public API. This plugin implements no citation formatting of its own.
- **Image inlining** — remote and vault images become data URIs before pagination, so an export is reproducible and works offline.
- **PDF Squeezer** — runs the `pdfs` CLI on the finished file when it is installed. Absence is not an error.
- **`md-annotation` gutters** — comments print in the page margin or as endnotes, decided by the profile.

## Installation

Not in the community plugin store yet. Install manually or with BRAT.

**Manual:** copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/multi-exporter/`, then enable the plugin.

**From source:**

```sh
npm install
npm run build      # tsc --noEmit && esbuild → main.js
npm test           # 173 headless tests, no Obsidian required
```

## Usage

| Action | Where |
|---|---|
| Export a note | Right-click the note → **Export to PDF**, or the command palette |
| Export a folder | Right-click the folder → **Export folder to PDF** |
| Set a folder's default profile | Right-click the folder → **Default export profile** |
| Edit profiles and stylesheets | Settings → Multi Exporter |

Folder defaults resolve **nearest-ancestor**: the deepest mapped folder containing a note wins, and they are stored as a path-prefix map in the plugin's `data.json` — nothing is written into your vault. They apply to single-note and Separate exports. **Merged export uses exactly one profile** for the whole document, because continuous page numbering across per-note page geometry means nothing.

### Customising a stylesheet

The stylesheet is the primary styling surface — everything about how an export *looks* is a
profile stylesheet, edited in **Settings → Multi Exporter → Edit → Stylesheet**. There is no
theme to fight and no template to override: the CSS you write is the CSS that paginates.

Each export is built from two stylesheets, concatenated in this order:

1. **Generated `@page` rules** — page size, margins, margin-box furniture, `orphans` /
   `widows`. These come from the *Page* controls above the editor, not from your CSS.
2. **Your profile stylesheet** — everything else. It comes last, so it wins every tie.

Both are handed to paged.js's polisher, which is what makes `@page` real: page geometry,
margin boxes and page counters are resolved *before* Chromium prints, so the PDF is printed
at zero margins from a document whose headers and footers are already ordinary elements.

**What the DOM looks like.** You are styling Obsidian's own rendered output, so every
selector you would use in a CSS snippet works — `.callout`, `.dataview`, `.internal-link`,
`.tag`, `.math`, `.mermaid`, and any class a plugin adds. On top of that, this plugin adds:

| Selector | What it is |
|---|---|
| `.mx-document` | One note inside a merged export; carries `data-mx-title` and `data-mx-source` |
| `.mx-bibliography` | The appended bibliography block, with one `div` per entry |
| `.mx-endnotes` | The endnotes block, when the profile puts annotations there |
| `.mx-citation` | A resolved citation link; carries `data-mx-citekey` |
| `.mx-image-failed` | An image that could not be fetched, left in place as a marker |
| `.gutter-host`, `.gutter-card` | `md-annotation`'s own gutter classes, kept when annotations print in the margin |
| `.pagedjs_page`, `.pagedjs_page_content` | paged.js's own per-page wrappers |

**Recipes.**

```css
/* Start every top-level heading on a new page, and never strand it at the foot of one. */
h1 { break-before: page; }
h2, h3 { break-after: avoid; }

/* Keep the things that must not be split, unsplit. */
figure, blockquote, pre, table tr { break-inside: avoid; }

/* Repeat table headers on every page a long table spills onto. */
thead { display: table-header-group; }

/* A running head that tracks the current chapter.
   `string-set` captures the text; the margin box that displays it is set in the Page
   controls as `string(chapter)`. */
h1 { string-set: chapter content(text); }

/* Hide something from the export without touching the note. */
.callout[data-callout="todo"] { display: none; }

/* Style resolved citations, or leave them looking like body text. */
.mx-citation { color: inherit; text-decoration: none; }

/* Print link targets after the link text — useful for a document read on paper. */
a[href^="http"]::after { content: " (" attr(href) ")"; font-size: 0.85em; color: #555; }

/* Widen the text block on the binding edge only, using recto/verso pages. */
@page :left  { margin-right: 1.25in; }
@page :right { margin-left: 1.25in; }
```

**Fonts.** Anything installed on the machine can be named directly. Web fonts are not
fetched during pagination, so an `@import` or a remote `@font-face` will not resolve — embed
the face as a `data:` URI in the stylesheet if you need one the system does not have.

**Units.** Profiles ship imperial: US Letter, margins in inches. A margin is any CSS length,
so `20mm`, `2cm` and `54pt` are all equally valid — change the page size to A4 and type
millimetres if that suits the document better.

**Iterating.** The preview *is* the paginated output, so the loop is: edit the stylesheet in
settings, reopen the export modal (or press **Refresh preview**), and look. What you see is
what the PDF contains — there is no second rendering pass to disagree with it.

### Citations

Detection runs on the rendered DOM, after Obsidian's renderer and before pagination. It has to: `![[embeds]]` place a transcluded note's citations in this DOM but not in this note's source, merged export has no single source to scan, and Dataview output only exists post-render.

Cite keys are found by **exact set intersection**, not by regex — `a.internal-link[data-href]` values, minus any `#heading` suffix, intersected against `zotero-manager`'s cite-key list. That sidesteps the entire class of regex false positives: email addresses, `@media` in code blocks, social handles in clipped articles.

If `zotero-manager` is missing, disabled, or does not expose API `version: 1`, citation features are disabled **for that export**, the export completes, and it is reported once. It never throws and never blocks a non-citation export.

## Architecture

```
src/core/     Pure decision logic. Zero imports from `obsidian`, node `fs`, or the network.
src/adapter/  The ONE module that touches undocumented internals and Electron.
src/shell/    Obsidian/Electron implementations of the interfaces core declares.
vendor/       Vendored, patched paged.js, with the diff checked in as a .patch.
tests/        173 headless tests. Import only from src/core/.
```

Every capability the pipeline needs — rendering, citations, image bytes, pagination, PDF surgery, disk — arrives as an injected interface, so the whole export sequence runs headlessly against fakes. Filesystem writes go through a `FileWriter`; tests inject `InMemoryFileWriter`, so a test run can never touch a real disk.

The only genuinely untestable surface — a live webview and Chromium's `printToPDF` — sits behind the `ExportBackend` interface. v1 ships exactly one real backend; `tests/fakes/fake-backend.ts` substitutes for it to drive an export end to end.

### The vendored paged.js

`findElement` crashes on a null node at page boundaries, aborting pagination with no useful error. The fix is one line. It is vendored under `vendor/pagedjs/` with the diff checked in, and guarded by `tests/pagedjs-null-guard.test.ts` — which extracts the real function from the shipped file and executes it against the null input that crashed. Re-vendoring without the patch breaks the build, not just a review.

### Internals targeted

| Surface | Version |
|---|---|
| Obsidian | 1.12.7 (`minAppVersion` 1.7.2) |
| Electron | 39.8.3 |
| Chromium | 142.0.7444.265 |
| `zotero-manager` | API `version: 1` (plugin v1.1.9) |
| `md-annotation` | v1.0.13 |

## Not in v1

Pandoc side-export to DOCX/LaTeX · cross-references and automatic figure numbering · per-note frontmatter overrides · profile export/import as JSON · page-window preview (unnecessary — pagination measured at ~17 ms/page, linear).

**Permanently out of scope:** mobile · a second citation engine · any markdown-source conversion path · content generation.

## Credits

- [paged.js](https://pagedjs.org) (Coko Foundation, MIT) — the paginator.
- [`l1xnan/obsidian-better-export-pdf`](https://github.com/l1xnan/obsidian-better-export-pdf) (MIT) — prior art; the outline-construction technique and the working approach to invoking `MarkdownRenderer` outside a live view.
- [`pdf-lib`](https://github.com/Hopding/pdf-lib) — PDF outline injection.

## License

MIT — see [LICENSE](LICENSE).
