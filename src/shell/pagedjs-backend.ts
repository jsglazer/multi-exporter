import PAGEDJS_SOURCE from 'vendor-text:vendor/pagedjs/paged.polyfill.js';
import { createPreviewWebview } from '../adapter/obsidian-internals';
import type { PreviewWebview } from '../adapter/obsidian-internals';
import { ExportCancelled } from '../core/backend';
import type {
	ExportBackend,
	ExportRequest,
	ExportResult,
	PaginateRequest,
	PaginateResult,
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
		const webview = this.container();
		await this.ensurePolyfill(webview);
		await webview.run<boolean>(paginateScript(request.html, request.css));
		return await this.readPageMap(webview);
	}

	async export(request: ExportRequest): Promise<ExportResult> {
		const webview = this.container();
		const cancelled = (): boolean => request.isCancelled?.() === true;
		if (cancelled()) throw new ExportCancelled();

		await this.ensurePolyfill(webview);

		// Merged export is one document: the notes are concatenated *before* pagination, so
		// page numbering is continuous and running heads carry across note boundaries by
		// construction rather than by stitching PDFs together afterwards.
		const html = request.documents
			.map(
				(document, index) =>
					`<section class="mx-document" data-mx-index="${index}" data-mx-source="${escapeAttribute(document.sourcePath)}" data-mx-title="${escapeAttribute(document.title)}">${document.html}</section>`,
			)
			.join('\n');

		request.onProgress?.(0.1, 'Paginating');
		await webview.run<boolean>(paginateScript(html, request.css));
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
	document.write('<!doctype html><html><head><meta charset="utf-8"><style id="mx-style"></style></head><body></body></html>');
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
 */
function paginateScript(html: string, css: string): string {
	return `(async () => {
	document.body.innerHTML = '';
	const style = document.getElementById('mx-style');
	style.textContent = ${JSON.stringify(css)};
	const source = document.createElement('div');
	source.innerHTML = ${JSON.stringify(html)};
	const previewer = new window.Paged.Previewer();
	await previewer.preview(source, [], document.body);
	return true;
})()`;
}

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

function escapeAttribute(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
