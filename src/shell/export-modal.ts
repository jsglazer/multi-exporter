import { Modal, Notice, Setting } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { showDirectoryDialog } from '../adapter/obsidian-internals';
import { planSeparateExport, singleNoteDestination } from '../core/export-plan';
import { composeCss } from '../core/pipeline';
import { resolveProfileForPath } from '../core/profile-resolver';
import type { PluginSettings, Profile } from '../core/types';
import { announceOutcome, ExportService } from './export-service';
import { PagedJsWebviewBackend } from './pagedjs-backend';
import { ObsidianDocumentRenderer } from './render';
import { DomTransforms } from './transforms';

/**
 * Single-note export, with the live preview.
 *
 * The container created here **is** the preview and **is** what gets printed. Changing the
 * profile, its stylesheet or its page geometry re-paginates in place; nothing is recreated,
 * and the export does not render again. That is the whole guarantee: the preview cannot
 * drift from the output, because it is the output.
 */
export class ExportModal extends Modal {
	private backend: PagedJsWebviewBackend | null = null;
	private profile: Profile;
	private status: HTMLElement | null = null;
	private exporting = false;

	constructor(
		app: App,
		private readonly file: TFile,
		private readonly settings: PluginSettings,
		private readonly service: ExportService,
	) {
		super(app);
		this.profile =
			resolveProfileForPath(settings.profiles, settings.folderProfiles, file.path, settings.defaultProfileId) ??
			(settings.profiles[0] as Profile);
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		modalEl.addClass('mx-export-modal');
		contentEl.empty();
		contentEl.createEl('h2', { text: `Export ${this.file.basename}` });

		const layout = contentEl.createDiv({ cls: 'mx-export-layout' });
		const previewPane = layout.createDiv({ cls: 'mx-export-preview' });
		const controls = layout.createDiv({ cls: 'mx-export-controls' });

		this.backend = new PagedJsWebviewBackend(previewPane);

		new Setting(controls).setName('Profile').addDropdown((dropdown) => {
			for (const profile of this.settings.profiles) dropdown.addOption(profile.id, profile.name);
			dropdown.setValue(this.profile.id);
			dropdown.onChange((value) => {
				const next = this.settings.profiles.find((profile) => profile.id === value);
				if (next === undefined) return;
				this.profile = next;
				void this.repaginate();
			});
		});

		this.status = controls.createDiv({ cls: 'mx-export-status' });

		const actions = contentEl.createDiv({ cls: 'mx-export-actions' });
		new Setting(actions)
			.addButton((button) =>
				button.setButtonText('Refresh preview').onClick(() => {
					void this.repaginate();
				}),
			)
			.addButton((button) =>
				button
					.setButtonText('Export PDF')
					.setCta()
					.onClick(() => {
						void this.export();
					}),
			);

		void this.repaginate();
	}

	/**
	 * Render the note and paginate it into the preview container.
	 *
	 * Runs the same transforms the export runs, so what is on screen is what would print.
	 */
	private async repaginate(): Promise<void> {
		const backend = this.backend;
		if (backend === null || this.exporting) return;
		this.setStatus('Rendering…');

		const host = this.service.createRenderHost();
		const renderer = new ObsidianDocumentRenderer(this.app, host);
		const transforms = new DomTransforms();
		try {
			const note = await renderer.render(this.file.path);
			const html = transforms.serialize(note);
			renderer.release(note);
			this.setStatus('Paginating…');
			const result = await backend.paginate({
				html,
				css: composeCss(this.profile),
				page: this.profile.page,
			});
			this.setStatus(`${result.pageCount} page${result.pageCount === 1 ? '' : 's'}.`);
		} catch (error) {
			console.error('[multi-exporter] preview failed', error);
			this.setStatus(`Preview failed: ${describeError(error)}`);
		} finally {
			host.detach();
		}
	}

	private async export(): Promise<void> {
		if (this.exporting) return;

		let outputDir: string | null;
		try {
			outputDir = await showDirectoryDialog('Export to folder', this.settings.lastExportDir);
		} catch (error) {
			// A dialog that could not be opened is a failure, not a cancellation. Saying so
			// out loud is the difference between a bug report and a mystery.
			this.fail(error);
			return;
		}
		if (outputDir === null) return;

		this.exporting = true;
		this.setStatus('Exporting…');
		try {
			const plan = planSeparateExport({
				paths: [this.file.path],
				sourceRoot: this.file.parent?.path ?? '',
				outputDir,
				profiles: this.settings.profiles,
				folderProfiles: this.settings.folderProfiles,
				defaultProfileId: this.settings.defaultProfileId,
				overrideProfile: this.profile,
			});
			const note = plan.notes[0];
			if (note !== undefined) note.destination = singleNoteDestination(outputDir, this.file.path);

			// The preview's own backend does the printing. That is the guarantee this modal
			// exists to keep: the container on screen is the container that prints, so there
			// is no second pagination pass to drift from what was reviewed — and no second
			// webview whose renderer process has to be spun up and torn down.
			const outcome = await this.service.run({
				plan,
				profileFallback: this.profile,
				...(this.backend === null ? {} : { backend: this.backend }),
			});
			announceOutcome(outcome);
			this.settings.lastExportDir = outputDir;
			void this.service.saveSettings();

			const written = outcome.written[0];
			this.setStatus(written ?? 'Nothing written.');
			// Close on success only: a failure leaves the modal up so its message can be read.
			if (written !== undefined && !outcome.cancelled) this.close();
		} catch (error) {
			this.fail(error);
		} finally {
			this.exporting = false;
		}
	}

	private fail(error: unknown): void {
		console.error('[multi-exporter] export failed', error);
		new Notice(`Export failed: ${describeError(error)}`);
		this.setStatus(`Export failed: ${describeError(error)}`);
	}

	private setStatus(text: string): void {
		if (this.status !== null) this.status.setText(text);
	}

	/**
	 * Explicit teardown. The webview owns a renderer process and will not go away because
	 * its parent element did.
	 */
	onClose(): void {
		void this.backend?.dispose();
		this.backend = null;
		this.contentEl.empty();
	}
}

export function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
