/**
 * The checks every AI change must pass before it is built. The AI may only
 * touch the site's own pages and components; everything that runs the site
 * (voting, sign-in, the cycle, the database, the API) is off limits, and so is
 * any code that could reach secrets, the server or other domains.
 *
 * Pure functions take text and paths, so they can be tested without git;
 * reviewWorkingTree() reads a real working tree and runs them all.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { parseCollection, STORE_LIMITS } from '../../src/core/store/collections';

export const ALLOWED_PREFIXES = ['src/', 'public/'];

/** The core. Never written by the AI. */
const DENIED_PREFIXES = ['src/core/', 'src/pages/api/', 'src/middleware/', 'src/actions/', 'public/core/', 'public/_astro/', 'public/api/'];
const DENIED_FILES = new Set([
	'src/middleware.ts',
	'src/middleware.js',
	'src/env.d.ts',
	'src/content.config.ts',
	'src/live.config.ts',
	'public/favicon.svg',
]);
/** Pages that belong to the core. The home page is the AI's, the rest are not. */
const CORE_PAGES = ['ideas', 'build', 'changelog', 'rules', 'privacy', 'signin', '404', '500'];
const CORE_PAGE = new RegExp(`^src/pages/(${CORE_PAGES.join('|')})(\\.[^/]+|/.*)$`);
const CORE_PUBLIC = new RegExp(`^public/(${CORE_PAGES.join('|')}|api)(\\.[^/]*|/.*)?$`);

/** Shared-data declarations: src/collections/<name>.json, checked by the core's own rules. */
const COLLECTION_FILE = /^src\/collections\/[a-z][a-z0-9-]{1,31}\.json$/;

/** Why a changed collection declaration is not acceptable, as a list. */
export function collectionProblems(path: string, text: string) {
	const name = path.slice('src/collections/'.length).replace(/\.json$/, '');
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return [`collection ${path} is not valid JSON`];
	}
	const parsed = parseCollection(name, raw);
	return parsed.ok ? [] : parsed.problems.map((problem) => `collection ${path}: ${problem}`);
}

const IMAGE_EXT = /\.(png|jpe?g|webp|avif|gif)$/i;
const SRC_EXT = /\.(astro|ts|js|mjs|css|json|svg|png|jpe?g|webp|avif|gif)$/i;
const PUBLIC_EXT = /\.(svg|png|jpe?g|webp|avif|gif)$/i;
const CODE_EXT = /\.(astro|[cm]?[jt]s)$/i;

export const LIMITS = {
	maxChangedLines: 800,
	maxAddedBytes: 1024 * 1024,
	maxImageBytes: 500 * 1024,
	maxImagesBytes: 2 * 1024 * 1024,
};

/** Why the AI may not touch this path, or null if it may. */
export function pathProblem(path: string): string | null {
	if (!path || path.includes('\\') || path.includes('\0') || /(^|\/)\.\.(\/|$)/.test(path)) return `invalid path: ${path}`;
	if (!ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix))) return `outside src/ and public/: ${path}`;
	// A new .gitignore or .gitattributes hides what's next to it from these checks.
	if (/(^|\/)\./.test(path)) return `hidden file: ${path}`;
	if (DENIED_FILES.has(path) || DENIED_PREFIXES.some((prefix) => path.startsWith(prefix))) return `core file: ${path}`;
	if (CORE_PAGE.test(path) || CORE_PUBLIC.test(path)) return `core page: ${path}`;
	// A .ts/.js/.md file under src/pages/ is an endpoint or a page nobody designed for.
	if (path.startsWith('src/pages/') && !path.endsWith('.astro')) return `only .astro pages: ${path}`;
	if (path.startsWith('src/collections/') && !COLLECTION_FILE.test(path)) {
		return `src/collections/ holds only <name>.json declarations: ${path}`;
	}
	if (path.startsWith('src/') && !SRC_EXT.test(path)) return `file type not allowed: ${path}`;
	if (path.startsWith('public/') && !PUBLIC_EXT.test(path)) return `only images in public/: ${path}`;
	return null;
}

const ALLOWED_PACKAGES = [/^astro$/, /^astro:(assets|transitions)$/, /^@iconify-json\/tabler$/];
/** From the core, only display components, the read-only data layer and formatting helpers. */
const ALLOWED_CORE = /^src\/core\/(components\/[\w-]+\.astro|public\/[\w/-]+?(\.ts)?|format(\.ts)?)$/;

/** Why `file` may not import `specifier`, or null if it may. */
export function importProblem(file: string, specifier: string): string | null {
	if (/[?#]/.test(specifier)) return `import with a query ("${specifier}") in ${file}`;
	if (specifier.startsWith('/')) return `absolute import "${specifier}" in ${file}`;
	if (!specifier.startsWith('.')) {
		return ALLOWED_PACKAGES.some((allowed) => allowed.test(specifier)) ? null : `package "${specifier}" in ${file}`;
	}
	const resolved = posix.normalize(posix.join(posix.dirname(file), specifier));
	if (!resolved.startsWith('src/')) return `import from outside src/ ("${specifier}") in ${file}`;
	if (resolved.startsWith('src/core/') && !ALLOWED_CORE.test(resolved)) return `core module "${specifier}" in ${file}`;
	if (/^src\/(pages\/api|middleware|actions)(\/|\.|$)/.test(resolved)) return `server module "${specifier}" in ${file}`;
	return null;
}

/** Static, dynamic and re-exported module specifiers. */
export function importsOf(text: string) {
	const found: string[] = [];
	const re = /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"`])([^'"`\n]+)\1/g;
	for (const match of text.matchAll(re)) found.push(match[2]);
	return found;
}

/** The parts of an .astro file that run as code: frontmatter, <script> blocks and {expressions}. */
export function codeRegions(file: string, text: string) {
	if (!file.endsWith('.astro')) return CODE_EXT.test(file) ? text : '';
	const parts: string[] = [];
	const front = text.match(/^\s*---\r?\n([\s\S]*?)\r?\n---/);
	if (front) parts.push(front[1]);
	const template = front ? text.slice(front[0].length) : text;
	for (const match of template.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) parts.push(match[1]);
	// Braces outside <script>/<style> are template expressions, which run on the server.
	const markup = template.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
	let depth = 0;
	let start = -1;
	for (let i = 0; i < markup.length; i++) {
		if (markup[i] === '{') {
			if (depth === 0) start = i + 1;
			depth++;
		} else if (markup[i] === '}' && depth > 0) {
			depth--;
			if (depth === 0) parts.push(markup.slice(start, i));
		}
	}
	return parts.join('\n');
}

/** The part that runs on the server: frontmatter of an .astro file, or a whole module. */
export function serverPart(file: string, text: string) {
	if (file.endsWith('.astro')) return text.match(/^\s*---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
	return /\.[cm]?[jt]s$/.test(file) ? text : '';
}

type Rule = [RegExp, string];

/** Anywhere in any text file: no idea for a web page needs these. */
const DANGEROUS: Rule[] = [
	[/\beval\s*[(`]/, 'eval()'],
	[/new\s+Function\s*\(/, 'new Function()'],
	[/child_process|\bexecSync\b|\bspawnSync\b|\bexecFileSync\b/, 'running processes'],
	[/\bfetch\s*\(\s*['"`](?:https?:)?\/\//i, 'fetch to another domain'],
	[/\bimport\s*\(\s*['"`](?:https?:)?\/\//i, 'importing code from another domain'],
	[/<script[^>]+src\s*=\s*["']?(?:https?:)?\/\//i, 'script from another domain'],
	[/<(link|iframe|embed|object|frame)\b[^>]+(?:href|src|data)\s*=\s*["']?(?:https?:)?\/\//i, 'resource from another domain'],
	[/new\s+WebSocket\s*\(/, 'WebSocket'],
	[/XMLHttpRequest/, 'XMLHttpRequest'],
	[/\bnew\s+Worker\s*\(|serviceWorker|SharedWorker/, 'workers'],
	[/@import\s+(url\()?\s*['"]?(?:https?:)?\/\//i, 'CSS import from another domain'],
	[/url\(\s*['"]?(?:https?:)?\/\//i, 'CSS url() to another domain'],
	[/\bsendBeacon\b/, 'sendBeacon'],
	[/http-equiv\s*=\s*["']?refresh/i, 'meta refresh'],
	[/rel\s*=\s*["']?(prefetch|preconnect|dns-prefetch|prerender)\b/i, 'preloading other domains'],
	// Visitors' text from the store must never become markup.
	[/\bset:html\b/, 'set:html (unescaped HTML)'],
	[/\binsertAdjacentHTML\b|\bcreateContextualFragment\b|\bDOMParser\b|\bdocument\s*\.\s*write(ln)?\s*\(/, 'writing raw HTML'],
];

/** In code regions only, so ordinary English copy ("our process", "update the board") never trips them. */
const CODE_ONLY: Rule[] = [
	[/\bprocess\b/, 'process'],
	[/\bglobalThis\b/, 'globalThis'],
	[/\brequire\s*\(|\bcreateRequire\b/, 'require'],
	[/import\.meta\.(glob|env)\b/, 'import.meta.glob/env'],
	[/\.\s*constructor\b|\[\s*['"`]constructor['"`]\s*\]/, '.constructor'],
	[/\bReflect\b|\bProxy\s*\(/, 'Reflect/Proxy'],
	[/['"`]eval['"`]|\bFunction\s*[(`]|['"`]Function['"`]/, 'Function/eval'],
	[/\b(setTimeout|setInterval)\s*\(\s*['"`]/, 'code as a string in a timer'],
	// obj['pro' + 'cess']: naming something forbidden without writing it.
	[/\[\s*['"`][^'"`\]]*['"`]\s*\+/, 'computed property name'],
	[/\bimport\s*\((?!\s*['"][^'"]+['"]\s*\))/, 'import() with a computed path'],
	[/\bwindow\s*\.\s*open\s*\(/, 'window.open'],
	// Clearing with innerHTML = '' is fine; putting anything into it is not.
	[/\.(inner|outer)HTML\s*(\+=|=(?!=))(?!\s*(''|""|``)\s*($|[;\n)},]))/m, 'innerHTML with content'],
	[/\[\s*['"`](inner|outer)HTML['"`]\s*\]|\b(inner|outer)HTML\s*:/, 'innerHTML with content'],
	[/\blocation(\s*\.\s*href)?\s*=(?!=)(?!\s*['"`]\/(?![\/\\]))/, 'navigating away from the site'],
	[/\blocation\s*\.\s*(assign|replace)\s*\((?!\s*['"`]\/(?![\/\\]))/, 'navigating away from the site'],
	[/\bexport\s+const\s+(prerender|partial)\b|\bgetStaticPaths\b/, 'code that runs at build time'],
	[/\bgetDb\b|\bDatabaseSync\b|\bgetProviderConfig\b|\bgetDatabaseUrl\b|\bconfiguredProviders\b/, 'database or secret access'],
	[/\bsession\s*\??\.\s*(set|regenerate|destroy|delete)\s*\(/, 'changing the visitor’s session'],
	[/\bcookies\s*\.\s*(set|delete)\s*\(|\bdocument\s*\.\s*cookie\b/, 'cookies'],
	[
		/\b(INSERT\s+(OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE\s+(OR\s+\w+\s+)?["'`[]?\w+["'`\]]?\s+SET|DELETE\s+FROM|DROP\s+(TABLE|INDEX|VIEW|TRIGGER)|ALTER\s+TABLE|CREATE\s+(TEMP\w*\s+)?(TABLE|INDEX|VIEW|TRIGGER)|ATTACH\s+DATABASE|VACUUM\s+INTO|PRAGMA)\b/i,
		'SQL that changes the database',
	],
	[/['"`]\s*(DROP|DELETE|INSERT|UPDATE|ALTER|ATTACH|PRAGMA)\s*['"`]\s*\+|\+\s*['"`]\s*(TABLE|FROM|INTO|SET)\b/i, 'SQL built from pieces'],
	[/\bFROM\s+sessions\b|\bsessions\s+WHERE\b|\bsqlite_(master|schema)\b/i, 'reading sessions or the schema'],
	[/\b(FROM|JOIN|INTO|UPDATE|TABLE)\s+(['"`]\s*\+|\$\{)/i, 'SQL with a computed table name'],
	[/\bfrom\s+['"]node:|\brequire\s*\(\s*['"]node:/, 'Node modules'],
];

/** Server-side only: a fetch to anything but a literal path on this site is SSRF or a leak. */
const SERVER_ONLY: Rule[] = [[/\bfetch\s*\((?!\s*['"`]\/(?![\/\\]))/, 'server-side fetch to a non-literal address']];

/** SVG can carry script; only plain drawings are allowed. */
const SVG_RULES: Rule[] = [
	[/<script/i, 'script in SVG'],
	[/\son[a-z]+\s*=/i, 'event handler in SVG'],
	[/<foreignObject/i, 'foreignObject in SVG'],
	[/javascript:/i, 'javascript: URL in SVG'],
	[/(?:xlink:)?href\s*=\s*["']?(?:https?:)?\/\//i, 'external reference in SVG'],
	[/<!ENTITY|<!DOCTYPE/i, 'entities in SVG'],
];

const SECRET_PATTERNS: Rule[] = [
	[/sk-ant-[A-Za-z0-9_-]{16,}/, 'Anthropic key'],
	[/\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/, 'API key'],
	[/\bgh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/, 'GitHub token'],
	[/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
	[/\bAKIA[0-9A-Z]{16}\b/, 'AWS key'],
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
];

/**
 * Reviews added text, per file. `contentOf` gives a file's full content after
 * the change, to know which part of an .astro file runs on the server.
 */
export function reviewAdded(files: Map<string, string>, contentOf: (file: string) => string = () => '') {
	const found = new Set<string>();
	for (const [file, text] of files) {
		const isCode = CODE_EXT.test(file);
		const full = contentOf(file) || text;

		for (const [pattern, name] of DANGEROUS) if (pattern.test(text)) found.add(`${name} in ${file}`);

		if (file.toLowerCase().endsWith('.svg')) {
			for (const [pattern, name] of SVG_RULES) if (pattern.test(full)) found.add(`${name}: ${file}`);
		}

		if (!isCode) continue;
		// Code rules look at the whole changed file, not just added lines: a change that adds
		// half an expression, or splits a word across lines, is judged by what it produces.
		const code = codeRegions(file, full);
		for (const [pattern, name] of CODE_ONLY) if (pattern.test(code)) found.add(`${name} in ${file}`);
		for (const [pattern, name] of SERVER_ONLY) if (pattern.test(serverPart(file, full))) found.add(`${name} in ${file}`);
		for (const specifier of importsOf(text)) {
			const problem = importProblem(file, specifier);
			if (problem) found.add(problem);
		}
	}
	return [...found];
}

/** Secrets that must never appear in a change: known key formats, and values from our own environment. */
export function leakedSecrets(files: Map<string, string>, secretValues: string[] = []) {
	const found = new Set<string>();
	for (const [file, text] of files) {
		for (const [pattern, name] of SECRET_PATTERNS) if (pattern.test(text)) found.add(`${name} in ${file}`);
		for (const value of secretValues) if (value.length >= 12 && text.includes(value)) found.add(`a configured secret in ${file}`);
	}
	return [...found];
}

/** Values of secret-looking environment variables, to look for in the diff. */
export function secretValuesFrom(env: NodeJS.ProcessEnv) {
	return Object.entries(env)
		.filter(([key, value]) => value && /SECRET|KEY|TOKEN|PASSWORD|CLIENT_ID|DATABASE_URL/i.test(key))
		.map(([, value]) => String(value).trim())
		.filter((value) => value.length >= 12);
}

const MAGIC: [RegExp, (bytes: Buffer) => boolean][] = [
	[/\.png$/i, (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
	[/\.jpe?g$/i, (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
	[/\.gif$/i, (b) => b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a'],
	[/\.webp$/i, (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
	[/\.avif$/i, (b) => b.subarray(4, 12).toString('latin1') === 'ftypavif'],
];

/** A raster image must really be one, and not too big. */
export function imageProblem(path: string, bytes: Buffer) {
	if (bytes.length > LIMITS.maxImageBytes) return `image over ${LIMITS.maxImageBytes / 1024} KB: ${path}`;
	const check = MAGIC.find(([pattern]) => pattern.test(path));
	if (check && !check[1](bytes)) return `not a real image: ${path}`;
	return null;
}

/**
 * Added lines per file from `git diff` output. A state machine: "+++" only
 * counts as a header before a file's first hunk, so an added line that begins
 * with "++ " can't pose as a new file name.
 */
export function parseDiff(diff: string) {
	const files = new Map<string, string>();
	let current: string | null = null;
	let inHunk = false;
	for (const line of diff.split('\n')) {
		if (line.startsWith('diff --git ')) {
			current = null;
			inHunk = false;
			continue;
		}
		if (!inHunk) {
			if (line.startsWith('+++ ')) {
				const path = line.slice(4).trim();
				current = path === '/dev/null' ? null : path.replace(/^b\//, '');
			} else if (line.startsWith('@@')) {
				inHunk = true;
			}
			continue;
		}
		if (line.startsWith('@@')) continue;
		if (current && line.startsWith('+')) files.set(current, `${files.get(current) ?? ''}${line.slice(1)}\n`);
	}
	return files;
}

// ---- Working tree ----

function git(cwd: string, args: string[]) {
	return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
		cwd,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

/** Every changed path, including both sides of a rename and untracked files. */
export function changedPaths(cwd: string) {
	const out = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
	const entries = out.split('\0').filter(Boolean);
	const paths: { path: string; status: string }[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const status = entry.slice(0, 2);
		paths.push({ path: entry.slice(3), status });
		// With -z, a rename or copy is followed by its original path as a separate entry.
		if (/[RC]/.test(status) && i + 1 < entries.length) paths.push({ path: entries[++i], status: 'R-' });
	}
	return paths;
}

/** Files git hides because of an ignore rule: they would escape every check and live on. */
export function ignoredPaths(cwd: string) {
	return git(cwd, ['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all', '--', ...ALLOWED_PREFIXES])
		.split('\0')
		.filter((entry) => entry.startsWith('!! '))
		.map((entry) => entry.slice(3));
}

export type Review = {
	ok: boolean;
	problems: string[];
	files: string[];
	added: number;
	removed: number;
};

/** Runs every check on the uncommitted changes in `cwd`. Any exception counts as a failure. */
export function reviewWorkingTree(cwd: string, secretValues: string[] = []): Review {
	try {
		return reviewUnsafe(cwd, secretValues);
	} catch (error) {
		return {
			ok: false,
			problems: [`the review itself failed: ${error instanceof Error ? error.message : String(error)}`],
			files: [],
			added: 0,
			removed: 0,
		};
	}
}

function reviewUnsafe(cwd: string, secretValues: string[]): Review {
	const changed = changedPaths(cwd);
	const problems = new Set<string>();
	const files = [...new Set(changed.map((entry) => entry.path))];

	for (const { path } of changed) {
		const problem = pathProblem(path);
		if (problem) problems.add(problem);
		const full = join(cwd, path);
		if (existsSync(full)) {
			const stat = lstatSync(full);
			if (stat.isSymbolicLink()) problems.add(`symbolic link: ${path}`);
			else if (!stat.isFile()) problems.add(`not a regular file: ${path}`);
		}
	}
	for (const path of ignoredPaths(cwd)) problems.add(`file hidden by an ignore rule: ${path}`);

	// Tracked changes from the diff; new files straight from disk.
	const tracked = changed.filter((entry) => entry.status !== '??' && entry.status !== 'R-').map((entry) => entry.path);
	const untracked = changed.filter((entry) => entry.status === '??').map((entry) => entry.path);

	let added = 0;
	let removed = 0;
	const addedText = new Map<string, string>();
	let imageBytes = 0;

	if (tracked.length > 0) {
		const numstat = git(cwd, ['diff', 'HEAD', '--numstat', '--no-renames', '--no-ext-diff', '--no-textconv', '--', ...tracked]);
		for (const line of numstat.split('\n').filter(Boolean)) {
			const [a, r] = line.split('\t');
			added += Number(a) || 0;
			removed += Number(r) || 0;
		}
		const textual = tracked.filter((path) => !IMAGE_EXT.test(path));
		if (textual.length > 0) {
			const diff = git(cwd, ['diff', 'HEAD', '--text', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color', '--', ...textual]);
			for (const [file, text] of parseDiff(diff)) addedText.set(file, text);
		}
	}

	for (const path of [...tracked, ...untracked]) {
		const full = join(cwd, path);
		if (!existsSync(full) || lstatSync(full).isSymbolicLink() || !lstatSync(full).isFile()) continue;
		if (IMAGE_EXT.test(path)) {
			const bytes = readFileSync(full);
			imageBytes += bytes.length;
			const problem = imageProblem(path, bytes);
			if (problem) problems.add(problem);
			continue;
		}
		if (untracked.includes(path)) {
			const text = readFileSync(full, 'utf8');
			addedText.set(path, text);
			added += text.split('\n').length;
		}
	}

	if (imageBytes > LIMITS.maxImagesBytes) problems.add(`images over ${LIMITS.maxImagesBytes / 1024 / 1024} MB in total`);
	if (added + removed > LIMITS.maxChangedLines) problems.add(`change too large: ${added + removed} lines (max ${LIMITS.maxChangedLines})`);
	const bytes = [...addedText.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0);
	if (bytes > LIMITS.maxAddedBytes) problems.add(`change too large: ${Math.round(bytes / 1024)} KB of text`);

	const contentOf = (file: string) => {
		try {
			return readFileSync(join(cwd, file), 'utf8');
		} catch {
			return '';
		}
	};
	for (const problem of reviewAdded(addedText, contentOf)) problems.add(problem);
	for (const problem of leakedSecrets(addedText, secretValues)) problems.add(problem);

	for (const path of files.filter((file) => COLLECTION_FILE.test(file))) {
		if (!existsSync(join(cwd, path))) continue;
		for (const problem of collectionProblems(path, contentOf(path))) problems.add(problem);
	}
	const collectionsDir = join(cwd, 'src', 'collections');
	const declared = existsSync(collectionsDir) ? readdirSync(collectionsDir).filter((name) => name.endsWith('.json')).length : 0;
	if (declared > STORE_LIMITS.collections) problems.add(`too many collections: ${declared} (max ${STORE_LIMITS.collections})`);

	return { ok: problems.size === 0, problems: [...problems], files, added, removed };
}
