import { describe, expect, it } from 'vitest';
import { planPerNoteNumbering } from '../src/core/page-numbering';

/**
 * Restarting the page count at each note in a merged export.
 *
 * The totals cannot come from CSS — paged.js sets `pages` once from the chunker's final page
 * count, and CSS Paged Media has no per-section total at all — so they are computed here from
 * the page map the backend reads back out of the paginated DOM, and applied as counter
 * scopes. This is the whole decision; the shell only carries the result into the guest.
 */
describe('planPerNoteNumbering', () => {
	it('gives each note its own run, with its own total', () => {
		// Ten pages, three notes starting at 0, 4 and 6.
		expect(planPerNoteNumbering([0, 4, 6], 10)).toEqual([
			{ pageIndex: 0, total: 4 },
			{ pageIndex: 4, total: 2 },
			{ pageIndex: 6, total: 4 },
		]);
	});

	it("the last note's total runs to the end of the document", () => {
		const resets = planPerNoteNumbering([0, 6], 18);
		expect(resets[resets.length - 1]).toEqual({ pageIndex: 6, total: 12 });
	});

	// The scenario from the request: ten notes, sixty pages, each numbered from one.
	it('totals every page exactly once across ten notes', () => {
		const starts = [0, 6, 12, 18, 24, 30, 36, 42, 48, 54];
		const resets = planPerNoteNumbering(starts, 60);
		expect(resets).toHaveLength(10);
		expect(resets.reduce((sum, reset) => sum + reset.total, 0)).toBe(60);
		expect(resets.every((reset) => reset.total === 6)).toBe(true);
	});

	/**
	 * Two notes can land on the same page, and numbering cannot restart mid-page. Only the
	 * first note at a start page gets a reset, and its total covers up to the next *distinct*
	 * start — which beats emitting `1 of 0` for the note that never got its own page.
	 */
	it('merges notes that share a start page into one run', () => {
		expect(planPerNoteNumbering([0, 3, 3, 3, 7], 10)).toEqual([
			{ pageIndex: 0, total: 3 },
			{ pageIndex: 3, total: 4 },
			{ pageIndex: 7, total: 3 },
		]);
	});

	it('always numbers from the first page, even if the map does not start at zero', () => {
		expect(planPerNoteNumbering([2, 5], 8)).toEqual([
			{ pageIndex: 0, total: 2 },
			{ pageIndex: 2, total: 3 },
			{ pageIndex: 5, total: 3 },
		]);
	});

	it('is a single whole-document run for one note, which the caller skips', () => {
		expect(planPerNoteNumbering([0], 7)).toEqual([{ pageIndex: 0, total: 7 }]);
	});

	// `documentStartPages` is read out of a live DOM, so it is not trusted to be clean.
	it('ignores starts that are out of range, negative, or not whole numbers', () => {
		expect(planPerNoteNumbering([0, 99, 3], 6)).toEqual([
			{ pageIndex: 0, total: 3 },
			{ pageIndex: 3, total: 3 },
		]);
		expect(planPerNoteNumbering([-2, 0, 2.5, 4], 8)).toEqual([
			{ pageIndex: 0, total: 4 },
			{ pageIndex: 4, total: 4 },
		]);
	});

	it('has nothing to plan for an empty document', () => {
		expect(planPerNoteNumbering([0, 1], 0)).toEqual([]);
		expect(planPerNoteNumbering([], 0)).toEqual([]);
	});

	it('still numbers a document whose page map came back empty', () => {
		expect(planPerNoteNumbering([], 5)).toEqual([{ pageIndex: 0, total: 5 }]);
	});
});
