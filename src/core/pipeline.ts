import { planAnnotations } from './annotations';
import type { AnnotationClassNames, Endnote } from './annotations';
import { ExportCancelled } from './backend';
import type { ExportBackend, RenderedDocument } from './backend';
import { scanCitations } from './citations';
import type { CitationLinkMatch } from './citations';
import type { ElementLike, RootLike } from './dom';
import type { ExportPlan, PlannedNote } from './export-plan';
import { inlineImages } from './image-inline';
import type { ImageSource, ImageSubstitution } from './image-inline';
import { buildOutline, mergeDocumentOutlines } from './outline';
import type { HeadingRef, OutlineNode } from './outline';
import { BASE_DOCUMENT_CSS, buildPageCss } from './page-css';
import { ExportReport } from './report';
import type { ExportItem, FileWriter } from './writer';
import { writeExportItems } from './writer';
import type { Profile } from './types';

/**
 * The export pipeline, as a pure orchestrator.
 *
 * Every capability it needs — rendering, citations, image bytes, pagination, PDF surgery,
 * disk — arrives as an injected interface, so the whole sequence runs headlessly against
 * fakes. That is what makes the end-to-end path testable at all: the only genuinely
 * untestable parts (a live webview, Chromium's `printToPDF`) sit behind `ExportBackend`,
 * and `tests/fakes/fake-backend.ts` substitutes for them.
 */

export interface RenderedNote {
	sourcePath: string;
	title: string;
	/** Live DOM root for the rendered note; the transforms mutate this. */
	root: RootLike;
}

/** Renders a vault note into DOM using Obsidian's own renderer. Shell-side. */
export interface DocumentRenderer {
	render(sourcePath: string): Promise<RenderedNote>;
	/** Release anything the render held. Called once per note, always. */
	release(note: RenderedNote): void;
}

/**
 * The `zotero-manager` gate, already resolved and version-checked by the shell.
 *
 * `available` false means citation features are off **for this export only** — the export
 * still runs to completion. A missing, disabled or differently-versioned `zotero-manager`
 * must never throw and must never block a non-citation export.
 */
export interface CitationProvider {
	readonly available: boolean;
	/** Whether the vault's cite-suggest template actually produces wikilinks. */
	readonly wikilinkDetection: boolean;
	getAllCiteKeys(): Promise<ReadonlySet<string>>;
	/** Formatted bibliography HTML, or `null` if it could not be produced. */
	getBibliography(citeKeys: readonly string[], cslStyle: string): Promise<string | null>;
}

/** DOM surgery. Implemented over the real DOM in the shell; recorded by a fake in tests. */
export interface DocumentTransforms {
	applyImageSubstitutions(note: RenderedNote, substitutions: readonly ImageSubstitution[]): void;
	markCitations(note: RenderedNote, links: readonly CitationLinkMatch[]): void;
	removeElements(note: RenderedNote, elements: readonly ElementLike[]): void;
	appendEndnotes(note: RenderedNote, endnotes: readonly Endnote[]): void;
	appendBibliography(note: RenderedNote, html: string): void;
	/** Final HTML handed to the backend. */
	serialize(note: RenderedNote): string;
}

/** Writes the bookmark tree into the finished PDF. `pdf-lib` in the shell. */
export interface OutlineInjector {
	inject(pdf: Uint8Array, outline: readonly OutlineNode[]): Promise<Uint8Array>;
}

/** PDF Squeezer's `pdfs` CLI. Absence is not an error. */
export interface PdfCompressor {
	isInstalled(): Promise<boolean>;
	compress(filePath: string, profilePath: string | undefined): Promise<boolean>;
}

export interface PipelineDeps {
	renderer: DocumentRenderer;
	citations: CitationProvider;
	images: ImageSource;
	transforms: DocumentTransforms;
	backend: ExportBackend;
	writer: FileWriter;
	outline: OutlineInjector;
	compressor: PdfCompressor;
	annotationClasses: AnnotationClassNames;
	imageFetchTimeoutMs: number;
	onProgress?: (fraction: number, label: string) => void;
	isCancelled?: () => boolean;
}

export interface PipelineOutcome {
	/** Files actually written. */
	written: string[];
	pageCount: number;
	report: ExportReport;
	cancelled: boolean;
}

/**
 * Run a plan to completion.
 *
 * **Fully serial**, including the render stage. A bounded render worker pool is a plausible
 * optimisation, but pagination and printing share one container by design and so cannot be
 * parallelised at all; shipping a worker pool for the render stage alone, unmeasured, would
 * add a concurrency bug surface for an unknown gain.
 */
export async function runExport(
	plan: ExportPlan,
	profileFallback: Profile,
	deps: PipelineDeps,
	report: ExportReport = new ExportReport(),
): Promise<PipelineOutcome> {
	const cancelled = (): boolean => deps.isCancelled?.() === true;
	const progress = (fraction: number, label: string): void => deps.onProgress?.(fraction, label);

	if (plan.notes.length === 0) {
		report.warn('nothing-to-export', 'No markdown notes matched the selection.');
		return { written: [], pageCount: 0, report, cancelled: false };
	}

	if (!deps.citations.available) {
		report.once(
			'info',
			'citations-unavailable',
			'zotero-manager was not available at version 1, so citations and bibliographies were skipped for this export.',
		);
	} else if (!deps.citations.wikilinkDetection) {
		report.once(
			'warning',
			'citesuggest-template-not-wikilink',
			"zotero-manager's cite-suggest template does not put {{citekey}} inside [[…]], so wikilink citation detection was disabled.",
		);
	}

	const citeKeySet = deps.citations.available ? await deps.citations.getAllCiteKeys() : new Set<string>();

	try {
		return plan.mode === 'merged'
			? await runMerged(plan, plan.mergedProfile ?? profileFallback, citeKeySet, deps, report, cancelled, progress)
			: await runSeparate(plan, citeKeySet, deps, report, cancelled, progress);
	} catch (error) {
		if (error instanceof ExportCancelled) {
			report.info('cancelled', 'Export cancelled.');
			return { written: [], pageCount: 0, report, cancelled: true };
		}
		throw error;
	}
}

async function runSeparate(
	plan: ExportPlan,
	citeKeySet: ReadonlySet<string>,
	deps: PipelineDeps,
	report: ExportReport,
	cancelled: () => boolean,
	progress: (fraction: number, label: string) => void,
): Promise<PipelineOutcome> {
	const items: ExportItem[] = [];
	let pageCount = 0;

	for (let index = 0; index < plan.notes.length; index++) {
		if (cancelled()) throw new ExportCancelled();
		const note = plan.notes[index];
		if (note === undefined || note.destination === null) continue;

		progress(index / plan.notes.length, note.sourcePath);

		const prepared = await prepareDocument(note, citeKeySet, deps, report);
		const css = composeCss(note.profile);
		const result = await deps.backend.export({
			documents: [prepared],
			profile: note.profile,
			css,
			...(deps.isCancelled === undefined ? {} : { isCancelled: deps.isCancelled }),
		});

		const outline = buildOutline(result.headings);
		const pdf = outline.length === 0 ? result.pdf : await deps.outline.inject(result.pdf, outline);
		items.push({ destination: note.destination, sourcePath: note.sourcePath, bytes: pdf });
		pageCount += result.pageCount;
	}

	progress(1, 'Writing');
	const outcome = await writeExportItems(items, deps.writer, report);
	await compressAll(outcome.written, plan.notes[0]?.profile ?? null, deps, report);
	return { written: outcome.written, pageCount, report, cancelled: false };
}

async function runMerged(
	plan: ExportPlan,
	profile: Profile,
	citeKeySet: ReadonlySet<string>,
	deps: PipelineDeps,
	report: ExportReport,
	cancelled: () => boolean,
	progress: (fraction: number, label: string) => void,
): Promise<PipelineOutcome> {
	const documents: RenderedDocument[] = [];

	for (let index = 0; index < plan.notes.length; index++) {
		if (cancelled()) throw new ExportCancelled();
		const note = plan.notes[index];
		if (note === undefined) continue;
		progress((index / plan.notes.length) * 0.6, note.sourcePath);
		documents.push(await prepareDocument({ ...note, profile }, citeKeySet, deps, report));
	}

	progress(0.6, 'Paginating');
	const result = await deps.backend.export({
		documents,
		profile,
		css: composeCss(profile),
		...(deps.isCancelled === undefined ? {} : { isCancelled: deps.isCancelled }),
	});

	// Merged mode paginates once, so page indices are already continuous — no offsetting.
	const outline = mergeDocumentOutlines(
		documents.map((document, index) => ({
			title: document.title,
			startPageIndex: result.documentStartPages[index] ?? 0,
			headings: headingsForDocument(result.headings, result.documentStartPages, index),
		})),
	);

	progress(0.9, 'Writing');
	const pdf = outline.length === 0 ? result.pdf : await deps.outline.inject(result.pdf, outline);
	const destination = plan.mergedDestination;
	if (destination === null) {
		report.error('no-destination', 'Merged export had no output file.');
		return { written: [], pageCount: result.pageCount, report, cancelled: false };
	}

	const outcome = await writeExportItems(
		[{ destination, sourcePath: plan.notes[0]?.sourcePath ?? '', bytes: pdf }],
		deps.writer,
		report,
	);
	await compressAll(outcome.written, profile, deps, report);
	progress(1, 'Done');
	return { written: outcome.written, pageCount: result.pageCount, report, cancelled: false };
}

/**
 * Headings belonging to document `index`, i.e. those on pages from its start page up to the
 * next document's start page.
 */
function headingsForDocument(
	headings: readonly HeadingRef[],
	startPages: readonly number[],
	index: number,
): HeadingRef[] {
	const start = startPages[index] ?? 0;
	const end = startPages[index + 1] ?? Number.POSITIVE_INFINITY;
	return headings.filter((heading) => heading.pageIndex >= start && heading.pageIndex < end);
}

/**
 * Render one note and run every pre-pagination transform over it, in the order the
 * architecture specifies: citations, then images, then annotations.
 */
async function prepareDocument(
	note: PlannedNote,
	citeKeySet: ReadonlySet<string>,
	deps: PipelineDeps,
	report: ExportReport,
): Promise<RenderedDocument> {
	const rendered = await deps.renderer.render(note.sourcePath);
	try {
		const flags = note.profile.flags;

		if (flags.resolveCitations && deps.citations.available) {
			const scan = scanCitations(rendered.root, citeKeySet, {
				wikilinkDetection: deps.citations.wikilinkDetection,
				pandocTextScan: flags.pandocCitationScan,
			});
			deps.transforms.markCitations(rendered, scan.links);

			if (flags.emitBibliography && scan.citeKeys.length > 0) {
				const html = await deps.citations.getBibliography(scan.citeKeys, note.profile.cslStyle);
				if (html === null) {
					report.warn('bibliography-failed', 'The bibliography could not be produced.', note.sourcePath);
				} else {
					deps.transforms.appendBibliography(rendered, html);
				}
			}
		}

		if (flags.inlineImages) {
			const result = await inlineImages(rendered.root, deps.images, report, {
				timeoutMs: deps.imageFetchTimeoutMs,
			});
			deps.transforms.applyImageSubstitutions(rendered, result.substitutions);
		}

		const annotations = planAnnotations(rendered.root, flags.annotationMode, deps.annotationClasses);
		if (annotations.removals.length > 0) deps.transforms.removeElements(rendered, annotations.removals);
		if (annotations.endnotes.length > 0) deps.transforms.appendEndnotes(rendered, annotations.endnotes);

		return { sourcePath: note.sourcePath, title: note.title, html: deps.transforms.serialize(rendered) };
	} finally {
		deps.renderer.release(rendered);
	}
}

/**
 * The full stylesheet for an export, in cascade order: normalisation, then the generated
 * `@page` rules, then the profile's own CSS. The profile wins every tie by coming last.
 */
export function composeCss(profile: Profile): string {
	return `${BASE_DOCUMENT_CSS}\n\n${buildPageCss(profile.page)}\n\n${profile.stylesheet}`;
}

async function compressAll(
	written: readonly string[],
	profile: Profile | null,
	deps: PipelineDeps,
	report: ExportReport,
): Promise<void> {
	if (profile === null || !profile.flags.runSqueezer || written.length === 0) return;
	if (!(await deps.compressor.isInstalled())) {
		report.once('info', 'squeezer-missing', 'PDF Squeezer (pdfs) is not installed, so compression was skipped.');
		return;
	}
	for (const filePath of written) {
		const ok = await deps.compressor.compress(filePath, profile.flags.squeezerProfile);
		if (!ok) report.warn('squeezer-failed', 'PDF Squeezer could not compress this file.', filePath);
	}
}
