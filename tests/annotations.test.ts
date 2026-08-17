import { describe, expect, it } from 'vitest';
import { planAnnotations } from '../src/core/annotations';
import type { AnnotationClassNames } from '../src/core/annotations';
import { el, root } from './fakes/mock-dom';

/**
 * `md-annotation` compatibility.
 *
 * The class names are injected rather than imported, mirroring the production wiring where
 * they come from the adapter module — so this test also demonstrates that core knows nothing
 * about another plugin's CSS.
 */
const CLASSES: AnnotationClassNames = {
	host: 'gutter-host',
	card: 'gutter-card',
	text: 'gutter-text',
	number: 'gutter-num',
	hidden: 'gutter-hidden',
	leader: 'gutter-leader',
	tick: 'gutter-tick',
};

function annotated(): ReturnType<typeof root> {
	return root(
		el({ tag: 'p', text: 'Body text.', children: [el({ classes: ['gutter-tick'] })] }),
		el({ classes: ['gutter-leader'] }),
		el({
			classes: ['gutter-host'],
			children: [
				el({
					classes: ['gutter-card'],
					children: [el({ classes: ['gutter-num'], text: '1' }), el({ classes: ['gutter-text'], text: 'First note' })],
				}),
				el({
					classes: ['gutter-card'],
					children: [el({ classes: ['gutter-num'], text: '2' }), el({ classes: ['gutter-text'], text: 'Second note' })],
				}),
			],
		}),
	);
}

describe('planAnnotations', () => {
	it('keeps the gutters in gutter mode', () => {
		const plan = planAnnotations(annotated(), 'gutter', CLASSES);
		expect(plan.keepGutters).toBe(true);
		expect(plan.removeGutters).toBe(false);
		expect(plan.endnotes).toEqual([]);
	});

	// Leader lines are a live-editor affordance with no meaning on paper.
	it('always removes leader lines', () => {
		expect(planAnnotations(annotated(), 'gutter', CLASSES).removals).toHaveLength(1);
	});

	it('collects endnotes in document order in endnotes mode', () => {
		const plan = planAnnotations(annotated(), 'endnotes', CLASSES);
		expect(plan.endnotes.map((note) => [note.number, note.text])).toEqual([
			[1, 'First note'],
			[2, 'Second note'],
		]);
		expect(plan.removeGutters).toBe(true);
		expect(plan.keepGutters).toBe(false);
	});

	// Prefers the card's dedicated text element so the number marker is not duplicated into
	// the endnote body.
	it('takes the card body text rather than the whole card', () => {
		const plan = planAnnotations(annotated(), 'endnotes', CLASSES);
		expect(plan.endnotes[0]?.text).toBe('First note');
	});

	it('falls back to the whole card when it has no dedicated text element', () => {
		const document = root(
			el({ classes: ['gutter-host'], children: [el({ classes: ['gutter-card'], text: 'Bare note' })] }),
		);
		expect(planAnnotations(document, 'endnotes', CLASSES).endnotes[0]?.text).toBe('Bare note');
	});

	it('removes everything in off mode', () => {
		const plan = planAnnotations(annotated(), 'off', CLASSES);
		expect(plan.removeGutters).toBe(true);
		expect(plan.endnotes).toEqual([]);
		// host + leader + tick
		expect(plan.removals).toHaveLength(3);
	});

	// Decision: gutter mode with no gutter host present is a silent no-op, not an error. A
	// profile with gutters on, applied to a note with no annotations, is ordinary.
	it('is a silent no-op when gutter mode meets a document with no gutters', () => {
		const plan = planAnnotations(root(el({ tag: 'p', text: 'Plain note.' })), 'gutter', CLASSES);
		expect(plan.noGutterHost).toBe(true);
		expect(plan.keepGutters).toBe(false);
		expect(plan.removals).toEqual([]);
		expect(plan.endnotes).toEqual([]);
	});

	it('produces no endnotes for a document with no cards', () => {
		const plan = planAnnotations(root(el({ tag: 'p', text: 'Plain note.' })), 'endnotes', CLASSES);
		expect(plan.endnotes).toEqual([]);
	});

	it('drops cards whose text is empty rather than emitting a blank endnote', () => {
		const document = root(
			el({
				classes: ['gutter-host'],
				children: [
					el({ classes: ['gutter-card'], children: [el({ classes: ['gutter-text'], text: '   ' })] }),
					el({ classes: ['gutter-card'], children: [el({ classes: ['gutter-text'], text: 'Real' })] }),
				],
			}),
		);
		const plan = planAnnotations(document, 'endnotes', CLASSES);
		expect(plan.endnotes).toEqual([{ number: 1, text: 'Real', source: expect.anything() }]);
	});

	// The rendered DOM supplies content, never the mode: the same tree yields three
	// different plans purely from the profile flag.
	it('is driven entirely by the flag, not by the DOM', () => {
		const document = annotated();
		expect(planAnnotations(document, 'gutter', CLASSES).keepGutters).toBe(true);
		expect(planAnnotations(document, 'endnotes', CLASSES).endnotes).toHaveLength(2);
		expect(planAnnotations(document, 'off', CLASSES).endnotes).toHaveLength(0);
	});
});
