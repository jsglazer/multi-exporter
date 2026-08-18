import type { MarginBoxContent, PageConfig, PageFurniture, PageSize } from './types';

/**
 * `@page` CSS generation.
 *
 * Page furniture is CSS, not a template string. Chromium's `printToPDF` header/footer API
 * offers about five classes and honours no margin boxes at all, which is why running heads
 * that track the current section, recto/verso furniture, and a suppressed first-page header
 * are unreachable through it. paged.js implements the real thing, so after pagination the
 * furniture is made of ordinary elements and the PDF is printed at zero margin.
 *
 * Pure string generation: given a `PageConfig` this always produces the same stylesheet,
 * which is what makes it testable without a browser.
 */

/**
 * Insertion order is the order of the settings dropdown, so the US sizes lead: this plugin
 * is authored against Letter, and the ISO sizes keep their millimetre definitions because
 * that is what they are — a Letter default does not make A4 210mm stop being 210mm.
 */
export const PAGE_SIZES: Record<PageSize, { width: string; height: string }> = {
	Letter: { width: '8.5in', height: '11in' },
	Legal: { width: '8.5in', height: '14in' },
	Tabloid: { width: '11in', height: '17in' },
	A4: { width: '210mm', height: '297mm' },
	A5: { width: '148mm', height: '210mm' },
};

/**
 * Normalisation applied to every export, ahead of the profile stylesheet.
 *
 * Obsidian's rendered DOM is laid out for a viewport that scrolls; a page cannot. Anything
 * that arrives wider or taller than the page box — a full-resolution image, a MathJax SVG
 * sized in `ex` units without its own stylesheet, a Mermaid diagram, a long code block — is
 * a single unbreakable element as far as the paginator is concerned, so it is not shrunk
 * but *moved*: pushed whole to the next page, leaving the page it came from mostly blank.
 * That failure reads as "the preview only rendered part of the note".
 *
 * Every rule is a ceiling, never a size, and the profile stylesheet comes after this and
 * overrides all of it.
 */
export const BASE_DOCUMENT_CSS = `/* multi-exporter base — normalisation, overridden by the profile stylesheet below. */
html, body { margin: 0; padding: 0; }
img, svg, video, canvas, iframe { max-width: 100%; height: auto; }
pre { max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; }
table { max-width: 100%; }
mjx-container { max-width: 100%; }
mjx-container svg { max-width: 100%; height: auto; }
.mermaid svg, .block-language-mermaid svg { max-width: 100%; height: auto; }

/* Obsidian's footnote return arrows are navigation, not content: on screen they jump back to
   the reference, on paper they are a row of blue ↩ glyphs after every note with nothing to
   click. The footnote text itself is kept — only the backlink goes. */
.footnote-backref { display: none; }

/* Running-head source. The wrapper carries the note name and the export timestamp so a
   margin box can name them; it takes no space and prints nothing itself. Sized to zero
   rather than display:none — paged.js only sets a named string from an element it actually
   lays out onto a page, and a collapsed element is never laid out.

   break-after: avoid because a zero-height block fits anywhere, including the last sliver of
   the previous note's final page. Orphaned there it names the wrong page as the note's first,
   which misplaces the running head and puts the PDF bookmark on the page before the note. */
.mx-doc-meta { height: 0; overflow: hidden; margin: 0; padding: 0; font-size: 0; line-height: 0; color: transparent; break-after: avoid; }
.mx-doc-title { string-set: doctitle content(text); }
.mx-doc-date { string-set: docdate content(text); }

/* Every note starts its own page in a merged export. Without this the notes simply flow into
   one another: one page ends up holding the tail of one note and the head of the next, which
   makes a running head and a per-note page count meaningless — there is no single answer for
   such a page.

   No exception is needed for the first note. paged.js's handleBreaks returns early while the
   current page is 1, so a break before the very first content is already a no-op; and
   processBreaks only marks an element that has something before it to break from. */
.mx-document { break-before: page; }
`;

const MARGIN_BOXES: [keyof PageFurniture, string][] = [
	['topLeft', '@top-left'],
	['topCenter', '@top-center'],
	['topRight', '@top-right'],
	['bottomLeft', '@bottom-left'],
	['bottomCenter', '@bottom-center'],
	['bottomRight', '@bottom-right'],
];

/** Full paged-media stylesheet for a profile's page configuration. */
export function buildPageCss(config: PageConfig): string {
	const blocks: string[] = [];
	blocks.push(basePageBlock(config));

	if (config.suppressFirstPageFurniture) {
		blocks.push(suppressBlock(':first'));
	}
	if (config.rectoFurniture !== undefined && hasContent(config.rectoFurniture)) {
		blocks.push(furnitureBlock(':right', config.rectoFurniture));
	}
	if (config.versoFurniture !== undefined && hasContent(config.versoFurniture)) {
		blocks.push(furnitureBlock(':left', config.versoFurniture));
	}

	blocks.push(breakControlBlock(config));
	if (config.keepHeadingsWithText) blocks.push(KEEP_HEADINGS_CSS);
	return blocks.join('\n\n');
}

function basePageBlock(config: PageConfig): string {
	const size = PAGE_SIZES[config.size];
	const dimensions =
		config.orientation === 'landscape' ? `${size.height} ${size.width}` : `${size.width} ${size.height}`;
	const lines = [
		'@page {',
		`\tsize: ${dimensions};`,
		`\tmargin: ${config.margins.top} ${config.margins.right} ${config.margins.bottom} ${config.margins.left};`,
		...marginBoxLines(config.furniture),
		'}',
	];
	return lines.join('\n');
}

function furnitureBlock(selector: string, furniture: PageFurniture): string {
	return [`@page ${selector} {`, ...marginBoxLines(furniture), '}'].join('\n');
}

/**
 * `@page :first` with every margin box emptied. An empty `content` is what actually removes
 * a running head on the opening page — omitting the box inherits the general rule instead.
 */
function suppressBlock(selector: string): string {
	const lines = MARGIN_BOXES.map(([, box]) => `\t${box} { content: none; }`);
	return [`@page ${selector} {`, ...lines, '}'].join('\n');
}

function marginBoxLines(furniture: PageFurniture): string[] {
	const lines: string[] = [];
	for (const [key, box] of MARGIN_BOXES) {
		const value = furniture[key];
		if (value === undefined || value.content.trim() === '') continue;
		lines.push(`\t${box} { content: ${value.content}; }`);
	}
	return lines;
}

function breakControlBlock(config: PageConfig): string {
	return [
		'.pagedjs_page_content > div {',
		`\torphans: ${config.orphans};`,
		`\twidows: ${config.widows};`,
		'}',
	].join('\n');
}

/**
 * Keep a heading with the text under it.
 *
 * paged.js implements this properly rather than leaving it to the browser: its `Breaks`
 * handler lifts `break-after` out of the stylesheet, marks the heading `data-break-after`
 * and the element after it `data-previous-break-after`, and when that element would overflow
 * the page the paginator breaks before the *heading* instead — carrying both to the next
 * page. `h1`–`h6` all the way down, so a run of consecutive headings stays together too.
 *
 * A profile stylesheet can opt a level back out with `break-after: auto`, because it is
 * parsed after this and the handler applies the later selector last.
 */
const KEEP_HEADINGS_CSS = ['h1, h2, h3, h4, h5, h6 {', '\tbreak-after: avoid;', '}'].join('\n');

function hasContent(furniture: PageFurniture): boolean {
	return MARGIN_BOXES.some(([key]) => {
		const value = furniture[key];
		return value !== undefined && value.content.trim() !== '';
	});
}

/** Quote a literal string for use in a CSS `content` value. */
export function cssString(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** `content` value for a running head that tracks the nearest preceding heading. */
export function runningHeading(named: string): MarginBoxContent {
	return { content: `string(${named})` };
}

/**
 * The `string-set` rules that make `runningHeading` work: each named string is captured
 * from the headings at the given level, so the margin box shows the current section.
 */
export function buildStringSetCss(named: string, headingSelector: string): string {
	return [`${headingSelector} {`, `\tstring-set: ${named} content(text);`, '}'].join('\n');
}
