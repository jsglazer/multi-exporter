import type { App, Plugin, TFile, View } from 'obsidian';
import type { AnnotationCategoryColor, AnnotationCategoryColors, AnnotationStripClasses } from '../core/annotations';

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
 * | `md-annotation` | v1.0.22, public `api` | `src/api.ts`, read 2026-08-29 |
 * | `obsidian-excalidraw-plugin` | v2.27.3, public `window.ExcalidrawAutomate` (`createSVG`, `getAPI`, `reset`, `addText`, `style.fontFamily`); canvas-file-node DOM (`.canvas-node-container > .canvas-node-content.markdown-embed > .markdown-embed-content > .markdown-preview-view`) it hosts embedded notes in; view type `excalidraw` and embedded-note leaves mounted inside the board view's DOM | `main.js`, read 2026-09-12 / 2026-09-13 |
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

/* ---------------------------------------------------------------------- excalidraw -- */

export const EXCALIDRAW_PLUGIN_ID = 'obsidian-excalidraw-plugin';

/** The slice of `ExcalidrawAutomate` this plugin calls, mirrored from its published API docs. */
interface ExcalidrawAutomateApi {
	createSVG(
		templatePath?: string,
		embedFont?: boolean,
		exportSettings?: unknown,
		loader?: unknown,
		theme?: string,
		padding?: number,
		/**
		 * Defaults to `false` in the plugin itself, which renders a note-embed box's link as
		 * the literal wikilink text (`[[CurveShifts]]`) instead of an `obsidian://` URL — the
		 * shell asks for `true` explicitly so a box's link is always the URL form
		 * `resolveEmbedLinkTarget` parses.
		 */
		convertMarkdownLinksToObsidianURLs?: boolean,
		includeInternalLinks?: boolean,
	): Promise<SVGSVGElement>;
	/** "Returns a new instance of ExcalidrawAutomate." — one whose scene is its own. */
	getAPI(): ExcalidrawAutomateApi;
	/** "clear() + reset all style values to default". */
	reset(): void;
	/** Adds a text element to this instance's own scene, drawn in `style.fontFamily`. */
	addText(x: number, y: number, text: string): string;
	style: { fontFamily: number };
}

function asExcalidrawAutomateApi(candidate: unknown): ExcalidrawAutomateApi | null {
	if (candidate === null || typeof candidate !== 'object') return null;
	const api = candidate as Partial<ExcalidrawAutomateApi>;
	return typeof api.createSVG === 'function' ? (api as ExcalidrawAutomateApi) : null;
}

/**
 * A private `ExcalidrawAutomate` instance, for building a throwaway scene without touching the
 * shared `window.ExcalidrawAutomate` a user's Templater or QuickAdd script may be mid-way through
 * using. `getAPI` registers every instance it makes with the plugin, so callers should create one
 * and keep it, not one per call. `null` when the plugin is off or its API has a different shape.
 */
export function createExcalidrawAutomateInstance(app: App): ExcalidrawAutomateApi | null {
	const shared = getExcalidrawAutomate(app);
	if (shared === null || typeof shared.getAPI !== 'function') return null;
	const instance = asExcalidrawAutomateApi(shared.getAPI());
	if (instance === null || typeof instance.reset !== 'function' || typeof instance.addText !== 'function') return null;
	return typeof instance.style === 'object' && instance.style !== null ? instance : null;
}

/**
 * Excalidraw's own scene renderer.
 *
 * Exposed as a bare `window.ExcalidrawAutomate` global rather than through the plugin
 * registry's `api` field `getPluginApi` reads — this is the same public surface a
 * Templater or QuickAdd script uses to render a drawing, not a private object reached into
 * for the first time here. Still gated on the plugin being enabled, since a global can
 * outlive its plugin being disabled within the same window session.
 */
export function getExcalidrawAutomate(app: App): ExcalidrawAutomateApi | null {
	if (!isPluginEnabled(app, EXCALIDRAW_PLUGIN_ID)) return null;
	return asExcalidrawAutomateApi((window as unknown as { ExcalidrawAutomate?: unknown }).ExcalidrawAutomate);
}

/** Excalidraw's own view type, as its `ExcalidrawView.getViewType()` returns it. */
export const EXCALIDRAW_VIEW_TYPE = 'excalidraw';

/**
 * Every Excalidraw board whose view DOM contains the active view, innermost first.
 *
 * Excalidraw hosts a note embedded on a board in a leaf it builds with
 * `workspace.createLeafInParent` on a detached split, mounted *inside* the board view's own
 * container, and makes that leaf active when the user clicks into it — so the embedded note
 * becomes the workspace's active file. DOM containment is the one relation between the two
 * leaves that is not a private field (`embeddableLeafRefs` is), so that is what this checks.
 * Only boards in the workspace tree are found; a board embedded inside another board is itself
 * in a detached leaf, which is fine, since the caller wants the outermost board anyway.
 *
 * The active view is passed in rather than looked up here because the lookup needs `View` as a
 * runtime value, and this file stays type-only against `obsidian` so tests can import it.
 */
export function findEnclosingExcalidrawBoards(app: App, active: View | null): TFile[] {
	if (active === null) return [];
	const boards: { containerEl: HTMLElement; file: TFile }[] = [];
	for (const leaf of app.workspace.getLeavesOfType(EXCALIDRAW_VIEW_TYPE)) {
		const view = leaf.view as View & { file?: TFile | null };
		if (view === active || view.file === null || view.file === undefined) continue;
		if (view.containerEl.contains(active.containerEl)) boards.push({ containerEl: view.containerEl, file: view.file });
	}
	const depth = (board: { containerEl: HTMLElement }): number =>
		boards.filter((other) => other.containerEl.contains(board.containerEl)).length;
	return boards.sort((a, b) => depth(b) - depth(a)).map((board) => board.file);
}

/**
 * The CSS custom properties Excalidraw's canvas theme sets on an open board, for the board at
 * `path`, or an empty object when that board is not open in any pane.
 *
 * Excalidraw derives a palette from the canvas background and Obsidian's accent colour
 * (`appState.dynamicStyle` in its `main.js`) and writes it as inline custom properties on the
 * board's container, `--bold-color` among them. A note embedded on the board inherits them, which
 * is why bold text in an embed is accent-purple on screen and plain black anywhere else. Found by
 * the one property every palette includes rather than by a class name, and read from the inline
 * style — exactly what Excalidraw set — not the computed style, which would drag in every Obsidian
 * variable too.
 */
export function getExcalidrawThemeVariables(app: App, path: string): Record<string, string> {
	for (const leaf of app.workspace.getLeavesOfType(EXCALIDRAW_VIEW_TYPE)) {
		const view = leaf.view as View & { file?: TFile | null };
		if (view.file?.path !== path) continue;
		const themed = view.containerEl.querySelector<HTMLElement>('[style*="--bold-color"]');
		if (themed === null) continue;
		const variables: Record<string, string> = {};
		for (const name of Array.from(themed.style)) {
			if (name.startsWith('--')) variables[name] = themed.style.getPropertyValue(name).trim();
		}
		return variables;
	}
	return {};
}

/* ------------------------------------------------------------------- md-annotation -- */

/**
 * `md-annotation`'s own rendered output, as it appears in a note this plugin rendered.
 *
 * Not a styling contract and not something to build on: this is the list of classes to
 * **take back out**. `md-annotation` registers a markdown post-processor, so a detached
 * `MarkdownRenderer.render()` does get highlight spans and comment markers from it — but
 * every branch that draws them is gated on that plugin's live visibility settings
 * (`annotationFormattingEnabled`, `commentsHiddenEnabled`, `gutterAnnotationsEnabled`).
 * Keeping them would make the PDF change with a sidebar toggle. They are removed, and the
 * annotations are drawn again from the API records, where the profile decides everything.
 *
 * Highlight and anchor spans wrap the *note's own words*, so they are unwrapped; markers and
 * gutter furniture are `md-annotation`'s own elements and go whole. `mdann-widget-hl` is
 * neither: it is a class that plugin paints **onto an element it does not own** — a rendered
 * MathJax container, a Live Preview widget — precisely because unwrapping such an element
 * would tear it apart. So the class comes off and the element stays.
 *
 * A CSS class name is an undocumented-by-contract coupling to another plugin, which is why
 * this list lives behind this boundary with everything else that can move without warning.
 */
export const MD_ANNOTATION_STRIP_CLASSES: AnnotationStripClasses = {
	unwrap: ['mdann-hl', 'mdann-anchor'],
	remove: ['mdann-marker', 'mdann-gutter-host', 'mdann-gutter-card', 'mdann-gutter-leader', 'mdann-gutter-tick'],
	unclass: ['mdann-widget-hl'],
};

/**
 * Highlight colours for each `md-annotation` category, or `{}` when they cannot be read.
 *
 * The **light** palette, always: an export goes onto white paper, and a category's dark-mode
 * colours are chosen to sit on a dark editor background. `use: false` means the category is
 * defined but switched off, so it contributes no colour and falls back to the profile's own
 * styling.
 *
 * Reading another plugin's settings object is the same class of coupling as its class names
 * and lives here for the same reason. Every level is treated as possibly absent: this is
 * user-editable JSON that survives across versions.
 */
export function getMdAnnotationCategoryColors(app: App, pluginId: string): AnnotationCategoryColors {
	const settings = pluginRegistry(app)?.plugins[pluginId]?.settings;
	const styles = settings?.['categoryStyles'];
	if (styles === null || typeof styles !== 'object') return {};

	const out: AnnotationCategoryColors = {};
	for (const [name, value] of Object.entries(styles as Record<string, unknown>)) {
		if (value === null || typeof value !== 'object') continue;
		const style = value as { use?: unknown; light?: unknown };
		if (style.use === false) continue;
		const light = style.light;
		if (light === null || typeof light !== 'object') continue;
		const parts = light as { fr?: unknown; bg?: unknown };
		const color: AnnotationCategoryColor = {};
		const foreground = enabledColor(parts.fr);
		const background = enabledColor(parts.bg);
		if (foreground !== null) color.foreground = foreground;
		if (background !== null) color.background = background;
		if (color.foreground !== undefined || color.background !== undefined) out[name] = color;
	}
	return out;
}

/** `{ enabled, color }` -> the colour, but only when it is switched on and non-empty. */
function enabledColor(option: unknown): string | null {
	if (option === null || typeof option !== 'object') return null;
	const candidate = option as { enabled?: unknown; color?: unknown };
	if (candidate.enabled !== true) return null;
	return typeof candidate.color === 'string' && candidate.color !== '' ? candidate.color : null;
}

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

/* --------------------------------------------------------------------- open exports -- */

interface ElectronShell {
	/** Resolves to an error string on failure — Electron does not reject this call. */
	openPath(path: string): Promise<string>;
}

interface ElectronShellBridge {
	remote?: { shell?: ElectronShell };
	shell?: ElectronShell;
}

/** Raised when Electron's shell bridge cannot be reached; never raised for a bad path. */
export class ShellUnavailableError extends Error {
	constructor() {
		super("Electron's shell module could not be reached, so the exported file could not be opened.");
		this.name = 'ShellUnavailableError';
	}
}

function shellBridge(): ElectronShell {
	for (const moduleId of ['electron', '@electron/remote']) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const module = require(moduleId) as ElectronShellBridge;
			const shell = module.remote?.shell ?? module.shell;
			if (shell !== undefined) return shell;
		} catch {
			// Try the next spelling; only exhausting both is a failure.
		}
	}
	throw new ShellUnavailableError();
}

/**
 * Open a finished export with the system's default app for its file type.
 *
 * `shell.openPath` resolves to an error string rather than rejecting, so a bad path or a
 * missing default app is turned into a thrown error here rather than silently doing nothing.
 */
export async function openExportedFile(path: string): Promise<void> {
	const error = await shellBridge().openPath(path);
	if (error !== '') throw new Error(error);
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
	print(options?: PrintOptions): void;
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

/** Electron's `<webview>.print()` options — the OS print dialog, not a PDF file. */
export interface PrintOptions {
	printBackground?: boolean;
	landscape?: boolean;
	margins?: { marginType: 'default' | 'none' | 'printableArea' | 'custom' };
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
	 * Send the guest straight to the OS print dialog, as an alternative to `printToPdf`.
	 *
	 * Chromium ignores `media="screen"` styles while printing, so the preview's own chrome —
	 * backdrop, page shadows, the fit-to-width transform, all scoped to `.mx-preview-mode`
	 * under a `media="screen"` `<style>` — drops out on its own; nothing has to be toggled off
	 * first, unlike `printToPdf`, which prints the guest exactly as it stands at all times.
	 */
	print(options?: PrintOptions): void;
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
		print(options?: PrintOptions): void {
			if (destroyed) throw new Error('The preview webview has been destroyed.');
			element.print(options);
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
