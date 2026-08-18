import PAGEDJS_SOURCE from 'vendor-text:vendor/pagedjs/paged.polyfill.js';
import { createPreviewWebview, isGuestGoneError } from '../adapter/obsidian-internals';
import type { PreviewWebview } from '../adapter/obsidian-internals';
import { ExportCancelled } from '../core/backend';
import type {
	ExportBackend,
	ExportRequest,
	ExportResult,
	PaginateRequest,
	PaginateResult,
	RenderedDocument,
} from '../core/backend';
import { PAGEDJS_BACKEND_ID } from '../core/profiles';

/**
 * The one real backend: paged.js pagination inside a `<webview>`, printed with
 * `printToPDF`.
 *
 * The whole design turns on one property: **the preview is the output**. There is a single
 * paginated DOM, the preview shows it, and the export prints that same already-paginated
 * container at zero margins — so the preview cannot drift from the PDF, because it is the
 * PDF. Creating a fresh container at export time would force a second pagination pass and
 * reintroduce exactly the drift this exists to eliminate.
 *
 * Pagination runs in the webview's own renderer process, so it blocks the webview and not
 * Obsidian's main thread. Measured at roughly 17ms per page and linear, which is why there
 * is no page-window pagination here: a 163-page document paginates in about 2.7 seconds,
 * and windowing would buy nothing for real cost.
 */

/** Marks the document root once the polyfill has been injected, so it happens once. */
const READY_FLAG = '__mxPagedReady';

export class PagedJsWebviewBackend implements ExportBackend {
	readonly id = PAGEDJS_BACKEND_ID;
	readonly label = 'paged.js (webview)';

	private webview: PreviewWebview | null = null;
	private disposed = false;

	constructor(private readonly host: HTMLElement) {}

	/**
	 * The single container, created once and reused for every note in a bulk export.
	 *
	 * Never N webviews: each one owns a renderer process, and a 200-note folder export that
	 * creates 200 of them will take the machine with it.
	 */
	private container(): PreviewWebview {
		if (this.disposed) throw new Error('Backend disposed.');
		this.webview ??= createPreviewWebview(this.host, 'persist:multi-exporter-preview');
		return this.webview;
	}

	/** Keep the container off-screen (never `display: none`) while a bulk export runs. */
	setOffscreen(offscreen: boolean): void {
		this.webview?.setOffscreen(offscreen);
	}

	async paginate(request: PaginateRequest): Promise<PaginateResult> {
		return await this.withGuestRecovery('the preview', async () => {
			const webview = this.container();
			await this.ensurePolyfill(webview);
			await webview.run<boolean>(paginateScript(request.html, request.css, true));
			const map = await this.readPageMap(webview);
			// Diagnostics first: they measure with `getBoundingClientRect`, which the fit
			// transform below would scale out from under them.
			await this.reportOverflow(webview);
			// Fitting happens last and only in preview mode: it is a `transform` on the page
			// stack, and a transform is the last thing that may exist when printing.
			await webview.run<boolean>(FIT_PREVIEW_SCRIPT);
			return map;
		});
	}

	/**
	 * Run something against the guest; if the guest *died*, build a new one and try once.
	 *
	 * A `<webview>`'s guest is a separate renderer process and it can go away underneath a
	 * call in flight — it is destroyed while a script is running, or it crashes outright.
	 * Every later call then rejects with Electron's `GUEST_VIEW_MANAGER_CALL ... item doesn't
	 * belong to list`, which is a sentence about Electron's bookkeeping and tells the user
	 * nothing: the preview simply reports a failure that a fresh webview would not have had,
	 * and stays broken until the modal is closed and reopened. Rebuilding is cheap — the
	 * polyfill is re-injected on demand — so the transient case heals itself.
	 *
	 * A second failure of the same kind is *not* transient: the content itself is killing the
	 * renderer, and no third attempt will change that. It is re-thrown as something a user can
	 * act on rather than as Electron's list-membership complaint.
	 */
	private async withGuestRecovery<T>(subject: string, action: () => Promise<T>): Promise<T> {
		try {
			return await action();
		} catch (error) {
			if (this.disposed || !isGuestGoneError(error)) throw error;
			console.warn('[multi-exporter] the preview webview died during %s; rebuilding it and retrying once.', subject, error);
			this.webview?.destroy();
			this.webview = null;
			try {
				return await action();
			} catch (retryError) {
				if (!isGuestGoneError(retryError)) throw retryError;
				// `cause` is deliberately not used: the bundle targets ES2018, where the two-argument
				// Error constructor is not declared, so the original message is carried in the text
				// instead of being dropped.
				throw new Error(
					`The preview process stopped while paginating ${subject}, twice. That usually means a ` +
						'stylesheet the paginator cannot resolve — check the developer console for the paged.js ' +
						"error, and try the profile's stylesheet without its @page or break rules. " +
						`(Electron said: ${retryError instanceof Error ? retryError.message : String(retryError)})`,
				);
			}
		}
	}

	async export(request: ExportRequest): Promise<ExportResult> {
		return await this.withGuestRecovery('the export', () => this.exportOnce(request));
	}

	private async exportOnce(request: ExportRequest): Promise<ExportResult> {
		const webview = this.container();
		const cancelled = (): boolean => request.isCancelled?.() === true;
		if (cancelled()) throw new ExportCancelled();

		await this.ensurePolyfill(webview);

		// Merged export is one document: the notes are concatenated *before* pagination, so
		// page numbering is continuous and running heads carry across note boundaries by
		// construction rather than by stitching PDFs together afterwards.
		const html = wrapDocumentSections(request.documents);

		request.onProgress?.(0.1, 'Paginating');
		// `false`: no preview chrome and no fit transform, so what Chromium prints is the
		// page boxes alone — `printBackground` would otherwise paint the preview's backdrop
		// across every page.
		await webview.run<boolean>(paginateScript(html, request.css, false));
		if (cancelled()) throw new ExportCancelled();

		const map = await this.readPageMap(webview);
		const documentStartPages = await webview.run<number[]>(DOCUMENT_START_PAGES_SCRIPT);

		request.onProgress?.(0.7, 'Printing');
		const pdf = await webview.printToPdf({
			printBackground: true,
			// The furniture is already elements in the paginated DOM, so Chromium is asked
			// to print exactly what is on screen: CSS page size, zero margins, no header or
			// footer template. Its template API could not express this furniture anyway.
			preferCSSPageSize: true,
			margins: { marginType: 'none' },
			landscape: request.profile.page.orientation === 'landscape',
		});
		if (cancelled()) throw new ExportCancelled();

		request.onProgress?.(0.85, 'Building outline');
		return { pdf, pageCount: map.pageCount, headings: map.headings, documentStartPages };
	}

	private async ensurePolyfill(webview: PreviewWebview): Promise<void> {
		const ready = await webview.run<boolean>(`Boolean(window.${READY_FLAG})`);
		if (ready) return;
		await webview.run<boolean>(bootstrapScript(PAGEDJS_SOURCE));
	}

	private async readPageMap(webview: PreviewWebview): Promise<PaginateResult> {
		return await webview.run<PaginateResult>(PAGE_MAP_SCRIPT);
	}

	/**
	 * Log what actually landed on each page, and warn about content wider or taller than the
	 * page box.
	 *
	 * A block the paginator cannot fit is not shrunk, it is moved: pushed whole to the next
	 * page, leaving the one before it blank below whatever preceded it. On screen that is
	 * indistinguishable from "the preview only rendered part of the note", and there is
	 * nothing in the DOM to inspect afterwards that says so. This says so.
	 */
	private async reportOverflow(webview: PreviewWebview): Promise<void> {
		try {
			const report = await webview.run<PageDiagnostics>(DIAGNOSTIC_SCRIPT);
			console.debug('[multi-exporter] pagination', report);
			if (report.oversized.length > 0) {
				console.warn(
					'[multi-exporter] %d element(s) do not fit the page box and were moved whole to a later page:',
					report.oversized.length,
					report.oversized,
				);
			}
		} catch (error) {
			console.debug('[multi-exporter] pagination diagnostics unavailable', error);
		}
	}

	/**
	 * Explicit teardown, wired to both modal close and plugin unload.
	 *
	 * A live webview holds a WebContents; leaving one attached leaks a renderer process and
	 * blocks clean plugin removal. An empty `onunload` is the incumbent's bug, not a style
	 * choice.
	 */
	dispose(): Promise<void> {
		this.disposed = true;
		this.webview?.destroy();
		this.webview = null;
		return Promise.resolve();
	}
}

/* ----------------------------------------------------------- guest-page scripts -- */

/**
 * Everything below runs inside the webview's own renderer, injected as source text.
 *
 * They are strings rather than imported functions because they execute in a different
 * JavaScript realm: nothing in the plugin bundle exists there.
 */

function bootstrapScript(pagedJsSource: string): string {
	return `(() => {
	document.open();
	document.write('<!doctype html><html><head><meta charset="utf-8"><style id="mx-chrome" media="screen"></style></head><body></body></html>');
	document.close();
	// auto:false — the polyfill must not start chunking the moment it loads; the host
	// decides when to paginate, and paginates again in place on every edit.
	window.PagedConfig = { auto: false };
	const script = document.createElement('script');
	script.textContent = ${JSON.stringify(pagedJsSource)};
	document.head.appendChild(script);
	window.${READY_FLAG} = true;
	return true;
})()`;
}

/**
 * Re-paginate **in place**. The container is never recreated between edits — that is what
 * keeps margin, stylesheet and header changes visible without a round trip, and what keeps
 * the preview identical to the export.
 *
 * The profile stylesheet goes to **paged.js's polisher**, not into a `<style>` element.
 * Only the polisher parses `@page`: it is what turns the profile's page size, margins,
 * margin boxes and counters into page geometry and furniture. A plain `<style>` leaves the
 * browser to ignore every `@page` rule, and pagination then silently falls back to the
 * polyfill's built-in 8.5×11in default with no headers or footers at all.
 */
function paginateScript(html: string, css: string, previewChrome: boolean): string {
	return `(async () => {
	// Each run builds a fresh Previewer, so the previous one's polisher output has to go
	// with it — otherwise every refresh leaves another copy of the page rules in the head
	// and the oldest one keeps winning ties.
	const previous = window.__mxPreviewer;
	if (previous) {
		try { previous.polisher.destroy(); } catch (error) { /* already gone */ }
		try { previous.chunker.destroy(); } catch (error) { /* already gone */ }
	}
	document.querySelectorAll('style[data-pagedjs-inserted-styles]').forEach((element) => element.remove());

	document.documentElement.classList.toggle('mx-preview-mode', ${previewChrome ? 'true' : 'false'});
	document.getElementById('mx-chrome').textContent = ${JSON.stringify(PREVIEW_CHROME_CSS)};
	document.documentElement.style.removeProperty('--mx-preview-scale');

	document.body.innerHTML = '';
	const source = document.createElement('div');
	source.innerHTML = ${JSON.stringify(html)};
	const previewer = new window.Paged.Previewer();
	window.__mxPreviewer = previewer;
	await previewer.preview(source, [{ 'mx-profile.css': ${JSON.stringify(css)} }], document.body);
	return true;
})()`;
}

/**
 * Preview-only chrome: a backdrop, a shadow under each sheet, and the fit-to-width scale.
 *
 * `media="screen"` on its `<style>` keeps paged.js from ever collecting it as a document
 * stylesheet, and the `.mx-preview-mode` class is off during an export, so none of this can
 * reach the PDF — which matters because the export prints with `printBackground: true`.
 */
const PREVIEW_CHROME_CSS = `html.mx-preview-mode { background: #4b4e52; }
html.mx-preview-mode body { background: transparent; margin: 0; }
html.mx-preview-mode .pagedjs_pages {
	transform: scale(var(--mx-preview-scale, 1));
	transform-origin: top center;
	padding: 16px 0;
}
html.mx-preview-mode .pagedjs_page {
	background: #fff;
	margin: 0 auto 16px;
	box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
}`;

/**
 * Scale the page stack down until a full page fits the preview's width.
 *
 * A Letter page is 816px at 96dpi and the preview pane is routinely narrower, so without
 * this the sheet is simply cut off at the right edge — the page is there, but only part of
 * it can be seen. Never scales up: 1 is the ceiling.
 */
const FIT_PREVIEW_SCRIPT = `(() => {
	const page = document.querySelector('.pagedjs_page');
	const stack = document.querySelector('.pagedjs_pages');
	if (!page || !stack) return false;
	const fit = () => {
		stack.style.height = '';
		const available = document.documentElement.clientWidth - 24;
		const width = page.getBoundingClientRect().width / (window.__mxPreviewScale || 1);
		if (!width || !available) return;
		const scale = Math.min(1, available / width);
		window.__mxPreviewScale = scale;
		document.documentElement.style.setProperty('--mx-preview-scale', String(scale));
		// The stack keeps its unscaled height after a transform, leaving dead space below
		// the last page; trimming it keeps the scrollbar honest.
		stack.style.height = (stack.scrollHeight * scale) + 'px';
	};
	fit();
	if (!window.__mxFitBound) {
		window.__mxFitBound = true;
		window.addEventListener('resize', () => {
			const current = document.querySelector('.pagedjs_page');
			if (current) fit();
		});
	}
	return true;
})()`;

/** Read paged.js's page map back out: page count plus every heading's landing page. */
const PAGE_MAP_SCRIPT = `(() => {
	const pages = Array.from(document.querySelectorAll('.pagedjs_page'));
	const headings = [];
	pages.forEach((page, pageIndex) => {
		page.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((element) => {
			// paged.js splits an element across pages by cloning it; only the first copy is
			// a real heading occurrence, and the clones carry data-split-from.
			if (element.hasAttribute('data-split-from')) return;
			const title = (element.textContent || '').replace(/\\s+/g, ' ').trim();
			if (!title) return;
			headings.push({ level: Number(element.tagName.substring(1)), title, pageIndex });
		});
	});
	return { pageCount: pages.length, headings };
})()`;

interface PageDiagnostics {
	/** The guest's own viewport. Too short here means the container never got a real box. */
	viewport: { width: number; height: number };
	/** Characters of text on each page, in order. A run of zeroes is the symptom. */
	pageChars: number[];
	/** Elements measured larger than the page's content box. */
	oversized: { tag: string; className: string; width: number; height: number }[];
	/** The content box every element above was measured against. */
	contentBox: { width: number; height: number } | null;
}

/**
 * Per-page text volume plus anything too big for the page's content box.
 *
 * Measured against `.pagedjs_page_content` rather than the sheet, because that box is what
 * an element actually has to fit inside once the margins are taken out.
 */
const DIAGNOSTIC_SCRIPT = `(() => {
	const pages = Array.from(document.querySelectorAll('.pagedjs_page'));
	const pageChars = pages.map((page) => (page.textContent || '').trim().length);
	const box = document.querySelector('.pagedjs_page_content');
	const contentBox = box ? { width: box.clientWidth, height: box.clientHeight } : null;
	const oversized = [];
	if (contentBox && contentBox.width > 0) {
		const seen = new Set();
		document.querySelectorAll('.pagedjs_page_content *').forEach((element) => {
			if (element.children.length > 0) return;
			const rect = element.getBoundingClientRect();
			if (rect.width <= contentBox.width + 1 && rect.height <= contentBox.height + 1) return;
			const key = element.tagName + ':' + element.className + ':' + Math.round(rect.width) + 'x' + Math.round(rect.height);
			if (seen.has(key)) return;
			seen.add(key);
			oversized.push({
				tag: element.tagName.toLowerCase(),
				className: String(element.className || ''),
				width: Math.round(rect.width),
				height: Math.round(rect.height),
			});
		});
	}
	return {
		viewport: { width: window.innerWidth, height: window.innerHeight },
		pageChars,
		oversized: oversized.slice(0, 20),
		contentBox,
	};
})()`;

/** First page index of each `.mx-document` section, in document order. */
const DOCUMENT_START_PAGES_SCRIPT = `(() => {
	const pages = Array.from(document.querySelectorAll('.pagedjs_page'));
	const starts = new Map();
	pages.forEach((page, pageIndex) => {
		page.querySelectorAll('.mx-document').forEach((section) => {
			const index = Number(section.getAttribute('data-mx-index'));
			if (Number.isInteger(index) && !starts.has(index)) starts.set(index, pageIndex);
		});
	});
	const max = starts.size === 0 ? -1 : Math.max(...starts.keys());
	const out = [];
	for (let i = 0; i <= max; i++) out.push(starts.has(i) ? starts.get(i) : 0);
	return out;
})()`;

/**
 * Wrap each document in its `.mx-document` section.
 *
 * Exported so the preview wraps identically: a stylesheet that targets `.mx-document` must
 * see the same tree on screen as in the PDF.
 *
 * Each section opens with a zero-height meta block carrying the note's name and the export
 * timestamp. That block exists so a running head can say them: CSS Paged Media reads text
 * for a margin box out of the document through `string-set`, and there is no other way to
 * get "the name of the note this page belongs to" into `@top-left` — least of all in a
 * merged export, where the answer changes partway down the PDF. It is sized to nothing
 * rather than `display: none` because paged.js only sets a named string from elements it
 * actually lays out onto a page, and a collapsed element is never laid out.
 *
 * The first section is marked, so a profile can stop its `break-before: page` heading rule
 * from opening the document with a blank page.
 */
export function wrapDocumentSections(
	documents: readonly RenderedDocument[],
	options: { exportedAt?: Date } = {},
): string {
	const stamp = formatExportStamp(options.exportedAt ?? new Date());
	return documents
		.map((document, index) => {
			const first = index === 0 ? ' mx-document-first' : '';
			const meta =
				`<div class="mx-doc-meta" aria-hidden="true">` +
				`<span class="mx-doc-title">${escapeText(document.title)}</span>` +
				`<span class="mx-doc-date">${escapeText(stamp)}</span>` +
				`</div>`;
			return (
				`<section class="mx-document${first}" data-mx-index="${index}"` +
				` data-mx-source="${escapeAttribute(document.sourcePath)}"` +
				` data-mx-title="${escapeAttribute(document.title)}">${meta}${document.html}</section>`
			);
		})
		.join('\n');
}

/**
 * The export timestamp as it appears in a running foot: `2026-08-18 at 09.41`.
 *
 * Local time, and formatted by hand rather than through `toLocaleString`: the same export on
 * two machines should produce the same footer, and a locale-aware formatter would make it
 * depend on the OS region setting. The shape mirrors the LaTeX `\dashdate{\today} at
 * \dottime` this profile was modelled on.
 */
export function formatExportStamp(when: Date): string {
	const pad = (value: number): string => String(value).padStart(2, '0');
	const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
	return `${date} at ${pad(when.getHours())}.${pad(when.getMinutes())}`;
}

function escapeText(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
