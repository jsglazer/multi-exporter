import { describe, expect, it } from 'vitest';
import { isGuestGoneError, unwrapGuestError } from '../src/adapter/obsidian-internals';

/**
 * Telling a dead renderer apart from a script that threw inside a live one.
 *
 * Electron routes every `<webview>` method through the guest view manager and wraps *every*
 * rejection the same way — `Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error:
 * <message>` — whether the guest's process is gone or the injected script simply threw. The
 * backend used to read that wrapper as proof of death, which cost users the only sentence that
 * said what was actually wrong: a Manuscript preview failed on a paged.js stylesheet error and
 * was reported as "the preview process stopped … twice", after a healthy webview had been
 * destroyed and the same error hit again on the rebuild.
 *
 * The asymmetry that decides the doubt: a missed death costs one honest error message, while a
 * script error misread as a death destroys the true message and substitutes a false one.
 */

const WRAP = (message: string): Error => new Error(`Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': ${message}`);

describe('unwrapGuestError', () => {
	it('strips Electron IPC framing so the guest speaks for itself', () => {
		expect(unwrapGuestError("Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: item doesn't belong to list")).toBe(
			"item doesn't belong to list",
		);
	});

	it('strips the framing whatever error class the guest threw', () => {
		expect(
			unwrapGuestError(
				"Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': TypeError: Cannot read properties of null (reading 'getAttribute')",
			),
		).toBe("Cannot read properties of null (reading 'getAttribute')");
	});

	it('leaves an unwrapped message exactly as it is', () => {
		expect(unwrapGuestError('Render frame was disposed before WebFrameMain could be accessed')).toBe(
			'Render frame was disposed before WebFrameMain could be accessed',
		);
	});
});

describe('isGuestGoneError', () => {
	// The exact failure reported against the Manuscript profile: csstree, thrown out of
	// paged.js's polisher by a selector list two rule handlers both claim. Nothing about the
	// renderer process is wrong, and destroying it fixes nothing.
	it("does not call a paged.js stylesheet error a dead guest, wrapped or not", () => {
		expect(isGuestGoneError(new Error("item doesn't belong to list"))).toBe(false);
		expect(isGuestGoneError(WRAP("Error: item doesn't belong to list"))).toBe(false);
	});

	it('does not treat the GUEST_VIEW_MANAGER_CALL wrapper alone as a death', () => {
		expect(isGuestGoneError(WRAP('TypeError: x is not a function'))).toBe(false);
		expect(isGuestGoneError(WRAP('Error: Invalid regular expression: missing /'))).toBe(false);
	});

	it('still recognises every way Electron says the guest is gone', () => {
		const deaths = [
			'Render frame was disposed before WebFrameMain could be accessed',
			'WebContents was destroyed',
			'Object has been destroyed',
			'Attempting to call a function in a renderer window that has been closed or released.',
			"Cannot call function 'executeJavaScript' on missing guest page.",
			'Invalid guestInstanceId: 12',
		];
		for (const message of deaths) {
			expect(isGuestGoneError(new Error(message)), message).toBe(true);
			expect(isGuestGoneError(WRAP(`Error: ${message}`)), `wrapped: ${message}`).toBe(true);
		}
	});

	it('is false for anything that is not an Error', () => {
		expect(isGuestGoneError('WebContents was destroyed')).toBe(false);
		expect(isGuestGoneError(null)).toBe(false);
		expect(isGuestGoneError(undefined)).toBe(false);
	});
});
