import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModerationProvider } from './types';

/**
 * Moderation through the Claude Code CLI, for a logged-in subscription with no
 * API key. No tools, no project files, structured JSON out.
 */

/** The command to start, as [program, ...leading args]. A .mjs/.js path runs under node (used by tests). */
function claudeCommand(): string[] {
	const configured = process.env.CLAUDE_CMD;
	if (configured) return /\.[cm]?js$/.test(configured) ? [process.execPath, configured] : [configured];
	// On Windows `claude` on PATH is a .cmd shim that needs a shell; the package ships an .exe.
	if (process.platform === 'win32' && process.env.APPDATA) {
		const exe = join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
		if (existsSync(exe)) return [exe];
	}
	return ['claude'];
}

/** Enough environment for the CLI to find itself and its login; none of the site's secrets. */
function cliEnv(): NodeJS.ProcessEnv {
	const keep = ['HOME', 'PATH', 'LANG', 'LC_ALL', 'TERM', 'USER', 'LOGNAME', 'SHELL', 'TZ'];
	if (process.platform === 'win32') {
		keep.push('USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'PATHEXT', 'ComSpec', 'HOMEDRIVE', 'HOMEPATH');
	}
	const env: NodeJS.ProcessEnv = {};
	for (const name of keep) if (process.env[name]) env[name] = process.env[name];
	return env;
}

function killTree(pid: number | undefined) {
	if (!pid) return;
	try {
		if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
		else process.kill(-pid, 'SIGKILL');
	} catch {
		// Already gone.
	}
}

type CliResult = {
	type?: string;
	is_error?: boolean;
	result?: string;
	structured_output?: unknown;
	total_cost_usd?: number;
	usage?: { input_tokens?: number; output_tokens?: number };
	subtype?: string;
	stop_reason?: string;
};

/** The structured answer: the CLI's own field when it sets one, otherwise the JSON in its text result. */
function answerOf(result: CliResult) {
	if (result.structured_output && typeof result.structured_output === 'object') return result.structured_output;
	const text = result.result ?? '';
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start < 0 || end <= start) throw new Error('no JSON in the answer');
	return JSON.parse(text.slice(start, end + 1));
}

export const cliProvider: ModerationProvider = (call) =>
	new Promise((resolve, reject) => {
		// An empty folder: nothing to read, no project instructions to pick up.
		const cwd = mkdtempSync(join(tmpdir(), 'pw-moderate-'));
		const args = [
			'-p',
			'--model',
			call.model,
			'--safe-mode',
			'--system-prompt',
			call.system,
			'--tools',
			'',
			'--strict-mcp-config',
			'--disable-slash-commands',
			'--no-session-persistence',
			'--permission-mode',
			'dontAsk',
			'--effort',
			call.effort,
			'--max-budget-usd',
			'0.25',
			'--output-format',
			'json',
			'--json-schema',
			JSON.stringify(call.schema),
		];
		const [program, ...lead] = claudeCommand();
		const child = spawn(program, [...lead, ...args], {
			cwd,
			env: cliEnv(),
			shell: false,
			windowsHide: true,
			detached: process.platform !== 'win32',
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		let stdout = '';
		let stderr = '';
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			// Best effort: on Windows a process that was just killed can still hold the folder.
			try {
				rmSync(cwd, { recursive: true, force: true });
			} catch {
				setTimeout(() => rmSync(cwd, { recursive: true, force: true }), 5000).unref();
			}
			fn();
		};
		const timer = setTimeout(() => {
			killTree(child.pid);
			finish(() => reject(new Error(`timed out after ${call.timeoutMs} ms`)));
		}, call.timeoutMs);

		child.stdout.on('data', (chunk) => (stdout += chunk));
		child.stderr.on('data', (chunk) => (stderr += chunk));
		child.on('error', (error) => finish(() => reject(error)));
		child.on('close', (code) => {
			finish(() => {
				let parsed: CliResult;
				try {
					parsed = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? '');
				} catch {
					reject(new Error(`unreadable CLI output (exit ${code}): ${(stderr || stdout).slice(-300)}`));
					return;
				}
				const costUsd = Number(parsed.total_cost_usd) || 0;
				// The model's own safeguards declined to look at it (phishing, exploits…). That is a verdict, not a failure.
				if (parsed.stop_reason === 'refusal') {
					resolve({ kind: 'refused', detail: 'refusal', costUsd });
					return;
				}
				if (parsed.is_error) {
					reject(new Error(`CLI error: ${parsed.subtype ?? parsed.result ?? 'unknown'}`));
					return;
				}
				try {
					resolve({
						kind: 'json',
						value: answerOf(parsed),
						costUsd,
						inputTokens: parsed.usage?.input_tokens ?? null,
						outputTokens: parsed.usage?.output_tokens ?? null,
					});
				} catch (error) {
					reject(error);
				}
			});
		});

		child.stdin.on('error', () => {});
		child.stdin.end(call.user);
	});
