import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every script this plugin injects into the preview webview must be valid JavaScript.
 *
 * These scripts are **template literals in TypeScript that become source code in another
 * realm**, and that double layer is a trap with no compile-time protection whatsoever: the
 * compiler type-checks the string as a string, eslint lints the *TypeScript*, and nothing
 * anywhere reads what the string actually says. A guest script can be syntactically broken and
 * every check in the project still passes.
 *
 * This is not hypothetical. `\t` written inside one of these literals is consumed by the
 * TypeScript template literal and emitted as a *real tab*; `\n` as a *real newline*. Put
 * either inside a regex literal in the guest script and it becomes
 * `Invalid regular expression: missing /` — at runtime, inside a webview, in the diagnostic
 * that only ever runs when something has already gone wrong. Escaping it as `\\s` is the fix,
 * and this test is what makes forgetting it a build failure rather than a silent one.
 *
 * It parses rather than executes: these scripts reach for `document` and a live paged.js, which
 * no headless environment has. Parsing is what catches the whole class anyway.
 */

const SOURCE = readFileSync(join(__dirname, '..', 'src', 'shell', 'pagedjs-backend.ts'), 'utf8');

/**
 * Pull every guest script out of the module by the shape they all share: a backtick literal
 * wrapping an immediately-invoked arrow function.
 *
 * Matching on shape rather than on a hand-maintained list means a script added later is
 * covered without anyone remembering to add it here.
 */
function guestScripts(): { name: string; code: string }[] {
	const found: { name: string; code: string }[] = [];
	const pattern = /(?:const (\w+) = |function (\w+)\([^)]*\)[^{]*\{[\s\S]{0,400}?return )`(\(\(\) => \{[\s\S]*?\}\)\(\))`/g;

	for (const match of SOURCE.matchAll(pattern)) {
		const name = match[1] ?? match[2] ?? 'anonymous';
		const raw = match[3];
		if (raw === undefined) continue;
		// Resolve the template literal exactly as the TypeScript compiler will — escape
		// sequences and all — so what is parsed is what the webview would receive. The
		// `${...}` interpolations are stubbed, since only syntax is under test.
		//
		// A bare identifier, not a quoted string: an interpolation can land in a *property
		// name* position (`window.${READY_FLAG}`) as readily as a value one, and a string
		// literal is a syntax error in the first.
		const resolved = raw.replace(/\$\{[^}]*\}/g, '__interpolated__');
		found.push({ name, code: resolveTemplate(resolved) });
	}
	return found;
}

/** Apply the escape-sequence processing a template literal performs. */
function resolveTemplate(raw: string): string {
	return Function(`return \`${raw.replace(/`/g, '\\`')}\`;`)() as string;
}

describe('injected guest scripts', () => {
	const scripts = guestScripts();

	it('finds the scripts, so a silent regex failure cannot make this suite vacuous', () => {
		expect(scripts.length).toBeGreaterThanOrEqual(4);
	});

	it.each(scripts.map((script) => script.name))('%s parses as JavaScript', (name) => {
		const script = scripts.find((candidate) => candidate.name === name);
		expect(script).toBeDefined();
		expect(() => new Function(`return ${(script as { code: string }).code};`)).not.toThrow();
	});

	/**
	 * The specific trap, guarded directly: a raw tab, carriage return or newline inside a
	 * regex literal. `new Function` above catches it, but only as an opaque
	 * "Invalid regular expression" — this says which script and why.
	 */
	it.each(scripts.map((script) => script.name))('%s has no raw whitespace inside a regex literal', (name) => {
		const script = scripts.find((candidate) => candidate.name === name);
		const code = (script as { code: string }).code;
		// A regex literal cannot span a line; anything matching here is a swallowed escape.
		expect(code).not.toMatch(/\/\[[^\]\n]*[\t\r\n][^\]]*\]/);
	});
});
