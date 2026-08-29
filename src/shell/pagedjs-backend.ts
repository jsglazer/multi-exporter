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
import { planPerNoteNumbering } from '../core/page-numbering';
import type { PageStamp } from '../core/page-numbering';
import { PAGEDJS_BACKEND_ID } from '../core/profiles';
import type { PageConfig, PageNumbering } from '../core/types';

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

/** How often the pagination watchdog asks the guest how many pages it has built. */
const PAGINATION_POLL_MS = 1000;

/**
 * How long pagination may produce no new page before it is called stuck.
 *
 * Generous on purpose: a single page of a heavy Dataview table is slow, and killing a working
 * export is worse than waiting. Measured pagination is ~17ms per page, so a minute and a half
 * without one is not slowness.
 */
const PAGINATION_STALL_MS = 90000;

/**
 * Pages past which pagination is runaway rather than long.
 *
 * A 163-page document is a real one; five thousand is not a document, it is a break rule
 * pushing the same content forward and generating a page each time.
 */
const RUNAWAY_PAGE_CEILING = 5000;

/** Below this the body text is no longer readable, so a fit is not worth having. */
const MIN_PRINT_SCALE = 0.4;

/**
 * Keep a print scale inside Chromium's range, and inside a sane one.
 *
 * `printToPDF` accepts 0.1 to 2 and rejects anything outside it outright. A profile whose
 * `printScale` is a stray string, a zero or a negative number is a settings file someone
 * hand-edited — not a reason to fail an export — so it lands on 1 rather than throwing.
 */
function clampScale(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 1;
	return Math.min(2, Math.max(MIN_PRINT_SCALE, value));
}

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

	/**
	 * Throw the guest away so the next call builds a fresh one.
	 *
	 * Distinct from `dispose()`, which retires the backend for good. Destroying the webview
	 * without also dropping the reference leaves `container()` handing back a dead object, and
	 * every later call fails with "The preview webview has been destroyed" — turning one
	 * recoverable failure into a permanently broken modal.
	 */
	private resetGuest(): void {
		this.webview?.destroy();
		this.webview = null;
	}

	/** Keep the container off-screen (never `display: none`) while a bulk export runs. */
	setOffscreen(offscreen: boolean): void {
		this.webview?.setOffscreen(offscreen);
	}

	async paginate(request: PaginateRequest): Promise<PaginateResult> {
		return await this.withGuestRecovery('the preview', async () => {
			const webview = this.container();
			await this.ensurePolyfill(webview);
			await this.runPagination(webview, paginateScript(request.html, request.css, true));
			const map = await this.readPageMap(webview);
			// Before anything measures or scales: the preview must show the same numbering the
			// PDF will carry, or the one guarantee this plugin makes is broken.
			await this.applyNumbering(webview, request.page.pageNumbering, map.pageCount);
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
	 * Every later call then rejects with a message about a disposed frame or a destroyed
	 * WebContents: the preview reports a failure a fresh webview would not have had, and stays
	 * broken until the modal is closed and reopened. Rebuilding is cheap — the polyfill is
	 * re-injected on demand — so the transient case heals itself.
	 *
	 * A second failure of the same kind is *not* transient: the content itself is killing the
	 * renderer, and no third attempt will change that.
	 *
	 * What must **not** reach here is an ordinary exception thrown by the injected script.
	 * Electron wraps those in the same `GUEST_VIEW_MANAGER_CALL` framing as a dead guest, and
	 * treating the framing as the signal made every paged.js error look like a crashed process:
	 * a healthy webview was destroyed, the work re-run, the identical error hit again, and the
	 * user told the process had died twice. `isGuestGoneError` matches the death itself now,
	 * never the wrapper.
	 */
	private async withGuestRecovery<T>(subject: string, action: () => Promise<T>): Promise<T> {
		try {
			return await action();
		} catch (error) {
			if (this.disposed || !isGuestGoneError(error)) throw error;
			console.warn('[multi-exporter] the preview webview died during %s; rebuilding it and retrying once.', subject, error);
			this.resetGuest();
			try {
				return await action();
			} catch (retryError) {
				if (!isGuestGoneError(retryError)) throw retryError;
				// `cause` is deliberately not used: the bundle targets ES2018, where the two-argument
				// Error constructor is not declared, so the original message is carried in the text
				// instead of being dropped.
				throw new Error(
					`The preview's renderer process died while paginating ${subject}, twice — a fresh one did not ` +
						'survive either, so the content itself is what is killing it. A very large image or an ' +
						'enormous note is the usual cause; try the export again with that note excluded. ' +
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
		await this.runPagination(webview, paginateScript(html, request.css, false), request.isCancelled);
		if (cancelled()) throw new ExportCancelled();

		const map = await this.readPageMap(webview);
		const documentStartPages = await webview.run<number[]>(DOCUMENT_START_PAGES_SCRIPT);

		await this.applyNumbering(webview, request.profile.page.pageNumbering, map.pageCount, documentStartPages);
		if (cancelled()) throw new ExportCancelled();

		request.onProgress?.(0.7, 'Printing');
		const scale = await this.resolveScale(webview, request.profile.page);
		const pdf = await webview.printToPdf({
			printBackground: true,
			// The furniture is already elements in the paginated DOM, so Chromium is asked
			// to print exactly what is on screen: CSS page size, zero margins, no header or
			// footer template. Its template API could not express this furniture anyway.
			preferCSSPageSize: true,
			margins: { marginType: 'none' },
			landscape: request.profile.page.orientation === 'landscape',
			scale,
		});
		if (cancelled()) throw new ExportCancelled();

		request.onProgress?.(0.85, 'Building outline');
		return { pdf, pageCount: map.pageCount, headings: map.headings, documentStartPages };
	}

	/**
	 * Paginate, watching it.
	 *
	 * Pagination is one `executeJavaScript` call that can take a while and, when something
	 * goes wrong inside the paginator, never returns at all. Awaiting it bare — which is what
	 * this used to do — makes that failure invisible and inescapable: no error, no timeout,
	 * and the export modal's Cancel button does nothing, because `isCancelled` is only ever
	 * read *between* stages. A merged export that stops at "Paginating" then stays there
	 * forever is that gap, not a mystery.
	 *
	 * So the call is raced against a poll of the guest's own page count, which is the one
	 * number that says what the paginator is actually doing:
	 *
	 * - **climbing past any plausible length** — the paginator is generating pages it will
	 *   never stop generating, usually because a break rule keeps pushing the same content
	 *   forward. Named as runaway rather than reported as a timeout.
	 * - **not moving for a long time** — stuck laying out a single page.
	 * - **not answering the poll at all** — the guest is locked synchronously, which the stall
	 *   branch catches too, since the count cannot change either.
	 *
	 * Any of the three destroys the webview. That is deliberate: the runaway work is happening
	 * in another process, and letting go of the promise would leave it burning a core until
	 * Obsidian quits. `withGuestRecovery` builds a fresh one on the next attempt.
	 */
	private async runPagination(
		webview: PreviewWebview,
		script: string,
		isCancelled?: () => boolean,
	): Promise<void> {
		let settled = false;
		const run = webview
			.run<boolean>(script)
			.then(() => {
				settled = true;
			})
			.catch((error: unknown) => {
				settled = true;
				throw error;
			});
		// The guest is destroyed on every abort below, which rejects this. Nothing is left to
		// observe it by then, and an unobserved rejection is a crash in some Electron builds.
		run.catch(() => undefined);

		const abort = async (message: string): Promise<never> => {
			// Ask what it was working on *before* the guest is destroyed — afterwards there is
			// nothing left to ask. A locked guest will not answer; the timeout gives up rather
			// than turning a diagnostic into a second hang.
			const where = await Promise.race([
				webview.run<StallSnapshot | null>(STALL_SNAPSHOT_SCRIPT).catch(() => null),
				new Promise<null>((resolve) => window.setTimeout(() => resolve(null), STALL_SNAPSHOT_TIMEOUT_MS)),
			]);
			console.error('[multi-exporter] pagination gave up; last known state:', where);
			this.resetGuest();
			throw new Error(`${message}${describeStall(where)}`);
		};

		let pages = 0;
		let lastChange = Date.now();
		while (!settled) {
			await new Promise<void>((resolve) => window.setTimeout(resolve, PAGINATION_POLL_MS));
			if (settled) break;

			if (isCancelled?.() === true) {
				// Cancelling mid-pagination has to take the guest with it: the work is in another
				// process and nothing else will stop it.
				this.resetGuest();
				throw new ExportCancelled();
			}

			// A guest locked in synchronous work never answers; that is a stall, so let the
			// clock below decide rather than treating the silence as a separate failure.
			const observed = await webview.run<number>(PAGE_COUNT_SCRIPT).catch(() => pages);
			if (observed !== pages) {
				pages = observed;
				lastChange = Date.now();
			}

			if (pages > RUNAWAY_PAGE_CEILING) {
				await abort(
					`Pagination ran away: ${pages} pages and still going, which is past anything a real ` +
						'document produces. A break rule is almost certainly pushing the same content forward ' +
						'forever — try turning off “Keep headings with their text” in the profile’s Page ' +
						'settings, or removing its break-before / break-after rules.',
				);
			}
			if (Date.now() - lastChange > PAGINATION_STALL_MS) {
				await abort(
					`Pagination stopped making progress after ${pages} page${pages === 1 ? '' : 's'} and was ` +
						`given up on after ${Math.round(PAGINATION_STALL_MS / 1000)}s. The paginator is stuck on ` +
						'a single page — usually one element it cannot fit and cannot break. Check the ' +
						'developer console for a paged.js error.',
				);
			}
		}

		try {
			await run;
		} catch (error) {
			throw await this.describePaginationFailure(webview, error);
		}
	}

	/**
	 * Say that the *paginator* threw, and where it was when it did.
	 *
	 * paged.js's errors are written for someone reading its source: csstree's `item doesn't
	 * belong to list`, thrown out of the polisher by a stylesheet whose selector list trips two
	 * rule handlers at once, is a true sentence about a linked list and tells the user nothing
	 * about their profile. The stage marker is what turns it into a location — a throw at
	 * `preview-called` with no pages is the stylesheet, one at `laying-out-page` is the content.
	 */
	private async describePaginationFailure(webview: PreviewWebview, error: unknown): Promise<Error> {
		if (this.disposed || isGuestGoneError(error)) return error instanceof Error ? error : new Error(String(error));
		const message = error instanceof Error ? error.message : String(error);
		const where = await webview.run<StallSnapshot | null>(STALL_SNAPSHOT_SCRIPT).catch(() => null);
		console.error('[multi-exporter] paged.js threw during pagination; last known state:', where, error);

		const stage = where?.stage === null || where?.stage === undefined ? '' : ` It was at “${where.stage}”.`;
		const blame =
			where === null || where.pageCount === 0
				? ' No page had been laid out yet, so the profile’s stylesheet is the cause rather than the note —' +
					' check its @page, break and selector rules.'
				: ` It had laid out ${where.pageCount} page${where.pageCount === 1 ? '' : 's'}.`;
		return new Error(`The paginator (paged.js) failed: ${message}.${stage}${blame}`);
	}

	/**
	 * Restart the page counters at each note, when the profile asks for it.
	 *
	 * Runs **after** pagination and before anything reads or prints the result, because the
	 * totals it needs do not exist until the chunker has finished: a note's length in pages is
	 * an output of pagination, not an input to it. The decision of where the restarts go is
	 * pure and lives in `core/page-numbering.ts`; this only carries it into the guest.
	 *
	 * A no-op for `continuous`, and for a single-document run, where there is nothing to
	 * restart — paged.js's own document-wide counters are already the right answer.
	 */
	private async applyNumbering(
		webview: PreviewWebview,
		numbering: PageNumbering,
		pageCount: number,
		startPages?: readonly number[],
	): Promise<void> {
		if (numbering !== 'per-note') return;
		const documentStartPages = startPages ?? (await webview.run<number[]>(DOCUMENT_START_PAGES_SCRIPT));
		const stamps = planPerNoteNumbering(documentStartPages, pageCount);
		if (stamps.length === 0) return;
		await webview.run<boolean>(numberingScript(stamps));
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
	/**
	 * The print scale for this export.
	 *
	 * `fitToPage` off is the simple case: the profile's percentage, verbatim. On, the guest
	 * measures the worst overflow across the finished pages and this prints at exactly the
	 * scale that brings it inside the page box.
	 *
	 * Measured **after** pagination rather than estimated before it, because "does it fit"
	 * is a fact about the laid-out page and nothing else — the same table fits Letter
	 * landscape and overflows A5 portrait. A measurement that cannot be taken (a guest that
	 * will not answer, a document with no pages) falls back to 1: printing unscaled is the
	 * behaviour every previous version had, and is never worse than printing at a scale
	 * derived from a failed measurement.
	 */
	private async resolveScale(webview: PreviewWebview, page: PageConfig): Promise<number> {
		if (page.fitToPage !== true) return clampScale(page.printScale / 100);
		try {
			const measured = await webview.run<number>(FIT_SCALE_SCRIPT);
			return clampScale(measured);
		} catch (error) {
			console.debug('[multi-exporter] fit-to-page measurement unavailable; printing unscaled', error);
			return 1;
		}
	}

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
	// Drive paged.js's render queue from a timer instead of the compositor.
	//
	// paged.js paginates through a Queue whose run loop calls this.tick.call(window, ...) with
	// tick = requestAnimationFrame. Chromium does not fire rAF in a WebContents it considers
	// hidden — and a bulk export deliberately runs its webview off-screen, where the guest is
	// exactly that. The queue then never dequeues: no pages, no error, no timeout, forever.
	// It is why a single-note export worked (its webview lives in a visible modal) while a
	// folder export hung on the first note every time.
	//
	// Shimmed here, before paged.js is even loaded, because the Queue captures the reference
	// when it is constructed. A timer keeps pagination independent of whether anything is being
	// painted, which is the only sane basis for an off-screen paginator.
	window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(Date.now()), 0);
	window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
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
	${AFTER_PARSED_INSTRUMENT}
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

	// Stage markers, for the watchdog to read back if this never returns.
	//
	// paged.js does a great deal before it lays out a single page — parses the stylesheet with
	// csstree, walks the content, runs every handler's beforeParsed and afterParsed hooks,
	// waits on fonts — and all of it is invisible from out here. A stall with zero pages could
	// be any of those, and without a marker the only honest report is "it stopped". These cost
	// nothing and turn that into a phase.
	window.__mxStage = 'clearing';
	document.body.innerHTML = '';
	const source = document.createElement('div');
	window.__mxStage = 'building-source';
	source.innerHTML = ${JSON.stringify(html)};
	window.__mxSourceElements = source.querySelectorAll('*').length;
	window.__mxStage = 'creating-previewer';
	const previewer = new window.Paged.Previewer();
	window.__mxPreviewer = previewer;
	// The chunker emits these as it goes; the last one recorded is how far it got.
	previewer.on('rendering', () => { window.__mxStage = 'rendering'; });
	previewer.on('page', () => { window.__mxStage = 'laying-out-page'; });
	previewer.on('rendered', () => { window.__mxStage = 'rendered'; });
	instrumentAfterParsed(previewer);
	window.__mxStage = 'preview-called';
	await previewer.preview(source, [{ 'mx-profile.css': ${JSON.stringify(css)} }], document.body);
	window.__mxStage = 'done';
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

/**
 * Write each page's numbering onto the page itself.
 *
 * Every page gets an explicit value for both counters and `counter-increment: none`, so what a
 * page reads is a fact about that page and not a consequence of the ones before it. Leaning on
 * counter *scope* instead — one reset per note, carried across the pages that follow — was
 * tried and produced correct restart pages separated by nonsense; `core/page-numbering.ts`
 * records the measurements.
 *
 * Set inline rather than through a stylesheet so nothing has to be cleaned up between runs:
 * every pagination rebuilds the page elements from scratch.
 */
function numberingScript(stamps: readonly PageStamp[]): string {
	return `(() => {
	const pages = Array.from(document.querySelectorAll('.pagedjs_page'));
	for (const stamp of ${JSON.stringify(stamps)}) {
		const page = pages[stamp.pageIndex];
		if (!page) continue;
		page.style.counterReset = 'page ' + stamp.number + ' pages ' + stamp.total;
		page.style.counterIncrement = 'none';
	}
	return true;
})()`;
}

/** How long the stall diagnostic may take before it is abandoned. */
const STALL_SNAPSHOT_TIMEOUT_MS = 3000;

/** What the paginator had managed to lay out when it stopped making progress. */
interface StallSnapshot {
	pageCount: number;
	/** Characters on the last page. Zero means it stalled before laying anything down. */
	lastPageChars: number;
	/** The last element placed on the last page — the thing it got stuck *after*. */
	lastElement: string | null;
	/** The element queued behind it, which is usually the one it cannot fit. */
	nextElement: string | null;
	/** How far the paginate script got before it stopped answering. */
	stage: string | null;
	/** Elements in the document being paginated — a size check, not a diagnosis. */
	sourceElements: number | null;
	/** Whether paged.js reached the point of building its page container. */
	pagesAreaBuilt: boolean;
	/** Font faces the document is still waiting on; a stuck one blocks layout entirely. */
	fontsPending: number;
	/** Each pre-layout handler by name, and whether it finished. */
	hooks: Record<string, string> | null;
}

/**
 * Name the element pagination died on.
 *
 * A page count says *that* something is wrong; this says *what*. The last element placed and
 * the one queued behind it are almost always the answer — an image or a code block taller than
 * the page box, a table row that cannot be split — and without them a stall report is a number
 * the user can do nothing with. Sizes are included because "taller than the page" is the whole
 * diagnosis in most cases.
 */
const STALL_SNAPSHOT_SCRIPT = `(() => {
	const describe = (element) => {
		if (!element) return null;
		const tag = element.tagName ? element.tagName.toLowerCase() : '?';
		const name = typeof element.className === 'string' && element.className.trim()
			? '.' + element.className.trim().split(/\\s+/).join('.')
			: '';
		const rect = element.getBoundingClientRect();
		const text = (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
		return tag + name + ' [' + Math.round(rect.width) + 'x' + Math.round(rect.height) + ']' + (text ? ' — "' + text + '"' : '');
	};
	const pages = Array.from(document.querySelectorAll('.pagedjs_page'));
	const last = pages[pages.length - 1];
	const content = last ? last.querySelector('.pagedjs_page_content') : null;
	const placed = content ? content.querySelector(':scope > *:last-child') : null;
	let fontsPending = 0;
	try {
		document.fonts.forEach((face) => { if (face.status !== 'loaded' && face.status !== 'error') fontsPending++; });
	} catch (error) { /* no font manager in this guest */ }
	return {
		pageCount: pages.length,
		lastPageChars: content ? (content.textContent || '').trim().length : 0,
		lastElement: describe(placed),
		nextElement: describe(placed ? placed.nextElementSibling : null),
		stage: window.__mxStage || null,
		sourceElements: typeof window.__mxSourceElements === 'number' ? window.__mxSourceElements : null,
		pagesAreaBuilt: Boolean(document.querySelector('.pagedjs_pages')),
		fontsPending: fontsPending,
		hooks: window.__mxHooks || null,
	};
})()`;

/**
 * Label each `afterParsed` hook so a stall inside one can be attributed to a handler.
 *
 * paged.js does a dozen passes over the parsed document before it lays out a single page —
 * page rules, break rules, counters, lists, sibling combinators, footnotes, named strings —
 * and every one of them is an anonymous bound method inside a single hook. When the whole
 * phase hangs, "afterParsed" is as much as anything outside can say, which is not enough to
 * act on.
 *
 * Two facts make the attribution exact. `Handler`'s constructor registers `this[name].bind(this)`
 * for every hook it implements, walking `registeredHandlers` in order; and paged.js exports
 * that list. Filtering it by the same predicate the constructor uses reproduces the
 * registration order exactly, so hook *i* belongs to handler *i*.
 *
 * The handlers are instrumented on the Previewer's chunker, which exists as soon as the
 * Previewer is constructed — before `preview()` is called and long before anything hangs.
 */
const AFTER_PARSED_INSTRUMENT = `const instrumentAfterParsed = (previewer) => {
	try {
		const hook = previewer.chunker && previewer.chunker.hooks && previewer.chunker.hooks.afterParsed;
		if (!hook || !Array.isArray(hook.hooks)) return;
		const names = (window.Paged.registeredHandlers || [])
			.filter((handler) => handler.prototype && 'afterParsed' in handler.prototype)
			.map((handler) => handler.name || 'anonymous');
		window.__mxHooks = {};
		hook.hooks = hook.hooks.map((task, index) => {
			const label = names[index] || ('handler-' + index);
			return function () {
				window.__mxHooks[label] = 'running';
				let result;
				try {
					result = task.apply(this, arguments);
				} catch (error) {
					window.__mxHooks[label] = 'threw: ' + error.message;
					throw error;
				}
				if (result && typeof result.then === 'function') {
					return result.then(
						(value) => { window.__mxHooks[label] = 'done'; return value; },
						(error) => { window.__mxHooks[label] = 'rejected: ' + error.message; throw error; },
					);
				}
				window.__mxHooks[label] = 'done';
				return result;
			};
		});
	} catch (error) {
		// Instrumentation must never be the reason an export fails.
		window.__mxHooks = { instrumentation: 'failed: ' + error.message };
	}
};`;

/** Just the page count — the watchdog's heartbeat, kept as cheap as possible. */
const PAGE_COUNT_SCRIPT = `document.querySelectorAll('.pagedjs_page').length`;

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

/**
 * The scale at which the worst-overflowing element fits its page box.
 *
 * Only leaf elements are measured, and only against the *content* box — the area paged.js
 * gave the flow after margins and furniture. An ancestor is as wide as its widest child, so
 * counting containers too would report the same overflow several times over and change
 * nothing about the answer.
 *
 * Never scales up: an export that fits already is printed at 1. The floor is there because a
 * single runaway element — a 4000px screenshot that resisted `max-width` — must not shrink
 * the body text to nothing; past that point the honest outcome is a clipped figure on a
 * readable page, and the console warning from the diagnostics pass says which element.
 */
const FIT_SCALE_SCRIPT = `(() => {
	const box = document.querySelector('.pagedjs_page_content');
	if (!box) return 1;
	const width = box.clientWidth;
	const height = box.clientHeight;
	if (!width || !height) return 1;
	let worst = 1;
	document.querySelectorAll('.pagedjs_page_content *').forEach((element) => {
		if (element.children.length > 0) return;
		const rect = element.getBoundingClientRect();
		if (!rect.width && !rect.height) return;
		worst = Math.max(worst, rect.width / width, rect.height / height);
	});
	return 1 / worst;
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
 * Turn a stall snapshot into the tail of an error message a user can act on.
 *
 * Zero pages is a different failure from a stall part-way through, and saying so is the whole
 * value here: paged.js creates a page element *before* it lays anything into it, so no pages at
 * all means it never entered the layout loop. Nothing about the page content can be
 * responsible; the cause is in what runs first — the stylesheet, the break rules applied to the
 * parsed document, or a font that never resolves.
 */
function describeStall(snapshot: StallSnapshot | null): string {
	if (snapshot === null) {
		return ' The paginator did not answer a diagnostic query either, which means it is locked solid rather than merely slow.';
	}

	const stage = snapshot.stage === null ? '' : ` It last reported being at “${snapshot.stage}”.`;
	const size =
		snapshot.sourceElements === null ? '' : ` The document has ${snapshot.sourceElements} elements.`;

	if (snapshot.pageCount === 0) {
		const fonts =
			snapshot.fontsPending > 0
				? ` ${snapshot.fontsPending} font face${snapshot.fontsPending === 1 ? '' : 's'} never finished loading, which blocks layout on its own.`
				: '';
		const reached = snapshot.pagesAreaBuilt
			? 'It built its page container but never laid out a first page'
			: 'It never got as far as building its page container';
		const stuckHandler = describeStuckHandlers(snapshot.hooks);
		return (
			` ${reached}, so nothing about the note's content can be the cause — the fault is in what runs` +
			` before layout.${stuckHandler}${stage}${size}${fonts}`
		);
	}

	const parts: string[] = [];
	if (snapshot.lastElement !== null) parts.push(`last placed ${snapshot.lastElement}`);
	if (snapshot.nextElement !== null) parts.push(`then stuck on ${snapshot.nextElement}`);
	if (parts.length === 0) return ` Nothing identifiable was on the last page.${stage}${size}`;
	return ` It got as far as: ${parts.join(', ')}.${stage} Full detail is in the developer console.`;
}

/** Name the pre-layout handler that started and never finished, if there is one. */
function describeStuckHandlers(hooks: Record<string, string> | null): string {
	if (hooks === null) return '';
	const running = Object.entries(hooks).filter(([, state]) => state === 'running');
	if (running.length === 0) {
		const failed = Object.entries(hooks).filter(([, state]) => state !== 'done');
		return failed.length === 0
			? ' Every pre-layout handler finished, so the hang is after them — font loading or the first layout pass.'
			: ` Handlers that did not finish cleanly: ${failed.map(([name, state]) => `${name} (${state})`).join(', ')}.`;
	}
	return ` It is stuck inside paged.js's ${running.map(([name]) => name).join(' and ')} handler${running.length === 1 ? '' : 's'}.`;
}

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
 * The first section carries an extra class, so a profile stylesheet can exempt the opening
 * note from a rule meant for the ones that follow.
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
