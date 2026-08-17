import { sanitizeHTMLToDom } from 'obsidian';
import type { Endnote } from '../core/annotations';
import type { CitationLinkMatch } from '../core/citations';
import type { ElementLike } from '../core/dom';
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

	appendEndnotes(note: RenderedNote, endnotes: readonly Endnote[]): void {
		const root = note.root as unknown as HTMLElement;
		const section = root.createDiv({ cls: ENDNOTES_CLASS });
		section.createEl('h2', { text: 'Notes' });
		const list = section.createEl('ol');
		for (const endnote of endnotes) {
			list.createEl('li', { text: endnote.text });
		}
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
