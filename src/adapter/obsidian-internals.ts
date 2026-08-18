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
 * here. Obsidian patches `remote` back onto the `electron` module from `@electron/remote`
 * when it is missing, so both spellings are tried before giving up.
 *
 * `null` means **the user cancelled**. A bridge that cannot be reached at all throws
 * `DialogUnavailableError` instead: silently returning `null` there made a broken export
 * indistinguishable from a cancelled one — no file, no error, no clue.
 */
interface ElectronDialog {
	showSaveDialog(options: SaveDialogOptions): Promise<{ canceled: boolean; filePath?: string }>;
	showOpenDialog(options: OpenDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>;
}

interface ElectronDialogBridge {
	remote?: { dialog?: ElectronDialog };
	dialog?: ElectronDialog;
}

/** Raised when Electron's dialog bridge cannot be reached; never raised on cancel. */
export class DialogUnavailableError extends Error {
	constructor() {
		super("Electron's file dialog could not be reached, so there was nowhere to write the export.");
		this.name = 'DialogUnavailableError';
	}
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

function dialogBridge(): ElectronDialog {
	for (const moduleId of ['electron', '@electron/remote']) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const module = require(moduleId) as ElectronDialogBridge;
			const dialog = module.remote?.dialog ?? module.dialog;
			if (dialog !== undefined) return dialog;
		} catch {
			// Try the next spelling; only exhausting both is a failure.
		}
	}
	throw new DialogUnavailableError();
}

/** Prompt for the merged-export output filename. `null` only if the user cancelled. */
export async function showPdfSaveDialog(title: string, defaultPath: string): Promise<string | null> {
	const dialog = dialogBridge();
	const result = await dialog.showSaveDialog({
		title,
		defaultPath,
		filters: [{ name: 'PDF', extensions: ['pdf'] }],
	});
	return result.canceled || result.filePath === undefined ? null : result.filePath;
}

/** Prompt for an output directory. `null` only if the user cancelled. */
export async function showDirectoryDialog(title: string, defaultPath: string): Promise<string | null> {
	const dialog = dialogBridge();
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
	/** False once the guest page has finished loading; absent on a detached element. */
	isLoading?(): boolean;
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

/**
 * Retry a guest call for as long as Electron reports the webview unready.
 *
 * `dom-ready` is the documented signal and it is now subscribed before the element can
 * possibly fire it — but readiness is a fact about the guest WebContents, not about our
 * bookkeeping, and one missed edge used to mean an export that hung forever with nothing
 * thrown. Retrying a call that says "not yet" costs milliseconds and removes that entire
 * failure mode; any other error propagates on the first attempt, unchanged.
 */
async function retryWhileUnready<T>(attempt: () => Promise<T>, destroyed: () => boolean): Promise<T> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	for (;;) {
		try {
			return await attempt();
		} catch (error) {
			if (destroyed() || !isUnreadyError(error) || Date.now() >= deadline) throw error;
			await new Promise<void>((resolve) => window.setTimeout(resolve, RETRY_INTERVAL_MS));
		}
	}
}

/**
 * Run a guest call, and if it rejects, re-raise it saying what the guest actually said.
 *
 * The stack is carried over rather than rebuilt: it points into the injected script, which is
 * where the fault is, and a stack rooted at this line would point at the messenger.
 */
async function unwrapped<T>(attempt: () => Promise<T>): Promise<T> {
	try {
		return await attempt();
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		const message = unwrapGuestError(error.message);
		if (message === error.message) throw error;
		const rethrown = new Error(message);
		if (error.stack !== undefined) rethrown.stack = error.stack;
		throw rethrown;
	}
}

/** Electron's own wording for "the guest is not ready yet". Matched, not guessed at. */
function isUnreadyError(error: unknown): boolean {
	return error instanceof Error && /must be attached to the DOM|dom-ready/i.test(error.message);
}

/**
 * Electron's IPC wrapper around anything a `<webview>` method reports.
 *
 * Every `<webview>` call is routed through the guest view manager, and *any* rejection —
 * including an ordinary exception thrown by the injected script — comes back as
 * `Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: <the real message>`.
 */
const GUEST_CALL_WRAPPER = /^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/;

/**
 * The guest's own error message, with Electron's IPC framing taken off.
 *
 * The framing is noise in every case and actively misleading in one: a stylesheet error
 * thrown by paged.js arrives reading like a failure of Electron's remote-method plumbing,
 * so the one line the user sees names a mechanism that is working fine. Stripping it puts
 * the paginator's own words in front of them.
 */
export function unwrapGuestError(message: string): string {
	return message.replace(GUEST_CALL_WRAPPER, '');
}

/**
 * Phrases Electron uses when the guest WebContents is *gone*.
 *
 * Deliberately narrow, and never the `GUEST_VIEW_MANAGER_CALL` prefix itself. That prefix is
 * on every guest rejection, script exceptions included, so matching it classified a healthy
 * webview as a dead one: the backend destroyed it, re-ran the work, hit the same script
 * error, and reported "the preview process stopped … twice" over an error that had nothing
 * to do with the process. `item doesn't belong to list` was matched for the same reason and
 * is worse — it is csstree's wording from inside paged.js's polisher, not Electron's at all.
 *
 * Failing to recognise a real death costs one honest error message. Mistaking a script error
 * for a death costs the true message and replaces it with a false one, so the doubt goes
 * here.
 */
const GUEST_GONE = /render frame was disposed|WebContents was destroyed|Object has been destroyed|closed or released|missing guest page|Invalid guestInstanceId|guest instance is not attached/i;

/**
 * True when the guest WebContents is *gone*, as opposed to not started yet.
 *
 * Once the guest's renderer process has died — a crash, an out-of-memory kill, a destroy
 * racing an in-flight call — no call on that WebContents can ever succeed, and naming the
 * condition here is what lets the backend rebuild the guest rather than surface Electron's
 * bookkeeping to the user.
 *
 * Distinct from `isUnreadyError`: that one means "not yet", and retrying works. This one
 * means "never again on this WebContents", and only a new one will do.
 */
export function isGuestGoneError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return GUEST_GONE.test(error.message);
}

/** Gap between retries while the guest starts. Short: readiness arrives in milliseconds. */
const RETRY_INTERVAL_MS = 150;

/**
 * How long to wait for the guest page's `dom-ready` before proceeding regardless.
 *
 * Generous by an order of magnitude: an `about:blank` guest is ready in milliseconds.
 */
const READY_TIMEOUT_MS = 15000;

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
	// Built detached and configured *before* it is attached, and `src` is set last.
	// A webview begins navigating the moment it has a src in the document, and after that
	// Electron refuses every session-shaping attribute: "The object has already navigated,
	// so its partition cannot be changed." The old order set `src` first and threw that on
	// every open, leaving the guest in the default session rather than ours.
	const document = parent.ownerDocument;
	const element = document.createElement('webview' as keyof HTMLElementTagNameMap) as unknown as WebviewTagLike;

	element.setAttribute('class', PREVIEW_CONTAINER_CLASS);
	element.setAttribute('partition', partition);
	element.setAttribute('nodeintegration', 'off');
	element.setAttribute('webpreferences', 'contextIsolation=no,sandbox=no,javascript=yes');
	element.setAttribute('disableblinkfeatures', 'Auxclick');
	element.setAttribute('src', 'about:blank');
	parent.appendChild(element as unknown as HTMLElement);

	let destroyed = false;

	/**
	 * Subscribed **here, synchronously at creation** — never lazily on first use.
	 *
	 * `dom-ready` is a one-shot event on an `about:blank` guest and it fires within a few
	 * milliseconds of attachment. A listener added later — after a note has been rendered,
	 * say — misses it, and the promise then never settles: every `run()` and `printToPdf()`
	 * on this webview hangs forever, with no error to report. The export appearing to do
	 * nothing at all, rather than failing, is that race.
	 */
	const readyPromise = new Promise<void>((resolve) => {
		let settled = false;
		const settle = (): void => {
			if (settled) return;
			settled = true;
			element.removeEventListener('dom-ready', onReady);
			window.clearTimeout(timer);
			resolve();
		};
		const onReady = (): void => settle();
		element.addEventListener('dom-ready', onReady);

		// Belt and braces: if the guest had already loaded before this ran, or the event is
		// never delivered at all, fall through rather than hang. `executeJavaScript` then
		// either works or throws a real error, and either beats waiting forever.
		const timer = window.setTimeout(() => {
			console.warn('[multi-exporter] webview dom-ready did not fire within %dms; continuing.', READY_TIMEOUT_MS);
			settle();
		}, READY_TIMEOUT_MS);

		// `isLoading()` throws *this very message* — "The WebView must be attached to the DOM
		// and the dom-ready event emitted before this method can be called" — while the guest
		// is still starting, which is the normal case at creation. That is an answer, not an
		// error: it means "not yet", and the listener above is what will say when.
		try {
			if (element.isLoading?.() === false) settle();
		} catch {
			// Not ready yet. Wait for the event.
		}
	});

	const ready = (): Promise<void> => readyPromise;

	return {
		element,
		ready,
		async run<T>(code: string): Promise<T> {
			if (destroyed) throw new Error('The preview webview has been destroyed.');
			await ready();
			return (await unwrapped(() =>
				retryWhileUnready(() => element.executeJavaScript(code), () => destroyed),
			)) as T;
		},
		async printToPdf(options: PrintToPdfOptions): Promise<Uint8Array> {
			if (destroyed) throw new Error('The preview webview has been destroyed.');
			await ready();
			return await unwrapped(() => retryWhileUnready(() => element.printToPDF(options), () => destroyed));
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
