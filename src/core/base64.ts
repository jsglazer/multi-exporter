/**
 * Base64 for data URIs.
 *
 * Implemented here rather than reached for from `Buffer` or `btoa`: `src/core/` must not
 * depend on a node built-in, and depending on an ambient browser global would make core
 * untestable in the node environment the tests run in. It is 20 lines and fully
 * deterministic.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function encodeBase64(bytes: Uint8Array): string {
	let out = '';
	for (let i = 0; i < bytes.length; i += 3) {
		const b0 = bytes[i] ?? 0;
		const b1 = bytes[i + 1] ?? 0;
		const b2 = bytes[i + 2] ?? 0;
		const triple = (b0 << 16) | (b1 << 8) | b2;
		const remaining = bytes.length - i;

		out += ALPHABET[(triple >> 18) & 0x3f] ?? '';
		out += ALPHABET[(triple >> 12) & 0x3f] ?? '';
		out += remaining > 1 ? (ALPHABET[(triple >> 6) & 0x3f] ?? '') : '=';
		out += remaining > 2 ? (ALPHABET[triple & 0x3f] ?? '') : '=';
	}
	return out;
}

export function toDataUri(mimeType: string, bytes: Uint8Array): string {
	return `data:${mimeType};base64,${encodeBase64(bytes)}`;
}
