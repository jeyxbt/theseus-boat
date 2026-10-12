import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

export type RunResult = {
	code: number | null;
	timedOut: boolean;
	/** stdout and stderr together, last part only. */
	output: string;
};

const KEEP_OUTPUT = 200_000;

function keepTail(text: string) {
	return text.length > KEEP_OUTPUT ? text.slice(-KEEP_OUTPUT) : text;
}

/** Kills a process and everything it started. */
export function killTree(pid: number | undefined) {
	if (!pid) return;
	try {
		if (process.platform === 'win32') {
			spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
		} else {
			// Started detached, so the child leads its own process group.
			process.kill(-pid, 'SIGKILL');
		}
	} catch {
		// Already gone.
	}
}

export function isAlive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export type RunOptions = {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	input?: string;
	onLine?: (line: string) => void;
	onSpawn?: (child: ChildProcess) => void;
};

/** Runs a command without a shell, with a timeout that kills the whole process tree. */
export function run([command, ...args]: string[], options: RunOptions): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			shell: false,
			windowsHide: true,
			detached: process.platform !== 'win32',
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		options.onSpawn?.(child);

		let output = '';
		let pending = '';
		let timedOut = false;
		const take = (chunk: Buffer, lines: boolean) => {
			const text = chunk.toString('utf8');
			output = keepTail(output + text);
			if (!lines || !options.onLine) return;
			pending += text;
			const parts = pending.split('\n');
			pending = parts.pop() ?? '';
			for (const line of parts) options.onLine(line);
		};
		child.stdout.on('data', (chunk) => take(chunk, true));
		child.stderr.on('data', (chunk) => take(chunk, false));

		const timer = options.timeoutMs
			? setTimeout(() => {
					timedOut = true;
					killTree(child.pid);
				}, options.timeoutMs)
			: null;

		child.on('error', (error) => {
			output = keepTail(`${output}\n${error.message}`);
		});
		child.on('close', (code) => {
			if (timer) clearTimeout(timer);
			if (pending && options.onLine) options.onLine(pending);
			resolve({ code, timedOut, output });
		});

		child.stdin.on('error', () => {});
		if (options.input !== undefined) child.stdin.end(options.input);
		else child.stdin.end();
	});
}

/** Starts a long-running process; the caller must stop it with killTree. */
export function start([command, ...args]: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
	const child = spawn(command, args, {
		cwd: options.cwd,
		env: options.env,
		shell: false,
		windowsHide: true,
		detached: process.platform !== 'win32',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let output = '';
	child.stdout.on('data', (chunk) => (output = keepTail(output + chunk.toString('utf8'))));
	child.stderr.on('data', (chunk) => (output = keepTail(output + chunk.toString('utf8'))));
	return { child, output: () => output };
}

/** A free TCP port on 127.0.0.1. */
export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

export function lastLines(text: string, count = 100) {
	return text.split('\n').slice(-count).join('\n');
}
