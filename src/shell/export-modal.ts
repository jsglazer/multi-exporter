import { Modal, Notice, Setting } from 'obsidian';
import type { App, SliderComponent, TextComponent, TFile } from 'obsidian';
import { showDirectoryDialog } from '../adapter/obsidian-internals';
import { planSeparateExport, singleNoteDestination } from '../core/export-plan';
import { composeCss } from '../core/pipeline';
import { resolveProfileForPath } from '../core/profile-resolver';
import { structuredCloneProfile } from '../core/profiles';
import { clampPagesTall, clampPagesWide } from '../core/fit-pages';
import type { AnnotationMode, PluginSettings, Profile } from '../core/types';
import { announceOutcome, ExportService } from './export-service';
import { PagedJsWebviewBackend, wrapDocumentSections } from './pagedjs-backend';

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
	/** Output file name, without `.pdf`. Starts as the note's own name. */
	private fileName: string;
	/**
	 * Per-export orientation, overriding the profile's own for this run only.
	 *
	 * `'profile'` — the default — means "whatever the profile says", which is not the same
	 * thing as picking the value the profile currently holds: switching profile then has to
	 * change the orientation too, and it does, because nothing was pinned.
	 */
	private orientation: 'profile' | 'portrait' | 'landscape' = 'profile';
	/**
	 * Per-export fit-to-page, on the same terms as `orientation` above.
	 *
	 * `'profile'` defers; `'off'` is not the same thing, because a profile that ships fit-to-page
	 * on has to be overridable in the direction that turns it *off* for one run — a two-state
	 * toggle could only ever express "on".
	 */
	private fit: FitOverride = 'profile';
	/**
	 * Per-export zoom, as a percentage. `null` means "whatever the profile says".
	 *
	 * The same number `printScale` has always been — Chromium's print scale, applied to the
	 * finished pages — reached from the modal rather than only from the profile, because
	 * "this one note wants to be smaller" is a per-export thought, not a per-profile one.
	 */
	private zoom: number | null = null;
	/**
	 * Per-export annotation mode, on the same terms as `orientation` and `fit` above.
	 *
	 * The profile flag stays authoritative when this is `'profile'`, which is the point:
	 * nothing about `md-annotation`'s sidebar toggles reaches the PDF, and never will. What
	 * this adds is the missing *deliberate* override — only the Manuscript profile ships
	 * annotations on, so exporting an annotated note with any other profile silently drew
	 * nothing, and the only way to change that was to edit the profile.
	 */
	private annotations: AnnotationOverride = 'profile';
	/**
	 * Per-export page targets. `null` means "whatever the profile says".
	 *
	 * `pagesWide` widens the fit's tolerance; `pagesTall` is a page-count target that
	 * re-paginates. Both are only consulted when fit-to-page will actually run — see
	 * `core/fit-pages.ts` for why they are two different mechanisms.
	 */
	private pagesWide: number | null = null;
	private pagesTall: number | null = null;
	/** Held so the fit and profile dropdowns can grey it out and re-seat it. */
	private zoomSlider: SliderComponent | null = null;
	/** Held for the same reason: the page inputs are dead while fit-to-page is off. */
	private pageInputs: TextComponent[] = [];
	/**
	 * The pagination currently in flight, plus whether another was asked for while it ran.
	 *
	 * Pagination is not re-entrant: every run destroys the previous paged.js polisher and
	 * chunker inside the guest, so a second run starting while the first is mid-`preview()`
	 * pulls the objects out from under it. That is a guest-side crash, and once the guest's
	 * renderer process is gone every later call fails with Electron's
	 * `GUEST_VIEW_MANAGER_CALL ... item doesn't belong to list` — a message about a dead
	 * webview that says nothing about the profile switch that killed it. Flipping the profile
	 * dropdown while the first preview is still rendering is all it takes.
	 */
	private paginating: Promise<void> | null = null;
	private repaginateQueued = false;

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
		this.fileName = file.basename;
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
				// A zoom the user has not touched follows the new profile, and whether the
				// slider is live at all depends on that profile's own fit setting.
				if (this.zoom === null) this.zoomSlider?.setValue(clampZoom(next.page.printScale));
				this.syncFitControls();
				void this.repaginate();
			});
		});

		new Setting(controls)
			.setName('Orientation')
			.setDesc('For this export only. The profile is not modified.')
			.addDropdown((dropdown) => {
				dropdown.addOption('profile', 'Profile default');
				dropdown.addOption('portrait', 'Portrait');
				dropdown.addOption('landscape', 'Landscape');
				dropdown.setValue(this.orientation);
				dropdown.onChange((value) => {
					this.orientation = value === 'portrait' || value === 'landscape' ? value : 'profile';
					void this.repaginate();
				});
			});

		new Setting(controls)
			.setName('Fit to page')
			.setDesc('For this export only. Shrinks the finished pages until the chosen constraint is met.')
			.addDropdown((dropdown) => {
				dropdown.addOption('profile', 'Profile default');
				dropdown.addOption('off', 'Off');
				dropdown.addOption('width', 'Fit width');
				dropdown.addOption('height', 'Fit height');
				dropdown.addOption('both', 'Fit both');
				dropdown.setValue(this.fit);
				dropdown.onChange((value) => {
					this.fit = isFitOverride(value) ? value : 'profile';
					this.syncFitControls();
					// Re-paginate only when a page-count target is live. The fit *scale* is applied
					// by `printToPDF` after the pages are laid out, so it changes nothing on screen
					// — but `pagesTall` changes the pagination itself, and turning fitting off has
					// to put those pages back.
					if (this.pagesTallTarget() > 0 || this.fit === 'off') void this.repaginate();
				});
			});

		// Two inputs, because they are two mechanisms. Text rather than a slider: these are
		// small exact integers a user knows the value of before they touch the control, and
		// dragging to "3" is worse than typing it.
		new Setting(controls)
			.setName('Pages wide')
			.setDesc('Page-widths of content the width fit allows before it shrinks anything. Blank follows the profile.')
			.addText((text) => {
				this.pageInputs.push(text);
				text
					.setPlaceholder(String(clampPagesWide(this.profile.page.fitPagesWide)))
					.onChange((value) => {
						this.pagesWide = value.trim() === '' ? null : clampPagesWide(Number(value));
					});
			});

		new Setting(controls)
			.setName('Pages tall')
			.setDesc('Fit the note into this many pages by laying it out smaller. Blank or zero means no target.')
			.addText((text) => {
				this.pageInputs.push(text);
				text
					.setPlaceholder(String(clampPagesTall(this.profile.page.fitPagesTall)))
					.onChange((value) => {
						this.pagesTall = value.trim() === '' ? null : clampPagesTall(Number(value));
						// This one *is* a pagination change, so the preview has to run it: the
						// preview is the output, and showing eleven pages for an export that will
						// produce eight is the drift this plugin exists to prevent.
						void this.repaginate();
					});
			});

		new Setting(controls)
			.setName('Zoom')
			.setDesc('Scales the whole PDF, where 100 is unscaled. Fit to page overrides it when on.')
			.addSlider((slider) => {
				this.zoomSlider = slider;
				slider
					.setLimits(ZOOM_MIN, ZOOM_MAX, ZOOM_STEP)
					.setValue(clampZoom(this.profile.page.printScale))
					.setDynamicTooltip()
					.onChange((value) => {
						this.zoom = value;
					});
			});
		new Setting(controls)
			.setName('Annotations')
			.setDesc('Where md-annotation comments go in this PDF. The sidebar never decides this.')
			.addDropdown((dropdown) => {
				dropdown.addOption('profile', 'Profile default');
				dropdown.addOption('off', 'Off');
				dropdown.addOption('gutter', 'Margin cards');
				dropdown.addOption('endnotes', 'Endnotes');
				dropdown.setValue(this.annotations);
				dropdown.onChange((value) => {
					this.annotations = isAnnotationOverride(value) ? value : 'profile';
					// Unlike the fit controls this rewrites the document, so the preview has to
					// render again — highlights, markers and cards are content, not print scale.
					void this.repaginate();
				});
			});

		this.syncFitControls();

		new Setting(controls)
			.setName('File name')
			.setDesc('Name for the PDF. Leave it as the note name, or type another. `.pdf` is added for you.')
			.addText((text) =>
				text
					.setPlaceholder(this.file.basename)
					.setValue(this.fileName)
					.onChange((value) => {
						this.fileName = value;
					}),
			);

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
	 * Goes through the service's own document preparation — the same citations, image
	 * inlining and annotation handling the export runs, wrapped in the same
	 * `.mx-document` section — so what is on screen is what would print. Rendering and
	 * serialising here directly, as this used to, silently skipped every transform: vault
	 * images stayed `app://` URLs the guest webview cannot load, and the preview showed
	 * broken images no export would ever produce.
	 */
	private async repaginate(): Promise<void> {
		// One pagination at a time, and at most one more queued behind it: the profile
		// dropdown can be changed faster than a document paginates, and every intermediate
		// selection but the last is worth nothing anyway.
		if (this.paginating !== null) {
			this.repaginateQueued = true;
			await this.paginating;
			return;
		}
		this.paginating = this.paginateOnce();
		try {
			await this.paginating;
		} finally {
			this.paginating = null;
		}
		if (this.repaginateQueued) {
			this.repaginateQueued = false;
			await this.repaginate();
		}
	}

	/**
	 * The profile as this export will actually use it.
	 *
	 * A copy whenever the orientation is overridden — never a mutation of the settings
	 * object. The profile in settings is shared with every other export and with the settings
	 * tab, and a per-export choice that quietly rewrote it would outlive the modal.
	 */
	private effectiveProfile(): Profile {
		if (
			this.orientation === 'profile' &&
			this.fit === 'profile' &&
			this.zoom === null &&
			this.annotations === 'profile' &&
			this.pagesWide === null &&
			this.pagesTall === null
		) {
			return this.profile;
		}
		const copy = structuredCloneProfile(this.profile);
		if (this.orientation !== 'profile') copy.page.orientation = this.orientation;
		if (this.fit === 'off') {
			copy.page.fitToPage = false;
		} else if (this.fit !== 'profile') {
			copy.page.fitToPage = true;
			copy.page.fitAxis = this.fit;
		}
		if (this.pagesWide !== null) copy.page.fitPagesWide = this.pagesWide;
		if (this.pagesTall !== null) copy.page.fitPagesTall = this.pagesTall;
		if (this.zoom !== null) copy.page.printScale = this.zoom;
		if (this.annotations !== 'profile') copy.flags.annotationMode = this.annotations;
		return copy;
	}

	/** Whether fit-to-page will run for this export, profile default included. */
	private fitsToPage(): boolean {
		return this.fit === 'profile' ? this.profile.page.fitToPage === true : this.fit !== 'off';
	}

	/** The page-count target this export will actually use, profile default included. */
	private pagesTallTarget(): number {
		if (!this.fitsToPage()) return 0;
		return clampPagesTall(this.pagesTall ?? this.profile.page.fitPagesTall);
	}

	/**
	 * Grey out the controls fit-to-page has taken over, or that it has switched off.
	 *
	 * A control that silently does nothing is worse than one that is visibly unavailable: the
	 * fit measurement *replaces* the print scale, it does not compose with it, and a zoom that
	 * looked live but changed nothing about the PDF would read as a bug. The two page inputs
	 * are the mirror image — they are read only while fitting is on, so they go dead when it
	 * is off.
	 */
	private syncFitControls(): void {
		const fitting = this.fitsToPage();
		this.zoomSlider?.setDisabled(fitting);
		for (const input of this.pageInputs) input.setDisabled(!fitting);
	}

	private async paginateOnce(): Promise<void> {
		const backend = this.backend;
		if (backend === null || this.exporting) return;
		this.setStatus('Rendering…');

		try {
			const profile = this.effectiveProfile();
			const prepared = await this.service.prepareDocument(this.file.path, this.file.basename, profile);
			this.setStatus('Paginating…');
			const result = await backend.paginate({
				html: wrapDocumentSections([prepared.note]),
				css: composeCss(profile),
				page: profile.page,
			});
			const warnings = prepared.report.warnings.length + prepared.report.errors.length;
			if (warnings > 0) console.warn('[multi-exporter] preview report', prepared.report.toLines());
			this.setStatus(
				`${result.pageCount} page${result.pageCount === 1 ? '' : 's'}.` +
					(warnings === 0 ? '' : ` ${warnings} warning${warnings === 1 ? '' : 's'} — see the console.`),
			);
		} catch (error) {
			console.error('[multi-exporter] preview failed', error);
			this.setStatus(`Preview failed: ${describeError(error)}`);
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
			// The export prints through the preview's own backend, so a pagination still in
			// flight is the same re-entrancy hazard as two previews: let it finish first.
			await this.paginating;

			const plan = planSeparateExport({
				paths: [this.file.path],
				sourceRoot: this.file.parent?.path ?? '',
				outputDir,
				profiles: this.settings.profiles,
				folderProfiles: this.settings.folderProfiles,
				defaultProfileId: this.settings.defaultProfileId,
				overrideProfile: this.effectiveProfile(),
			});
			const note = plan.notes[0];
			if (note !== undefined) {
				note.destination = singleNoteDestination(outputDir, this.file.path, this.fileName);
			}

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

/**
 * The fit dropdown's states: defer to the profile, off, or one of the three constraints.
 *
 * The axis is folded into this one control rather than given a second dropdown that would be
 * meaningless three-fifths of the time — there is no axis to choose when fitting is off, and
 * none to choose when the profile is deciding.
 */
type FitOverride = 'profile' | 'off' | 'width' | 'height' | 'both';

/**
 * The annotation dropdown's states: defer to the profile, or name a mode outright.
 *
 * `'off'` is a real choice and not the same as `'profile'`, for the same reason it is on the
 * fit dropdown: the Manuscript profile ships annotations on, and one export of it has to be
 * able to turn them off without editing the profile every other export shares.
 */
type AnnotationOverride = 'profile' | AnnotationMode;

function isAnnotationOverride(value: string): value is AnnotationOverride {
	return value === 'profile' || value === 'off' || value === 'gutter' || value === 'endnotes';
}

function isFitOverride(value: string): value is FitOverride {
	return value === 'profile' || value === 'off' || value === 'width' || value === 'height' || value === 'both';
}

/** The zoom slider's range. Matches the profile setting's, so the two agree on what is sane. */
const ZOOM_MIN = 40;
const ZOOM_MAX = 200;
const ZOOM_STEP = 5;

/**
 * A percentage the slider can actually display.
 *
 * `data.json` is user-editable and predates this field, so a profile's `printScale` can be
 * absent or nonsense; a slider handed a value outside its limits throws its handle off the
 * track. The export clamps the scale again for Chromium regardless.
 */
function clampZoom(value: number): number {
	if (!Number.isFinite(value)) return 100;
	return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value / ZOOM_STEP) * ZOOM_STEP));
}
