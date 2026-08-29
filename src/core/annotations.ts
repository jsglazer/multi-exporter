import { flattenText, locate, runForCaret, runsForRange } from './annotation-match';
import type { TextQuoteSelector } from './annotation-match';
import { toArray } from './dom';
import type { ElementLike, NodeLike, RootLike } from './dom';
import type { AnnotationMode } from './types';

/**
 * `md-annotation` compatibility.
 *
 * The **profile's `annotationMode` flag is authoritative**. It decides whether comments go
 * in the margin, at the end of the document, or nowhere; nothing about the rendered page or
 * about `md-annotation`'s own visibility toggles may change the answer. That keeps the
 * behaviour a property of the export, reproducible from settings alone, rather than a
 * property of whatever the sidebar happened to be showing when the export ran.
 *
 * ## Why this reads records rather than the page
 *
 * The first version of this file scraped `md-annotation`'s gutter cards out of the rendered
 * DOM. That could never have worked, at any class name. The gutter is not
 * markdown-post-processor output: `md-annotation` mounts it on the live view's `scrollDOM`
 * and its card body is a `<textarea>` — an editable control, not print content. This plugin
 * renders through `MarkdownRenderer.render()` into a **detached** container, where there is
 * no view, no `scrollDOM`, and therefore no gutter and no cards, ever.
 *
 * So the content comes from `md-annotation`'s public API instead — the same lazily-resolved,
 * version-gated arrangement as `zotero-manager`'s — and the *positions*, which the API does
 * not return, are recovered by `annotation-match.ts`. Everything here stays pure: it takes
 * records plus a tree and returns a plan, and the shell performs the surgery.
 */

export type AnnotationType = 'highlight' | 'comment';

/**
 * A category's print colours.
 *
 * Declared here rather than in the adapter because the *shape* is this plugin's — a
 * foreground and a background, either of which may be absent — while where the values come
 * from is the adapter's business. Core never learns that they were read out of another
 * plugin's settings file.
 */
export interface AnnotationCategoryColor {
	foreground?: string;
	background?: string;
}

/** Category name -> its colours. An unknown category simply has no entry. */
export type AnnotationCategoryColors = Record<string, AnnotationCategoryColor>;

/**
 * One record as `md-annotation`'s API returns it, narrowed to what an export uses.
 *
 * `category` is the v1.0.20 spelling; the API still emits the old `format` alongside it, and
 * the shell's gate accepts either — see `shell/md-annotation.ts`.
 */
export interface AnnotationRecord {
	id: string;
	type: AnnotationType;
	category: string;
	selector: TextQuoteSelector;
	comment: string;
	author: string;
	status: 'open' | 'closed';
}

/** One text node slice to wrap in a highlight span. */
export interface AnnotationWrap {
	node: NodeLike;
	from: number;
	to: number;
}

/** Where a marker or gutter tick is inserted: inside a text node, at an offset. */
export interface AnnotationCaret {
	node: NodeLike;
	offset: number;
}

export interface AnnotationPlacement {
	annotation: AnnotationRecord;
	/**
	 * 1-based number as it will be printed, or `0` when this annotation prints no note.
	 *
	 * A highlight with no comment is a highlight and nothing more: it is coloured, and it
	 * gets neither a marker nor an endnote, because there would be nothing at the other end.
	 */
	number: number;
	/** Slices to wrap. Empty for a point comment, which highlights nothing. */
	wraps: AnnotationWrap[];
	/** Insertion point for the marker. `null` only when the tree had no usable text node. */
	caret: AnnotationCaret | null;
	/** Position in the flattened note text; the sort key that numbers the notes. */
	at: number;
	confidence: number;
}

/** One printed note — an endnote entry or a gutter card. */
export interface AnnotationNote {
	number: number;
	/** The annotated words, for a note that quotes what it refers to. `''` for a comment. */
	quote: string;
	comment: string;
	category: string;
	author: string;
}

export interface AnnotationPlan {
	mode: AnnotationMode;
	/** Every annotation that could be placed, in document order. */
	placements: AnnotationPlacement[];
	/** Notes to print, in document order. Empty when `mode` is `off`. */
	notes: AnnotationNote[];
	/** Records that could not be located in the rendered note. Reported, never dropped. */
	unmatched: AnnotationRecord[];
}

/**
 * What `md-annotation`'s own reading-view post-processor left in the rendered DOM.
 *
 * Its output is stripped and re-made from the records rather than reused, because every one
 * of its draw branches is gated on `md-annotation`'s live settings —
 * `annotationFormattingEnabled`, `commentsHiddenEnabled`, `gutterAnnotationsEnabled` — and
 * an export that changes with a sidebar toggle is exactly what `annotationMode` exists to
 * prevent.
 */
export interface AnnotationStripClasses {
	/** Spans wrapping note text: unwrapped, because the text inside them is the note's. */
	unwrap: readonly string[];
	/** Elements the other plugin created outright: removed, content and all. */
	remove: readonly string[];
}

export interface AnnotationStripPlan {
	unwrap: ElementLike[];
	remove: ElementLike[];
}

/**
 * Find another plugin's rendered annotation markup, so the shell can take it out.
 *
 * Runs **before** `planAnnotations`: the flattened text has to be the note's own text, and a
 * marker's digit sitting in the middle of a sentence would shift every offset after it.
 */
export function planAnnotationStrip(root: RootLike, classes: AnnotationStripClasses): AnnotationStripPlan {
	const collect = (names: readonly string[]): ElementLike[] => {
		const seen = new Set<ElementLike>();
		for (const name of names) {
			for (const element of toArray(root.querySelectorAll(`.${name}`))) seen.add(element);
		}
		return [...seen];
	};
	const remove = collect(classes.remove);
	const removeSet = new Set(remove);
	// An element listed for removal is not also unwrapped: it is going away whole.
	return { unwrap: collect(classes.unwrap).filter((element) => !removeSet.has(element)), remove };
}

/**
 * Decide what happens to a note's annotations.
 *
 * Returns a plan rather than mutating: the decision is pure and testable against records and
 * a mock tree, and the shell performs the DOM surgery.
 *
 * A profile with annotations enabled applied to a note that has none is an ordinary thing to
 * do and is a silent no-op — an empty plan, no empty endnotes section, no warning.
 */
export function planAnnotations(
	root: RootLike & NodeLike,
	mode: AnnotationMode,
	records: readonly AnnotationRecord[],
	skipClasses: readonly string[] = [],
): AnnotationPlan {
	if (mode === 'off' || records.length === 0) {
		return { mode, placements: [], notes: [], unmatched: [] };
	}

	const flat = flattenText(root, skipClasses);
	const placements: AnnotationPlacement[] = [];
	const unmatched: AnnotationRecord[] = [];

	for (const record of records) {
		const found = locate(flat.text, record.selector);
		if (found === null) {
			unmatched.push(record);
			continue;
		}
		const wraps = found.end > found.start ? runsForRange(flat, found.start, found.end) : [];
		const caret = runForCaret(flat, found.end);
		if (wraps.length === 0 && caret === null) {
			unmatched.push(record);
			continue;
		}
		placements.push({
			annotation: record,
			number: 0,
			wraps: wraps.map((run) => ({ node: run.node, from: run.from, to: run.to })),
			caret,
			at: found.start,
			confidence: found.confidence,
		});
	}

	// Document order is what numbers the notes, and it is the order of the *text*, not the
	// order the records happen to sit in the note's `%%md-annotation` block — those follow
	// creation time, so a comment added last to the first paragraph would otherwise be
	// numbered last.
	placements.sort((a, b) => a.at - b.at);

	const notes: AnnotationNote[] = [];
	for (const placement of placements) {
		const record = placement.annotation;
		// Only an annotation with something to say prints a note. A bare highlight is
		// already fully expressed by being highlighted.
		if (record.comment.trim() === '') continue;
		placement.number = notes.length + 1;
		notes.push({
			number: placement.number,
			quote: record.selector.exact,
			comment: record.comment,
			category: record.category,
			author: record.author,
		});
	}

	return { mode, placements, notes, unmatched };
}
