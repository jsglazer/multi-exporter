import { execFile } from 'node:child_process';
import type { PdfCompressor } from '../core/pipeline';

/**
 * PDF Squeezer's `pdfs` CLI.
 *
 * **Absence is not an error.** If `pdfs` is not installed the export completes uncompressed
 * and the report says so — the plugin does not make an optional third-party binary into a
 * hard dependency of exporting a note.
 */

const PDFS_BINARY = 'pdfs';
/** Generous: compressing a several-hundred-page PDF is not instant. */
const COMPRESS_TIMEOUT_MS = 180000;

export class PdfSqueezerCompressor implements PdfCompressor {
	private installed: boolean | null = null;

	async isInstalled(): Promise<boolean> {
		this.installed ??= await run(PDFS_BINARY, ['--help'], 10000);
		return this.installed;
	}

	compress(filePath: string, profilePath: string | undefined): Promise<boolean> {
		const args = profilePath === undefined || profilePath === '' ? [filePath] : [filePath, '--profile', profilePath];
		return run(PDFS_BINARY, args, COMPRESS_TIMEOUT_MS);
	}
}

/**
 * `execFile`, not `exec`: arguments are passed as an array and never interpolated into a
 * shell string, so a note title containing a quote or a semicolon cannot become a command.
 */
function run(command: string, args: readonly string[], timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		execFile(command, [...args], { timeout: timeoutMs }, (error) => {
			resolve(error === null);
		});
	});
}
