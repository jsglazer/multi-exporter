import { Modal, Notice, Setting, TFile, TFolder } from 'obsidian';
import type { App } from 'obsidian';
import { showDirectoryDialog, showPdfSaveDialog } from '../adapter/obsidian-internals';
import { isExportableNote, planMergedExport, planSeparateExport } from '../core/export-plan';
import type { ExportPlan } from '../core/export-plan';
import { sanitizeFileName } from '../core/paths';
import type { BulkExportMode, PluginSettings, Profile } from '../core/types';
import { announceOutcome, ExportService } from './export-service';
import { describeError } from './export-modal';

/**
 * Bulk folder export.
 *
 * Two modes with genuinely different semantics:
 *
 * - **Separate** — one PDF per note, reproducing the source hierarchy on disk. Each note
 *   keeps its own folder-default profile unless one is chosen here.
 * - **Merged** — a single PDF with continuous page numbering and a combined outline. It
 *   uses **exactly one profile** for the whole document: a merged document with per-note
 *   page geometry is not a document, and continuous numbering across it means nothing.
 *
 * Merged mode is what justifies the architecture — continuous pagination across
 * concatenated documents is precisely what a real paginator gives you and what per-file
 * printing cannot.
 */
export class FolderExportModal extends Modal {
	private mode: BulkExportMode = 'separate';
	private profile: Profile;
	private useFolderDefaults = true;
	private cancelled = false;
	private running = false;
	private progressEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly folder: TFolder,
		private readonly settings: PluginSettings,
		private readonly service: ExportService,
	) {
		super(app);
		this.profile =
			settings.profiles.find((profile) => profile.id === settings.defaultProfileId) ??
			(settings.profiles[0] as Profile);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: `Export folder: ${this.folder.name}` });

		const notes = this.collectNotes();
		contentEl.createDiv({
			cls: 'mx-hint',
			text: `${notes.length} Markdown note${notes.length === 1 ? '' : 's'}, ordered by folder hierarchy then file name.`,
		});

		new Setting(contentEl)
			.setName('Mode')
			.setDesc('Separate reproduces the folder hierarchy; merged produces one continuously paginated PDF.')
			.addDropdown((dropdown) => {
				dropdown.addOption('separate', 'Separate — one PDF per note');
				dropdown.addOption('merged', 'Merged — one PDF');
				dropdown.setValue(this.mode);
				dropdown.onChange((value) => {
					this.mode = value === 'merged' ? 'merged' : 'separate';
					this.onOpen();
				});
			});

		if (this.mode === 'separate') {
			new Setting(contentEl)
				.setName('Use per-folder profile defaults')
				.setDesc('Off means every note is exported with the profile chosen below.')
				.addToggle((toggle) =>
					toggle.setValue(this.useFolderDefaults).onChange((value) => {
						this.useFolderDefaults = value;
					}),
				);
		} else {
			contentEl.createDiv({
				cls: 'mx-hint',
				text: 'Merged export uses one profile for the whole document, so per-folder defaults do not apply.',
			});
		}

		new Setting(contentEl).setName('Profile').addDropdown((dropdown) => {
			for (const profile of this.settings.profiles) dropdown.addOption(profile.id, profile.name);
			dropdown.setValue(this.profile.id);
			dropdown.onChange((value) => {
				const next = this.settings.profiles.find((profile) => profile.id === value);
				if (next !== undefined) this.profile = next;
			});
		});

		this.progressEl = contentEl.createDiv({ cls: 'mx-progress-list' });
		this.progressEl.setText('Ready.');

		new Setting(contentEl.createDiv({ cls: 'mx-export-actions' }))
			.addButton((button) =>
				button.setButtonText('Cancel').onClick(() => {
					if (this.running) {
						this.cancelled = true;
						this.log('Cancelling after the current note…');
					} else {
						this.close();
					}
				}),
			)
			.addButton((button) =>
				button
					.setButtonText('Export')
					.setCta()
					.onClick(() => {
						void this.export(notes);
					}),
			);
	}

	/** Recursive, markdown-only. Ordering is applied by the planner, not here. */
	private collectNotes(): string[] {
		const paths: string[] = [];
		const walk = (folder: TFolder): void => {
			for (const child of folder.children) {
				if (child instanceof TFolder) walk(child);
				else if (child instanceof TFile && isExportableNote(child.path)) paths.push(child.path);
			}
		};
		walk(this.folder);
		return paths;
	}

	private async export(paths: readonly string[]): Promise<void> {
		if (this.running || paths.length === 0) {
			if (paths.length === 0) new Notice('That folder contains no Markdown notes.');
			return;
		}

		const plan =
			this.mode === 'merged'
				? await this.buildMergedPlan(paths)
				: await this.buildSeparatePlan(paths);
		if (plan === null) return;

		this.running = true;
		this.cancelled = false;
		try {
			const outcome = await this.service.run({
				plan,
				profileFallback: this.profile,
				onProgress: (fraction, label) => {
					this.log(`${Math.round(fraction * 100)}% — ${label}`);
				},
				isCancelled: () => this.cancelled,
			});
			for (const line of outcome.report.toLines()) this.log(line);
			announceOutcome(outcome);
		} catch (error) {
			new Notice(`Export failed: ${describeError(error)}`);
			this.log(`Failed: ${describeError(error)}`);
		} finally {
			this.running = false;
		}
	}

	private async buildSeparatePlan(paths: readonly string[]): Promise<ExportPlan | null> {
		const outputDir = await showDirectoryDialog('Export folder to', this.settings.lastExportDir);
		if (outputDir === null) return null;
		this.settings.lastExportDir = outputDir;
		return planSeparateExport({
			paths,
			sourceRoot: this.folder.path,
			outputDir,
			profiles: this.settings.profiles,
			folderProfiles: this.settings.folderProfiles,
			defaultProfileId: this.settings.defaultProfileId,
			overrideProfile: this.useFolderDefaults ? null : this.profile,
		});
	}

	private async buildMergedPlan(paths: readonly string[]): Promise<ExportPlan | null> {
		const suggested = `${this.settings.lastExportDir}/${sanitizeFileName(this.folder.name || 'Vault')}.pdf`;
		const outputFile = await showPdfSaveDialog('Save merged PDF as', suggested);
		if (outputFile === null) return null;
		return planMergedExport({ paths, outputFile, profile: this.profile });
	}

	private log(line: string): void {
		if (this.progressEl === null) return;
		this.progressEl.createSpan({ cls: 'mx-report-entry', text: line });
		this.progressEl.scrollTop = this.progressEl.scrollHeight;
	}

	onClose(): void {
		this.cancelled = true;
		this.contentEl.empty();
	}
}
