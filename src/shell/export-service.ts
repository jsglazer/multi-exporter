import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import { MD_ANNOTATION_CLASSES } from '../adapter/obsidian-internals';
import type { ExportPlan } from '../core/export-plan';
import { runExport } from '../core/pipeline';
import type { PipelineDeps, PipelineOutcome } from '../core/pipeline';
import { ExportReport } from '../core/report';
import type { PluginSettings, Profile } from '../core/types';
import { NodeFileWriter } from './fs-writer';
import { ObsidianImageSource } from './image-source';
import { PagedJsWebviewBackend } from './pagedjs-backend';
import { PdfLibOutlineInjector } from './pdf-outline';
import { ObsidianDocumentRenderer } from './render';
import { PdfSqueezerCompressor } from './squeezer';
import { DomTransforms } from './transforms';
import { describeGateReason, resolveCitationGate } from './zotero';

/**
 * Assembles the pipeline's dependencies and runs a plan.
 *
 * This is the seam between "everything that can be tested headlessly" and "everything that
 * needs Electron". It contains no decisions — every decision it looks like it is making was
 * made in `src/core/` — so there is nothing here a test would want to reach.
 */

export const RENDER_HOST_ROOT_CLASS = 'mx-render-host-root';

export interface ExportRunOptions {
	plan: ExportPlan;
	profileFallback: Profile;
	onProgress?: (fraction: number, label: string) => void;
	isCancelled?: () => boolean;
	/** An already-open backend to reuse, so the preview's container is the one that prints. */
	backend?: PagedJsWebviewBackend;
}

export class ExportService {
	private readonly writer = new NodeFileWriter();
	private readonly outline = new PdfLibOutlineInjector();
	private readonly compressor = new PdfSqueezerCompressor();
	private readonly transforms = new DomTransforms();

	constructor(
		private readonly app: App,
		private readonly getSettings: () => PluginSettings,
	) {}

	/**
	 * Off-screen host for rendering notes into DOM, attached to the document body.
	 *
	 * Positioned off-screen with real dimensions rather than hidden — Dataview and Datacore
	 * measure their containers, and a collapsed box gives them nothing to measure.
	 */
	createRenderHost(): HTMLElement {
		return activeDocument.body.createDiv({ cls: RENDER_HOST_ROOT_CLASS });
	}

	async run(options: ExportRunOptions): Promise<PipelineOutcome> {
		const settings = this.getSettings();
		const report = new ExportReport();
		const host = this.createRenderHost();
		const ownsBackend = options.backend === undefined;
		const backend = options.backend ?? new PagedJsWebviewBackend(host);

		// The citation gate is resolved here, once per export, and never in `onload`: plugin
		// load order is not something either plugin controls.
		const wantsCitations = options.plan.notes.some((note) => note.profile.flags.resolveCitations);
		const gate = await resolveCitationGate(this.app, wantsCitations);
		if (gate.reason !== 'ok') {
			report.once('warning', `citations-${gate.reason}`, describeGateReason(gate.reason));
		}

		const deps: PipelineDeps = {
			renderer: new ObsidianDocumentRenderer(this.app, host),
			citations: gate.provider,
			images: new ObsidianImageSource(this.app),
			transforms: this.transforms,
			backend,
			writer: this.writer,
			outline: this.outline,
			compressor: this.compressor,
			annotationClasses: MD_ANNOTATION_CLASSES,
			imageFetchTimeoutMs: settings.imageFetchTimeoutMs,
			...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
			...(options.isCancelled === undefined ? {} : { isCancelled: options.isCancelled }),
		};

		try {
			return await runExport(options.plan, options.profileFallback, deps, report);
		} finally {
			// Teardown is explicit and unconditional. A live webview holds a WebContents;
			// leaving one attached leaks a renderer process and blocks plugin removal.
			if (ownsBackend) await backend.dispose();
			host.detach();
		}
	}
}

/** Surface a finished export: one Notice, with the report's own counts. */
export function announceOutcome(outcome: PipelineOutcome): void {
	if (outcome.cancelled) {
		new Notice('Export cancelled.');
		return;
	}
	const errors = outcome.report.errors.length;
	const warnings = outcome.report.warnings.length;
	const files = outcome.written.length;
	const suffix =
		errors > 0
			? ` — ${errors} error${errors === 1 ? '' : 's'}`
			: warnings > 0
				? ` — ${warnings} warning${warnings === 1 ? '' : 's'}`
				: '';
	new Notice(
		files === 0
			? `Nothing was exported${suffix}.`
			: `Exported ${files} file${files === 1 ? '' : 's'}, ${outcome.pageCount} page${outcome.pageCount === 1 ? '' : 's'}${suffix}.`,
	);
}
