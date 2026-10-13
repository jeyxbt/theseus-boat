/**
 * The tools the build agent gets when it runs on the Messages API instead of
 * Claude Code. There is no shell and no network: the agent can look at the
 * working tree and change files, and every path the model names is checked
 * here, in code, before anything is touched.
 *
 * Reading: anything in the working tree except secrets and state (.env,
 * databases, .git, node_modules, build output, the runner's data folder).
 * Writing: only what guards.pathProblem() allows, the same rule the diff review
 * applies afterwards. A path that leaves the tree, or reaches it through a
 * symbolic link, is refused whatever it is.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { pathProblem } from './guards';

export const SANDBOX_LIMITS = {
	/** Largest file the agent may write, in bytes. */
	maxWriteBytes: 300 * 1024,
	/** Everything it may write in one run. */
	maxTotalWriteBytes: 1536 * 1024,
	/** Writes and edits in one run, refused ones not counted. */
	maxChanges: 120,
	maxReadLines: 2000,
	maxReadBytes: 120 * 1024,
	/** Files looked at by one search, and bytes per file. */
	maxSearchFiles: 3000,
	maxSearchFileBytes: 300 * 1024,
	maxListEntries: 400,
	maxSearchHits: 150,
};

const DENIED_DIRS = new Set(['.git', 'node_modules', 'dist', 'data', '.astro']);
const DENIED_FILE = /^(\.env.*|.*\.(db|db-shm|db-wal|db-journal|sqlite|pem|key)|\.iterate.*|\.release-sha)$/i;

export type ToolResult = { ok: true; text: string } | { ok: false; text: string };
const ok = (text: string): ToolResult => ({ ok: true, text });
const refuse = (text: string): ToolResult => ({ ok: false, text });

/** A glob like src/**\/*.astro as a regular expression. `*` stays inside a folder; `**` crosses folders. */
export function globToRegExp(glob: string) {
	let out = '';
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i];
		if (char === '*') {
			if (glob[i + 1] === '*') {
				i++;
				if (glob[i + 1] === '/') i++;
				out += '(?:.*/)?';
			} else {
				out += '[^/]*';
			}
		} else if (char === '?') {
			out += '[^/]';
		} else {
			out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		}
	}
	return new RegExp(`^${out}$`);
}

export function createSandbox(root: string) {
	const base = resolve(root);
	let real = base;
	try {
		real = realpathSync(base);
	} catch {
		// A tree that doesn't exist yet has nothing to read.
	}
	const usage = { changes: 0, bytes: 0 };

	/** A path the model gave, as a clean tree-relative POSIX path, or why it is not acceptable. */
	function clean(raw: unknown): { path: string } | { error: string } {
		if (typeof raw !== 'string' || raw.trim() === '') return { error: 'a path is required' };
		if (raw.includes('\0')) return { error: 'invalid path' };
		const given = raw.trim().replaceAll('\\', '/');
		const absolute = isAbsolute(given) || /^[A-Za-z]:\//.test(given) ? resolve(given) : resolve(base, given);
		const rel = relative(base, absolute).split(sep).join('/');
		if (rel === '' ) return { path: '.' };
		if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return { error: `outside the working tree: ${raw}` };
		return { path: posix.normalize(rel) };
	}

	const deniedRead = (rel: string) => {
		if (rel === '.') return null;
		const parts = rel.split('/');
		for (const [index, part] of parts.entries()) {
			if (DENIED_DIRS.has(part)) return `not readable: ${rel}`;
			if (index === parts.length - 1 && DENIED_FILE.test(part)) return `not readable: ${rel}`;
			// A .env anywhere on the way, as a folder, is as secret as the file.
			if (/^\.env/i.test(part)) return `not readable: ${rel}`;
		}
		return null;
	};

	/** The real location must still be inside the tree: no symbolic link may lead out of it. */
	function staysInside(absolute: string) {
		let probe = absolute;
		while (!existsSync(probe)) {
			const parent = dirname(probe);
			if (parent === probe) return false;
			probe = parent;
		}
		const actual = realpathSync(probe);
		const inside = relative(real, actual);
		return inside === '' || !(inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside));
	}

	function readable(raw: unknown): { path: string; absolute: string } | { error: string } {
		const checked = clean(raw);
		if ('error' in checked) return checked;
		const denied = deniedRead(checked.path);
		if (denied) return { error: denied };
		const absolute = join(base, checked.path);
		if (!staysInside(absolute)) return { error: `outside the working tree: ${checked.path}` };
		return { path: checked.path, absolute };
	}

	function writable(raw: unknown): { path: string; absolute: string } | { error: string } {
		const checked = clean(raw);
		if ('error' in checked) return checked;
		const problem = pathProblem(checked.path);
		if (problem) return { error: `not allowed: ${problem}` };
		const absolute = join(base, checked.path);
		if (!staysInside(absolute)) return { error: `outside the working tree: ${checked.path}` };
		if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) return { error: `not allowed: ${checked.path} is a symbolic link` };
		return { path: checked.path, absolute };
	}

	/** Every readable file under a folder, relative to the tree, in a stable order. */
	function walk(startRel: string, limit = Infinity) {
		const found: string[] = [];
		const visit = (rel: string) => {
			if (found.length >= limit) return;
			const absolute = rel === '.' ? base : join(base, rel);
			let entries;
			try {
				entries = readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
			} catch {
				return;
			}
			for (const entry of entries) {
				const child = rel === '.' ? entry.name : `${rel}/${entry.name}`;
				if (entry.isSymbolicLink()) continue;
				if (entry.isDirectory()) {
					if (!DENIED_DIRS.has(entry.name) && !/^\.env/i.test(entry.name)) visit(child);
				} else if (entry.isFile() && !DENIED_FILE.test(entry.name)) {
					found.push(child);
					if (found.length >= limit) return;
				}
			}
		};
		visit(startRel);
		return found;
	}

	function takeBudget(bytes: number): string | null {
		if (usage.changes >= SANDBOX_LIMITS.maxChanges) return `too many changes in one run (max ${SANDBOX_LIMITS.maxChanges})`;
		if (usage.bytes + bytes > SANDBOX_LIMITS.maxTotalWriteBytes) {
			return `too much written in one run (max ${SANDBOX_LIMITS.maxTotalWriteBytes / 1024} KB in total)`;
		}
		usage.changes++;
		usage.bytes += bytes;
		return null;
	}

	return {
		/** Paths of files written or edited, for the log. */
		usage,

		readFile(input: { path?: unknown; offset?: unknown; limit?: unknown }): ToolResult {
			const target = readable(input.path);
			if ('error' in target) return refuse(target.error);
			if (!existsSync(target.absolute)) return refuse(`no such file: ${target.path}`);
			const stat = statSync(target.absolute);
			if (stat.isDirectory()) return refuse(`${target.path} is a folder: use list_files`);
			const bytes = readFileSync(target.absolute);
			if (bytes.includes(0)) return refuse(`${target.path} is a binary file (${bytes.length} bytes)`);

			const lines = bytes.toString('utf8').split('\n');
			const offset = Math.max(1, Math.floor(Number(input.offset) || 1));
			const limit = Math.min(SANDBOX_LIMITS.maxReadLines, Math.max(1, Math.floor(Number(input.limit) || SANDBOX_LIMITS.maxReadLines)));
			let out = '';
			let shown = 0;
			for (let i = offset - 1; i < lines.length && shown < limit; i++) {
				const next = `${i + 1}\t${lines[i]}\n`;
				if (out.length + next.length > SANDBOX_LIMITS.maxReadBytes) break;
				out += next;
				shown++;
			}
			const last = offset - 1 + shown;
			const more = last < lines.length ? `\n[showing lines ${offset}-${last} of ${lines.length}; read on with offset ${last + 1}]` : '';
			return ok(out === '' ? `[${target.path} is empty or has no line ${offset}]` : out + more);
		},

		listFiles(input: { path?: unknown; pattern?: unknown }): ToolResult {
			const target = input.path === undefined || input.path === '' ? { path: '.', absolute: base } : readable(input.path);
			if ('error' in target) return refuse(target.error);
			if (!existsSync(target.absolute) || !statSync(target.absolute).isDirectory()) return refuse(`no such folder: ${target.path}`);
			let matcher: RegExp | null = null;
			if (input.pattern !== undefined && input.pattern !== '') {
				if (typeof input.pattern !== 'string' || input.pattern.length > 200) return refuse('the pattern must be a short glob like src/**/*.astro');
				// A bare pattern like *.astro means "anywhere below".
				matcher = globToRegExp(input.pattern.includes('/') ? input.pattern : `**/${input.pattern}`);
			}
			const files = walk(target.path).filter((file) => !matcher || matcher.test(file));
			const shown = files.slice(0, SANDBOX_LIMITS.maxListEntries);
			if (shown.length === 0) return ok('(no files)');
			const more = files.length > shown.length ? `\n[${files.length - shown.length} more: narrow the path or the pattern]` : '';
			return ok(shown.join('\n') + more);
		},

		search(input: { pattern?: unknown; path?: unknown; glob?: unknown; ignore_case?: unknown }): ToolResult {
			if (typeof input.pattern !== 'string' || input.pattern === '' || input.pattern.length > 200) {
				return refuse('a pattern (a regular expression, up to 200 characters) is required');
			}
			let expression: RegExp;
			try {
				expression = new RegExp(input.pattern, input.ignore_case === true ? 'i' : '');
			} catch (error) {
				return refuse(`invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
			}
			const target = input.path === undefined || input.path === '' ? { path: '.', absolute: base } : readable(input.path);
			if ('error' in target) return refuse(target.error);
			let matcher: RegExp | null = null;
			if (typeof input.glob === 'string' && input.glob !== '') {
				if (input.glob.length > 200) return refuse('the glob is too long');
				matcher = globToRegExp(input.glob.includes('/') ? input.glob : `**/${input.glob}`);
			}
			const files = existsSync(target.absolute) && statSync(target.absolute).isFile() ? [target.path] : walk(target.path, SANDBOX_LIMITS.maxSearchFiles);
			const hits: string[] = [];
			for (const file of files) {
				if (matcher && !matcher.test(file)) continue;
				let bytes: Buffer;
				try {
					const absolute = join(base, file);
					if (statSync(absolute).size > SANDBOX_LIMITS.maxSearchFileBytes) continue;
					bytes = readFileSync(absolute);
				} catch {
					continue;
				}
				if (bytes.includes(0)) continue;
				const lines = bytes.toString('utf8').split('\n');
				for (let i = 0; i < lines.length; i++) {
					if (expression.test(lines[i])) {
						hits.push(`${file}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
						if (hits.length >= SANDBOX_LIMITS.maxSearchHits) return ok(`${hits.join('\n')}\n[stopped at ${SANDBOX_LIMITS.maxSearchHits} matches: narrow the search]`);
					}
				}
			}
			return ok(hits.length === 0 ? '(no matches)' : hits.join('\n'));
		},

		editFile(input: { path?: unknown; old_string?: unknown; new_string?: unknown; replace_all?: unknown }): ToolResult {
			const target = writable(input.path);
			if ('error' in target) return refuse(target.error);
			if (typeof input.old_string !== 'string' || input.old_string === '') return refuse('old_string is required and can’t be empty');
			if (typeof input.new_string !== 'string') return refuse('new_string is required (it may be empty to delete the old text)');
			if (input.old_string === input.new_string) return refuse('old_string and new_string are the same: nothing to change');
			if (!existsSync(target.absolute)) return refuse(`no such file: ${target.path}. Use write_file to create it.`);

			const before = readFileSync(target.absolute, 'utf8');
			const count = before.split(input.old_string).length - 1;
			if (count === 0) return refuse(`old_string was not found in ${target.path}. Read the file again and copy the text exactly, spaces and tabs included.`);
			if (count > 1 && input.replace_all !== true) {
				return refuse(`old_string appears ${count} times in ${target.path}. Add surrounding lines to make it unique, or set replace_all to true.`);
			}
			const after = input.replace_all === true ? before.split(input.old_string).join(input.new_string) : before.replace(input.old_string, () => input.new_string as string);
			const size = Buffer.byteLength(after);
			if (size > SANDBOX_LIMITS.maxWriteBytes) return refuse(`the file would be ${Math.round(size / 1024)} KB: over the ${SANDBOX_LIMITS.maxWriteBytes / 1024} KB limit`);
			const spent = takeBudget(Math.abs(size - Buffer.byteLength(before)));
			if (spent) return refuse(spent);
			writeFileSync(target.absolute, after);
			return ok(`edited ${target.path}${count > 1 ? ` (${count} places)` : ''}`);
		},

		writeFile(input: { path?: unknown; content?: unknown }): ToolResult {
			const target = writable(input.path);
			if ('error' in target) return refuse(target.error);
			if (typeof input.content !== 'string') return refuse('content is required');
			const size = Buffer.byteLength(input.content);
			if (size > SANDBOX_LIMITS.maxWriteBytes) return refuse(`the file would be ${Math.round(size / 1024)} KB: over the ${SANDBOX_LIMITS.maxWriteBytes / 1024} KB limit`);
			const spent = takeBudget(size);
			if (spent) return refuse(spent);
			const existed = existsSync(target.absolute);
			mkdirSync(dirname(target.absolute), { recursive: true });
			writeFileSync(target.absolute, input.content);
			return ok(`${existed ? 'overwrote' : 'created'} ${target.path} (${size} bytes)`);
		},
	};
}

export type Sandbox = ReturnType<typeof createSandbox>;
