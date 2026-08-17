import type { App, Plugin } from 'obsidian';
import type { AnnotationClassNames } from '../core/annotations';

/**
 * **The** adapter for everything undocumented this plugin touches.
 *
 * Nothing outside this file reaches into an Obsidian private object, an Electron
 * `<webview>`, or another plugin's CSS class names. When one of those breaks — and the
 * Electron team has discouraged `<webview>` for years — the fix is confined to this file.
 * `src/core/` never imports it.
 *
 * ## Versions this was written against
 *
 * | Surface | Targeted version | Verified |
 * |---|---|---|
 * | Obsidian | 1.12.7 (`manifest.json` `minAppVersion` 1.7.2) | installed app, 2026-08-17 |
 * | Electron | 39.8.3 | `Electron Framework.framework` `CFBundleVersion` |
 * | Chromium | 142.0.7444.265 | embedded version string |
 * | `zotero-manager` | API `version: 1` (plugin v1.1.9) | `src/api.ts`, read 2026-08-17 |
 * | `md-annotation` | v1.0.13 | `styles.css` class names, read 2026-08-17 |
 *
 * The audit named no Obsidian internal beyond these; in particular it specified no file
 * explorer access, so none is taken.
 */

export const TARGETED_OBSIDIAN_VERSION = '1.12.7';
export const TARGETED_ELECTRON_VERSION = '39.8.3';

/* ------------------------------------------------------------------ plugin registry -- */

/** `App.plugins` is not in `obsidian.d.ts`. This is the only place that shape is asserted. */
interface PluginRegistry {
	enabledPlugins: Set<string>;
	plugins: Record<string, (Plugin & { api?: unknown; settings?: Record<string, unknown> }) | undefined>;
}

function pluginRegistry(app: App): PluginRegistry | null {
	const registry = (app as App & { plugins?: unknown }).plugins;
	if (registry === null || typeof registry !== 'object') return null;
	const candidate = registry as Partial<PluginRegistry>;
	if (typeof candidate.plugins !== 'object' || candidate.plugins === null) return null;
	return candidate as PluginRegistry;
}

export function isPluginEnabled(app: App, pluginId: string): boolean {
	const registry = pluginRegistry(app);
	if (registry === null) return false;
	if (registry.enabledPlugins instanceof Set && !registry.enabledPlugins.has(pluginId)) return false;
	return registry.plugins[pluginId] !== undefined;
}

/**
 * The raw `api` object another plugin exposes, or `null`.
 *
 * Resolved **lazily, at export time** — never in `onload`. Plugin load order is not
 * something either plugin controls, so caching a reference at load would make citation
 * support depend on which plugin Obsidian happened to start first.
 */
export function getPluginApi(app: App, pluginId: string): unknown {
	const registry = pluginRegistry(app);
	if (registry === null) return null;
	if (registry.enabledPlugins instanceof Set && !registry.enabledPlugins.has(pluginId)) return null;
	return registry.plugins[pluginId]?.api ?? null;
}

/** A single setting from another plugin's settings object, when it is a string. */
export function getPluginStringSetting(app: App, pluginId: string, key: string): string | null {
	const registry = pluginRegistry(app);
	const settings = registry?.plugins[pluginId]?.settings;
	if (settings === undefined) return null;
	const value = settings[key];
	return typeof value === 'string' ? value : null;
}

/* --------------------------------------------------------------- md-annotation CSS -- */

/**
 * `md-annotation`'s gutter classes, v1.0.13.
 *
 * A first-party coupling, but an undocumented-by-contract one: these are CSS class names,
 * not an API, so they belong behind this boundary with everything else that can move
 * without warning.
 */
export const MD_ANNOTATION_CLASSES: AnnotationClassNames = {
	host: 'gutter-host',
	card: 'gutter-card',
	text: 'gutter-text',
	number: 'gutter-num',
	hidden: 'gutter-hidden',
	leader: 'gutter-leader',
	tick: 'gutter-tick',
};

/* -------------------------------------------------------------------- save dialogs -- */

/**
 * Electron's file dialogs, reached through the renderer's `remote` bridge.
 *
 * Undocumented from Obsidian's point of view and version-sensitive, hence its presence
 * here. Every entry point returns `null` rather than throwing, so a dialog that cannot be
 * opened cancels the export instead of breaking it.
 */
interface ElectronDialog {
	showSaveDialog(options: SaveDialogOptions): Promise<{ canceled: boolean; filePath?: string }>;
	showOpenDialog(options: OpenDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>;
}

interface ElectronDialogBridge {
	remote?: { dialog?: ElectronDialog };
}

interface SaveDialogOptions {
	title: string;
	defaultPath: string;
	filters: { name: string; extensions: string[] }[];
}

interface OpenDialogOptions {
	title: string;
	defaultPath?: string;
	properties: ('openDirectory' | 'createDirectory')[];
}

function dialogBridge(): ElectronDialog | null {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const electron = require('electron') as ElectronDialogBridge;
		return electron.remote?.dialog ?? null;
	} catch {
		return null;
	}
}

/** Prompt for the merged-export output filename. `null` if cancelled or unavailable. */
export async function showPdfSaveDialog(title: string, defaultPath: string): Promise<string | null> {
	const dialog = dialogBridge();
	if (dialog === null) return null;
	const result = await dialog.showSaveDialog({
		title,
		defaultPath,
		filters: [{ name: 'PDF', extensions: ['pdf'] }],
	});
	return result.canceled || result.filePath === undefined ? null : result.filePath;
}

/** Prompt for an output directory. `null` if cancelled or unavailable. */
export async function showDirectoryDialog(title: string, defaultPath: string): Promise<string | null> {
	const dialog = dialogBridge();
	if (dialog === null) return null;
	const result = await dialog.showOpenDialog({
		title,
		...(defaultPath === '' ? {} : { defaultPath }),
		properties: ['openDirectory', 'createDirectory'],
	});
	return result.canceled ? null : (result.filePaths[0] ?? null);
}

/* ------------------------------------------------------------------------- webview -- */

/**
 * The slice of Electron's `<webview>` tag this plugin uses.
 *
 * Declared locally rather than imported from `electron`: the plugin bundle marks `electron`
 * external, and a hand-written interface makes the exact surface area — five methods —
 * visible at the boundary instead of implied.
 */
export interface WebviewTagLike {
	src: string;
	executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
	printToPDF(options: PrintToPdfOptions): Promise<Uint8Array>;
	getWebContentsId(): number;
	setAttribute(name: string, value: string): void;
	addEventListener(type: 'dom-ready', listener: () => void): void;
	removeEventListener(type: 'dom-ready', listener: () => void): void;
	/** Obsidian's `HTMLElement` extensions, used for off-screen toggling and teardown. */
	toggleClass(classes: string, value: boolean): void;
	detach(): void;
}

export interface PrintToPdfOptions {
	printBackground: boolean;
	preferCSSPageSize: boolean;
	margins: { marginType: 'default' | 'none' | 'printableArea' | 'custom' };
	landscape?: boolean;
	scale?: number;
}

/** Class marking the container; styling lives in `styles.css`. */
export const PREVIEW_CONTAINER_CLASS = 'mx-preview-container';
export const PREVIEW_OFFSCREEN_CLASS = 'mx-preview-offscreen';

export interface PreviewWebview {
	readonly element: WebviewTagLike;
	/** Resolves once the guest page has loaded and can execute script. */
	ready(): Promise<void>;
	run<T>(code: string): Promise<T>;
	printToPdf(options: PrintToPdfOptions): Promise<Uint8Array>;
	/**
	 * Move the container off-screen while keeping real geometry.
	 *
	 * **Never `display: none`.** A collapsed box has no layout, and paged.js computes page
	 * breaks from measured geometry — hiding it that way does not slow pagination down, it
	 * silently produces wrong or zero pages. Off-screen absolute positioning keeps every
	 * measurement real.
	 */
	setOffscreen(offscreen: boolean): void;
	/** Detach and destroy the guest WebContents. Safe to call more than once. */
	destroy(): void;
}

/**
 * Create the one preview webview.
 *
 * A `<webview>` owns its own WebContents, so `printToPDF` prints *that* document. An
 * `<iframe>` does not, which forces printing the main window over IPC and drags in a mutex
 * over `document.title`, per-document `display` toggling, and hiding every sibling — all of
 * it machinery to compensate for the missing WebContents.
 *
 * Exactly one of these exists per modal and it is reused for every note in a bulk export.
 * A live webview holds a renderer process; leaving one attached leaks it and blocks clean
 * plugin removal, so `destroy()` is wired to both modal close and plugin unload.
 */
export function createPreviewWebview(parent: HTMLElement, partition: string): PreviewWebview {
	const element = parent.createEl('webview' as keyof HTMLElementTagNameMap, {
		cls: PREVIEW_CONTAINER_CLASS,
	}) as unknown as WebviewTagLike;

	element.setAttribute('src', 'about:blank');
	element.setAttribute('partition', partition);
	element.setAttribute('nodeintegration', 'off');
	element.setAttribute('webpreferences', 'contextIsolation=no,sandbox=no,javascript=yes');
	element.setAttribute('disableblinkfeatures', 'Auxclick');

	let destroyed = false;
	let readyPromise: Promise<void> | null = null;

	const ready = (): Promise<void> => {
		readyPromise ??= new Promise<void>((resolve) => {
			const onReady = (): void => {
				element.removeEventListener('dom-ready', onReady);
				resolve();
			};
			element.addEventListener('dom-ready', onReady);
		});
		return readyPromise;
	};

	return {
		element,
		ready,
		async run<T>(code: string): Promise<T> {
			if (destroyed) throw new Error('The preview webview has been destroyed.');
			await ready();
			return (await element.executeJavaScript(code)) as T;
		},
		async printToPdf(options: PrintToPdfOptions): Promise<Uint8Array> {
			if (destroyed) throw new Error('The preview webview has been destroyed.');
			await ready();
			return await element.printToPDF(options);
		},
		setOffscreen(offscreen: boolean): void {
			element.toggleClass(PREVIEW_OFFSCREEN_CLASS, offscreen);
		},
		destroy(): void {
			if (destroyed) return;
			destroyed = true;
			element.detach();
		},
	};
}
