import { sanitizeHTMLToDom } from 'obsidian';
import type {
	AnnotationCategoryColors,
	AnnotationPlacement,
	AnnotationPlan,
	AnnotationStripPlan,
} from '../core/annotations';
import type { CitationLinkMatch } from '../core/citations';
import type { ElementLike, NodeLike } from '../core/dom';
import type { ImageSubstitution } from '../core/image-inline';
import type { DocumentTransforms, RenderedNote } from '../core/pipeline';

/**
 * The DOM surgery half of the pipeline.
 *
 * Core decides *what* should change and produces a plan; this applies it to the real DOM.
 * Splitting it this way is what lets every decision be unit-tested against a mock tree
 * while the mutation stays a handful of obvious lines.
 */

export const CITATION_CLASS = 'mx-citation';
export const BIBLIOGRAPHY_CLASS = 'mx-bibliography';
export const ENDNOTES_CLASS = 'mx-endnotes';
export const FAILED_IMAGE_CLASS = 'mx-image-failed';

/** Print markup for annotations. Ours, not `md-annotation`'s — see `core/annotations.ts`. */
export const ANNOTATION_CLASS = 'mx-annotation';
export const ANNOTATION_MARKER_CLASS = 'mx-annotation-marker';
export const ANNOTATION_CARD_CLASS = 'mx-annotation-card';

export class DomTransforms implements DocumentTransforms {
	applyImageSubstitutions(_note: RenderedNote, substitutions: readonly ImageSubstitution[]): void {
		for (const substitution of substitutions) {
			const image = substitution.element as unknown as HTMLImageElement;
			image.setAttribute('data-mx-original-src', substitution.originalSrc);
			image.setAttribute('src', substitution.dataUri);
			if (substitution.failed) image.addClass(FAILED_IMAGE_CLASS);
		}
	}

	/**
	 * Mark a matched link as a citation and strip its navigation affordances.
	 *
	 * The link text is left exactly as it was: `zotero-manager` owns citation formatting,
	 * and rewriting the visible text here would be a second citation engine by the back
	 * door — the one thing the non-goals rule out.
	 */
	markCitations(_note: RenderedNote, links: readonly CitationLinkMatch[]): void {
		for (const link of links) {
			const anchor = link.element as unknown as HTMLElement;
			anchor.addClass(CITATION_CLASS);
			anchor.setAttribute('data-mx-citekey', link.citeKey);
			anchor.removeAttribute('href');
		}
	}

	removeElements(_note: RenderedNote, elements: readonly ElementLike[]): void {
		for (const element of elements) {
			(element as unknown as HTMLElement).detach();
		}
	}

	/**
	 * Take `md-annotation`'s own rendered markup back out.
	 *
	 * Unwrapping rather than removing is the whole point for highlight spans: the words
	 * inside them are the note's, and detaching the span would delete a sentence. `normalize()`
	 * afterwards re-joins the text nodes the unwrap leaves adjacent, so the annotation matcher
	 * sees one run of text where the reader sees one run of text.
	 */
	stripPluginAnnotations(note: RenderedNote, plan: AnnotationStripPlan): void {
		for (const element of plan.remove) (element as unknown as HTMLElement).detach();
		for (const element of plan.unwrap) {
			const span = element as unknown as HTMLElement;
			const parent = span.parentNode;
			if (parent === null) continue;
			while (span.firstChild !== null) parent.insertBefore(span.firstChild, span);
			parent.removeChild(span);
		}
		(note.root as unknown as HTMLElement).normalize();
	}

	/**
	 * Draw the annotations the plan located.
	 *
	 * Every text node is rebuilt **once**, from all the operations that touch it, rather than
	 * being split per annotation. Splitting a text node renumbers every offset after the cut,
	 * so a second annotation in the same paragraph would land at the wrong character — and
	 * two annotations in one paragraph is the ordinary case, not the exotic one.
	 */
	applyAnnotations(note: RenderedNote, plan: AnnotationPlan, colors: AnnotationCategoryColors): void {
		if (plan.mode === 'off') return;

		const byNode = new Map<Text, NodeOp[]>();
		const push = (node: NodeLike, op: NodeOp): void => {
			const text = node as unknown as Text;
			const list = byNode.get(text);
			if (list === undefined) byNode.set(text, [op]);
			else list.push(op);
		};

		for (const placement of plan.placements) {
			for (const wrap of placement.wraps) {
				push(wrap.node, { kind: 'wrap', from: wrap.from, to: wrap.to, placement });
			}
			// Only an annotation that prints a note gets a marker: a bare highlight has
			// nothing at the other end for a number to point at.
			if (placement.number > 0 && placement.caret !== null) {
				push(placement.caret.node, { kind: 'marker', at: placement.caret.offset, placement });
			}
		}

		for (const [node, ops] of byNode) rebuildTextNode(node, ops, plan, colors);

		if (plan.mode === 'endnotes' && plan.notes.length > 0) appendEndnotes(note, plan);
	}

	/**
	 * Insert the bibliography `zotero-manager` produced.
	 *
	 * This is *rendered CSL output* — the italics, hanging indents and punctuation are the
	 * payload, so it cannot be inserted as text. It goes through `sanitizeHTMLToDom` rather
	 * than `innerHTML`: the markup crosses a plugin boundary and then a webview boundary, and
	 * parsing it into a sanitised fragment costs nothing.
	 */
	appendBibliography(note: RenderedNote, html: string): void {
		const root = note.root as unknown as HTMLElement;
		const section = root.createDiv({ cls: BIBLIOGRAPHY_CLASS });
		section.createEl('h2', { text: 'Bibliography' });
		section.createDiv().appendChild(sanitizeHTMLToDom(html));
	}

	serialize(note: RenderedNote): string {
		return (note.root as unknown as HTMLElement).innerHTML;
	}
}

/* ------------------------------------------------------------------ annotation DOM -- */

type NodeOp =
	| { kind: 'wrap'; from: number; to: number; placement: AnnotationPlacement }
	| { kind: 'marker'; at: number; placement: AnnotationPlacement };

/**
 * Replace one text node with the highlighted, marked-up version of the same text.
 *
 * Overlapping highlights are clipped rather than nested: two annotations covering the same
 * words is a real thing to do in the editor, but nesting the spans on paper produces a
 * doubled background nobody chose, and the second colour would win by accident of ordering.
 * The earlier annotation keeps the overlap.
 */
function rebuildTextNode(
	node: Text,
	ops: readonly NodeOp[],
	plan: AnnotationPlan,
	colors: AnnotationCategoryColors,
): void {
	const parent = node.parentNode;
	if (parent === null) return;
	const text = node.nodeValue ?? '';

	const wraps = ops
		.filter((op): op is Extract<NodeOp, { kind: 'wrap' }> => op.kind === 'wrap')
		.sort((a, b) => a.from - b.from);
	const markers = ops
		.filter((op): op is Extract<NodeOp, { kind: 'marker' }> => op.kind === 'marker')
		.sort((a, b) => a.at - b.at);

	const document = node.ownerDocument;
	const fragment = document.createDocumentFragment();
	let cursor = 0;
	let markerIndex = 0;

	const emitMarkersUpTo = (position: number): void => {
		while (markerIndex < markers.length) {
			const marker = markers[markerIndex];
			if (marker === undefined || marker.at > position) break;
			if (marker.at > cursor) {
				fragment.appendChild(document.createTextNode(text.slice(cursor, marker.at)));
				cursor = marker.at;
			}
			fragment.appendChild(buildMarker(document, marker.placement, plan.mode));
			markerIndex++;
		}
	};

	for (const wrap of wraps) {
		const from = Math.max(wrap.from, cursor);
		const to = Math.max(from, wrap.to);
		if (to <= from) continue;
		emitMarkersUpTo(from);
		if (from > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, from)));
		const span = document.createElement('span');
		applyAnnotationStyle(span, wrap.placement, colors);
		span.appendChild(document.createTextNode(text.slice(from, to)));
		fragment.appendChild(span);
		cursor = to;
	}

	emitMarkersUpTo(text.length);
	if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));

	parent.replaceChild(fragment, node);
}

/** Class list, category attribute and print colours for one highlight span. */
function applyAnnotationStyle(
	span: HTMLElement,
	placement: AnnotationPlacement,
	colors: AnnotationCategoryColors,
): void {
	const record = placement.annotation;
	span.addClass(ANNOTATION_CLASS);
	if (record.category !== '') {
		span.addClass(`${ANNOTATION_CLASS}-cat-${slug(record.category)}`);
		span.setAttribute('data-mx-category', record.category);
	}
	span.setAttribute('data-mx-annotation-id', record.id);
	if (placement.number > 0) span.setAttribute('data-mx-note', String(placement.number));

	// The colour is an inline style rather than a generated stylesheet: a category name is
	// arbitrary user text, and building a selector out of it is how a stylesheet acquires an
	// injection surface. A profile stylesheet can still override it — `!important` on
	// `.mx-annotation` wins over an inline declaration.
	const color = colors[record.category];
	if (color?.background !== undefined) span.style.setProperty('background-color', color.background);
	if (color?.foreground !== undefined) span.style.setProperty('color', color.foreground);
}

/**
 * The number in the text, and — in gutter mode — the card it refers to.
 *
 * Both are phrasing content on purpose. The serialised HTML is re-parsed inside the guest
 * webview, and an `<aside>` or a `<div>` inside a `<p>` is hoisted out of it by the HTML
 * parser, which silently moves every card to the end of the paragraph it belonged to. A
 * `<span>` with `display: block` survives the round trip and floats where the CSS puts it.
 */
function buildMarker(document: Document, placement: AnnotationPlacement, mode: AnnotationPlan['mode']): Node {
	const record = placement.annotation;
	const marker = document.createElement('sup');
	marker.addClass(ANNOTATION_MARKER_CLASS);
	marker.setAttribute('data-mx-annotation-id', record.id);
	marker.appendChild(document.createTextNode(String(placement.number)));
	if (mode !== 'gutter') return marker;

	const holder = document.createDocumentFragment();
	holder.appendChild(marker);
	const card = document.createElement('span');
	card.addClass(ANNOTATION_CARD_CLASS);
	if (record.category !== '') card.setAttribute('data-mx-category', record.category);
	const number = document.createElement('span');
	number.addClass(`${ANNOTATION_CARD_CLASS}-num`);
	number.appendChild(document.createTextNode(String(placement.number)));
	card.appendChild(number);
	const body = document.createElement('span');
	body.addClass(`${ANNOTATION_CARD_CLASS}-text`);
	body.appendChild(document.createTextNode(record.comment));
	card.appendChild(body);
	holder.appendChild(card);
	return holder;
}

/** The endnote list, appended once, after everything the note itself contains. */
function appendEndnotes(note: RenderedNote, plan: AnnotationPlan): void {
	const root = note.root as unknown as HTMLElement;
	const section = root.createDiv({ cls: ENDNOTES_CLASS });
	section.createEl('h2', { text: 'Notes' });
	const list = section.createEl('ol');
	for (const entry of plan.notes) {
		const item = list.createEl('li');
		item.setAttribute('value', String(entry.number));
		if (entry.quote !== '') {
			item.createEl('span', { cls: `${ENDNOTES_CLASS}-quote`, text: entry.quote });
		}
		item.createEl('span', { cls: `${ENDNOTES_CLASS}-comment`, text: entry.comment });
	}
}

/** A category name reduced to something usable as a class-name suffix. */
function slug(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'unnamed'
	);
}
