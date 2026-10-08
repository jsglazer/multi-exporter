import type { App } from 'obsidian';
import { getPluginApi } from '../adapter/obsidian-internals';

/**
 * The `virtual-outliner` hook.
 *
 * An outlined note's entries are `@`/`@@`/… lines whose numbering, indent and typography the
 * outliner draws at view time — nothing is written to disk. Its Reading-view post-processor
 * keys every line off `getSectionInfo`, which `MarkdownRenderer.render` never provides, so
 * rendered here it bails and the raw sigils print. The outliner therefore exposes the same
 * work as two calls: the markdown to render in place of the note's own (sigils swapped for
 * anchors, whatever the note's current view hides dropped), and a pass over the rendered DOM
 * that numbers, indents and styles it — inline, since the guest document carries no plugin
 * stylesheet.
 *
 * Same rules as the other inter-plugin gates: resolved lazily at render time, and anything
 * missing or unrecognisable means the note renders exactly as it would without the outliner.
 */

export const VIRTUAL_OUTLINER_ID = 'virtual-outliner';

/** One note's export, mirrored from `virtual-outliner`'s `src/api.ts`. */
export interface OutlinerExport {
	markdown: string;
	decorate(root: HTMLElement): void;
}

interface VirtualOutlinerApi {
	prepareRenderedExport(path: string, markdown: string): OutlinerExport | null;
}

function asApi(candidate: unknown): VirtualOutlinerApi | null {
	if (candidate === null || typeof candidate !== 'object') return null;
	const api = candidate as Partial<VirtualOutlinerApi>;
	return typeof api.prepareRenderedExport === 'function' ? (api as VirtualOutlinerApi) : null;
}

/**
 * The outliner's export for one note, or `null` when the outliner is absent, too old to offer
 * the hook, or the note has no outline. Never throws: a failure here must not cost the export.
 */
export function prepareOutlinerExport(app: App, sourcePath: string, markdown: string): OutlinerExport | null {
	const api = asApi(getPluginApi(app, VIRTUAL_OUTLINER_ID));
	if (api === null) return null;
	try {
		const prepared = api.prepareRenderedExport(sourcePath, markdown);
		return prepared !== null && typeof prepared.markdown === 'string' && typeof prepared.decorate === 'function'
			? prepared
			: null;
	} catch (error) {
		console.error('multi-exporter: virtual-outliner could not prepare', sourcePath, error);
		return null;
	}
}

/** Number and style the rendered outline. A failure leaves the note as rendered. */
export function decorateOutline(outline: OutlinerExport, root: HTMLElement, sourcePath: string): void {
	try {
		outline.decorate(root);
	} catch (error) {
		console.error('multi-exporter: virtual-outliner could not decorate', sourcePath, error);
	}
}
