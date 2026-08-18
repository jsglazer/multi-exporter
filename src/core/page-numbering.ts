/**
 * Where page numbering restarts in a merged document.
 *
 * A merged export paginates every note as one document — that is what makes the preview the
 * output and lets running heads carry across note boundaries — so `counter(page)` runs 1…N
 * across the whole PDF and `counter(pages)` is the whole PDF's total. Restarting the count at
 * each note is therefore not something a stylesheet can ask for: CSS Paged Media has no
 * per-section total at all, and paged.js sets `pages` once, from the chunker's final page
 * count.
 *
 * ## Why every page is stamped, not just the ones that restart
 *
 * The obvious implementation is one `counter-reset` per note, leaning on counter *scope* to
 * carry the new value across the pages that follow. It does not work. Measured against real
 * output: a `counter-reset` on a page element creates a counter scoped to that element and its
 * descendants, and the following sibling pages do **not** see it — they fall back to the
 * document-wide counter, which is itself only incremented on the pages that did not reset. A
 * fourteen-page merge came out reading `1 of 1`, `1 of 3`, `1 of 14`, `2 of 14`, `1 of 1`,
 * `1 of 2`, `3 of 14` — every restart page correct, every page between them nonsense.
 *
 * So nothing is left to scope. Every page carries its own explicit `counter-reset` for both
 * counters and `counter-increment: none`, which makes each page's numbering a fact about that
 * page alone rather than a consequence of the ones before it.
 */

/** The numbering for a single page: what it should read, and out of how many. */
export interface PageStamp {
	/** Index of the page in the full paginated document. */
	pageIndex: number;
	/** The number this page should display. */
	number: number;
	/** Pages in the run this page belongs to — the `of N` half of a running foot. */
	total: number;
}

/**
 * Plan per-note numbering for a merged document, one entry per page.
 *
 * `documentStartPages` is what the backend reads back out of the paginated DOM: the first page
 * index of each note, in document order, non-decreasing.
 *
 * **Notes that share a page share a run.** Two short notes can land on the same page, and
 * numbering cannot restart in the middle of one — so a run begins at each *distinct* start page
 * and covers every page up to the next. That beats a `1 of 0` for the note that never got a
 * page of its own.
 *
 * Returns an empty array when there is nothing to change: no pages, or a single run covering
 * the whole document, which is what continuous numbering already produces.
 */
export function planPerNoteNumbering(documentStartPages: readonly number[], pageCount: number): PageStamp[] {
	if (pageCount <= 0) return [];

	const starts: number[] = [];
	for (const start of documentStartPages) {
		if (!Number.isInteger(start) || start < 0 || start >= pageCount) continue;
		if (starts.length > 0 && start <= (starts[starts.length - 1] as number)) continue;
		starts.push(start);
	}

	// A merged document always numbers from its own first page, even if the first note's
	// recorded start was missing or out of range.
	if (starts.length === 0 || starts[0] !== 0) starts.unshift(0);

	// One run is exactly what continuous numbering already does; stamping it would be work
	// with no effect, and the caller skips the guest round trip entirely.
	if (starts.length <= 1) return [];

	const stamps: PageStamp[] = [];
	for (let run = 0; run < starts.length; run++) {
		const start = starts[run] as number;
		const end = starts[run + 1] ?? pageCount;
		for (let pageIndex = start; pageIndex < end; pageIndex++) {
			stamps.push({ pageIndex, number: pageIndex - start + 1, total: end - start });
		}
	}
	return stamps;
}
