import { describe, expect, it } from 'vitest';
import {
	buildOutline,
	collectHeadingRefs,
	countOutlineNodes,
	mergeDocumentOutlines,
} from '../src/core/outline';
import type { HeadingRef, PagedPage } from '../src/core/outline';
import { el } from './fakes/mock-dom';

/**
 * Deterministic test requirement: "Unit-test PDF bookmark outline construction via a mock
 * page-flow walker."
 *
 * The mock walker stands in for paged.js's page map: each page is an element whose headings
 * are the ones that landed on that page.
 */

function page(pageIndex: number, headings: { tag: string; text: string }[]): PagedPage {
	return {
		pageIndex,
		element: el({ children: headings.map((heading) => el({ tag: heading.tag, text: heading.text })) }),
	};
}

describe('collectHeadingRefs', () => {
	it('walks a page flow and records the page each heading landed on', () => {
		const pages = [
			page(0, [{ tag: 'h1', text: 'Chapter One' }]),
			page(1, [
				{ tag: 'h2', text: 'Background' },
				{ tag: 'h2', text: 'Method' },
			]),
			page(2, [{ tag: 'h1', text: 'Chapter Two' }]),
		];
		expect(collectHeadingRefs(pages)).toEqual<HeadingRef[]>([
			{ level: 1, title: 'Chapter One', pageIndex: 0 },
			{ level: 2, title: 'Background', pageIndex: 1 },
			{ level: 2, title: 'Method', pageIndex: 1 },
			{ level: 1, title: 'Chapter Two', pageIndex: 2 },
		]);
	});

	it('collapses whitespace in titles', () => {
		const pages = [page(0, [{ tag: 'h1', text: '  A   long\n  title ' }])];
		expect(collectHeadingRefs(pages)[0]?.title).toBe('A long title');
	});

	it('drops headings with no text rather than emitting an empty bookmark', () => {
		const pages = [page(0, [{ tag: 'h1', text: '   ' }])];
		expect(collectHeadingRefs(pages)).toEqual([]);
	});

	it('honours an explicit data-outline-level override', () => {
		const pages: PagedPage[] = [
			{
				pageIndex: 0,
				element: el({
					children: [el({ tag: 'div', attrs: { 'data-outline-level': '2' }, text: 'Pseudo-heading' })],
				}),
			},
		];
		expect(collectHeadingRefs(pages, 'div')).toEqual([{ level: 2, title: 'Pseudo-heading', pageIndex: 0 }]);
	});

	it('returns nothing for an empty flow', () => {
		expect(collectHeadingRefs([])).toEqual([]);
	});
});

describe('buildOutline', () => {
	it('nests headings by level', () => {
		const outline = buildOutline([
			{ level: 1, title: 'One', pageIndex: 0 },
			{ level: 2, title: 'One.A', pageIndex: 1 },
			{ level: 3, title: 'One.A.i', pageIndex: 1 },
			{ level: 2, title: 'One.B', pageIndex: 2 },
			{ level: 1, title: 'Two', pageIndex: 3 },
		]);

		expect(outline).toHaveLength(2);
		expect(outline[0]?.title).toBe('One');
		expect(outline[0]?.children.map((child) => child.title)).toEqual(['One.A', 'One.B']);
		expect(outline[0]?.children[0]?.children[0]?.title).toBe('One.A.i');
		expect(outline[1]?.title).toBe('Two');
	});

	// Real documents skip levels. Nesting relative to the stack rather than to the tag
	// number means no heading is ever dropped.
	it('handles a skipped level', () => {
		const outline = buildOutline([
			{ level: 1, title: 'One', pageIndex: 0 },
			{ level: 3, title: 'Deep', pageIndex: 1 },
		]);
		expect(outline[0]?.children[0]?.title).toBe('Deep');
	});

	it('handles a document that starts at h2', () => {
		const outline = buildOutline([
			{ level: 2, title: 'First', pageIndex: 0 },
			{ level: 2, title: 'Second', pageIndex: 1 },
		]);
		expect(outline.map((node) => node.title)).toEqual(['First', 'Second']);
	});

	it('pops back out when a shallower heading follows a deep one', () => {
		const outline = buildOutline([
			{ level: 1, title: 'One', pageIndex: 0 },
			{ level: 4, title: 'Deep', pageIndex: 1 },
			{ level: 2, title: 'One.B', pageIndex: 2 },
		]);
		expect(outline[0]?.children.map((child) => child.title)).toEqual(['Deep', 'One.B']);
	});

	it('carries the page index onto every node', () => {
		const outline = buildOutline([
			{ level: 1, title: 'One', pageIndex: 4 },
			{ level: 2, title: 'One.A', pageIndex: 7 },
		]);
		expect(outline[0]?.pageIndex).toBe(4);
		expect(outline[0]?.children[0]?.pageIndex).toBe(7);
	});

	it('returns an empty outline for no headings', () => {
		expect(buildOutline([])).toEqual([]);
	});
});

describe('mergeDocumentOutlines', () => {
	it('gives each document a top-level bookmark with its headings nested beneath', () => {
		const outline = mergeDocumentOutlines([
			{
				title: 'First note',
				startPageIndex: 0,
				headings: [
					{ level: 1, title: 'Intro', pageIndex: 0 },
					{ level: 2, title: 'Detail', pageIndex: 1 },
				],
			},
			{
				title: 'Second note',
				startPageIndex: 2,
				headings: [{ level: 1, title: 'Findings', pageIndex: 2 }],
			},
		]);

		expect(outline.map((node) => node.title)).toEqual(['First note', 'Second note']);
		expect(outline[0]?.children.map((child) => child.title)).toEqual(['Intro']);
		expect(outline[0]?.children[0]?.children.map((child) => child.title)).toEqual(['Detail']);
		expect(outline[1]?.pageIndex).toBe(2);
	});

	// Merged mode paginates once, so page indices are already continuous — nothing is
	// offset after the fact.
	it('preserves the continuous page indices it was handed', () => {
		const outline = mergeDocumentOutlines([
			{ title: 'A', startPageIndex: 0, headings: [{ level: 1, title: 'A1', pageIndex: 3 }] },
			{ title: 'B', startPageIndex: 9, headings: [{ level: 1, title: 'B1', pageIndex: 12 }] },
		]);
		expect(outline[0]?.children[0]?.pageIndex).toBe(3);
		expect(outline[1]?.children[0]?.pageIndex).toBe(12);
	});

	it('handles a document with no headings', () => {
		const outline = mergeDocumentOutlines([{ title: 'Empty', startPageIndex: 0, headings: [] }]);
		expect(outline).toEqual([{ title: 'Empty', pageIndex: 0, children: [] }]);
	});
});

describe('countOutlineNodes', () => {
	it('counts the whole tree', () => {
		const outline = buildOutline([
			{ level: 1, title: 'One', pageIndex: 0 },
			{ level: 2, title: 'One.A', pageIndex: 0 },
			{ level: 2, title: 'One.B', pageIndex: 1 },
			{ level: 1, title: 'Two', pageIndex: 2 },
		]);
		expect(countOutlineNodes(outline)).toBe(4);
	});
});
