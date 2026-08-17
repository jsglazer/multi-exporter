import { describe, expect, it } from 'vitest';
import type { AnnotationClassNames, Endnote } from '../src/core/annotations';
import type { CitationLinkMatch } from '../src/core/citations';
import type { ElementLike } from '../src/core/dom';
import { planMergedExport, planSeparateExport } from '../src/core/export-plan';
import type { FetchedImage, ImageSource, ImageSubstitution } from '../src/core/image-inline';
import { runExport } from '../src/core/pipeline';
import type {
	CitationProvider,
	DocumentRenderer,
	DocumentTransforms,
	OutlineInjector,
	PdfCompressor,
	PipelineDeps,
	RenderedNote,
} from '../src/core/pipeline';
import type { OutlineNode } from '../src/core/outline';
import { createDefaultProfiles } from '../src/core/profiles';
import { ExportReport } from '../src/core/report';
import type { Profile } from '../src/core/types';
import { InMemoryFileWriter } from '../src/core/writer';
import { FakeBackend, serializeMockChildren } from './fakes/fake-backend';
import { el, internalLink, MockElement, root } from './fakes/mock-dom';

/**
 * End-to-end export, driven entirely by fakes.
 *
 * Decision: v1 ships one real backend plus "a test-only fake backend under `tests/` that
 * drives an export end to end". This is that test. Nothing here touches Obsidian, Electron,
 * the network or a disk — the whole pipeline runs in-process and deterministically.
 */

const CLASSES: AnnotationClassNames = {
	host: 'gutter-host',
	card: 'gutter-card',
	text: 'gutter-text',
	number: 'gutter-num',
	hidden: 'gutter-hidden',
	leader: 'gutter-leader',
	tick: 'gutter-tick',
};

const profiles = createDefaultProfiles();
const article = profiles.find((profile) => profile.id === 'article') as Profile;
const manuscript = profiles.find((profile) => profile.id === 'manuscript') as Profile;

/** Builds a mock note tree per path. */
class FakeRenderer implements DocumentRenderer {
	readonly rendered: string[] = [];
	readonly released: string[] = [];

	constructor(private readonly trees: Record<string, () => MockElement>) {}

	render(sourcePath: string): Promise<RenderedNote> {
		this.rendered.push(sourcePath);
		const build = this.trees[sourcePath];
		if (build === undefined) throw new Error(`No fixture for ${sourcePath}`);
		return Promise.resolve({
			sourcePath,
			title: sourcePath.replace(/\.md$/, '').split('/').pop() ?? sourcePath,
			root: build(),
		});
	}

	release(note: RenderedNote): void {
		this.released.push(note.sourcePath);
	}
}

/** Records what the pipeline asked to be done to the DOM, and serialises the tree. */
class RecordingTransforms implements DocumentTransforms {
	readonly citations: CitationLinkMatch[] = [];
	readonly substitutions: ImageSubstitution[] = [];
	readonly removed: ElementLike[] = [];
	readonly endnotes: Endnote[] = [];
	readonly bibliographies: string[] = [];

	applyImageSubstitutions(_note: RenderedNote, substitutions: readonly ImageSubstitution[]): void {
		this.substitutions.push(...substitutions);
	}

	markCitations(_note: RenderedNote, links: readonly CitationLinkMatch[]): void {
		this.citations.push(...links);
	}

	removeElements(_note: RenderedNote, elements: readonly ElementLike[]): void {
		this.removed.push(...elements);
	}

	appendEndnotes(_note: RenderedNote, endnotes: readonly Endnote[]): void {
		this.endnotes.push(...endnotes);
	}

	appendBibliography(_note: RenderedNote, html: string): void {
		this.bibliographies.push(html);
	}

	serialize(note: RenderedNote): string {
		return serializeMockChildren(note.root as unknown as MockElement);
	}
}

class RecordingOutlineInjector implements OutlineInjector {
	readonly injected: OutlineNode[][] = [];

	inject(pdf: Uint8Array, outline: readonly OutlineNode[]): Promise<Uint8Array> {
		this.injected.push([...outline]);
		return Promise.resolve(new Uint8Array([...pdf, 0x21]));
	}
}

class FakeCompressor implements PdfCompressor {
	readonly compressed: string[] = [];

	constructor(
		private readonly installed: boolean,
		private readonly succeeds = true,
	) {}

	isInstalled(): Promise<boolean> {
		return Promise.resolve(this.installed);
	}

	compress(filePath: string): Promise<boolean> {
		this.compressed.push(filePath);
		return Promise.resolve(this.succeeds);
	}
}

function citationProvider(overrides: Partial<CitationProvider> = {}): CitationProvider {
	return {
		available: true,
		wikilinkDetection: true,
		getAllCiteKeys: () => Promise.resolve(new Set(['smith2020'])),
		getBibliography: () => Promise.resolve('<div>Smith, J. (2020).</div>'),
		...overrides,
	};
}

const noImages: ImageSource = { fetch: (): Promise<FetchedImage | null> => Promise.resolve(null) };

function chapter(title: string, extra: MockElement[] = []): MockElement {
	return root(
		el({ tag: 'h1', text: title }),
		el({ tag: 'p', text: 'Opening paragraph.' }),
		el({ tag: 'h2', text: `${title} — detail` }),
		el({ tag: 'p', text: 'More text.' }),
		...extra,
	);
}

interface Harness {
	deps: PipelineDeps;
	writer: InMemoryFileWriter;
	backend: FakeBackend;
	transforms: RecordingTransforms;
	renderer: FakeRenderer;
	outline: RecordingOutlineInjector;
	compressor: FakeCompressor;
	report: ExportReport;
}

function harness(
	trees: Record<string, () => MockElement>,
	overrides: Partial<PipelineDeps> = {},
	compressor = new FakeCompressor(false),
): Harness {
	const writer = new InMemoryFileWriter();
	const backend = new FakeBackend();
	const transforms = new RecordingTransforms();
	const renderer = new FakeRenderer(trees);
	const outline = new RecordingOutlineInjector();
	const report = new ExportReport();

	const deps: PipelineDeps = {
		renderer,
		citations: citationProvider(),
		images: noImages,
		transforms,
		backend,
		writer,
		outline,
		compressor,
		annotationClasses: CLASSES,
		imageFetchTimeoutMs: 1000,
		...overrides,
	};

	return { deps, writer, backend, transforms, renderer, outline, compressor, report };
}

describe('separate export, end to end', () => {
	const trees = {
		'Research/One.md': () => chapter('One'),
		'Research/Sub/Two.md': () => chapter('Two'),
	};

	const plan = (): ReturnType<typeof planSeparateExport> =>
		planSeparateExport({
			paths: ['Research/One.md', 'Research/Sub/Two.md'],
			sourceRoot: 'Research',
			outputDir: '/out',
			profiles,
			folderProfiles: {},
			defaultProfileId: 'article',
			overrideProfile: article,
		});

	it('writes one PDF per note, reproducing the hierarchy', async () => {
		const h = harness(trees);
		const outcome = await runExport(plan(), article, h.deps, h.report);

		expect(outcome.cancelled).toBe(false);
		expect(outcome.written).toEqual(['/out/One.pdf', '/out/Sub/Two.pdf']);
		expect(h.writer.paths).toEqual(['/out/One.pdf', '/out/Sub/Two.pdf']);
		expect(h.writer.dirs.has('/out/Sub')).toBe(true);
	});

	it('renders and releases every note', async () => {
		const h = harness(trees);
		await runExport(plan(), article, h.deps, h.report);
		expect(h.renderer.rendered).toEqual(['Research/One.md', 'Research/Sub/Two.md']);
		expect(h.renderer.released).toEqual(['Research/One.md', 'Research/Sub/Two.md']);
	});

	it('builds an outline per document and injects it', async () => {
		const h = harness(trees);
		await runExport(plan(), article, h.deps, h.report);

		expect(h.outline.injected).toHaveLength(2);
		expect(h.outline.injected[0]?.map((node) => node.title)).toEqual(['One']);
		expect(h.outline.injected[0]?.[0]?.children.map((node) => node.title)).toEqual(['One — detail']);
	});

	it('runs the export fully serially', async () => {
		const h = harness(trees);
		await runExport(plan(), article, h.deps, h.report);
		// One backend call per note, in order — never a batch and never concurrent.
		expect(h.backend.exportCalls).toHaveLength(2);
		expect(h.backend.exportCalls.map((call) => call.documents[0]?.sourcePath)).toEqual([
			'Research/One.md',
			'Research/Sub/Two.md',
		]);
	});

	it('produces the same bytes and paths on a repeat run', async () => {
		const first = harness(trees);
		const second = harness(trees);
		await runExport(plan(), article, first.deps, first.report);
		await runExport(plan(), article, second.deps, second.report);
		expect(first.writer.paths).toEqual(second.writer.paths);
		expect(first.writer.files.get('/out/One.pdf')).toEqual(second.writer.files.get('/out/One.pdf'));
	});
});

describe('merged export, end to end', () => {
	const trees = {
		'A/One.md': () => chapter('One'),
		'A/Two.md': () => chapter('Two'),
	};

	const plan = (): ReturnType<typeof planMergedExport> =>
		planMergedExport({ paths: ['A/One.md', 'A/Two.md'], outputFile: '/out/Merged.pdf', profile: article });

	it('writes a single file', async () => {
		const h = harness(trees);
		const outcome = await runExport(plan(), article, h.deps, h.report);
		expect(outcome.written).toEqual(['/out/Merged.pdf']);
		expect(h.backend.exportCalls).toHaveLength(1);
		expect(h.backend.exportCalls[0]?.documents).toHaveLength(2);
	});

	// Continuous pagination across concatenated documents is what a real paginator gives
	// you and what per-file printing cannot.
	it('paginates once, so page numbering is continuous', async () => {
		const h = harness(trees);
		const outcome = await runExport(plan(), article, h.deps, h.report);
		expect(outcome.pageCount).toBe(4);
	});

	it('gives each document a top-level bookmark with its own headings nested', async () => {
		const h = harness(trees);
		await runExport(plan(), article, h.deps, h.report);

		const outline = h.outline.injected[0] ?? [];
		expect(outline.map((node) => node.title)).toEqual(['One', 'Two']);
		expect(outline[0]?.children.map((node) => node.title)).toEqual(['One']);
		expect(outline[0]?.children[0]?.children.map((node) => node.title)).toEqual(['One — detail']);
		expect(outline[1]?.pageIndex).toBe(2);
	});

	it('uses one profile for the whole document', async () => {
		const h = harness(trees);
		await runExport(
			planMergedExport({ paths: ['A/One.md', 'A/Two.md'], outputFile: '/out/M.pdf', profile: manuscript }),
			article,
			h.deps,
			h.report,
		);
		expect(h.backend.exportCalls[0]?.profile.id).toBe('manuscript');
	});
});

describe('citations through the pipeline', () => {
	const cited = (): MockElement =>
		root(
			el({ tag: 'h1', text: 'Chapter' }),
			el({ tag: 'p', children: [internalLink('smith2020'), internalLink('Ordinary note')] }),
		);

	function citePlan(profile: Profile): ReturnType<typeof planSeparateExport> {
		return planSeparateExport({
			paths: ['Cited.md'],
			sourceRoot: '',
			outputDir: '/out',
			profiles,
			folderProfiles: {},
			defaultProfileId: profile.id,
			overrideProfile: profile,
		});
	}

	it('marks matched links and appends the bibliography', async () => {
		const h = harness({ 'Cited.md': cited });
		await runExport(citePlan(manuscript), manuscript, h.deps, h.report);

		expect(h.transforms.citations.map((link) => link.citeKey)).toEqual(['smith2020']);
		expect(h.transforms.bibliographies).toEqual(['<div>Smith, J. (2020).</div>']);
	});

	it('does neither when the profile flag is off', async () => {
		const h = harness({ 'Cited.md': cited });
		await runExport(citePlan(article), article, h.deps, h.report);
		expect(h.transforms.citations).toEqual([]);
		expect(h.transforms.bibliographies).toEqual([]);
	});

	// The gate: a missing, disabled or differently-versioned zotero-manager disables
	// citation features for the export, completes the export, and reports it once.
	it('completes the export and reports once when zotero-manager is unavailable', async () => {
		const h = harness(
			{ 'Cited.md': cited },
			{
				citations: {
					available: false,
					wikilinkDetection: false,
					getAllCiteKeys: () => Promise.resolve(new Set<string>()),
					getBibliography: () => Promise.resolve(null),
				},
			},
		);
		const outcome = await runExport(citePlan(manuscript), manuscript, h.deps, h.report);

		expect(outcome.written).toEqual(['/out/Cited.pdf']);
		expect(outcome.report.has('citations-unavailable')).toBe(true);
		expect(outcome.report.errors).toHaveLength(0);
		expect(h.transforms.citations).toEqual([]);
	});

	// Decision: a non-wikilink citeSuggestTemplate disables wikilink detection and shows one
	// notice — it is never parsed for keys.
	it('reports the template shape once when it is not wikilink-shaped', async () => {
		const h = harness(
			{ 'Cited.md': cited },
			{ citations: citationProvider({ wikilinkDetection: false }) },
		);
		const outcome = await runExport(citePlan(manuscript), manuscript, h.deps, h.report);

		expect(outcome.report.has('citesuggest-template-not-wikilink')).toBe(true);
		expect(h.transforms.citations).toEqual([]);
		expect(outcome.written).toEqual(['/out/Cited.pdf']);
	});

	it('reports a bibliography failure without failing the export', async () => {
		const h = harness(
			{ 'Cited.md': cited },
			{ citations: citationProvider({ getBibliography: () => Promise.resolve(null) }) },
		);
		const outcome = await runExport(citePlan(manuscript), manuscript, h.deps, h.report);

		expect(outcome.report.has('bibliography-failed')).toBe(true);
		expect(outcome.written).toEqual(['/out/Cited.pdf']);
	});
});

describe('annotations through the pipeline', () => {
	const annotated = (): MockElement =>
		root(
			el({ tag: 'h1', text: 'Chapter' }),
			el({ tag: 'p', text: 'Body.' }),
			el({
				classes: ['gutter-host'],
				children: [
					el({ classes: ['gutter-card'], children: [el({ classes: ['gutter-text'], text: 'A comment' })] }),
				],
			}),
		);

	it('appends endnotes when the profile says endnotes', async () => {
		const h = harness({ 'A.md': annotated });
		await runExport(
			planSeparateExport({
				paths: ['A.md'],
				sourceRoot: '',
				outputDir: '/out',
				profiles,
				folderProfiles: {},
				defaultProfileId: 'manuscript',
				overrideProfile: manuscript,
			}),
			manuscript,
			h.deps,
			h.report,
		);

		expect(h.transforms.endnotes.map((note) => note.text)).toEqual(['A comment']);
	});
});

describe('images through the pipeline', () => {
	it('records a non-fatal failure and still writes the file', async () => {
		const withImage = (): MockElement =>
			root(el({ tag: 'h1', text: 'Clip' }), el({ tag: 'img', attrs: { src: 'https://x/dead.png' } }));
		const h = harness({ 'Clip.md': withImage });

		const outcome = await runExport(
			planSeparateExport({
				paths: ['Clip.md'],
				sourceRoot: '',
				outputDir: '/out',
				profiles,
				folderProfiles: {},
				defaultProfileId: 'article',
				overrideProfile: article,
			}),
			article,
			h.deps,
			h.report,
		);

		expect(outcome.report.has('image-inline-failed')).toBe(true);
		expect(h.transforms.substitutions[0]?.failed).toBe(true);
		expect(outcome.written).toEqual(['/out/Clip.pdf']);
	});
});

describe('compression', () => {
	const plan = (profile: Profile): ReturnType<typeof planSeparateExport> =>
		planSeparateExport({
			paths: ['A.md'],
			sourceRoot: '',
			outputDir: '/out',
			profiles,
			folderProfiles: {},
			defaultProfileId: profile.id,
			overrideProfile: profile,
		});

	const squeezed: Profile = { ...article, flags: { ...article.flags, runSqueezer: true } };

	it('skips compression and says so when pdfs is not installed', async () => {
		const h = harness({ 'A.md': () => chapter('A') }, {}, new FakeCompressor(false));
		const outcome = await runExport(plan(squeezed), squeezed, h.deps, h.report);

		expect(outcome.report.has('squeezer-missing')).toBe(true);
		expect(h.compressor.compressed).toEqual([]);
		expect(outcome.written).toEqual(['/out/A.pdf']);
	});

	it('compresses every written file when it is installed', async () => {
		const h = harness({ 'A.md': () => chapter('A') }, {}, new FakeCompressor(true));
		await runExport(plan(squeezed), squeezed, h.deps, h.report);
		expect(h.compressor.compressed).toEqual(['/out/A.pdf']);
	});

	it('does not run at all when the flag is off', async () => {
		const h = harness({ 'A.md': () => chapter('A') }, {}, new FakeCompressor(true));
		await runExport(plan(article), article, h.deps, h.report);
		expect(h.compressor.compressed).toEqual([]);
	});
});

describe('cancellation and empty plans', () => {
	it('reports an empty selection rather than writing nothing silently', async () => {
		const h = harness({});
		const outcome = await runExport(
			planSeparateExport({
				paths: [],
				sourceRoot: '',
				outputDir: '/out',
				profiles,
				folderProfiles: {},
				defaultProfileId: 'article',
				overrideProfile: article,
			}),
			article,
			h.deps,
			h.report,
		);

		expect(outcome.written).toEqual([]);
		expect(outcome.report.has('nothing-to-export')).toBe(true);
	});

	it('stops cleanly when cancelled, writing nothing', async () => {
		const h = harness(
			{ 'A.md': () => chapter('A'), 'B.md': () => chapter('B') },
			{ isCancelled: () => true },
		);
		const outcome = await runExport(
			planSeparateExport({
				paths: ['A.md', 'B.md'],
				sourceRoot: '',
				outputDir: '/out',
				profiles,
				folderProfiles: {},
				defaultProfileId: 'article',
				overrideProfile: article,
			}),
			article,
			h.deps,
			h.report,
		);

		expect(outcome.cancelled).toBe(true);
		expect(outcome.written).toEqual([]);
		expect(h.writer.paths).toEqual([]);
	});

	it('reports progress monotonically', async () => {
		const seen: number[] = [];
		const h = harness(
			{ 'A.md': () => chapter('A'), 'B.md': () => chapter('B') },
			{ onProgress: (fraction) => seen.push(fraction) },
		);
		await runExport(
			planSeparateExport({
				paths: ['A.md', 'B.md'],
				sourceRoot: '',
				outputDir: '/out',
				profiles,
				folderProfiles: {},
				defaultProfileId: 'article',
				overrideProfile: article,
			}),
			article,
			h.deps,
			h.report,
		);

		expect(seen.length).toBeGreaterThan(0);
		expect([...seen].sort((a, b) => a - b)).toEqual(seen);
		expect(seen[seen.length - 1]).toBe(1);
	});
});
