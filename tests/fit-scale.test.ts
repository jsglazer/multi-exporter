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

	// Content that already fits must print at 1: the fit only ever shrinks.
	it('never reports a scale above 1', () => {
		expect(fitScaleScript('both')).toContain('let worst = 1;');
		expect(fitScaleScript('both')).toContain('return 1 / worst;');
	});
});
