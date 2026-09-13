import { Component, MarkdownRenderer, TFile } from 'obsidian';
import type { App } from 'obsidian';
import { isExcalidrawNote } from '../core/excalidraw';
import type { DocumentRenderer, RenderedNote } from '../core/pipeline';
import { waitForDomStability } from './dom-stability';
import { renderExcalidrawBoard } from './excalidraw-render';

/**
 * Rendering a note to DOM with Obsidian's own renderer.
 *
 * This is the whole reason the plugin exists: Pandoc parses markdown text and so can never
 * see DataviewJS output, and Obsidian's own export does not paginate. Rendering through
 * `MarkdownRenderer` means every plugin that contributes to a rendered note — Dataview,
 * Datacore, Mermaid, callouts, `md-annotation` gutters — contributes to the export too.
 */

const RENDER_HOST_CLASS = 'mx-render-host';

export class ObsidianDocumentRenderer implements DocumentRenderer {
	private readonly components = new WeakMap<object, Component>();

	constructor(
		private readonly app: App,
		private readonly host: HTMLElement,
	) {}

	async render(sourcePath: string): Promise<RenderedNote> {
		const file = this.app.vault.getAbstractFileByPath(sourcePath);
		if (!(file instanceof TFile)) throw new Error(`Not a note: ${sourcePath}`);

		const container = this.host.createDiv({ cls: RENDER_HOST_CLASS });
		const component = new Component();
		component.load();

		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (isExcalidrawNote(file.path, frontmatter)) {
			// An .excalidraw.md file's own markdown is just the plugin's save-format scaffold;
			// the canvas it actually draws is rendered by Excalidraw's own API instead. See
			// `core/excalidraw.ts` for why this note type needs its own path.
			await renderExcalidrawBoard(this.app, file, container, component, new Set([sourcePath]));
		} else {
			const markdown = await this.app.vault.cachedRead(file);
			await MarkdownRenderer.render(this.app, markdown, container, sourcePath, component);
		}
		// Dataview and Datacore render asynchronously and reactively, so the DOM is not
		// finished when `render` resolves. Poll for stability rather than sleeping a fixed
		// two seconds: a plain note settles in one poll, and a slow one is still correct.
		await waitForDomStability(container);

		const cssClasses = normalizeCssClasses(frontmatter?.['cssclasses'] ?? frontmatter?.['cssclass']);
		const note: RenderedNote = {
			sourcePath,
			title: file.basename,
			root: container,
			...(cssClasses.length === 0 ? {} : { cssClasses }),
		};
		this.components.set(note, component);
		return note;
	}

	release(note: RenderedNote): void {
		const component = this.components.get(note);
		if (component !== undefined) {
			component.unload();
			this.components.delete(note);
		}
		const root = note.root as unknown as HTMLElement;
		root.detach?.();
	}
}

/**
 * `cssclasses` frontmatter, however the user wrote it: a single string, a list of strings, or
 * a string with more than one class in it — Obsidian's own reading view accepts all three.
 */
export function normalizeCssClasses(value: unknown): string[] {
	const entries = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
	const classes: string[] = [];
	for (const entry of entries) {
		if (typeof entry !== 'string') continue;
		for (const token of entry.split(/\s+/)) {
			if (token !== '') classes.push(token);
		}
	}
	return classes;
}
