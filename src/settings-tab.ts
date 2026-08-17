import { PluginSettingTab, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { PAGE_SIZES } from './core/page-css';
import { clearFolderProfile, mappingsUnder, pruneFolderProfiles } from './core/profile-resolver';
import { createDefaultProfiles, duplicateProfile, makeProfileId } from './core/profiles';
import type { AnnotationMode, PageSize, Profile } from './core/types';
import type MultiExporterPlugin from './main';

/**
 * Settings: profile CRUD and the folder-default map.
 *
 * There is no fixed set of profiles. `Article`, `Dataview` and `Manuscript` ship as starting
 * examples and can be renamed, edited or deleted like any other; the set is expected to grow
 * as document types accumulate. Nothing in the plugin branches on a profile's name — every
 * behavioural difference below is a flag — so a profile created here is a first-class one.
 */
export class MultiExporterSettingTab extends PluginSettingTab {
	private editingProfileId: string | null = null;

	constructor(
		app: App,
		private readonly plugin: MultiExporterPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderProfileList(containerEl);
		this.renderProfileEditor(containerEl);
		this.renderFolderDefaults(containerEl);
		this.renderGeneral(containerEl);
	}

	private get settings(): MultiExporterPlugin['settings'] {
		return this.plugin.settings;
	}

	private async save(): Promise<void> {
		await this.plugin.saveSettings();
	}

	private renderProfileList(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Profiles').setHeading();

		new Setting(containerEl)
			.setName('Default profile')
			.setDesc('Used when no folder mapping matches.')
			.addDropdown((dropdown) => {
				for (const profile of this.settings.profiles) dropdown.addOption(profile.id, profile.name);
				dropdown.setValue(this.settings.defaultProfileId);
				dropdown.onChange(async (value) => {
					this.settings.defaultProfileId = value;
					await this.save();
				});
			});

		for (const profile of this.settings.profiles) {
			new Setting(containerEl)
				.setName(profile.name)
				.setDesc(profile.id)
				.addButton((button) =>
					button.setButtonText('Edit').onClick(() => {
						this.editingProfileId = profile.id;
						this.display();
					}),
				)
				.addButton((button) =>
					button.setButtonText('Duplicate').onClick(async () => {
						const copy = duplicateProfile(profile, this.settings.profiles);
						this.settings.profiles.push(copy);
						this.editingProfileId = copy.id;
						await this.save();
						this.display();
					}),
				)
				.addButton((button) =>
					button
						.setButtonText('Delete')
						.setWarning()
						.setDisabled(this.settings.profiles.length <= 1)
						.onClick(async () => {
							this.settings.profiles = this.settings.profiles.filter((other) => other.id !== profile.id);
							// A folder mapping pointing at a deleted profile would resolve to
							// nothing on every export, so the map is pruned with it.
							this.settings.folderProfiles = pruneFolderProfiles(
								this.settings.folderProfiles,
								this.settings.profiles,
							);
							if (this.settings.defaultProfileId === profile.id) {
								this.settings.defaultProfileId = this.settings.profiles[0]?.id ?? '';
							}
							if (this.editingProfileId === profile.id) this.editingProfileId = null;
							await this.save();
							this.display();
						}),
				);
		}

		new Setting(containerEl)
			.addButton((button) =>
				button
					.setButtonText('New profile')
					.setCta()
					.onClick(async () => {
						const template = createDefaultProfiles()[0];
						if (template === undefined) return;
						const name = `Profile ${this.settings.profiles.length + 1}`;
						const created: Profile = {
							...template,
							id: makeProfileId(name, this.settings.profiles),
							name,
						};
						this.settings.profiles.push(created);
						this.editingProfileId = created.id;
						await this.save();
						this.display();
					}),
			)
			.addButton((button) =>
				button.setButtonText('Restore example profiles').onClick(async () => {
					const existing = new Set(this.settings.profiles.map((profile) => profile.id));
					for (const example of createDefaultProfiles()) {
						if (!existing.has(example.id)) this.settings.profiles.push(example);
					}
					await this.save();
					this.display();
				}),
			);
	}

	private renderProfileEditor(containerEl: HTMLElement): void {
		const profile = this.settings.profiles.find((candidate) => candidate.id === this.editingProfileId);
		if (profile === undefined) return;

		const editor = containerEl.createDiv({ cls: 'mx-profile-editor' });
		new Setting(editor).setName(`Editing: ${profile.name}`).setHeading();

		new Setting(editor).setName('Name').addText((text) =>
			text.setValue(profile.name).onChange(async (value) => {
				profile.name = value;
				await this.save();
			}),
		);

		new Setting(editor)
			.setName('CSL style')
			.setDesc("Passed to zotero-manager. Leave empty to use its own configured default.")
			.addText((text) =>
				text.setValue(profile.cslStyle).onChange(async (value) => {
					profile.cslStyle = value;
					await this.save();
				}),
			);

		new Setting(editor).setName('Page').setHeading();

		new Setting(editor).setName('Page size').addDropdown((dropdown) => {
			for (const size of Object.keys(PAGE_SIZES)) dropdown.addOption(size, size);
			dropdown.setValue(profile.page.size);
			dropdown.onChange(async (value) => {
				profile.page.size = value as PageSize;
				await this.save();
			});
		});

		new Setting(editor).setName('Orientation').addDropdown((dropdown) => {
			dropdown.addOption('portrait', 'Portrait');
			dropdown.addOption('landscape', 'Landscape');
			dropdown.setValue(profile.page.orientation);
			dropdown.onChange(async (value) => {
				profile.page.orientation = value === 'landscape' ? 'landscape' : 'portrait';
				await this.save();
			});
		});

		new Setting(editor)
			.setName('Margins')
			.setDesc('Top, right, bottom, left — any CSS length.')
			.addText((text) =>
				text.setValue(profile.page.margins.top).onChange(async (value) => {
					profile.page.margins.top = value;
					await this.save();
				}),
			)
			.addText((text) =>
				text.setValue(profile.page.margins.right).onChange(async (value) => {
					profile.page.margins.right = value;
					await this.save();
				}),
			)
			.addText((text) =>
				text.setValue(profile.page.margins.bottom).onChange(async (value) => {
					profile.page.margins.bottom = value;
					await this.save();
				}),
			)
			.addText((text) =>
				text.setValue(profile.page.margins.left).onChange(async (value) => {
					profile.page.margins.left = value;
					await this.save();
				}),
			);

		new Setting(editor)
			.setName('Suppress furniture on the first page')
			.setDesc('Emits @page :first with every margin box emptied.')
			.addToggle((toggle) =>
				toggle.setValue(profile.page.suppressFirstPageFurniture).onChange(async (value) => {
					profile.page.suppressFirstPageFurniture = value;
					await this.save();
				}),
			);

		new Setting(editor).setName('Behaviour').setHeading();

		new Setting(editor)
			.setName('Resolve citations')
			.setDesc('Treat wikilinks whose target is a known cite key as citations.')
			.addToggle((toggle) =>
				toggle.setValue(profile.flags.resolveCitations).onChange(async (value) => {
					profile.flags.resolveCitations = value;
					await this.save();
				}),
			);

		new Setting(editor)
			.setName('Emit bibliography')
			.setDesc('Append a bibliography formatted by zotero-manager.')
			.addToggle((toggle) =>
				toggle.setValue(profile.flags.emitBibliography).onChange(async (value) => {
					profile.flags.emitBibliography = value;
					await this.save();
				}),
			);

		new Setting(editor)
			.setName('Scan for Pandoc-style citations')
			.setDesc('Opt-in secondary text scan for [@key]. Bare @key is never matched.')
			.addToggle((toggle) =>
				toggle.setValue(profile.flags.pandocCitationScan).onChange(async (value) => {
					profile.flags.pandocCitationScan = value;
					await this.save();
				}),
			);

		new Setting(editor)
			.setName('Inline images')
			.setDesc('Embed remote and vault images as data URIs, so exports work offline.')
			.addToggle((toggle) =>
				toggle.setValue(profile.flags.inlineImages).onChange(async (value) => {
					profile.flags.inlineImages = value;
					await this.save();
				}),
			);

		new Setting(editor)
			.setName('Annotations')
			.setDesc('Where md-annotation comments go. This setting decides, not the sidebar.')
			.addDropdown((dropdown) => {
				dropdown.addOption('off', 'Omit');
				dropdown.addOption('gutter', 'In the page margin');
				dropdown.addOption('endnotes', 'As endnotes');
				dropdown.setValue(profile.flags.annotationMode);
				dropdown.onChange(async (value) => {
					profile.flags.annotationMode = value as AnnotationMode;
					await this.save();
				});
			});

		new Setting(editor)
			.setName('Run PDF Squeezer')
			.setDesc('Uses the pdfs CLI when installed. Absence is not an error.')
			.addToggle((toggle) =>
				toggle.setValue(profile.flags.runSqueezer).onChange(async (value) => {
					profile.flags.runSqueezer = value;
					await this.save();
				}),
			);

		new Setting(editor)
			.setName('PDF Squeezer profile')
			.setDesc('Optional path to a .pdfscp file.')
			.addText((text) =>
				text.setValue(profile.flags.squeezerProfile ?? '').onChange(async (value) => {
					if (value === '') delete profile.flags.squeezerProfile;
					else profile.flags.squeezerProfile = value;
					await this.save();
				}),
			);

		new Setting(editor)
			.setName('Stylesheet')
			.setDesc('The primary styling surface. @page rules are generated from the settings above and placed before this.')
			.setClass('mx-stylesheet-setting');

		const textarea = editor.createEl('textarea', { cls: 'mx-stylesheet-input' });
		textarea.value = profile.stylesheet;
		textarea.addEventListener('change', () => {
			profile.stylesheet = textarea.value;
			void this.save();
		});

		new Setting(editor).addButton((button) =>
			button.setButtonText('Close editor').onClick(() => {
				this.editingProfileId = null;
				this.display();
			}),
		);
	}

	/**
	 * Folder defaults.
	 *
	 * Stored as a centralised path-prefix map in `data.json` — not as folder notes and not
	 * as `.folder-meta.json` files, so nothing is written into the vault. Resolution is a
	 * nearest-ancestor lookup, so a deep mapping beats a shallow one.
	 */
	private renderFolderDefaults(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Folder defaults').setHeading();
		containerEl.createDiv({
			cls: 'mx-hint',
			text: 'Add a mapping from the folder context menu. The deepest mapping containing a note wins; these apply to single-note and separate exports, not to merged ones.',
		});

		const mappings = mappingsUnder(this.settings.folderProfiles, '');
		if (mappings.length === 0) {
			containerEl.createDiv({ cls: 'mx-hint', text: 'No folder mappings yet.' });
			return;
		}

		for (const [folder, profileId] of mappings) {
			const row = containerEl.createDiv({ cls: 'mx-folder-map-row' });
			row.createSpan({ cls: 'mx-folder-map-path', text: folder === '' ? '(vault root)' : folder });
			const profile = this.settings.profiles.find((candidate) => candidate.id === profileId);
			row.createSpan({ text: profile?.name ?? `${profileId} (missing)` });
			new Setting(row).addButton((button) =>
				button
					.setButtonText('Remove')
					.setWarning()
					.onClick(async () => {
						this.settings.folderProfiles = clearFolderProfile(this.settings.folderProfiles, folder);
						await this.save();
						this.display();
					}),
			);
		}
	}

	private renderGeneral(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Images').setHeading();
		new Setting(containerEl)
			.setName('Image fetch timeout')
			.setDesc('Milliseconds to wait for a remote image before substituting a placeholder.')
			.addText((text) =>
				text.setValue(String(this.settings.imageFetchTimeoutMs)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					if (Number.isInteger(parsed) && parsed > 0) {
						this.settings.imageFetchTimeoutMs = parsed;
						await this.save();
					}
				}),
			);
	}
}
