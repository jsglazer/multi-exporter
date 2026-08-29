import { planAnnotationStrip, planAnnotations } from './annotations';
import type {
	AnnotationCategoryColors,
	AnnotationPlan,
	AnnotationRecord,
	AnnotationStripClasses,
	AnnotationStripPlan,
} from './annotations';
import { ExportCancelled } from './backend';
import type { ExportBackend, RenderedDocument } from './backend';
import { scanCitations } from './citations';
import type { CitationLinkMatch } from './citations';
import type { ElementLike, NodeLike, RootLike } from './dom';
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
	/**
	 * Live DOM root for the rendered note; the transforms mutate this.
	 *
	 * Both halves of the structural surface, because locating annotations has to *walk* the
	 * tree — `querySelectorAll` alone cannot tell you what order two pieces of text are in.
	 */
	root: RootLike & NodeLike;
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

/**
 * The `md-annotation` gate, already resolved by the shell.
 *
 * Exactly the same contract as `CitationProvider`: `available` false means annotations are
 * off **for this export only** and the export still runs to completion. A missing, disabled
 * or differently-shaped `md-annotation` must never throw and must never fail an export.
 */
export interface AnnotationProvider {
	readonly available: boolean;
	/** Highlight colours per category name, as configured in `md-annotation`. */
	readonly categoryColors: AnnotationCategoryColors;
	/** The note's annotation records, straight from the other plugin's API. */
	getAnnotations(sourcePath: string): Promise<AnnotationRecord[]>;
}

/** DOM surgery. Implemented over the real DOM in the shell; recorded by a fake in tests. */
export interface DocumentTransforms {
	applyImageSubstitutions(note: RenderedNote, substitutions: readonly ImageSubstitution[]): void;
	markCitations(note: RenderedNote, links: readonly CitationLinkMatch[]): void;
	removeElements(note: RenderedNote, elements: readonly ElementLike[]): void;
	/** Take another plugin's rendered annotation markup back out, before anything is located. */
	stripPluginAnnotations(note: RenderedNote, plan: AnnotationStripPlan): void;
	/** Draw the annotations: highlights, markers, and either gutter cards or an endnote list. */
	applyAnnotations(note: RenderedNote, plan: AnnotationPlan, colors: AnnotationCategoryColors): void;
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
	annotations: AnnotationProvider;
	images: ImageSource;
	transforms: DocumentTransforms;
	backend: ExportBackend;
	writer: FileWriter;
	outline: OutlineInjector;
	compressor: PdfCompressor;
	annotationStripClasses: AnnotationStripClasses;
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
 * What `prepareDocument` needs, which is strictly less than a whole pipeline.
 *
 * Named so the preview can run the identical preparation without inventing a backend, a
 * writer, an outline injector and a compressor it has no use for.
 */
export type DocumentPrepDeps = Pick<
	PipelineDeps,
	'renderer' | 'citations' | 'annotations' | 'images' | 'transforms' | 'annotationStripClasses' | 'imageFetchTimeoutMs'
>;

/**
 * Render one note and run every pre-pagination transform over it, in the order the
 * architecture specifies: citations, then images, then annotations.
 *
 * Exported because **the preview must run this too**. A preview that renders and serialises
 * without inlining images shows broken images the export would never produce — the drift
 * this plugin exists to eliminate, reintroduced in the one place that advertises its
 * absence.
 */
export async function prepareDocument(
	note: PlannedNote,
	citeKeySet: ReadonlySet<string>,
	deps: DocumentPrepDeps,
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

		await applyAnnotations(rendered, note, deps, report);

		return { sourcePath: note.sourcePath, title: note.title, html: deps.transforms.serialize(rendered) };
	} finally {
		deps.renderer.release(rendered);
	}
}

/**
 * Annotations, last of the three transforms.
 *
 * Two passes over the tree, and the order between them is not negotiable. `md-annotation`'s
 * own post-processor output is stripped **first**: its markers are elements that carry text
 * of their own, and leaving one in the middle of a sentence would shift every character
 * offset after it, so every annotation past the first would be located slightly wrong.
 *
 * The strip runs whenever the profile wants annotations at all, including in `off` mode —
 * `off` means *no annotations in the PDF*, and the other plugin's leftovers are annotations.
 */
async function applyAnnotations(
	rendered: RenderedNote,
	note: PlannedNote,
	deps: DocumentPrepDeps,
	report: ExportReport,
): Promise<void> {
	const mode = note.profile.flags.annotationMode;
	const strip = planAnnotationStrip(rendered.root, deps.annotationStripClasses);
	if (strip.unwrap.length > 0 || strip.remove.length > 0) deps.transforms.stripPluginAnnotations(rendered, strip);
	if (mode === 'off' || !deps.annotations.available) return;

	const records = await deps.annotations.getAnnotations(note.sourcePath);
	// A profile with annotations enabled on a note that has none is an ordinary thing to do.
	if (records.length === 0) return;

	const plan = planAnnotations(rendered.root, mode, records, [ANNOTATION_SKIP_CLASSES.bibliography]);
	deps.transforms.applyAnnotations(rendered, plan, deps.annotations.categoryColors);

	// An annotation that could not be placed is reported, never dropped silently: the note
	// was edited out from under the selector, and the only honest thing to do is say which.
	for (const orphan of plan.unmatched) {
		report.warn(
			'annotation-unmatched',
			`An annotation could not be located in the rendered note, so it was left out: "${excerpt(orphan)}"`,
			note.sourcePath,
		);
	}
}

/** Subtrees the export appended itself, which are not the note and must not attract a match. */
const ANNOTATION_SKIP_CLASSES = { bibliography: 'mx-bibliography' };

/** A short, single-line identification of an annotation, for a warning line. */
function excerpt(record: AnnotationRecord): string {
	const text = (record.selector.exact === '' ? record.comment : record.selector.exact).replace(/\s+/g, ' ').trim();
	return text.length > 60 ? `${text.slice(0, 57)}…` : text;
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
