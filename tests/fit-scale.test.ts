import { describe, expect, it } from 'vitest';
import { fitScaleScript } from '../src/shell/fit-scale';

/**
 * Which constraint fit-to-page measures.
 *
 * Chromium's print scale is a single uniform number, so the axis cannot change *how* the page
 * is scaled — only what it is scaled *for*. That makes the measurement the whole of the
 * behaviour, and the measurement is a generated string, so this is where it can be checked.
 */
describe('fitScaleScript', () => {
	it('measures width alone when the constraint is width', () => {
		const script = fitScaleScript('width');
		expect(script).toContain('rect.width / width');
		expect(script).not.toContain('rect.height / height');
	});

	it('measures height alone when the constraint is height', () => {
		const script = fitScaleScript('height');
		expect(script).toContain('rect.height / height');
		expect(script).not.toContain('rect.width / width');
	});

	// Both takes the harsher of the two, which is what the single scale has to satisfy.
	it('measures both when the constraint is both', () => {
		const script = fitScaleScript('both');
		expect(script).toContain('rect.width / width');
		expect(script).toContain('rect.height / height');
	});

	// One page-width is the strict reading and has to generate the script it always did:
	// dividing by a literal 1 is noise in an injected source string.
	it('divides by nothing when a single page-width is allowed', () => {
		expect(fitScaleScript('width', 1)).toBe(fitScaleScript('width'));
		expect(fitScaleScript('width', 1)).toContain('rect.width / width');
	});

	// Nothing flows sideways in CSS Paged Media, so "two pages wide" is a tolerance: content
	// up to twice the text column is accepted, and only worse overflow is scaled away.
	it('widens the width allowance by the page count', () => {
		const script = fitScaleScript('both', 3);
		expect(script).toContain('rect.width / (width * 3)');
		// Height has no equivalent tolerance — an element taller than the page just falls off.
		expect(script).toContain('rect.height / height');
	});

	it('ignores a nonsense allowance rather than generating a broken script', () => {
		expect(fitScaleScript('width', 0)).toBe(fitScaleScript('width'));
		expect(fitScaleScript('width', Number.NaN)).toBe(fitScaleScript('width'));
	});

	// Content that already fits must print at 1: the fit only ever shrinks.
	it('never reports a scale above 1', () => {
		expect(fitScaleScript('both')).toContain('let worst = 1;');
		expect(fitScaleScript('both')).toContain('return 1 / worst;');
	});
});
