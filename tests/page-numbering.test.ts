import { describe, expect, it } from 'vitest';
import { planPerNoteNumbering } from '../src/core/page-numbering';

/**
 * Restarting the page count at each note in a merged export.
 *
 * The totals cannot come from CSS — paged.js sets `pages` once from the chunker's final page
 * count, and CSS Paged Media has no per-section total — so they are computed here from the page
 * map the backend reads back out of the paginated DOM.
 *
 * **Every page is stamped, not just the ones that restart.** Leaning on counter scope was tried
 * and measured against real output: a `counter-reset` on a page element is not seen by the
 * following sibling pages, which fall back to a document-wide counter that is only incremented
 * on the pages that did not reset. The result was correct restart pages separated by nonsense —
 * `1 of 1`, `1 of 3`, `1 of 14`, `2 of 14`. So each page now carries its own explicit value.
 */
describe('planPerNoteNumbering', () => {
	it('numbers every page of every run from one', () => {
		expect(planPerNoteNumbering([0, 3], 5)).toEqual([
			{ pageIndex: 0, number: 1, total: 3 },
			{ pageIndex: 1, number: 2, total: 3 },
			{ pageIndex: 2, number: 3, total: 3 },
			{ pageIndex: 3, number: 1, total: 2 },
			{ pageIndex: 4, number: 2, total: 2 },
		]);
	});

	// The shape the bug produced: pages between two restarts must belong to the run they sit in,
	// never fall back to a document-wide count.
	it('leaves no page reading the document total', () => {
		const stamps = planPerNoteNumbering([0, 1, 4, 5, 7, 10, 11, 12], 14);
		expect(stamps).toHaveLength(14);
		expect(stamps.every((stamp) => stamp.total < 14)).toBe(true);
		expect(stamps.every((stamp) => stamp.number <= stamp.total)).toBe(true);
	});

	it('covers every page exactly once, in order', () => {
		const stamps = planPerNoteNumbering([0, 6, 12, 18, 24, 30, 36, 42, 48, 54], 60);
		expect(stamps.map((stamp) => stamp.pageIndex)).toEqual([...Array(60).keys()]);
		expect(stamps.every((stamp) => stamp.total === 6)).toBe(true);
		expect(stamps.filter((stamp) => stamp.number === 1)).toHaveLength(10);
	});

	/**
	 * Two notes can land on the same page, and numbering cannot restart mid-page. A run begins
	 * at each *distinct* start and covers every page up to the next.
	 */
	it('merges notes that share a start page into one run', () => {
		expect(planPerNoteNumbering([0, 3, 3, 3, 7], 10).filter((stamp) => stamp.number === 1)).toEqual([
			{ pageIndex: 0, number: 1, total: 3 },
			{ pageIndex: 3, number: 1, total: 4 },
			{ pageIndex: 7, number: 1, total: 3 },
		]);
	});

	it('always numbers from the first page, even if the map does not start at zero', () => {
		const stamps = planPerNoteNumbering([2, 5], 8);
		expect(stamps[0]).toEqual({ pageIndex: 0, number: 1, total: 2 });
		expect(stamps[2]).toEqual({ pageIndex: 2, number: 1, total: 3 });
	});

	// Nothing to change is nothing to send: the caller skips the guest round trip entirely.
	it('plans nothing when one run covers the whole document', () => {
		expect(planPerNoteNumbering([0], 7)).toEqual([]);
		expect(planPerNoteNumbering([], 5)).toEqual([]);
	});

	// `documentStartPages` is read out of a live DOM, so it is not trusted to be clean.
	it('ignores starts that are out of range, negative, or not whole numbers', () => {
		expect(planPerNoteNumbering([0, 99, 3], 6).filter((stamp) => stamp.number === 1)).toEqual([
			{ pageIndex: 0, number: 1, total: 3 },
			{ pageIndex: 3, number: 1, total: 3 },
		]);
		expect(planPerNoteNumbering([-2, 0, 2.5, 4], 8).filter((stamp) => stamp.number === 1)).toEqual([
			{ pageIndex: 0, number: 1, total: 4 },
			{ pageIndex: 4, number: 1, total: 4 },
		]);
	});

	it('has nothing to plan for an empty document', () => {
		expect(planPerNoteNumbering([0, 1], 0)).toEqual([]);
		expect(planPerNoteNumbering([], 0)).toEqual([]);
	});
});
