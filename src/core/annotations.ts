import { toArray } from './dom';
import type { ElementLike, RootLike } from './dom';
import type { AnnotationMode } from './types';

/**
 * `md-annotation` compatibility.
 *
 * The **profile's `annotationMode` flag is authoritative**. The rendered DOM supplies the
 * annotation *content* and nothing else — it never decides whether comments belong in the
 * margin or at the end of the document. That keeps the behaviour a property of the export,
 * reproducible from settings alone, rather than a property of whatever the sidebar happened
 * to be showing when the export ran.
 *
 * The class names themselves are an undocumented-by-contract coupling to another plugin, so
 * they are injected rather than hard-coded here — the concrete table lives in
 * `src/adapter/md-annotation.ts`.
 */

export interface AnnotationClassNames {
	/** Container that holds the gutter cards. */
	host: string;
	/** A single annotation card. */
	card: string;
	/** The card's body text. */
	text: string;
	/** The card's number/marker. */
	number: string;
	/** Cards hidden in the editor; still exported, because "hidden" is a UI state. */
	hidden: string;
	/** Leader line connecting a card to its anchor. Never wanted in print. */
	leader: string;
	/** Marker in the body text that anchors a card. */
	tick: string;
}

export interface Endnote {
	/** 1-based number as it will be printed. */
	number: number;
	/** Plain text of the annotation. */
	text: string;
	/** The source card element, so the shell can read richer content if it wants to. */
	source: ElementLike;
}

export interface AnnotationPlan {
	mode: AnnotationMode;
	/** Keep the gutter host in the paginated DOM and let CSS place it in the page margin. */
	keepGutters: boolean;
	/** Remove the gutter host (and leaders) before pagination. */
	removeGutters: boolean;
	/** Endnotes to append, in document order. Empty unless `mode` is `endnotes`. */
	endnotes: Endnote[];
	/** Elements the shell should drop outright — leader lines never print well. */
	removals: ElementLike[];
	/**
	 * True when `mode` is `gutter` but the document has no gutter host. This is a **silent
	 * no-op, not an error**: a profile with gutters enabled applied to a note that has no
	 * annotations is an ordinary thing to do.
	 */
	noGutterHost: boolean;
}

/**
 * Decide what happens to a document's annotations.
 *
 * Returns a plan rather than mutating: the decision is pure and testable against a mock
 * tree, and the shell performs the DOM surgery.
 */
export function planAnnotations(
	root: RootLike,
	mode: AnnotationMode,
	classes: AnnotationClassNames,
): AnnotationPlan {
	const hosts = toArray(root.querySelectorAll(`.${classes.host}`));
	const leaders = toArray(root.querySelectorAll(`.${classes.leader}`));

	if (mode === 'off') {
		return {
			mode,
			keepGutters: false,
			removeGutters: true,
			endnotes: [],
			removals: [...hosts, ...leaders, ...toArray(root.querySelectorAll(`.${classes.tick}`))],
			noGutterHost: hosts.length === 0,
		};
	}

	if (mode === 'gutter') {
		return {
			mode,
			keepGutters: hosts.length > 0,
			removeGutters: false,
			endnotes: [],
			// Leader lines are a live-editor affordance; they have no meaning on paper.
			removals: leaders,
			noGutterHost: hosts.length === 0,
		};
	}

	const endnotes: Endnote[] = [];
	for (const card of toArray(root.querySelectorAll(`.${classes.card}`))) {
		const text = annotationText(card, classes);
		if (text === '') continue;
		endnotes.push({ number: endnotes.length + 1, text, source: card });
	}

	return {
		mode,
		keepGutters: false,
		removeGutters: true,
		endnotes,
		removals: [...hosts, ...leaders],
		noGutterHost: hosts.length === 0,
	};
}

/**
 * Text of one annotation card. Prefers the card's dedicated text element so the card's
 * number marker does not end up duplicated inside the endnote body.
 */
function annotationText(card: ElementLike, classes: AnnotationClassNames): string {
	const body = toArray(card.querySelectorAll(`.${classes.text}`))[0];
	const target = body ?? card;
	return (target.textContent ?? '').replace(/\s+/g, ' ').trim();
}
