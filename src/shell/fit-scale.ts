import type { FitAxis } from '../core/types';

/**
 * The fit-to-page measurement, as a script for the guest webview.
 *
 * Its own module for one reason: `pagedjs-backend.ts` imports the vendored paged.js source
 * and Obsidian's runtime, so nothing under `tests/` can import it — which is why every other
 * guest script in this plugin is checked by *parsing the source file as text*. That is the
 * right tool for "is this valid JavaScript" and the wrong one for "does it measure the axis
 * it was asked for". Kept here, with no import a test environment lacks, the answer can
 * simply be asserted.
 */

/**
 * The scale at which the worst-overflowing element fits its page box, on the chosen axis.
 *
 * Only leaf elements are measured, and only against the *content* box — the area paged.js
 * gave the flow after margins and furniture. An ancestor is as wide as its widest child, so
 * counting containers too would report the same overflow several times over and change
 * nothing about the answer.
 *
 * The axis is baked into the script rather than passed as data because the whole script is
 * injected as source text anyway, and a measurement loop that re-decides which ratio it
 * cares about on every element is slower and harder to read than three-line variants.
 *
 * Never scales up: an export that fits already is printed at 1. The floor is applied by the
 * caller, because a single runaway element — a 4000px screenshot that resisted `max-width` —
 * must not shrink the body text to nothing; past that point the honest outcome is a clipped
 * figure on a readable page, and the diagnostics pass names the element in the console.
 */
export function fitScaleScript(axis: FitAxis): string {
	const ratios =
		axis === 'width'
			? 'rect.width / width'
			: axis === 'height'
				? 'rect.height / height'
				: 'rect.width / width, rect.height / height';
	return `(() => {
	const box = document.querySelector('.pagedjs_page_content');
	if (!box) return 1;
	const width = box.clientWidth;
	const height = box.clientHeight;
	if (!width || !height) return 1;
	let worst = 1;
	document.querySelectorAll('.pagedjs_page_content *').forEach((element) => {
		if (element.children.length > 0) return;
		const rect = element.getBoundingClientRect();
		if (!rect.width && !rect.height) return;
		worst = Math.max(worst, ${ratios});
	});
	return 1 / worst;
})()`;
}
