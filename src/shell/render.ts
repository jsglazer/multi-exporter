import { Component, MarkdownRenderer, TFile } from 'obsidian';
import type { App } from 'obsidian';
import type { DocumentRenderer, RenderedNote } from '../core/pipeline';

/**
 * Rendering a note to DOM with Obsidian's own renderer.
 *
 * This is the whole reason the plugin exists: Pandoc parses markdown text and so can never
 * see DataviewJS output, and Obsidian's own export does not paginate. Rendering through
 * `MarkdownRenderer` means every plugin that contributes to a rendered note — Dataview,
 * Datacore, Mermaid, callouts, `md-annotation` gutters — contributes to the export too.
 */

const RENDER_HOST_CLASS = 'mx-render-host';

/** Interval between DOM-stability samples while waiting for async renderers to settle. */
const STABILITY_POLL_MS = 60;
/** Consecutive unchanged samples required before a document is considered settled. */
const STABILITY_SAMPLES = 3;
/** Hard ceiling, so a permanently-reactive Datacore view cannot hang an export. */
const STABILITY_TIMEOUT_MS = 15000;

export class ObsidianDocumentRenderer implements DocumentRenderer {
	private readonly components = new WeakMap<object, Component>();

	constructor(
		private readonly app: App,
		private readonly host: HTMLElement,
	) {}

	async render(sourcePath: string): Promise<RenderedNote> {
		const file = this.app.vault.getAbstractFileByPath(sourcePath);
		if (!(file instanceof TFile)) throw new Error(`Not a note: ${sourcePath}`);

		const markdown = await this.app.vault.cachedRead(file);
		const container = this.host.createDiv({ cls: RENDER_HOST_CLASS });
		const component = new Component();
		component.load();

		await MarkdownRenderer.render(this.app, markdown, container, sourcePath, component);
		// Dataview and Datacore render asynchronously and reactively, so the DOM is not
		// finished when `render` resolves. Poll for stability rather than sleeping a fixed
		// two seconds: a plain note settles in one poll, and a slow one is still correct.
		await waitForDomStability(container);

		const note: RenderedNote = { sourcePath, title: file.basename, root: container };
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
 * Wait until a subtree stops changing.
 *
 * Measured by HTML length and node count rather than by a `MutationObserver`, which would
 * have to be torn down on every path out and is one more live handle to leak. Sampling is
 * cheap here because it runs once per note, not once per keystroke.
 */
export async function waitForDomStability(
	element: HTMLElement,
	options: { pollMs?: number; samples?: number; timeoutMs?: number } = {},
): Promise<void> {
	const pollMs = options.pollMs ?? STABILITY_POLL_MS;
	const required = options.samples ?? STABILITY_SAMPLES;
	const timeoutMs = options.timeoutMs ?? STABILITY_TIMEOUT_MS;

	const started = Date.now();
	let previous = signature(element);
	let stable = 0;

	while (stable < required) {
		if (Date.now() - started > timeoutMs) return;
		await sleep(pollMs);
		const current = signature(element);
		if (current === previous) {
			stable++;
		} else {
			stable = 0;
			previous = current;
		}
	}
}

function signature(element: HTMLElement): string {
	return `${element.innerHTML.length}:${element.querySelectorAll('*').length}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}
