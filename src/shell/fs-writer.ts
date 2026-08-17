import { mkdir, stat, writeFile } from 'node:fs/promises';
import type { FileWriter } from '../core/writer';

/**
 * The only node-`fs` implementation of `FileWriter`, and the only place in the plugin that
 * imports `fs` at all.
 *
 * Exports land outside the vault, so this is the code that could pollute a machine during
 * an automated run. Keeping it in one small file with no logic in it means tests have
 * nothing to accidentally reach: they inject `InMemoryFileWriter` instead.
 */
export class NodeFileWriter implements FileWriter {
	async ensureDir(dirPath: string): Promise<void> {
		await mkdir(dirPath, { recursive: true });
	}

	async exists(filePath: string): Promise<boolean> {
		try {
			await stat(filePath);
			return true;
		} catch {
			return false;
		}
	}

	async writeFile(filePath: string, data: Uint8Array): Promise<void> {
		await writeFile(filePath, data);
	}
}
