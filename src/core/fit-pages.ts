/**
 * Fitting a document to a *number of pages*, rather than to the page box.
 *
 * `fitToPage` answers "is anything hanging off the edge of the paper" and fixes it with
 * Chromium's print scale, applied to the finished pages. That scale cannot change the page
 * count: pagination has already happened by the time it is measured, so a document that
 * came to eleven pages prints as eleven smaller pages.
 *
 * The two numbers here are the other question — "how many sheets may this take" — and they
 * are answered in two different places, because the two axes are not the same problem:
 *
 * - **Pages wide** is a *tolerance* on the fit measurement. Nothing flows sideways in CSS
 *   Paged Media, so "two pages wide" cannot mean two sheets side by side; it means content
 *   up to twice the text column's width is accepted as-is and only worse overflow is scaled
 *   away. `1` is the previous behaviour exactly.
 * - **Pages tall** is a *target page count*, and the only way to change a page count is to
 *   paginate again with the content laid out smaller. So it is a search: paginate, count,
 *   shrink, paginate again — bounded, because each attempt is a full re-pagination.
 *
 * Everything in this module is pure arithmetic and string building, so the search's
 * behaviour is testable without a browser; the backend runs the loop.
 */

/** The most page-widths of tolerance worth offering. Past this the fit stops meaning anything. */
export const MAX_PAGES_WIDE = 10;

/** The most pages a "fit to N pages" target may name. */
export const MAX_PAGES_TALL = 200;

/**
 * The floor on the content scale the page-count search may reach.
 *
 * Below this the text is no longer readable on paper, and a target that cannot be met
 * without illegible type is better missed than met — the export completes at the floor and
 * the page count is simply higher than asked.
 */
export const MIN_CONTENT_SCALE = 0.4;

/**
 * How many extra paginations the search may spend.
 *
 * Each one is a full paged.js run over the whole document, which for a long merged export is
 * seconds, not milliseconds. The estimate below is good enough that the first or second
 * attempt normally lands; the cap is there so a document that resists — one enormous
 * unbreakable figure forcing its own page — cannot turn an export into a grinding loop.
 */
export const MAX_FIT_ATTEMPTS = 4;

/** A stored `fitPagesWide`, made sane. `data.json` is user-editable and predates the field. */
export function clampPagesWide(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
	return Math.min(MAX_PAGES_WIDE, Math.max(1, Math.round(value)));
}

/** A stored `fitPagesTall`, made sane. `0` — the default — means "no page-count target". */
export function clampPagesTall(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
	return Math.min(MAX_PAGES_TALL, Math.max(0, Math.round(value)));
}

/**
 * The next content scale to try, or `null` when the search should stop.
 *
 * The estimate is `sqrt(target / count)` because shrinking by `s` shrinks the content in
 * *both* directions at once — lines hold more characters as well as taking less height — so
 * the page count falls roughly with the area, `s²`. A linear guess would undershoot every
 * time and spend the whole attempt budget creeping towards the answer.
 *
 * The extra 3% is deliberate overshoot. Pagination is lumpy: a scale that makes the content
 * fit "exactly" leaves one widow line on a final page and misses the target by one. Aiming
 * slightly small costs a few points of type size and hits it on the first attempt.
 *
 * Stops — returns `null` — when the target is already met, when the floor leaves no room to
 * move, or when the next step would not be a real reduction; another pagination at
 * essentially the current scale can only produce the current answer.
 */
export function nextContentScale(current: number, pageCount: number, target: number): number | null {
	if (target <= 0 || pageCount <= target || pageCount <= 0) return null;
	const ideal = current * Math.sqrt(target / pageCount) * 0.97;
	const next = Math.max(MIN_CONTENT_SCALE, Math.round(ideal * 1000) / 1000);
	if (next >= current - 0.005) return null;
	return next;
}

/**
 * The stylesheet that lays the flow out smaller.
 *
 * `zoom` on paged.js's own content wrapper, and it has to be `zoom` rather than `transform`
 * or a font-size change. A transform is applied after layout, so the chunker would still
 * break the pages where it always did and the page count would not move. A font-size change
 * misses everything sized in absolute units — images, tables with pixel widths, Mermaid
 * diagrams — which are exactly the things that make a document too long. `zoom` is a layout
 * property in Chromium: the wrapper's `width: auto` resolves against the page box *divided*
 * by the scale, so the flow gets more CSS pixels to work with, renders into the same
 * physical box, and paged.js measures the smaller result and fits more onto each page.
 *
 * The selector is paged.js's own (`.pagedjs_page_content > div` is the single element it
 * flows content into — see its stylesheet in `vendor/pagedjs/`), which makes this an
 * undocumented coupling like the class names in the adapter; it is one rule, and it fails
 * visibly — the page count simply does not move — rather than silently corrupting output.
 *
 * A scale of 1 emits nothing at all, so an export with no page target is byte-for-byte the
 * stylesheet it was before this existed.
 */
export function contentScaleCss(scale: number): string {
	if (!Number.isFinite(scale) || scale >= 1) return '';
	const bounded = Math.max(MIN_CONTENT_SCALE, scale);
	return `\n/* Fit to page count: lay the flow out smaller so more of it fits on each page. */\n.pagedjs_page_content > div { zoom: ${bounded}; }\n`;
}
