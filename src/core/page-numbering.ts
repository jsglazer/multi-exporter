/**
 * Where page numbering restarts in a merged document.
 *
 * A merged export paginates every note as one document — that is what makes the preview the
 * output and lets running heads carry across note boundaries — so `counter(page)` runs
 * 1…N across the whole PDF and `counter(pages)` is the whole PDF's total. Restarting the
 * count at each note is therefore not something a stylesheet can ask for: CSS Paged Media
 * has no per-section total at all, and paged.js sets `pages` once, from the chunker's final
 * page count.
 *
 * What it *can* be is a counter scope. A `counter-reset` on a page element creates a new
 * counter scoped to that element and its following siblings, shadowing the one the page
 * container established. Dropping one reset on the first page of each note therefore
 * restarts both `page` and `pages` for exactly that note's run of pages, and every margin
 * box downstream reads the note-local values without knowing anything has changed.
 *
 * This module decides *where* those resets go and *what* they say. It is pure so the
 * decision can be tested without a paginator; the shell only applies the result.
 */

/** One counter restart: which page it lands on, and the total that page's note spans. */
export interface NumberingReset {
	/** Index of the page the reset is applied to, in the full paginated document. */
	pageIndex: number;
	/** Pages the note starting here spans — the `of N` half of a running foot. */
	total: number;
}

/**
 * Plan the per-note counter restarts for a merged document.
 *
 * `documentStartPages` is what the backend already reads back out of the paginated DOM: the
 * first page index of each note, in document order, non-decreasing.
 *
 * **Notes that share a page share a count.** Two short notes can land on the same page, and
 * numbering cannot restart in the middle of one — so only the first note at a given start
 * page gets a reset, and its total covers every page up to the next *distinct* start. That
 * is the honest answer rather than a `1 of 0` for the note that did not get its own page.
 */
export function planPerNoteNumbering(
	documentStartPages: readonly number[],
	pageCount: number,
): NumberingReset[] {
	if (pageCount <= 0) return [];

	// Distinct starts, in order, clamped into the document. A start beyond the last page
	// cannot begin a run of pages, so it cannot carry a reset.
	const starts: number[] = [];
	for (const start of documentStartPages) {
		if (!Number.isInteger(start) || start < 0 || start >= pageCount) continue;
		if (starts.length > 0 && start <= (starts[starts.length - 1] as number)) continue;
		starts.push(start);
	}

	// A merged document always numbers from its own first page, even if the first note's
	// recorded start was missing or out of range.
	if (starts.length === 0 || starts[0] !== 0) starts.unshift(0);

	return starts.map((start, index) => ({
		pageIndex: start,
		total: (starts[index + 1] ?? pageCount) - start,
	}));
}
