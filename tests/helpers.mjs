import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Points DATABASE_URL at a fresh temp file. Call before importing src/core. */
// Tests never call a real model; the moderation tests plug in their own stand-in.
process.env.MODERATION_PROVIDER = 'off';

export function useTempDatabase(name = 'test') {
	const dir = mkdtempSync(join(tmpdir(), 'pw-'));
	process.env.DATABASE_URL = `file:${join(dir, `${name}.db`)}`;
	return process.env.DATABASE_URL;
}
