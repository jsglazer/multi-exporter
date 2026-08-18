import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';

/**
 * A yes/no gate in front of anything that destroys a profile the user configured.
 *
 * Profiles are the entire configuration surface of this plugin — a stylesheet someone spent
 * an afternoon on lives in one — and both "Delete" and "Restore example profiles" replace
 * or remove them with a single click and no undo, because settings are written straight to
 * `data.json`. A confirmation is the only thing standing between a mis-click and a rewrite.
 *
 * Resolves `false` on every path out that is not the confirm button: the cancel button, the
 * Escape key, and clicking the background all mean "no".
 */
export interface ConfirmOptions {
	title: string;
	/** Body text. Each string is its own paragraph. */
	body: readonly string[];
	/** Label for the confirming button. Name the action, never "OK". */
	confirmText: string;
	/** Style the confirm button as destructive. */
	destructive?: boolean;
}

export class ConfirmModal extends Modal {
	private confirmed = false;

	constructor(
		app: App,
		private readonly options: ConfirmOptions,
		private readonly resolve: (confirmed: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h3', { text: this.options.title });
		for (const paragraph of this.options.body) contentEl.createEl('p', { text: paragraph });

		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText('Cancel').onClick(() => {
					this.close();
				}),
			)
			.addButton((button) => {
				button.setButtonText(this.options.confirmText).onClick(() => {
					this.confirmed = true;
					this.close();
				});
				if (this.options.destructive === true) button.setWarning();
				else button.setCta();
			});
	}

	/**
	 * The single resolution point.
	 *
	 * Obsidian calls this for the close button, Escape and a background click as well as for
	 * the two buttons above, so answering here — rather than in each handler — is what makes
	 * "dismissed" mean "no" instead of leaving the promise pending forever.
	 */
	onClose(): void {
		this.contentEl.empty();
		this.resolve(this.confirmed);
	}
}

/** Open a confirmation and wait for the answer. `false` for every kind of dismissal. */
export function confirm(app: App, options: ConfirmOptions): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		new ConfirmModal(app, options, resolve).open();
	});
}
