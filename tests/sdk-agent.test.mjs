import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { useTempDatabase } from './helpers.mjs';

useTempDatabase('sdk-agent');

const { costUsd, PRICES } = await import('../src/core/ai/pricing.ts');
const { createSandbox, globToRegExp, SANDBOX_LIMITS } = await import('../scripts/pipeline/sandbox.ts');
const { runSdkAgent, setSdkClientForTests, TOOLS } = await import('../scripts/pipeline/sdk-agent.ts');
const { pipelineConfig } = await import('../scripts/pipeline/config.ts');

// ---- A working tree like the runner's ----

function tree(files = {}) {
	const root = mkdtempSync(join(tmpdir(), 'pw-sandbox-'));
	const all = {
		'src/pages/index.astro': '---\nconst a = 1;\n---\n<h1>Home</h1>\n<p>one</p>\n<p>one</p>\n',
		'src/components/Card.astro': '<div class="card"></div>\n',
		'src/core/votes.ts': 'export const MAX = 3;\n',
		'src/pages/api/votes.ts': 'export const POST = 1;\n',
		'public/sun.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
		'package.json': '{ "name": "fixture" }\n',
		'.env': 'SESSION_SECRET=do-not-read-me-0123456789\n',
		'.env.local': 'X=1\n',
		'data/local.db': 'binary-ish',
		'node_modules/pkg/index.js': 'module.exports = 1;\n',
		'dist/server/entry.mjs': 'export {};\n',
		'.git/config': '[core]\n',
		...files,
	};
	for (const [path, text] of Object.entries(all)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	return root;
}

// ---- Cost ----

describe('what a call costs', () => {
	test('uncached input, cache writes, cache reads and output are each priced', () => {
		const usage = { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10_000, output_tokens: 500 };
		// Sonnet 5.5: $2 in, $10 out; a write costs 1.25x, a read a tenth.
		const expected = (1000 * 2 + 2000 * 2 * 1.25 + 10_000 * 2 * 0.1 + 500 * 10) / 1e6;
		assert.ok(Math.abs(costUsd('claude-sonnet-5-5', usage) - expected) < 1e-12);
	});

	test('a long prompt on Haiku is priced at the higher rate', () => {
		const short = costUsd('claude-haiku-5-5', { input_tokens: 90_000, output_tokens: 1000 });
		const long = costUsd('claude-haiku-5-5', { input_tokens: 110_000, output_tokens: 1000 });
		assert.ok(Math.abs(short - (90_000 * 0.1 + 1000 * 0.5) / 1e6) < 1e-12);
		assert.ok(Math.abs(long - (110_000 * 0.5 + 1000 * 2.5) / 1e6) < 1e-12);
	});

	test('an unknown model is counted at the dearest price, never as free; no usage is zero', () => {
		const usage = { input_tokens: 1_000_000, output_tokens: 0 };
		assert.equal(costUsd('some-future-model', usage), PRICES['claude-fable-5-1'].input);
		assert.equal(costUsd('claude-sonnet-5-5', null), 0);
		assert.equal(costUsd('claude-sonnet-5-5', {}), 0);
	});
});

// ---- The sandbox ----

describe('the sandbox: reading', () => {
	const root = tree();
	const sandbox = createSandbox(root);

	test('reads the site, with line numbers and paging', () => {
		const result = sandbox.readFile({ path: 'src/pages/index.astro' });
		assert.equal(result.ok, true);
		assert.match(result.text, /^1\t---\n2\tconst a = 1;/);
		const page = sandbox.readFile({ path: 'src/pages/index.astro', offset: 5, limit: 1 });
		assert.match(page.text, /^5\t<p>one<\/p>/);
		assert.match(page.text, /read on with offset 6/);
	});

	test('accepts the paths a model tends to write: leading ./, backslashes, an absolute path inside the tree', () => {
		assert.equal(sandbox.readFile({ path: './src/components/Card.astro' }).ok, true);
		assert.equal(sandbox.readFile({ path: 'src\\components\\Card.astro' }).ok, true);
		assert.equal(sandbox.readFile({ path: join(root, 'src', 'components', 'Card.astro') }).ok, true);
	});

	test('refuses secrets and state, however they are spelled', () => {
		for (const path of ['.env', '.env.local', './.env', 'data/local.db', 'node_modules/pkg/index.js', 'dist/server/entry.mjs', '.git/config', 'src/../.env', 'src/./../data/local.db']) {
			const result = sandbox.readFile({ path });
			assert.equal(result.ok, false, path);
		}
	});

	test('refuses paths that leave the tree', () => {
		for (const path of ['../outside.txt', '../../etc/passwd', 'src/../../x', '/etc/passwd', 'C:\\Windows\\win.ini', 'src/\0/x']) {
			assert.equal(sandbox.readFile({ path }).ok, false, path);
		}
		assert.equal(sandbox.readFile({}).ok, false);
		assert.equal(sandbox.readFile({ path: 42 }).ok, false);
	});

	test('lists files without the ones it must not show', () => {
		const all = sandbox.listFiles({}).text.split('\n');
		assert.ok(all.includes('src/pages/index.astro'));
		for (const hidden of ['.env', 'data/local.db', 'node_modules/pkg/index.js', 'dist/server/entry.mjs', '.git/config']) {
			assert.ok(!all.includes(hidden), `${hidden} was listed`);
		}
		assert.deepEqual(sandbox.listFiles({ pattern: '*.astro' }).text.split('\n').sort(), ['src/components/Card.astro', 'src/pages/index.astro']);
		assert.deepEqual(sandbox.listFiles({ path: 'src/pages', pattern: 'src/pages/*.astro' }).text.split('\n'), ['src/pages/index.astro']);
		assert.equal(sandbox.listFiles({ path: '.env' }).ok, false);
	});

	test('searches contents, and never looks in secrets', () => {
		const hits = sandbox.search({ pattern: 'MAX|do-not-read' }).text;
		assert.match(hits, /src\/core\/votes\.ts:1: export const MAX = 3;/);
		assert.doesNotMatch(hits, /do-not-read/);
		assert.equal(sandbox.search({ pattern: 'nothing-like-this' }).text, '(no matches)');
		assert.equal(sandbox.search({ pattern: '(' }).ok, false);
		assert.match(sandbox.search({ pattern: '<p>', glob: '*.astro' }).text, /index\.astro:5/);
		assert.equal(sandbox.search({ pattern: 'x', path: '.env' }).ok, false);
	});

	test('globs: * stays in a folder, ** crosses them', () => {
		assert.equal(globToRegExp('src/*.ts').test('src/a.ts'), true);
		assert.equal(globToRegExp('src/*.ts').test('src/lib/a.ts'), false);
		assert.equal(globToRegExp('src/**/*.ts').test('src/lib/deep/a.ts'), true);
		assert.equal(globToRegExp('src/**/*.ts').test('src/a.ts'), true);
		assert.equal(globToRegExp('**/*.astro').test('src/pages/index.astro'), true);
		assert.equal(globToRegExp('a.b').test('axb'), false);
	});
});

describe('the sandbox: writing', () => {
	test('creates and edits files where the guards allow', () => {
		const root = tree();
		const sandbox = createSandbox(root);
		assert.match(sandbox.writeFile({ path: 'src/pages/garden.astro', content: '<h1>Garden</h1>\n' }).text, /created src\/pages\/garden\.astro/);
		assert.equal(readFileSync(join(root, 'src/pages/garden.astro'), 'utf8'), '<h1>Garden</h1>\n');
		assert.match(sandbox.writeFile({ path: 'public/img/new.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }).text, /created/);
		assert.match(sandbox.writeFile({ path: 'src/pages/garden.astro', content: '<h1>Garden 2</h1>\n' }).text, /overwrote/);
		assert.match(sandbox.writeFile({ path: 'src/collections/notes.json', content: '{}' }).text, /created/);

		assert.match(sandbox.editFile({ path: 'src/components/Card.astro', old_string: 'card', new_string: 'card big' }).text, /edited/);
		assert.equal(readFileSync(join(root, 'src/components/Card.astro'), 'utf8'), '<div class="card big"></div>\n');
	});

	test('refuses the core, the API, config, hidden files and anything outside src/ and public/', () => {
		const root = tree();
		const sandbox = createSandbox(root);
		const forbidden = [
			'src/core/votes.ts',
			'src/core/new.ts',
			'src/pages/api/new.ts',
			'src/pages/api/votes.ts',
			'src/middleware.ts',
			'src/pages/ideas.astro',
			'package.json',
			'astro.config.mjs',
			'.env',
			'src/.gitignore',
			'scripts/x.mjs',
			'tests/x.mjs',
			'../escape.txt',
			'/tmp/escape.txt',
			'src/pages/feed.xml.js',
			'public/app.js',
		];
		for (const path of forbidden) {
			const result = sandbox.writeFile({ path, content: 'x' });
			assert.equal(result.ok, false, `wrote ${path}`);
		}
		assert.equal(readFileSync(join(root, 'src/core/votes.ts'), 'utf8'), 'export const MAX = 3;\n');
		assert.equal(sandbox.editFile({ path: 'src/core/votes.ts', old_string: '3', new_string: '300' }).ok, false);
		assert.equal(readFileSync(join(root, 'src/core/votes.ts'), 'utf8'), 'export const MAX = 3;\n');
		assert.equal(existsSync(join(root, 'src/core/new.ts')), false);
	});

	test('an edit needs a unique, exact match, and says what to do otherwise', () => {
		const root = tree();
		const sandbox = createSandbox(root);
		const twice = sandbox.editFile({ path: 'src/pages/index.astro', old_string: '<p>one</p>', new_string: '<p>two</p>' });
		assert.equal(twice.ok, false);
		assert.match(twice.text, /appears 2 times/);
		assert.match(sandbox.editFile({ path: 'src/pages/index.astro', old_string: '<p>one</p>', new_string: '<p>two</p>', replace_all: true }).text, /2 places/);
		assert.match(sandbox.editFile({ path: 'src/pages/index.astro', old_string: 'absent', new_string: 'x' }).text, /not found/);
		assert.equal(sandbox.editFile({ path: 'src/pages/index.astro', old_string: '', new_string: 'x' }).ok, false);
		assert.equal(sandbox.editFile({ path: 'src/pages/index.astro', old_string: 'Home', new_string: 'Home' }).ok, false);
		assert.match(sandbox.editFile({ path: 'src/pages/missing.astro', old_string: 'a', new_string: 'b' }).text, /no such file/);
		// "$&" and friends in the new text are text, not replacement patterns.
		sandbox.editFile({ path: 'src/pages/index.astro', old_string: '<h1>Home</h1>', new_string: '<h1>$& $1</h1>' });
		assert.match(readFileSync(join(root, 'src/pages/index.astro'), 'utf8'), /<h1>\$& \$1<\/h1>/);
	});

	test('limits: one file, the whole run, and the number of changes', () => {
		const root = tree();
		const sandbox = createSandbox(root);
		const big = 'x'.repeat(SANDBOX_LIMITS.maxWriteBytes + 1);
		assert.match(sandbox.writeFile({ path: 'src/pages/big.astro', content: big }).text, /over the/);
		assert.equal(existsSync(join(root, 'src/pages/big.astro')), false);

		const total = createSandbox(tree());
		const chunk = 'y'.repeat(SANDBOX_LIMITS.maxWriteBytes);
		let refused = null;
		for (let i = 0; i < 10 && !refused; i++) {
			const result = total.writeFile({ path: `src/pages/p${i}.astro`, content: chunk });
			if (!result.ok) refused = result.text;
		}
		assert.match(refused, /too much written in one run/);

		const many = createSandbox(tree());
		let last = null;
		for (let i = 0; i < SANDBOX_LIMITS.maxChanges + 1; i++) last = many.writeFile({ path: `src/pages/n${i}.astro`, content: 'a' });
		assert.match(last.text, /too many changes/);
	});

	test('a symbolic link cannot lead out of the tree', (t) => {
		const outside = mkdtempSync(join(tmpdir(), 'pw-outside-'));
		writeFileSync(join(outside, 'secret.txt'), 'outside secret');
		const root = tree();
		try {
			symlinkSync(outside, join(root, 'src', 'link'), 'junction');
		} catch {
			return t.skip('this machine does not allow creating links');
		}
		const sandbox = createSandbox(root);
		assert.equal(sandbox.readFile({ path: 'src/link/secret.txt' }).ok, false);
		assert.equal(sandbox.writeFile({ path: 'src/link/new.astro', content: 'x' }).ok, false);
		assert.equal(sandbox.editFile({ path: 'src/link/secret.txt', old_string: 'outside', new_string: 'inside' }).ok, false);
		assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'outside secret');
		assert.ok(!sandbox.listFiles({}).text.includes('secret.txt'));
	});
});

// ---- The loop ----

/** A stand-in for the SDK client: replies from a script, and records what it was sent. */
function stub(script) {
	const calls = [];
	let turn = 0;
	const client = {
		calls,
		messages: {
			stream(params, options) {
				calls.push({ params: { ...params, messages: JSON.parse(JSON.stringify(params.messages)) }, options });
				const reply = script[Math.min(turn++, script.length - 1)];
				return { finalMessage: async () => (typeof reply === 'function' ? reply(params, options) : reply) };
			},
		},
	};
	return client;
}

const usage = (extra = {}) => ({ input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...extra });
const text = (value) => ({ type: 'text', text: value });
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
const reply = (stop_reason, content, extra) => ({ stop_reason, content, usage: usage(extra) });

const config = (overrides = {}) => ({ ...pipelineConfig({}), model: 'claude-sonnet-5-5', agentRuntime: 'sdk', ...overrides });
const run = (root, overrides = {}, input = {}) =>
	runSdkAgent({ config: config(overrides), cwd: root, prompt: 'Build the idea.', timeoutMs: 10_000, maxBudgetUsd: 1, ...input });

describe('the agent loop', () => {
	test('reads, writes, and finishes: files land, the log names them, usage is summed', async () => {
		const root = tree();
		const client = stub([
			reply('tool_use', [text('Looking.'), use('t1', 'list_files', { pattern: '*.astro' })]),
			reply('tool_use', [use('t2', 'write_file', { path: 'src/pages/garden.astro', content: '<h1>Garden</h1>\n' }), use('t3', 'edit_file', { path: 'src/components/Card.astro', old_string: 'card', new_string: 'card big' })], { cache_read_input_tokens: 5000 }),
			reply('end_turn', [text('Built a garden page.')]),
		]);
		setSdkClientForTests(client);
		const events = [];
		const result = await run(root, {}, { onEvent: (line) => events.push(line) });

		assert.equal(result.ok, true, result.error);
		assert.equal(result.error, null);
		assert.equal(result.numTurns, 3);
		assert.deepEqual(result.touched.sort(), ['src/components/Card.astro', 'src/pages/garden.astro']);
		assert.deepEqual(events, ['wrote src/pages/garden.astro', 'edited src/components/Card.astro']);
		assert.equal(result.output, 'Built a garden page.');
		assert.equal(readFileSync(join(root, 'src/pages/garden.astro'), 'utf8'), '<h1>Garden</h1>\n');
		assert.equal(result.outputTokens, 600);
		assert.equal(result.inputTokens, 3000 + 5000);
		const expected = 3 * costUsd('claude-sonnet-5-5', usage()) + costUsd('claude-sonnet-5-5', { cache_read_input_tokens: 5000 });
		assert.ok(Math.abs(result.costUsd - expected) < 1e-9);
		setSdkClientForTests(null);
	});

	test('every request carries the tools, the cache marker and the effort; the key is never in it', async () => {
		const client = stub([reply('end_turn', [text('Nothing to do.')])]);
		setSdkClientForTests(client);
		await run(tree(), { agentEffort: 'low', agentMaxOutputTokens: 9000 });
		const { params, options } = client.calls[0];
		assert.equal(params.model, 'claude-sonnet-5-5');
		assert.equal(params.max_tokens, 9000);
		assert.deepEqual(params.output_config, { effort: 'low' });
		assert.deepEqual(params.cache_control, { type: 'ephemeral' });
		assert.deepEqual(params.tools.map((tool) => tool.name), ['read_file', 'list_files', 'search', 'edit_file', 'write_file']);
		assert.equal(params.tool_choice, undefined, 'a forced tool choice is a 400 on this model');
		assert.equal(params.thinking, undefined, 'thinking is left to the model');
		assert.ok(options.signal instanceof AbortSignal);
		assert.doesNotMatch(JSON.stringify(params), /sk-ant|ANTHROPIC_API_KEY/);
		assert.ok(TOOLS.every((tool) => tool.input_schema.additionalProperties === false));
		setSdkClientForTests(null);
	});

	test('the agent names the workspace when told to, and only then', async () => {
		const saved = process.env.ANTHROPIC_WORKSPACE_ID;
		try {
			delete process.env.ANTHROPIC_WORKSPACE_ID;
			let client = stub([reply('end_turn', [text('ok')])]);
			setSdkClientForTests(client);
			await run(tree());
			assert.equal('workspace_id' in client.calls[0].params, false);

			process.env.ANTHROPIC_WORKSPACE_ID = 'wrkspc_01XYZ';
			client = stub([reply('end_turn', [text('ok')])]);
			setSdkClientForTests(client);
			await run(tree());
			assert.equal(client.calls[0].params.workspace_id, 'wrkspc_01XYZ');
		} finally {
			setSdkClientForTests(null);
			if (saved === undefined) delete process.env.ANTHROPIC_WORKSPACE_ID;
			else process.env.ANTHROPIC_WORKSPACE_ID = saved;
		}
	});

	test('the model’s whole reply goes back unchanged, and results follow in one message', async () => {
		const thinking = { type: 'thinking', thinking: 'plan', signature: 'sig' };
		const client = stub([
			reply('tool_use', [thinking, use('a', 'read_file', { path: 'package.json' }), use('b', 'read_file', { path: '.env' })]),
			reply('end_turn', [text('ok')]),
		]);
		setSdkClientForTests(client);
		await run(tree());
		const second = client.calls[1].params.messages;
		assert.deepEqual(second[1], { role: 'assistant', content: [thinking, use('a', 'read_file', { path: 'package.json' }), use('b', 'read_file', { path: '.env' })] });
		assert.equal(second[2].role, 'user');
		assert.equal(second[2].content.length, 2);
		assert.equal(second[2].content[0].tool_use_id, 'a');
		assert.equal(second[2].content[0].is_error, undefined);
		assert.equal(second[2].content[1].tool_use_id, 'b');
		assert.equal(second[2].content[1].is_error, true, 'the secret read is refused, as an error the model can read');
		assert.doesNotMatch(JSON.stringify(second[2]), /do-not-read-me/);
		setSdkClientForTests(null);
	});

	test('a tool problem is a result, not a crash: an unknown tool, bad input, a refused write', async () => {
		const root = tree();
		const client = stub([
			reply('tool_use', [use('a', 'run_shell', { command: 'cat /etc/passwd' }), use('b', 'write_file', null), use('c', 'write_file', { path: 'src/core/x.ts', content: 'x' })]),
			reply('end_turn', [text('gave up')]),
		]);
		setSdkClientForTests(client);
		const result = await run(root);
		assert.equal(result.ok, true);
		const results = client.calls[1].params.messages[2].content;
		assert.ok(results.every((entry) => entry.is_error === true));
		assert.match(results[0].content, /no tool called run_shell/);
		assert.deepEqual(result.touched, []);
		assert.equal(existsSync(join(root, 'src/core/x.ts')), false);
		setSdkClientForTests(null);
	});

	test('stops when the budget is spent', async () => {
		const client = stub([reply('tool_use', [use('a', 'list_files', {})], { input_tokens: 400_000 })]);
		setSdkClientForTests(client);
		const result = await run(tree(), {}, { maxBudgetUsd: 0.5 });
		assert.equal(result.ok, false);
		assert.match(result.error, /budget of \$0\.50 ran out/);
		assert.equal(client.calls.length, 1, 'no second call is paid for');
		assert.ok(result.costUsd >= 0.5);
		setSdkClientForTests(null);
	});

	test('stops at the turn limit', async () => {
		const client = stub([reply('tool_use', [use('a', 'list_files', {})])]);
		setSdkClientForTests(client);
		const result = await run(tree(), { agentMaxTurns: 3 });
		assert.equal(result.ok, false);
		assert.match(result.error, /stopped after 3 turns/);
		assert.equal(client.calls.length, 3);
		setSdkClientForTests(null);
	});

	test('a refusal ends the run and nothing from that turn is executed', async () => {
		const root = tree();
		setSdkClientForTests(stub([reply('refusal', [use('a', 'write_file', { path: 'src/pages/x.astro', content: 'x' })])]));
		const result = await run(root);
		assert.equal(result.ok, false);
		assert.match(result.error, /declined/);
		assert.equal(existsSync(join(root, 'src/pages/x.astro')), false);
		setSdkClientForTests(null);
	});

	test('a reply cut off at max_tokens fails the run instead of running half a tool call', async () => {
		const root = tree();
		setSdkClientForTests(stub([reply('max_tokens', [use('a', 'write_file', { path: 'src/pages/x.astro', content: 'half a fi' })])]));
		const result = await run(root);
		assert.equal(result.ok, false);
		assert.match(result.error, /ran out of room/);
		assert.equal(existsSync(join(root, 'src/pages/x.astro')), false);
		setSdkClientForTests(null);
	});

	test('an unexpected stop reason is an error, not a success', async () => {
		setSdkClientForTests(stub([reply('model_context_window_exceeded', [text('...')])]));
		const result = await run(tree());
		assert.equal(result.ok, false);
		assert.match(result.error, /unexpected reason: model_context_window_exceeded/);
		setSdkClientForTests(null);
	});

	test('the clock: a call that hangs is aborted at the timeout', async () => {
		setSdkClientForTests(
			stub([
				(params, options) =>
					new Promise((_, reject) => {
						options.signal.addEventListener('abort', () => reject(new Error('aborted')));
					}),
			]),
		);
		const started = Date.now();
		const result = await run(tree(), {}, { timeoutMs: 300 });
		assert.equal(result.ok, false);
		assert.equal(result.timedOut, true);
		assert.equal(result.error, 'timed out');
		assert.ok(Date.now() - started < 5000);
		setSdkClientForTests(null);
	});

	test('an API error is reported with its status, and a missing key is caught before any call', async () => {
		const failing = new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers());
		setSdkClientForTests(stub([() => Promise.reject(failing)]));
		const result = await run(tree());
		assert.equal(result.ok, false);
		assert.match(result.error, /the API answered 401/);
		setSdkClientForTests(null);

		const saved = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		try {
			const missing = await run(tree());
			assert.equal(missing.ok, false);
			assert.equal(missing.error, 'ANTHROPIC_API_KEY is not set');
			assert.equal(missing.costUsd, 0);
		} finally {
			if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
		}
	});
});
