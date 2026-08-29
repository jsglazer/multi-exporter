import { describe, expect, it } from 'vitest';
import { containsMath } from '../src/shell/mathjax';

/**
 * The one decision in the MathJax bridge that is testable without a browser: whether a
 * serialised document needs the stylesheet at all.
 *
 * Everything else in that module reads the live CSSOM and fetches `app://` URLs, which only
 * exist inside Obsidian — there is nothing a fake could stand in for that would still be
 * testing anything.
 */
describe('containsMath', () => {
	it('recognises a rendered formula', () => {
		expect(containsMath('<p>x <mjx-container class="MathJax"><mjx-math/></mjx-container></p>')).toBe(true);
	});

	// The cost of a false positive is a megabyte of inlined fonts on a document with no
	// formulas in it, so prose that merely talks about maths must not trigger it.
	it('is not fooled by prose about maths', () => {
		expect(containsMath('<p>MathJax renders $x$ as an mjx-container element.</p>')).toBe(false);
	});

	it('says no for an empty document', () => {
		expect(containsMath('')).toBe(false);
	});
});
