import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import type { PipelineConfig } from './config';
import { run } from './proc';
import { runSdkAgent } from './sdk-agent';

export type AgentResult = {
	ok: boolean;
	timedOut: boolean;
	costUsd: number;
	inputTokens: number | null;
	outputTokens: number | null;
	numTurns: number | null;
	durationMs: number;
	error: string | null;
	/** Files the agent wrote or edited, relative to the working tree. */
	touched: string[];
	output: string;
	/** The agent's last words to us, where it describes what it built. */
	finalText: string;
};

/** The only tools, and where they may write. Edit rules cover Write as well. */
const TOOLS = 'Read,Glob,Grep,Edit,Write';
const ALLOWED = ['Read', 'Glob', 'Grep', 'Edit(./src/**)', 'Edit(./public/**)'];
const DISALLOWED = 'Bash,WebFetch,WebSearch,Agent,Task,NotebookEdit';

/** As POSIX-style absolute permission paths: //c/Users/... on Windows, //home/... elsewhere. */
function permissionPath(path: string) {
	const posixish = path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
	return `/${posixish.startsWith('/') ? posixish : `/${posixish}`}`;
}

/**
 * Nothing the AI may even look at. The guards catch a secret that shows up in
 * the diff; this keeps it from ever reading one. Writes to the core are denied
 * here too, as well as by the guards afterwards.
 */
export function claudeSettings(config: PipelineConfig) {
	const deny = [
		'Read(**/.env*)',
		'Read(**/*.db*)',
		'Read(./data/**)',
		'Read(./dist/**)',
		'Read(./.git/**)',
		'Read(./node_modules/.astro/**)',
		'Read(**/.iterate*)',
		`Read(${permissionPath(config.sourceDir)}/**)`,
		'Edit(./src/core/**)',
		'Edit(./src/pages/api/**)',
		'Edit(./src/middleware*)',
		'Edit(./src/env.d.ts)',
	];
	if (process.platform === 'win32') {
		const home = process.env.USERPROFILE;
		if (home) deny.push(`Read(${permissionPath(home)}/**)`);
		deny.push('Read(//c/Windows/**)', 'Read(//c/ProgramData/**)');
	} else {
		deny.push('Read(//root/**)', 'Read(//home/**)', 'Read(//etc/**)', 'Read(//proc/**)', 'Read(//sys/**)', 'Read(//var/**)', 'Read(//tmp/**)', 'Read(//run/**)');
	}
	return { permissions: { deny } };
}

/** Just enough environment to find the binary and its login; none of our secrets. */
export function claudeEnv(config: PipelineConfig): NodeJS.ProcessEnv {
	const keep = ['HOME', 'PATH', 'LANG', 'LC_ALL', 'TERM', 'USER', 'LOGNAME', 'SHELL', 'TZ'];
	if (process.platform === 'win32') {
		keep.push('USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'PATHEXT', 'ComSpec', 'HOMEDRIVE', 'HOMEPATH');
	}
	const env: NodeJS.ProcessEnv = {};
	for (const name of keep) if (process.env[name]) env[name] = process.env[name];
	// The one credential the agent may have, and only in api-key mode.
	if (config.claudeAuth === 'api-key' && process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
	return env;
}

export function claudeArgs(config: PipelineConfig, settingsFile: string, maxBudgetUsd: number) {
	return [
		'-p',
		'--model',
		config.model,
		config.claudeAuth === 'api-key' ? '--bare' : '--safe-mode',
		'--settings',
		settingsFile,
		'--strict-mcp-config',
		'--disable-slash-commands',
		'--no-session-persistence',
		'--permission-mode',
		'dontAsk',
		'--tools',
		TOOLS,
		'--allowedTools',
		...ALLOWED,
		'--disallowedTools',
		DISALLOWED,
		'--max-budget-usd',
		maxBudgetUsd.toFixed(2),
		'--output-format',
		'stream-json',
		'--verbose',
	];
}

type StreamEvent = {
	type?: string;
	message?: { content?: { type?: string; name?: string; input?: { file_path?: string } }[] };
	total_cost_usd?: number;
	usage?: { input_tokens?: number; output_tokens?: number };
	num_turns?: number;
	is_error?: boolean;
	result?: string;
	subtype?: string;
};

/**
 * Runs Claude Code headless in `cwd` with the prompt on stdin. Reports each
 * file it writes through `onEvent`, and returns cost and usage from its final
 * result line.
 */
export async function runAgent(input: {
	config: PipelineConfig;
	cwd: string;
	prompt: string;
	timeoutMs: number;
	maxBudgetUsd: number;
	onEvent?: (message: string) => void;
}): Promise<AgentResult> {
	const { config, cwd } = input;
	// On a server there is no signed-in Claude Code: the agent runs on the API with a key.
	if (config.agentRuntime === 'sdk') return runSdkAgent(input);
	const dir = mkdtempSync(join(tmpdir(), 'pw-claude-'));
	const settingsFile = join(dir, 'settings.json');
	writeFileSync(settingsFile, JSON.stringify(claudeSettings(config)));

	const touched = new Set<string>();
	let result: StreamEvent | null = null;
	const started = Date.now();

	try {
		const outcome = await run([...config.claudeCommand, ...claudeArgs(config, settingsFile, input.maxBudgetUsd)], {
			cwd,
			env: claudeEnv(config),
			timeoutMs: input.timeoutMs,
			input: input.prompt,
			onLine: (line) => {
				let event: StreamEvent;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (event.type === 'result') result = event;
				for (const part of event.message?.content ?? []) {
					if (part.type !== 'tool_use' || !part.input?.file_path || !['Write', 'Edit'].includes(part.name ?? '')) continue;
					const file = isAbsolute(part.input.file_path) ? relative(cwd, part.input.file_path) : part.input.file_path;
					const path = file.replaceAll('\\', '/');
					if (!touched.has(path)) input.onEvent?.(`${part.name === 'Write' ? 'wrote' : 'edited'} ${path}`);
					touched.add(path);
				}
			},
		});

		const final = result as StreamEvent | null;
		const error = outcome.timedOut
			? 'timed out'
			: outcome.code !== 0
				? `exited with code ${outcome.code}`
				: !final
					? 'no result from the agent'
					: final.is_error
						? `agent error: ${final.subtype ?? final.result ?? 'unknown'}`
						: null;

		return {
			ok: error === null,
			timedOut: outcome.timedOut,
			costUsd: Number(final?.total_cost_usd) || 0,
			inputTokens: final?.usage?.input_tokens ?? null,
			outputTokens: final?.usage?.output_tokens ?? null,
			numTurns: final?.num_turns ?? null,
			durationMs: Date.now() - started,
			error,
			touched: [...touched],
			output: outcome.output,
			finalText: typeof final?.result === 'string' && !final.is_error ? final.result : '',
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
