import { Menu, Notice, Plugin, TFile, TFolder } from 'obsidian';
import type { TAbstractFile } from 'obsidian';
import { setFolderProfile } from './core/profile-resolver';
import { normalizeSettings } from './core/profiles';
import { remapFolderPaths, removeFolderPaths } from './core/rename-map';
import type { PluginSettings } from './core/types';
import { ExportService } from './shell/export-service';
import { ExportModal } from './shell/export-modal';
import { FolderExportModal } from './shell/folder-export-modal';
import { MultiExporterSettingTab } from './settings-tab';

/**
 * Plugin shell.
 *
 * Translates Obsidian events into calls on the pure core and back again. It holds no
 * decision logic of its own: profile resolution, path rewriting, ordering, planning and
 * reporting all live under `src/core/`, which imports neither `obsidian` nor `fs`.
 */
export default class MultiExporterPlugin extends Plugin {
	settings: PluginSettings = normalizeSettings(null);
	private service: ExportService | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.service = new ExportService(this.app, () => this.settings);

		this.addSettingTab(new MultiExporterSettingTab(this.app, this));

		this.addCommand({
			id: 'export-active-note',
			name: 'Export active note to PDF',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (file === null || file.extension !== 'md') return false;
				if (!checking) this.openExportModal(file);
				return true;
			},
		});

		this.addCommand({
			id: 'export-vault-folder',
			name: 'Export the active note’s folder to PDF',
			checkCallback: (checking) => {
				const folder = this.app.workspace.getActiveFile()?.parent ?? null;
				if (folder === null) return false;
				if (!checking) this.openFolderExportModal(folder);
				return true;
			},
		});

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
				if (file instanceof TFile && file.extension === 'md') {
					menu.addItem((item) =>
						item
							.setTitle('Export to PDF')
							.setIcon('file-output')
							.onClick(() => this.openExportModal(file)),
					);
					return;
				}
				if (file instanceof TFolder) {
					menu.addItem((item) =>
						item
							.setTitle('Export folder to PDF')
							.setIcon('folder-output')
							.onClick(() => this.openFolderExportModal(file)),
					);
					this.addFolderDefaultMenu(menu, file);
				}
			}),
		);

		// Folder metadata is a path-keyed map, so a rename or move silently orphans every
		// entry beneath it unless the keys are rewritten. Obsidian fires one event for the
		// top-most moved item and says nothing about its descendants, so the rewrite is a
		// prefix rewrite, not a single-key swap.
		this.registerEvent(
			this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
				void this.handleRename(file, oldPath);
			}),
		);

		this.registerEvent(
			this.app.vault.on('delete', (file: TAbstractFile) => {
				void this.handleDelete(file);
			}),
		);
	}

	/**
	 * Rewrite folder-profile keys after a rename or move, then persist.
	 *
	 * Files are ignored: the map is keyed by folder, and a note moving between folders
	 * changes which mapping applies to it without changing the map itself.
	 */
	private async handleRename(file: TAbstractFile, oldPath: string): Promise<void> {
		if (!(file instanceof TFolder)) return;
		const result = remapFolderPaths(this.settings.folderProfiles, oldPath, file.path);
		if (!result.changed) return;
		this.settings.folderProfiles = result.map;
		await this.saveSettings();
	}

	private async handleDelete(file: TAbstractFile): Promise<void> {
		if (!(file instanceof TFolder)) return;
		const result = removeFolderPaths(this.settings.folderProfiles, file.path);
		if (!result.changed) return;
		this.settings.folderProfiles = result.map;
		await this.saveSettings();
	}

	private addFolderDefaultMenu(menu: Menu, folder: TFolder): void {
		menu.addItem((item) => {
			item.setTitle('Default export profile').setIcon('settings');
			const submenu = (item as unknown as { setSubmenu(): Menu }).setSubmenu();
			for (const profile of this.settings.profiles) {
				submenu.addItem((entry) =>
					entry
						.setTitle(profile.name)
						.setChecked(this.settings.folderProfiles[folder.path] === profile.id)
						.onClick(async () => {
							this.settings.folderProfiles = setFolderProfile(
								this.settings.folderProfiles,
								folder.path,
								profile.id,
							);
							await this.saveSettings();
							new Notice(`${folder.name || 'Vault root'} now defaults to ${profile.name}.`);
						}),
				);
			}
		});
	}

	private openExportModal(file: TFile): void {
		if (this.service === null) return;
		new ExportModal(this.app, file, this.settings, this.service).open();
	}

	private openFolderExportModal(folder: TFolder): void {
		if (this.service === null) return;
		new FolderExportModal(this.app, folder, this.settings, this.service).open();
	}

	async loadSettings(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * Every registered event and DOM handler is registered through `this.registerEvent` /
	 * `this.register`, so Obsidian tears them down here. The webview containers are owned by
	 * the modals and disposed on close; nothing outlives the plugin.
	 */
	onunload(): void {
		this.service = null;
	}
}
