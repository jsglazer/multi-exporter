import { describe, expect, it } from 'vitest';
import {
	clampPagesTall,
	clampPagesWide,
	contentScaleCss,
	MAX_FIT_ATTEMPTS,
	MIN_CONTENT_SCALE,
	nextContentScale,
} from '../src/core/fit-pages';

/**
 * Fitting to a *number of pages*.
 *
 * The two numbers are two mechanisms — a tolerance on the fit measurement, and a target that
 * re-paginates — and the search behind the second one is the part worth pinning down: it
 * spends a full paged.js run per attempt, so it has to converge, stop, and never run away.
 */

describe('clampPagesWide', () => {
	it('defaults to a single page for anything that is not a number', () => {
		expect(clampPagesWide(undefined)).toBe(1);
		expect(clampPagesWide('2')).toBe(1);
		expect(clampPagesWide(Number.NaN)).toBe(1);
	});

	it('never drops below one page-width', () => {
		expect(clampPagesWide(0)).toBe(1);
		expect(clampPagesWide(-4)).toBe(1);
	});

	it('rounds and caps', () => {
		expect(clampPagesWide(2.4)).toBe(2);
		expect(clampPagesWide(1000)).toBe(10);
	});
});

describe('clampPagesTall', () => {
	// Zero is the "no target" value here, unlike pagesWide where zero pages is meaningless.
	it('treats absent, nonsense and zero alike as no target', () => {
		expect(clampPagesTall(undefined)).toBe(0);
		expect(clampPagesTall(Number.NaN)).toBe(0);
		expect(clampPagesTall(0)).toBe(0);
		expect(clampPagesTall(-3)).toBe(0);
	});

	it('rounds and caps', () => {
		expect(clampPagesTall(3.6)).toBe(4);
		expect(clampPagesTall(9999)).toBe(200);
	});
});

describe('nextContentScale', () => {
	it('stops when there is no target', () => {
		expect(nextContentScale(1, 12, 0)).toBeNull();
	});

	it('stops when the document already fits', () => {
		expect(nextContentScale(1, 8, 8)).toBeNull();
		expect(nextContentScale(1, 3, 8)).toBeNull();
	});

	// The page count falls with the area, not the linear scale: shrinking makes lines hold
	// more characters as well as taking less height. A linear guess would undershoot every
	// attempt and burn the whole budget creeping down.
	it('estimates from the square root of the ratio, aimed slightly small', () => {
		const next = nextContentScale(1, 12, 8);
		expect(next).not.toBeNull();
		expect(next as number).toBeCloseTo(Math.sqrt(8 / 12) * 0.97, 3);
	});

	it('compounds from the current scale rather than restarting at 1', () => {
		const first = nextContentScale(1, 20, 10) as number;
		const second = nextContentScale(first, 14, 10) as number;
		expect(second).toBeLessThan(first);
	});

	it('never goes below the readability floor', () => {
		expect(nextContentScale(1, 400, 1)).toBe(MIN_CONTENT_SCALE);
	});

	// At the floor there is nothing left to try, and another pagination could only produce
	// the answer already in hand.
	it('stops once the floor cannot be improved on', () => {
		expect(nextContentScale(MIN_CONTENT_SCALE, 400, 1)).toBeNull();
	});

	// The overshoot is what guarantees progress. Missing a hundred-page target by one page is
	// the case where a bare `sqrt` estimate would step by half a percent, fail to move a
	// single break, and burn every remaining attempt on the same answer.
	it('still takes a real step when the target is missed by one page', () => {
		const next = nextContentScale(1, 101, 100) as number;
		expect(next).toBeLessThan(0.98);
	});

	// The bound exists because each attempt is a full re-pagination of the whole document.
	it('converges inside the attempt budget for an ordinary overshoot', () => {
		let scale = 1;
		let pages = 30;
		let attempts = 0;
		while (pages > 20 && attempts < MAX_FIT_ATTEMPTS) {
			const next = nextContentScale(scale, pages, 20);
			if (next === null) break;
			// Pages fall roughly with the area of the scale — the model the estimate assumes.
			pages = Math.ceil(30 * next * next);
			scale = next;
			attempts++;
		}
		expect(pages).toBeLessThanOrEqual(20);
		expect(attempts).toBeLessThan(MAX_FIT_ATTEMPTS);
	});
});

describe('contentScaleCss', () => {
	// An export with no page target must produce byte-for-byte the stylesheet it always did.
	it('emits nothing at all when nothing is being scaled', () => {
		expect(contentScaleCss(1)).toBe('');
		expect(contentScaleCss(1.4)).toBe('');
		expect(contentScaleCss(Number.NaN)).toBe('');
	});

	// `zoom`, not `transform`: a transform is applied after layout, so the chunker would break
	// the pages exactly where it always did and the page count would not move.
	it('zooms the flow wrapper paged.js lays content into', () => {
		const css = contentScaleCss(0.8);
		expect(css).toContain('.pagedjs_page_content > div');
		expect(css).toContain('zoom: 0.8');
		expect(css).not.toContain('transform');
	});

	it('holds the floor even when handed something smaller', () => {
		expect(contentScaleCss(0.05)).toContain(`zoom: ${MIN_CONTENT_SCALE}`);
	});
});
