import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { useTempDatabase } from './helpers.mjs';

useTempDatabase('pipeline');

const { get, all, nowIso } = await import('../src/core/db/client.ts');
const { closeWindowNow } = await import('../src/core/cycle/windows.ts');
const { submitIdea } = await import('../src/core/ideas/queries.ts');
const { toggleVote } = await import('../src/core/votes/queries.ts');
const { setSetting } = await import('../src/core/settings.ts');
const { runCycle } = await import('../scripts/pipeline/iterate.ts');
const { acquireLock } = await import('../scripts/pipeline/lock.ts');
const { isAlive } = await import('../scripts/pipeline/proc.ts');

const FAKE_CLAUDE = fileURLToPath(new URL('../scripts/pipeline/fake-claude.mjs', import.meta.url));

// ---- A tiny site with a fake build and a fake server ----

const FAKE_BUILD = `import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const walk = (dir) => readdirSync(dir).flatMap((name) => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : [p]; });
for (const file of walk('src')) {
	if (readFileSync(file, 'utf8').includes('BROKEN')) { console.error('error: ' + file + ' does not compile (BROKEN)'); process.exit(1); }
}
mkdirSync('dist', { recursive: true });
writeFileSync('dist/ok', 'built');
`;

// LIVE=1 plays the dev server the site runs on: no security policy, and LIVECRASH pages fail only there.
// LIVE=prod plays a production build that serves old code.
// LIVE=production plays a restarted production site: a security policy, and LIVECRASH pages fail.
const FAKE_SERVER = `import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
const live = process.env.LIVE;
createServer((req, res) => {
	const path = new URL(req.url, 'http://x').pathname;
	if (path === '/api/health') { res.writeHead(200); return res.end('{"ok":true}'); }
	if (path.startsWith('/api/store/')) {
		const declared = existsSync('src/collections/' + path.slice(11) + '.json');
		res.writeHead(declared ? 200 : 404, { 'content-type': 'application/json' });
		return res.end(declared ? '{"items":[]}' : '{"error":"not_found"}');
	}
	const file = 'src/pages' + (path === '/' ? '/index' : path) + '.astro';
	const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
	if (text.includes('CRASH') && (!text.includes('LIVECRASH') || live === '1' || live === 'production')) { res.writeHead(500); return res.end('Internal error: CRASH in ' + file); }
	if (live && !existsSync(file) && path !== '/ideas' && path !== '/build' && path !== '/changelog' && path !== '/rules') { res.writeHead(404); return res.end('not found'); }
	res.writeHead(200, live === '1' ? { 'content-type': 'text/html' } : { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'" });
	res.end('<header data-site-shell>THESEUS</header><main>' + path + '</main>');
}).listen(Number(process.env.PORT), '127.0.0.1');
`;

/** The site as it runs on the developer's machine, serving files from the site's own folder. */
async function startLiveSite(site, mode = '1') {
	const { freePort } = await import('../scripts/pipeline/proc.ts');
	const port = await freePort();
	const child = spawn(process.execPath, ['fake-server.mjs'], { cwd: site.source, env: { ...process.env, PORT: String(port), LIVE: mode }, stdio: 'ignore' });
	const url = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 50; i++) {
		try {
			if ((await fetch(`${url}/api/health`)).ok) break;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return { url, stop: () => child.kill() };
}

function makeSite() {
	const root = mkdtempSync(join(tmpdir(), 'pw-pipe-'));
	const source = join(root, 'site');
	const files = {
		'package.json': '{ "name": "fixture", "private": true, "type": "module" }\n',
		'.gitignore': 'dist/\ndata/\nnode_modules/\n.iterate*\n.env\n',
		'.gitattributes': '* text=auto eol=lf\n',
		'src/core/votes.ts': 'export const MAX = 3;\n',
		'src/pages/index.astro': '---\nconst a = 1;\n---\n<h1>THESEUS</h1>\n',
		'fake-build.mjs': FAKE_BUILD,
		'fake-server.mjs': FAKE_SERVER,
	};
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(source, path)), { recursive: true });
		writeFileSync(join(source, path), text);
	}
	const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: source, stdio: 'ignore' });
	git('init', '-q', '-b', 'main');
	git('add', '-A');
	git('commit', '-q', '-m', 'init');
	return { source, runner: join(root, 'runner') };
}

function config(site, scenario, overrides = {}) {
	return {
		sourceDir: site.source,
		runnerDir: site.runner,
		deployMode: 'preview',
		agentRuntime: 'cli',
		agentEffort: 'medium',
		agentMaxTurns: 20,
		agentMaxOutputTokens: 8000,
		claudeCommand: [process.execPath, FAKE_CLAUDE, `--scenario=${scenario}`],
		claudeAuth: 'oauth',
		model: 'fake-model',
		implementTimeoutMs: 20_000,
		repairTimeoutMs: 20_000,
		maxRepairs: 2,
		perRunBudgetUsd: 1,
		installCommand: null,
		buildCommand: [process.execPath, 'fake-build.mjs'],
		startCommand: [process.execPath, 'fake-server.mjs'],
		buildTimeoutMs: 20_000,
		healthTimeoutMs: 10_000,
		heartbeatMs: 200,
		botName: 'theseus-bot',
		botEmail: 'bot@example.com',
		// Nothing listens here unless a test starts a live site.
		liveUrl: 'http://127.0.0.1:9',
		liveSettleMs: 1500,
		// The fake site has no real header; the browser check has its own tests.
		browserCheck: 'off',
		restartCommand: null,
		restartTimeoutMs: 10_000,
		pushAfterShip: false,
		pushRemote: 'origin',
		...overrides,
	};
}

/** A command that notes each restart in a file, and exits with the given code. */
function restarter(logFile, exitCode = 0) {
	return [process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(logFile)}, 'r'); process.exit(${exitCode});`];
}
const restarts = (logFile) => (existsSync(logFile) ? readFileSync(logFile, 'utf8').length : 0);

let counter = 0;
function makeUser() {
	counter++;
	return get(
		"INSERT INTO users (provider, provider_id, handle, created_at) VALUES ('dev', ?, ?, ?) RETURNING id",
		`p${counter}`,
		`piper${counter}`,
		nowIso(),
	).id;
}

/** A closed window whose winning idea waits for a build. */
function queueWinner() {
	counter++;
	const idea = submitIdea(makeUser(), `Build zqw${counter.toString(36)} zqx${counter.toString(36)} zqy${counter.toString(36)} for visitors`).idea;
	for (let i = 0; i < 3; i++) toggleVote(makeUser(), idea.id);
	closeWindowNow();
	return idea;
}

const runnerStatus = (site) => execFileSync('git', ['status', '--porcelain'], { cwd: site.runner, encoding: 'utf8' }).trim();
const events = (buildId) => all('SELECT tag, message FROM build_events WHERE build_id = ? ORDER BY id', buildId).map((e) => `${e.tag}: ${e.message}`);
const quiet = { print: () => {} };

describe('the pipeline, end to end with a fake AI', () => {
	test('nothing queued: idle', async () => {
		const site = makeSite();
		assert.deepEqual(await runCycle(config(site, 'ok'), quiet), { status: 'idle' });
	});

	test('success: a local commit by the bot, build live, spend and log recorded', async () => {
		const site = makeSite();
		const idea = queueWinner();
		const outcome = await runCycle(config(site, 'ok'), quiet);
		assert.equal(outcome.status, 'live', JSON.stringify(outcome));

		const build = get('SELECT status, dry_run, idea_id, commit_sha, files, cost_usd, repairs FROM builds WHERE id = ?', outcome.buildId);
		assert.equal(build.status, 'live');
		assert.equal(build.dry_run, 1, 'a dry run never counts as shipped');
		assert.equal(build.idea_id, idea.id);
		assert.deepEqual(JSON.parse(build.files), ['src/pages/garden.astro']);
		assert.ok(Math.abs(build.cost_usd - 0.12) < 1e-9);

		const author = execFileSync('git', ['log', '-1', '--format=%an|%s'], { cwd: site.runner, encoding: 'utf8' }).trim();
		assert.match(author, /^theseus-bot\|feat: Build zqw/);
		assert.equal(build.commit_sha, execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: site.runner, encoding: 'utf8' }).trim());
		assert.equal(runnerStatus(site), '');

		const log = events(outcome.buildId);
		assert.ok(log.includes('ai: wrote src/pages/garden.astro'), log.join('\n'));
		assert.ok(log.some((line) => line.startsWith('smoke: ') && line.includes('/garden')), log.join('\n'));

		// Dry run: the site's own repository is untouched.
		assert.equal(existsSync(join(site.source, 'src/pages/garden.astro')), false);
	});

	test('a build that breaks is repaired by the AI', async () => {
		const site = makeSite();
		queueWinner();
		const outcome = await runCycle(config(site, 'broken-fixed'), quiet);
		assert.equal(outcome.status, 'live', JSON.stringify(outcome));
		assert.equal(outcome.repairs, 1);
		assert.equal(get('SELECT repairs FROM builds WHERE id = ?', outcome.buildId).repairs, 1);
		assert.ok(events(outcome.buildId).some((line) => line.startsWith('repair: attempt 1')));
		assert.equal(get("SELECT count(*) AS n FROM ai_spend WHERE build_id = ? AND kind = 'repair'", outcome.buildId).n, 1);
	});

	test('a page that answers 500 in the smoke test is repaired', async () => {
		const site = makeSite();
		queueWinner();
		const outcome = await runCycle(config(site, 'crash-fixed'), quiet);
		assert.equal(outcome.status, 'live', JSON.stringify(outcome));
		assert.ok(events(outcome.buildId).some((line) => line.includes('/garden answered 500')));
	});

	test('a build that stays broken fails after two repairs, leaving the runner clean', async () => {
		const site = makeSite();
		queueWinner();
		const outcome = await runCycle(config(site, 'broken'), quiet);
		assert.equal(outcome.status, 'failed');
		assert.equal(get('SELECT repairs, status, note FROM builds WHERE id = ?', outcome.buildId).repairs, 2);
		assert.equal(runnerStatus(site), '');
	});

	test('touching the core is refused and thrown away', async () => {
		const site = makeSite();
		queueWinner();
		const outcome = await runCycle(config(site, 'forbidden'), quiet);
		assert.equal(outcome.status, 'failed');
		assert.match(outcome.reason, /safety checks/);
		assert.ok(events(outcome.buildId).some((line) => line.startsWith('guard: ✗ core file: src/core/votes.ts')));
		assert.equal(readFileSync(join(site.runner, 'src/core/votes.ts'), 'utf8'), 'export const MAX = 3;\n');
		assert.equal(runnerStatus(site), '');
	});

	test('no change at all is a failure, not a success', async () => {
		const site = makeSite();
		queueWinner();
		const outcome = await runCycle(config(site, 'nothing'), quiet);
		assert.equal(outcome.status, 'failed');
	});

	test('a hanging AI is killed at the timeout, with no process left behind', async () => {
		const site = makeSite();
		queueWinner();
		const pidFile = join(tmpdir(), 'pw-fake-claude-hang.pid');
		const started = Date.now();
		const outcome = await runCycle(config(site, 'hang', { implementTimeoutMs: 1500 }), quiet);
		assert.equal(outcome.status, 'failed');
		assert.match(outcome.reason, /timed out/);
		assert.ok(Date.now() - started < 15_000);
		const pid = Number(readFileSync(pidFile, 'utf8'));
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(isAlive(pid), false, `fake AI ${pid} still running`);
		assert.equal(runnerStatus(site), '');
	});

	test('a second run exits while the first holds the lock', async () => {
		const site = makeSite();
		queueWinner();
		const held = acquireLock(`${site.runner}.lock`, 60_000);
		try {
			assert.deepEqual(await runCycle(config(site, 'ok'), quiet), { status: 'busy' });
		} finally {
			held.release();
		}
		// The winner is still waiting: the busy run didn't take it.
		assert.equal((await runCycle(config(site, 'ok'), quiet)).status, 'live');
	});

	test('a lock left by a dead process is taken over', async () => {
		const site = makeSite();
		queueWinner();
		writeFileSync(`${site.runner}.lock`, JSON.stringify({ pid: 999999, at: Date.now() }));
		assert.equal(isAlive(999999), false);
		assert.equal((await runCycle(config(site, 'ok'), quiet)).status, 'live');
	});

	test('the heartbeat keeps moving during a long step', async () => {
		const site = makeSite();
		queueWinner();
		const beats = new Set();
		const running = runCycle(config(site, 'slow', { heartbeatMs: 150 }), quiet);
		const poll = setInterval(() => {
			const row = get('SELECT heartbeat_at FROM builds ORDER BY id DESC LIMIT 1');
			if (row) beats.add(row.heartbeat_at);
		}, 100);
		const outcome = await running;
		clearInterval(poll);
		assert.equal(outcome.status, 'live');
		assert.ok(beats.size >= 4, `only ${beats.size} heartbeats seen`);
	});

	test('paused: the winner is skipped, publicly', async () => {
		const site = makeSite();
		const idea = queueWinner();
		setSetting('paused', '1');
		try {
			const outcome = await runCycle(config(site, 'ok'), quiet);
			assert.equal(outcome.status, 'skipped');
			assert.equal(outcome.reason, 'paused');
			assert.equal(get('SELECT skip_reason FROM windows WHERE id = ?', outcome.windowId).skip_reason, 'paused');
			assert.equal(get('SELECT status FROM ideas WHERE id = ?', idea.id).status, 'skipped');
		} finally {
			setSetting('paused', '0');
		}
		assert.deepEqual(await runCycle(config(site, 'ok'), quiet), { status: 'idle' });
	});

	test('local mode fast-forwards the site repository to the new commit', async () => {
		const site = makeSite();
		queueWinner();
		const outcome = await runCycle(config(site, 'ok', { deployMode: 'local' }), quiet);
		assert.equal(outcome.status, 'live', JSON.stringify(outcome));
		assert.equal(existsSync(join(site.source, 'src/pages/garden.astro')), true);
		const head = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: site.source, encoding: 'utf8' }).trim();
		assert.equal(head, outcome.commitSha);
	});

	test('local mode checks the running site after applying the change', async () => {
		const site = makeSite();
		queueWinner();
		const live = await startLiveSite(site);
		try {
			const outcome = await runCycle(config(site, 'ok', { deployMode: 'local', liveUrl: live.url }), quiet);
			assert.equal(outcome.status, 'live', JSON.stringify(outcome));
			assert.equal(get('SELECT dry_run FROM builds WHERE id = ?', outcome.buildId).dry_run, 0);
			assert.ok(events(outcome.buildId).includes('smoke: the live site works ✓'), events(outcome.buildId).join('\n'));
		} finally {
			live.stop();
		}
	});

	test('a change that breaks the running site is reverted with a commit of its own', async () => {
		const site = makeSite();
		queueWinner();
		const live = await startLiveSite(site);
		try {
			const outcome = await runCycle(config(site, 'live-crash', { deployMode: 'local', liveUrl: live.url }), quiet);
			assert.equal(outcome.status, 'rolled_back', JSON.stringify(outcome));
			assert.match(outcome.reason, /\/garden answered 500/);

			const build = get('SELECT status, note, commit_sha FROM builds WHERE id = ?', outcome.buildId);
			assert.equal(build.status, 'rolled_back');
			assert.equal(build.note, 'broke the live site');
			// The site is back to what it was, and the history shows the change and its revert.
			assert.equal(existsSync(join(site.source, 'src/pages/garden.astro')), false);
			const log = execFileSync('git', ['log', '-2', '--format=%an|%s'], { cwd: site.source, encoding: 'utf8' }).trim().split('\n');
			assert.match(log[0], /^theseus-bot\|revert: cycle \d+ broke the live site$/);
			assert.match(log[1], /^theseus-bot\|feat: /);
			assert.ok(events(outcome.buildId).includes('rollback: the site works again ✓'), events(outcome.buildId).join('\n'));
		} finally {
			live.stop();
		}
	});

	test('with no site running, the change is applied and the log says it was not checked live', async () => {
		const site = makeSite();
		queueWinner();
		const outcome = await runCycle(config(site, 'ok', { deployMode: 'local' }), quiet);
		assert.equal(outcome.status, 'live');
		assert.ok(events(outcome.buildId).some((line) => line.startsWith('deploy: nothing answers at')));
	});

	test('a production build is not taken as proof: it still serves the old code', async () => {
		const site = makeSite();
		queueWinner();
		const live = await startLiveSite(site, 'prod');
		try {
			const outcome = await runCycle(config(site, 'live-crash', { deployMode: 'local', liveUrl: live.url }), quiet);
			assert.equal(outcome.status, 'live');
			assert.ok(events(outcome.buildId).some((line) => line.includes('runs a production build')));
		} finally {
			live.stop();
		}
	});

	test('a declared collection must answer on the store API, in the preview and live', async () => {
		const site = makeSite();
		queueWinner();
		const live = await startLiveSite(site);
		try {
			const outcome = await runCycle(config(site, 'store', { deployMode: 'local', liveUrl: live.url }), quiet);
			assert.equal(outcome.status, 'live', JSON.stringify(outcome));
			assert.ok(events(outcome.buildId).some((line) => line.startsWith('smoke: ') && line.includes('/api/store/notes')));
		} finally {
			live.stop();
		}
	});

	test('a collection the core would reject is refused by the guards', async () => {
		const site = makeSite();
		queueWinner();
		const outcome = await runCycle(config(site, 'bad-store'), quiet);
		assert.equal(outcome.status, 'failed');
		assert.ok(events(outcome.buildId).some((line) => line.includes('collection src/collections/notes.json')), events(outcome.buildId).join('\n'));
	});

	test('a build left "building" by a run that died is closed as interrupted', async () => {
		const site = makeSite();
		const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
		const { id } = get(
			`INSERT INTO builds (cycle, idea_text, author_handle, status, started_at, heartbeat_at) VALUES (?, 'stuck', 'x', 'building', ?, ?) RETURNING id`,
			90000 + counter++,
			hourAgo,
			hourAgo,
		);
		assert.deepEqual(await runCycle(config(site, 'ok'), quiet), { status: 'idle' });
		const build = get('SELECT status, note FROM builds WHERE id = ?', id);
		assert.equal(build.status, 'failed');
		assert.equal(build.note, 'interrupted');
	});

	test('a winner that asks for something already on the site is skipped, not built twice', async () => {
		const site = makeSite();
		const first = queueWinner();
		const shipped = await runCycle(config(site, 'ok', { deployMode: 'local' }), quiet);
		assert.equal(shipped.status, 'live');

		const author = makeUser();
		const again = submitIdea(author, `${first.body}, please`);
		// The board refuses it right away...
		assert.equal(again.ok, false);
		assert.equal(again.error, 'already_built');
		// ...but one that won before the first was built gets skipped at build time.
		const { id: windowId } = get("SELECT id FROM windows WHERE status = 'open'");
		const { id: ideaId } = get(
			"INSERT INTO ideas (user_id, window_id, body, status, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?) RETURNING id",
			author,
			windowId,
			`${first.body}, please`,
			nowIso(),
			nowIso(),
		);
		for (let i = 0; i < 3; i++) toggleVote(makeUser(), ideaId);
		closeWindowNow();
		const outcome = await runCycle(config(site, 'ok', { deployMode: 'local' }), quiet);
		assert.equal(outcome.status, 'skipped');
		assert.equal(outcome.reason, 'already_built');
	});

	test('local mode never overwrites uncommitted work in the site', async () => {
		const site = makeSite();
		queueWinner();
		// Someone is editing the very file the AI is about to create.
		writeFileSync(join(site.source, 'src/pages/garden.astro'), 'my work in progress\n');
		const outcome = await runCycle(config(site, 'ok', { deployMode: 'local' }), quiet);
		assert.equal(outcome.status, 'failed');
		assert.equal(readFileSync(join(site.source, 'src/pages/garden.astro'), 'utf8'), 'my work in progress\n');
	});

	test('the final check refuses the winner: skipped publicly, nothing built', async () => {
		const { setModerationProviderForTests } = await import('../src/core/moderation/index.ts');
		const site = makeSite();
		const idea = queueWinner();
		setModerationProviderForTests(async () => ({
			kind: 'json',
			value: { verdict: 'reject', category: 'vulnerability', reason: 'asks to bypass voting' },
			costUsd: 0.01,
			inputTokens: 1,
			outputTokens: 1,
		}));
		try {
			const outcome = await runCycle(config(site, 'ok'), quiet);
			assert.equal(outcome.status, 'skipped');
			assert.equal(outcome.reason, 'final_gate');
			assert.equal(get('SELECT status FROM ideas WHERE id = ?', idea.id).status, 'skipped');
			assert.equal(get("SELECT count(*) AS n FROM ai_spend WHERE kind = 'final_gate' AND window_id = ?", outcome.windowId).n, 1);
		} finally {
			setModerationProviderForTests(null);
		}
	});

	test('the final check is unreachable: fail closed, skipped as moderation unavailable', async () => {
		const { setModerationProviderForTests } = await import('../src/core/moderation/index.ts');
		const site = makeSite();
		queueWinner();
		setModerationProviderForTests(async () => {
			throw new Error('timed out');
		});
		try {
			const outcome = await runCycle(config(site, 'ok'), quiet);
			assert.equal(outcome.status, 'skipped');
			assert.equal(outcome.reason, 'moderation_unavailable');
		} finally {
			setModerationProviderForTests(null);
		}
	});

	test('the browser check is part of the build: a page without the essential parts is repaired, then fails', async (t) => {
		const { findChrome } = await import('../scripts/pipeline/browser.ts');
		if (!findChrome()) return t.skip('no Chrome or Chromium on this machine');
		const site = makeSite();
		queueWinner();
		// The fake site has no real header or footer, so none of the essential parts exist.
		const outcome = await runCycle(config(site, 'ok', { browserCheck: 'required', maxRepairs: 1 }), quiet);
		assert.equal(outcome.status, 'failed', JSON.stringify(outcome));
		assert.match(outcome.reason, /logo is missing/);
		assert.equal(get('SELECT repairs FROM builds WHERE id = ?', outcome.buildId).repairs, 1);
		assert.equal(runnerStatus(site), '');
	});

	test('production mode: the change is built where the site lives, the site restarted and checked', async () => {
		const site = makeSite();
		queueWinner();
		const log = join(dirname(site.source), 'restarts.log');
		const live = await startLiveSite(site, 'production');
		try {
			const outcome = await runCycle(config(site, 'ok', { deployMode: 'production', liveUrl: live.url, restartCommand: restarter(log) }), quiet);
			assert.equal(outcome.status, 'live', JSON.stringify(outcome));
			assert.equal(get('SELECT dry_run, status FROM builds WHERE id = ?', outcome.buildId).dry_run, 0);
			assert.equal(existsSync(join(site.source, 'src/pages/garden.astro')), true);
			assert.equal(existsSync(join(site.source, 'dist/ok')), true, 'the site was built in its own folder');
			assert.equal(restarts(log), 1);
			const lines = events(outcome.buildId);
			assert.ok(lines.includes('deploy: building the site…'), lines.join('\n'));
			assert.ok(lines.includes('deploy: restarting the site…'));
			assert.ok(lines.some((line) => line.startsWith('smoke: the live site works ✓')));
		} finally {
			live.stop();
		}
	});

	test('production mode: a change that breaks the restarted site is reverted, rebuilt and restarted again', async () => {
		const site = makeSite();
		queueWinner();
		const log = join(dirname(site.source), 'restarts.log');
		const live = await startLiveSite(site, 'production');
		try {
			const outcome = await runCycle(config(site, 'live-crash', { deployMode: 'production', liveUrl: live.url, restartCommand: restarter(log) }), quiet);
			assert.equal(outcome.status, 'rolled_back', JSON.stringify(outcome));
			assert.match(outcome.reason, /\/garden answered 500/);
			assert.equal(restarts(log), 2, 'restarted for the change, and again for the revert');
			assert.equal(existsSync(join(site.source, 'src/pages/garden.astro')), false);
			const history = execFileSync('git', ['log', '-2', '--format=%s'], { cwd: site.source, encoding: 'utf8' }).trim().split('\n');
			assert.match(history[0], /^revert: cycle \d+ broke the live site$/);
			assert.ok(events(outcome.buildId).includes('rollback: the site works again ✓'), events(outcome.buildId).join('\n'));
			assert.equal(get('SELECT status FROM builds WHERE id = ?', outcome.buildId).status, 'rolled_back');
		} finally {
			live.stop();
		}
	});

	test('production mode: a site that is still down after its own rollback is reported as down, not as rolled back', async () => {
		const site = makeSite();
		queueWinner();
		const log = join(dirname(site.source), 'restarts.log');
		const live = await startLiveSite(site, 'production');
		try {
			const outcome = await runCycle(config(site, 'ok', { deployMode: 'production', liveUrl: live.url, restartCommand: restarter(log, 1) }), quiet);
			assert.equal(outcome.status, 'failed', JSON.stringify(outcome));
			assert.match(outcome.reason, /site is down after the rollback/);
			const build = get('SELECT status, note FROM builds WHERE id = ?', outcome.buildId);
			assert.equal(build.status, 'failed');
			assert.equal(build.note, 'site down after rollback');
			assert.ok(events(outcome.buildId).includes('failed: the site is not working: it needs a person'));
			assert.equal(restarts(log), 2);
		} finally {
			live.stop();
		}
	});

	test('production mode: a build that fails where the site lives is reverted, and the old site rebuilt and restarted', async () => {
		const site = makeSite();
		queueWinner();
		const log = join(dirname(site.source), 'restarts.log');
		const live = await startLiveSite(site, 'production');
		// Passes in the runner, where the preview builds; fails in the site's own folder while the change is in it.
		const buildCommand = [process.execPath, '-e', "const fs = require('node:fs'); process.exit(process.cwd().endsWith('site') && fs.existsSync('src/pages/garden.astro') ? 1 : 0)"];
		try {
			const outcome = await runCycle(config(site, 'ok', { deployMode: 'production', liveUrl: live.url, restartCommand: restarter(log), buildCommand }), quiet);
			assert.equal(outcome.status, 'rolled_back', JSON.stringify(outcome));
			assert.match(outcome.reason, /production build failed/);
			assert.equal(restarts(log), 1, 'no restart for a build that failed; one for the rebuilt old site');
			assert.equal(existsSync(join(site.source, 'src/pages/garden.astro')), false);
			assert.ok(events(outcome.buildId).includes('rollback: the site works again ✓'), events(outcome.buildId).join('\n'));
		} finally {
			live.stop();
		}
	});

	test('each shipped change is pushed when asked; a push that fails never fails the build', async () => {
		const site = makeSite();
		const remote = join(dirname(site.source), 'remote.git');
		execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
		execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: site.source });
		queueWinner();
		const log = join(dirname(site.source), 'restarts.log');
		const live = await startLiveSite(site, 'production');
		try {
			const first = await runCycle(config(site, 'ok', { deployMode: 'production', liveUrl: live.url, restartCommand: restarter(log), pushAfterShip: true }), quiet);
			assert.equal(first.status, 'live', JSON.stringify(first));
			const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: site.source, encoding: 'utf8' }).trim();
			assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(), head);
			assert.ok(events(first.buildId).some((line) => line.startsWith('git: pushed to origin')));

			queueWinner();
			// A different page from the first: writing the same one again would be no change at all.
			const second = await runCycle(
				config(site, 'slow', { deployMode: 'production', liveUrl: live.url, restartCommand: restarter(log), pushAfterShip: true, pushRemote: 'nowhere' }),
				quiet,
			);
			assert.equal(second.status, 'live', 'a failed push leaves a working change in place');
			assert.ok(events(second.buildId).some((line) => line.startsWith('git: could not push to nowhere')), events(second.buildId).join('\n'));
		} finally {
			live.stop();
		}
	});

	test('configuration problems are caught before a single build starts', async () => {
		const { configProblems, pipelineConfig, splitCommand } = await import('../scripts/pipeline/config.ts');
		const base = pipelineConfig({ ANTHROPIC_API_KEY: 'x', RESTART_COMMAND: 'pm2 reload "theseus web"' });
		assert.deepEqual(base.restartCommand, ['pm2', 'reload', 'theseus web']);
		assert.deepEqual(splitCommand("a 'b c' d"), ['a', 'b c', 'd']);
		assert.equal(splitCommand('   '), null);
		assert.equal(splitCommand(undefined), null);

		const ready = pipelineConfig({ DEPLOY_MODE: 'production', RESTART_COMMAND: 'pm2 reload site', AGENT_RUNTIME: 'sdk', ANTHROPIC_API_KEY: 'key' });
		assert.equal(ready.deployMode, 'production');
		assert.equal(ready.agentRuntime, 'sdk');
		assert.deepEqual(configProblems(ready, { ANTHROPIC_API_KEY: 'key' }), []);

		const noRestart = pipelineConfig({ DEPLOY_MODE: 'production', AGENT_RUNTIME: 'sdk' });
		const problems = configProblems(noRestart, {});
		assert.equal(problems.length, 2);
		assert.match(problems.join('\n'), /needs RESTART_COMMAND/);
		assert.match(problems.join('\n'), /needs ANTHROPIC_API_KEY/);

		const noBrowser = pipelineConfig({ DEPLOY_MODE: 'production', RESTART_COMMAND: 'x', BROWSER_CHECK: 'off' });
		assert.match(configProblems(noBrowser, {}).join('\n'), /needs the browser check/);

		// A preview on a laptop needs none of it.
		assert.deepEqual(configProblems(pipelineConfig({}), {}), []);
		assert.equal(pipelineConfig({ DEPLOY_MODE: 'nonsense' }).deployMode, 'preview');
	});

	describe('the agent on the API', () => {
		const usage = { input_tokens: 2000, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
		const turn = (stop_reason, content) => ({ stop_reason, content, usage });
		const stub = (script) => {
			let at = 0;
			return { messages: { stream: () => ({ finalMessage: async () => script[Math.min(at++, script.length - 1)] }) } };
		};
		const sdk = (site, overrides = {}) => config(site, 'unused', { agentRuntime: 'sdk', model: 'claude-sonnet-5-5', ...overrides });

		test('builds a page that then goes through every check, and the spend is recorded', async () => {
			const { setSdkClientForTests } = await import('../scripts/pipeline/sdk-agent.ts');
			const { costUsd } = await import('../src/core/ai/pricing.ts');
			const site = makeSite();
			queueWinner();
			setSdkClientForTests(
				stub([
					turn('tool_use', [{ type: 'tool_use', id: 't1', name: 'write_file', input: { path: 'src/pages/garden.astro', content: '---\nconst a = 1;\n---\n<main><h1>A garden</h1></main>\n' } }]),
					turn('end_turn', [{ type: 'text', text: 'Built a garden page.' }]),
				]),
			);
			try {
				const outcome = await runCycle(sdk(site), quiet);
				assert.equal(outcome.status, 'live', JSON.stringify(outcome));
				assert.deepEqual(JSON.parse(get('SELECT files FROM builds WHERE id = ?', outcome.buildId).files), ['src/pages/garden.astro']);
				assert.ok(events(outcome.buildId).includes('ai: wrote src/pages/garden.astro'), events(outcome.buildId).join('\n'));
				const spend = get("SELECT model, cost_usd, num_turns FROM ai_spend WHERE build_id = ? AND kind = 'implement'", outcome.buildId);
				assert.equal(spend.model, 'claude-sonnet-5-5');
				assert.equal(spend.num_turns, 2);
				assert.ok(Math.abs(spend.cost_usd - 2 * costUsd('claude-sonnet-5-5', usage)) < 1e-9);
				assert.equal(runnerStatus(site), '');
			} finally {
				setSdkClientForTests(null);
			}
		});

		test('an agent that goes for the core changes nothing, and the build says so', async () => {
			const { setSdkClientForTests } = await import('../scripts/pipeline/sdk-agent.ts');
			const site = makeSite();
			queueWinner();
			setSdkClientForTests(
				stub([
					turn('tool_use', [{ type: 'tool_use', id: 't1', name: 'write_file', input: { path: 'src/core/votes.ts', content: 'export const MAX = 300;\n' } }]),
					turn('end_turn', [{ type: 'text', text: 'Could not.' }]),
				]),
			);
			try {
				const outcome = await runCycle(sdk(site), quiet);
				assert.equal(outcome.status, 'failed');
				assert.ok(events(outcome.buildId).includes('guard: ✗ no changes were made'), events(outcome.buildId).join('\n'));
				assert.equal(readFileSync(join(site.runner, 'src/core/votes.ts'), 'utf8'), 'export const MAX = 3;\n');
				assert.equal(runnerStatus(site), '');
			} finally {
				setSdkClientForTests(null);
			}
		});

		test('without a key the build fails clearly and costs nothing', async () => {
			const site = makeSite();
			queueWinner();
			const saved = process.env.ANTHROPIC_API_KEY;
			delete process.env.ANTHROPIC_API_KEY;
			try {
				const outcome = await runCycle(sdk(site), quiet);
				assert.equal(outcome.status, 'failed');
				assert.match(outcome.reason, /ANTHROPIC_API_KEY is not set/);
				assert.equal(get('SELECT cost_usd FROM builds WHERE id = ?', outcome.buildId).cost_usd, 0);
			} finally {
				if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
			}
		});

		test('the budget of one build is enforced on the API agent too', async () => {
			const { setSdkClientForTests } = await import('../scripts/pipeline/sdk-agent.ts');
			const site = makeSite();
			queueWinner();
			const dear = { ...usage, input_tokens: 800_000 };
			setSdkClientForTests({
				messages: { stream: () => ({ finalMessage: async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'list_files', input: {} }], usage: dear }) }) },
			});
			try {
				const outcome = await runCycle(sdk(site, { perRunBudgetUsd: 1 }), quiet);
				assert.equal(outcome.status, 'failed');
				assert.match(outcome.reason, /budget of \$1\.00 ran out/);
			} finally {
				setSdkClientForTests(null);
			}
		});
	});

	test('over the monthly budget: the winner is skipped as budget', async () => {
		const site = makeSite();
		queueWinner();
		setSetting('monthly_cap_usd', 0);
		try {
			const outcome = await runCycle(config(site, 'ok'), quiet);
			assert.equal(outcome.status, 'skipped');
			assert.equal(outcome.reason, 'budget');
		} finally {
			setSetting('monthly_cap_usd', 75);
		}
	});
});
