import { describe, expect, it } from 'vitest';
import {
	BASE_DOCUMENT_CSS,
	buildPageCss,
	buildStringSetCss,
	cssString,
	PAGE_SIZES,
	runningHeading,
} from '../src/core/page-css';
import { createDefaultProfiles } from '../src/core/profiles';
import type { PageConfig, Profile } from '../src/core/types';

/**
 * Page furniture is CSS, not a template string.
 *
 * Chromium's `printToPDF` header/footer API offers about five classes and honours no margin
 * boxes, so running heads that track the current section, recto/verso furniture and a
 * suppressed first-page header are unreachable through it. These are the rules paged.js
 * turns into real elements before the PDF is printed at zero margin.
 */

function config(overrides: Partial<PageConfig> = {}): PageConfig {
	return {
		size: 'A4',
		orientation: 'portrait',
		margins: { top: '20mm', right: '18mm', bottom: '20mm', left: '18mm' },
		furniture: { bottomCenter: { content: 'counter(page)' } },
		suppressFirstPageFurniture: false,
		keepHeadingsWithText: false,
		pageNumbering: 'continuous',
		fitToPage: false,
		printScale: 100,
		orphans: 2,
		widows: 2,
		...overrides,
	};
}

describe('buildPageCss', () => {
	it('emits size and margins', () => {
		const css = buildPageCss(config());
		expect(css).toContain('size: 210mm 297mm;');
		expect(css).toContain('margin: 20mm 18mm 20mm 18mm;');
	});

	it('swaps the dimensions for landscape', () => {
		expect(buildPageCss(config({ orientation: 'landscape' }))).toContain('size: 297mm 210mm;');
	});

	it('emits a margin box for each populated corner', () => {
		const css = buildPageCss(
			config({
				furniture: {
					topLeft: { content: cssString('Draft') },
					bottomRight: { content: 'counter(page) " / " counter(pages)' },
				},
			}),
		);
		expect(css).toContain('@top-left { content: "Draft"; }');
		expect(css).toContain('@bottom-right { content: counter(page) " / " counter(pages); }');
	});

	it('omits empty margin boxes', () => {
		const css = buildPageCss(config({ furniture: { topLeft: { content: '   ' } } }));
		expect(css).not.toContain('@top-left');
	});

	// Omitting the box would inherit the general rule; only an explicit `content: none`
	// actually removes the running head on the opening page.
	it('empties every box under @page :first when furniture is suppressed', () => {
		const css = buildPageCss(config({ suppressFirstPageFurniture: true }));
		expect(css).toContain('@page :first {');
		expect(css).toContain('@top-center { content: none; }');
		expect(css).toContain('@bottom-center { content: none; }');
	});

	it('emits recto and verso blocks when they differ', () => {
		const css = buildPageCss(
			config({
				rectoFurniture: { topRight: { content: 'string(chapter)' } },
				versoFurniture: { topLeft: { content: 'string(chapter)' } },
			}),
		);
		expect(css).toContain('@page :right {');
		expect(css).toContain('@page :left {');
	});

	it('omits recto and verso blocks that have no content', () => {
		const css = buildPageCss(config({ rectoFurniture: {}, versoFurniture: { topLeft: { content: '' } } }));
		expect(css).not.toContain('@page :right');
		expect(css).not.toContain('@page :left');
	});

	it('emits orphan and widow control', () => {
		const css = buildPageCss(config({ orphans: 3, widows: 4 }));
		expect(css).toContain('orphans: 3;');
		expect(css).toContain('widows: 4;');
	});

	it('is deterministic', () => {
		expect(buildPageCss(config())).toBe(buildPageCss(config()));
	});

	it('produces valid CSS for every shipped profile', () => {
		for (const profile of createDefaultProfiles()) {
			const css = buildPageCss(profile.page);
			expect(css).toContain('@page {');
			// Balanced braces is a cheap but real syntax check.
			expect([...css].filter((c) => c === '{').length).toBe([...css].filter((c) => c === '}').length);
		}
	});

	it('supports every declared page size', () => {
		for (const size of Object.keys(PAGE_SIZES) as (keyof typeof PAGE_SIZES)[]) {
			expect(buildPageCss(config({ size }))).toContain(PAGE_SIZES[size].width);
		}
	});
});

describe('cssString', () => {
	it('quotes and escapes', () => {
		expect(cssString('He said "hi"')).toBe('"He said \\"hi\\""');
		expect(cssString('C:\\path')).toBe('"C:\\\\path"');
	});
});

describe('running heads', () => {
	it('references a named string', () => {
		expect(runningHeading('chapter')).toEqual({ content: 'string(chapter)' });
	});

	it('emits the string-set rule that populates it', () => {
		expect(buildStringSetCss('chapter', 'h1')).toBe('h1 {\n\tstring-set: chapter content(text);\n}');
	});
});

/**
 * The running-head plumbing for the note name and the export timestamp.
 *
 * A margin box can only say what a named string holds, and the only thing that fills a named
 * string is a `string-set` on an element in the document. So the base stylesheet and the
 * backend's document wrapper are two halves of one mechanism: if either half is dropped, the
 * Article header quietly prints nothing at all rather than failing.
 */
describe('document meta strings', () => {
	it('sets a named string from each half of the meta block', () => {
		expect(BASE_DOCUMENT_CSS).toContain('.mx-doc-title { string-set: doctitle content(text); }');
		expect(BASE_DOCUMENT_CSS).toContain('.mx-doc-date { string-set: docdate content(text); }');
	});

	// Never `display: none`: paged.js sets a named string from elements it lays out onto a
	// page, and a collapsed element is never laid out — the header would come out empty.
	it('hides the meta block by collapsing it, not by removing it from layout', () => {
		const rule = /\.mx-doc-meta \{([^}]*)\}/.exec(BASE_DOCUMENT_CSS)?.[1] ?? '';
		expect(rule).toContain('height: 0');
		expect(rule).not.toContain('display: none');
	});

	// A zero-height block fits anywhere, including the last sliver of the previous note's final
	// page. Orphaned there it names the wrong page as the note's first, which misplaces the
	// running head and puts the PDF bookmark on the page before the note starts.
	it('keeps the meta block with the note it belongs to', () => {
		const rule = /\.mx-doc-meta \{([^}]*)\}/.exec(BASE_DOCUMENT_CSS)?.[1] ?? '';
		expect(rule).toContain('break-after: avoid');
	});

	// Without this the notes flow into one another and a page can hold the tail of one note and
	// the head of the next — for which a running head and a per-note page count have no single
	// right answer. The first note needs no exception: paged.js ignores a break while the
	// current page is 1.
	it('starts every note on its own page', () => {
		expect(BASE_DOCUMENT_CSS).toContain('.mx-document { break-before: page; }');
	});
});

describe('the Article profile furniture', () => {
	const article = createDefaultProfiles().find((profile) => profile.id === 'article');

	it('exists', () => {
		expect(article).toBeDefined();
	});

	it('names the note, the author, the page count and the timestamp', () => {
		const css = buildPageCss((article as NonNullable<typeof article>).page);
		// `start`, not the bare form: bare `string()` is the *first* value on the page, which
		// heads a page with the note that begins on it rather than the one being read.
		expect(css).toContain('@top-left { content: string(doctitle, start); }');
		expect(css).toContain('@top-right { content: "Joshua S. Glazer"; }');
		expect(css).toContain('@bottom-left { content: counter(page) " of " counter(pages); }');
		expect(css).toContain('@bottom-right { content: string(docdate, start); }');
	});

	// The 0.4pt head and foot rules from the fancyhdr block this profile was modelled on.
	it('rules the head and the foot at 0.4pt', () => {
		const stylesheet = (article as NonNullable<typeof article>).stylesheet;
		expect(stylesheet).toContain('.pagedjs_margin-top-left');
		expect(stylesheet).toContain('border-bottom: 0.4pt solid #000;');
		expect(stylesheet).toContain('border-top: 0.4pt solid #000;');
	});
});

/**
 * Keeping a heading with the text under it.
 *
 * `orphans` and `widows` cannot express this — they count lines inside one block, and a
 * stranded heading is a break *between* two blocks. paged.js implements `break-after` itself:
 * its Breaks handler marks the heading `data-break-after` and the element after it
 * `data-previous-break-after`, then breaks before the heading when that element overflows.
 */
describe('keeping headings with their text', () => {
	it('emits break-after: avoid for every heading level when on', () => {
		const css = buildPageCss(config({ keepHeadingsWithText: true }));
		expect(css).toContain('h1, h2, h3, h4, h5, h6 {\n\tbreak-after: avoid;\n}');
	});

	it('emits nothing at all when off', () => {
		expect(buildPageCss(config({ keepHeadingsWithText: false }))).not.toContain('break-after');
	});

	// The toggle is a page-break control, so it belongs with orphans and widows rather than
	// in the profile stylesheet — which is why the shipped profiles get it without carrying
	// a CSS rule of their own.
	it('is on for every shipped profile', () => {
		for (const profile of createDefaultProfiles()) {
			expect(profile.page.keepHeadingsWithText).toBe(true);
			expect(buildPageCss(profile.page)).toContain('break-after: avoid;');
		}
	});

	it('still balances its braces', () => {
		const css = buildPageCss(config({ keepHeadingsWithText: true }));
		expect([...css].filter((c) => c === '{').length).toBe([...css].filter((c) => c === '}').length);
	});
});

/**
 * Two regressions the AI-v003 export surfaced, both invisible until a real document was
 * paginated: a page number printed twice per page, and Obsidian's footnote return arrows
 * printed as a row of blue glyphs with nothing to click.
 */
describe('the generated stylesheet, after the duplicated-furniture fix', () => {
	const manuscript = createDefaultProfiles().find((profile) => profile.id === 'manuscript') as Profile;

	it('emits counter(page) exactly once per side, never a centred copy as well', () => {
		const css = buildPageCss(manuscript.page);
		expect(css.match(/counter\(page\)/g)).toHaveLength(2);
		expect(css).toContain('@page :right {');
		expect(css).toContain('@page :left {');
		// The general @page block must carry no margin box at all for this profile.
		const general = css.slice(0, css.indexOf('@page :'));
		expect(general).not.toContain('@bottom-');
		expect(general).not.toContain('@top-');
	});

	it('still suppresses every box on the first page', () => {
		expect(buildPageCss(manuscript.page)).toContain('@page :first {');
	});

	it('hides footnote return arrows, which are navigation and not content', () => {
		expect(BASE_DOCUMENT_CSS).toContain('.footnote-backref { display: none; }');
	});
});
