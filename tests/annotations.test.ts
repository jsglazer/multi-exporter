import { describe, expect, it } from 'vitest';
import { flattenText, locate, similarity } from '../src/core/annotation-match';
import { planAnnotationStrip, planAnnotations } from '../src/core/annotations';
import type { AnnotationRecord, AnnotationStripClasses } from '../src/core/annotations';
import { el, root } from './fakes/mock-dom';

/**
 * `md-annotation` compatibility.
 *
 * The input is **data** now, not a DOM: the plugin's API returns annotation records, and the
 * plugin has to find them in the rendered note itself. So these tests are mostly about the
 * matcher, and the tree is only there to be searched.
 *
 * The class names are injected rather than imported, mirroring the production wiring where
 * they come from the adapter module — so this also demonstrates that core knows nothing
 * about another plugin's CSS.
 */
const STRIP: AnnotationStripClasses = {
	unwrap: ['mdann-hl', 'mdann-anchor'],
	remove: ['mdann-marker', 'mdann-gutter-host'],
};

const SENTENCE = 'A NAND gate needs four transistors, while a NOT gate needs two.';

function note(): ReturnType<typeof root> {
	return root(el({ tag: 'h1', text: 'Gates' }), el({ tag: 'p', text: SENTENCE }));
}

function record(init: Partial<AnnotationRecord> & { selector: AnnotationRecord['selector'] }): AnnotationRecord {
	return {
		id: 'a1',
		type: 'highlight',
		category: 'Define',
		comment: '',
		author: 'Josh',
		status: 'open',
		...init,
	};
}

describe('planAnnotationStrip', () => {
	it('separates what is unwrapped from what is removed', () => {
		const tree = root(
			el({ tag: 'p', children: [el({ tag: 'span', classes: ['mdann-hl'], text: 'kept text' })] }),
			el({ tag: 'span', classes: ['mdann-marker'], text: '1' }),
		);
		const plan = planAnnotationStrip(tree, STRIP);
		expect(plan.unwrap).toHaveLength(1);
		expect(plan.remove).toHaveLength(1);
	});

	// An element listed for removal is going away whole; unwrapping it as well would put its
	// contents back into the note.
	it('never both unwraps and removes the same element', () => {
		const tree = root(el({ tag: 'span', classes: ['mdann-hl', 'mdann-marker'], text: '1' }));
		const plan = planAnnotationStrip(tree, STRIP);
		expect(plan.unwrap).toEqual([]);
		expect(plan.remove).toHaveLength(1);
	});

	it('finds nothing in a note the other plugin never touched', () => {
		const plan = planAnnotationStrip(note(), STRIP);
		expect(plan.unwrap).toEqual([]);
		expect(plan.remove).toEqual([]);
	});
});

describe('flattenText', () => {
	it('concatenates the note text and maps each run back to its node', () => {
		const flat = flattenText(note());
		expect(flat.text).toBe(`Gates${SENTENCE}`);
		expect(flat.runs).toHaveLength(2);
		expect(flat.runs[1]?.start).toBe(5);
	});

	// A code block is not prose: a quote must never be "found" inside one.
	it('skips code, script and style subtrees', () => {
		const flat = flattenText(root(el({ tag: 'p', text: 'ok' }), el({ tag: 'code', text: 'NAND' })));
		expect(flat.text).toBe('ok');
	});

	it('skips the subtrees the export appended itself', () => {
		const tree = root(el({ tag: 'p', text: 'ok' }), el({ classes: ['mx-bibliography'], text: 'Smith 1999' }));
		expect(flattenText(tree, ['mx-bibliography']).text).toBe('ok');
	});
});

describe('locate', () => {
	const flat = SENTENCE;

	it('finds a quote that occurs once', () => {
		const found = locate(flat, { exact: 'NAND gate', prefix: 'A ', suffix: ' needs' });
		expect(found).toEqual({ start: 2, end: 11, confidence: 1 });
	});

	it('uses the stored context to choose between repeats', () => {
		const repeated = 'the gate is here. and the gate is there.';
		const found = locate(repeated, { exact: 'the gate', prefix: 'here. and ', suffix: ' is there' });
		expect(found?.start).toBe(22);
	});

	// Two candidates too close to call are orphaned, never guessed at: putting a comment on
	// the wrong one of two identical sentences is worse than saying it could not be placed.
	it('gives up on a quote whose context cannot separate it', () => {
		expect(locate('ab ab', { exact: 'ab', prefix: '', suffix: '' })).toBeNull();
	});

	// The selector was captured from the markdown source; the search runs over the rendered
	// text, where a source line break has become a single space.
	it('matches across re-wrapped whitespace', () => {
		const rendered = 'a NAND gate needs four transistors';
		const found = locate(rendered, { exact: 'NAND\n  gate', prefix: 'a ', suffix: ' needs' });
		expect(found?.start).toBe(2);
		expect(rendered.slice(found?.start, found?.end)).toBe('NAND gate');
	});

	// The words the reader highlighted were edited afterwards, but the sentence around them
	// was not — so the context is the surviving landmark.
	it('falls back to the stored context when the quote itself changed', () => {
		const rendered = 'A NAND gate needs exactly four transistors, while a NOT gate needs two.';
		const found = locate(rendered, {
			exact: 'needs four transistors',
			prefix: 'A NAND gate ',
			suffix: ', while a NOT gate',
		});
		expect(found).not.toBeNull();
		expect(found?.confidence).toBeLessThan(1);
	});

	it('resolves a point comment to a caret between its two context windows', () => {
		const found = locate(flat, { exact: '', prefix: 'A NAND gate', suffix: ' needs four' });
		expect(found).toEqual({ start: 11, end: 11, confidence: 1 });
	});

	// A selector captured inside a table stores the raw pipe-delimited row as its context,
	// and none of that survives rendering — so the words are what the two texts agree on.
	it('sees through a table row stored as context', () => {
		const rendered = 'One Three bob Highlight here please Four ann Highlight there please';
		const found = locate(rendered, {
			exact: 'here',
			prefix: '# One\n| Three | bob | Highlight ',
			suffix: ' please |\n|       |     |       ',
		});
		expect(found?.start).toBe(24);
	});

	it('reports nothing for a quote that is simply gone', () => {
		expect(locate(flat, { exact: 'a paragraph that was deleted', prefix: 'x', suffix: 'y' })).toBeNull();
	});
});

describe('similarity', () => {
	it('is 1 for identical strings and 0 for unrelated ones', () => {
		expect(similarity('transistor', 'transistor')).toBe(1);
		expect(similarity('abcd', 'wxyz')).toBe(0);
	});

	it('degrades gradually rather than falling off a cliff', () => {
		expect(similarity('four transistors', 'exactly four transistors')).toBeGreaterThan(0.7);
	});
});

describe('planAnnotations', () => {
	const highlight = record({
		id: 'nand',
		selector: { exact: 'NAND gate', prefix: 'A ', suffix: ' needs four' },
		comment: 'The universal gate.',
	});
	const later = record({
		id: 'not',
		selector: { exact: 'NOT gate', prefix: 'while a ', suffix: ' needs two' },
		comment: 'Two transistors.',
	});

	it('does nothing at all in off mode', () => {
		const plan = planAnnotations(note(), 'off', [highlight]);
		expect(plan.placements).toEqual([]);
		expect(plan.notes).toEqual([]);
	});

	// A profile with annotations enabled applied to a note that has none is ordinary.
	it('is a silent no-op on a note with no records', () => {
		const plan = planAnnotations(note(), 'endnotes', []);
		expect(plan.notes).toEqual([]);
		expect(plan.unmatched).toEqual([]);
	});

	it('numbers the notes by position in the text, not by record order', () => {
		const plan = planAnnotations(note(), 'endnotes', [later, highlight]);
		expect(plan.notes.map((entry) => [entry.number, entry.quote])).toEqual([
			[1, 'NAND gate'],
			[2, 'NOT gate'],
		]);
	});

	it('carries the category and author onto the printed note', () => {
		const plan = planAnnotations(note(), 'endnotes', [highlight]);
		expect(plan.notes[0]).toEqual({
			number: 1,
			quote: 'NAND gate',
			comment: 'The universal gate.',
			category: 'Define',
			author: 'Josh',
		});
	});

	it('places a highlight over the text node that holds it', () => {
		const plan = planAnnotations(note(), 'endnotes', [highlight]);
		const placement = plan.placements[0];
		expect(placement?.wraps).toHaveLength(1);
		expect(placement?.wraps[0]?.from).toBe(2);
		expect(placement?.wraps[0]?.to).toBe(11);
	});

	// A bare highlight is fully expressed by being highlighted; a number pointing at nothing
	// is worse than no number.
	it('gives a highlight with no comment no number and no note', () => {
		const bare = record({ selector: { exact: 'NAND gate', prefix: 'A ', suffix: ' needs four' } });
		const plan = planAnnotations(note(), 'endnotes', [bare]);
		expect(plan.placements[0]?.number).toBe(0);
		expect(plan.notes).toEqual([]);
	});

	it('reports what it could not place rather than dropping it', () => {
		const gone = record({
			id: 'gone',
			selector: { exact: 'an entire paragraph that no longer exists', prefix: 'x', suffix: 'y' },
			comment: 'orphan',
		});
		const plan = planAnnotations(note(), 'endnotes', [gone]);
		expect(plan.placements).toEqual([]);
		expect(plan.unmatched.map((entry) => entry.id)).toEqual(['gone']);
	});

	// The mode is carried through untouched: it is the profile's decision, and this function
	// is not allowed to have an opinion about it.
	it('carries the mode through to the plan', () => {
		expect(planAnnotations(note(), 'gutter', [highlight]).mode).toBe('gutter');
	});
});
