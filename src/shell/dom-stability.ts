/**
 * Waiting for a subtree of asynchronous, reactive renderers to stop changing.
 *
 * Shared by `ObsidianDocumentRenderer` (Dataview/Datacore settle after `MarkdownRenderer`
 * resolves) and the Excalidraw board renderer (a swapped-in note embed settles after its own
 * nested `MarkdownRenderer.render()` resolves, for the same reason). Its own module so
 * neither importer has to import the other just to reach it.
 */

/** Interval between DOM-stability samples while waiting for async renderers to settle. */
const STABILITY_POLL_MS = 60;
/** Consecutive unchanged samples required before a document is considered settled. */
const STABILITY_SAMPLES = 3;
/** Hard ceiling, so a permanently-reactive Datacore view cannot hang an export. */
const STABILITY_TIMEOUT_MS = 15000;

/**
 * Measured by HTML length and node count rather than by a `MutationObserver`, which would
 * have to be torn down on every path out and is one more live handle to leak. Sampling is
 * cheap here because it runs once per note, not once per keystroke.
 */
export async function waitForDomStability(
	element: HTMLElement,
	options: { pollMs?: number; samples?: number; timeoutMs?: number } = {},
): Promise<void> {
	const pollMs = options.pollMs ?? STABILITY_POLL_MS;
	const required = options.samples ?? STABILITY_SAMPLES;
	const timeoutMs = options.timeoutMs ?? STABILITY_TIMEOUT_MS;

	const started = Date.now();
	let previous = signature(element);
	let stable = 0;

	while (stable < required) {
		if (Date.now() - started > timeoutMs) return;
		await sleep(pollMs);
		const current = signature(element);
		if (current === previous) {
			stable++;
		} else {
			stable = 0;
			previous = current;
		}
	}
}

function signature(element: HTMLElement): string {
	return `${element.innerHTML.length}:${element.querySelectorAll('*').length}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}
