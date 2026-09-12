import { MarkdownRenderer } from 'obsidian';
import type { App, Component, TFile } from 'obsidian';
import { computeBoardLayout, extractSceneSource, isExcalidrawNote, parseExcalidrawScene } from '../core/excalidraw';

/**
 * Rendering an Excalidraw canvas note as a printable board.
 *
 * See `core/excalidraw.ts` for why this exists at all: the scene lives in a compressed blob
 * `MarkdownRenderer` never sees, and the boards actually in use are live iframe embeds of
 * other notes rather than drawn artwork. This lays each embedded note's own rendered content
 * into a box positioned where its canvas element was, recursing through the same renderer
 * used for the rest of the export so citations, images and callouts inside an embedded note
 * still work.
 *
 * Sizing is deliberately natural, not clipped: the board container gets the canvas's own
 * pixel dimensions as a *minimum*, and each box's height is a minimum too, so a note whose
 * rendered content is taller than its canvas box simply grows the box rather than losing
 * text. Whatever the result's overall size, the profile's own "fit to page" measures the
 * finished pages and scales them down like it would an oversized table or image — this
 * module has no scaling logic of its own to duplicate that with.
 */

const BOARD_CLASS = 'mx-excalidraw-board';
const BOX_CLASS = 'mx-excalidraw-box';
const PLACEHOLDER_CLASS = 'mx-excalidraw-placeholder';

export async function renderExcalidrawBoard(
	app: App,
	file: TFile,
	markdown: string,
	container: HTMLElement,
	component: Component,
	ancestors: ReadonlySet<string>,
): Promise<void> {
	const source = extractSceneSource(markdown);
	if (source === null) {
		placeholder(container, 'This Excalidraw drawing has no scene data to render.');
		return;
	}

	let layout: ReturnType<typeof computeBoardLayout>;
	try {
		layout = computeBoardLayout(parseExcalidrawScene(source));
	} catch (error) {
		placeholder(container, `This Excalidraw drawing could not be read: ${errorMessage(error)}`);
		return;
	}

	if (layout.boxes.length === 0) {
		placeholder(container, 'This Excalidraw drawing has no embedded notes to render.');
		return;
	}

	const board = container.createDiv({ cls: BOARD_CLASS });
	board.style.width = `${layout.width}px`;
	board.style.minHeight = `${layout.height}px`;

	for (const box of layout.boxes) {
		const boxEl = board.createDiv({ cls: BOX_CLASS });
		boxEl.style.left = `${box.x}px`;
		boxEl.style.top = `${box.y}px`;
		boxEl.style.width = `${box.width}px`;
		boxEl.style.minHeight = `${box.height}px`;
		await renderBoxContent(app, file, box.linkTarget, boxEl, component, ancestors);
	}
}

async function renderBoxContent(
	app: App,
	file: TFile,
	linkTarget: string | null,
	boxEl: HTMLElement,
	component: Component,
	ancestors: ReadonlySet<string>,
): Promise<void> {
	if (linkTarget === null) {
		placeholder(boxEl, '(not a note embed)');
		return;
	}

	const target = app.metadataCache.getFirstLinkpathDest(linkTarget, file.path);
	if (target === null) {
		placeholder(boxEl, `Missing note: ${linkTarget}`);
		return;
	}

	if (ancestors.has(target.path)) {
		placeholder(boxEl, `Circular embed skipped: ${linkTarget}`);
		return;
	}

	const targetMarkdown = await app.vault.cachedRead(target);
	const targetFrontmatter = app.metadataCache.getFileCache(target)?.frontmatter;
	const nextAncestors = new Set(ancestors);
	nextAncestors.add(target.path);

	if (isExcalidrawNote(targetFrontmatter)) {
		await renderExcalidrawBoard(app, target, targetMarkdown, boxEl, component, nextAncestors);
		return;
	}

	await MarkdownRenderer.render(app, targetMarkdown, boxEl, target.path, component);
}

function placeholder(container: HTMLElement, text: string): void {
	container.createEl('p', { cls: PLACEHOLDER_CLASS, text });
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
