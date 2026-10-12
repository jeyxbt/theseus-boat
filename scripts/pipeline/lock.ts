import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAlive } from './proc';

/** A lock whose owner stopped beating for this long is taken over. */
export const STALE_LOCK_MS = 10 * 60 * 1000;

type LockData = { pid: number; at: number };

function read(path: string): LockData | null {
	try {
		const data = JSON.parse(readFileSync(path, 'utf8'));
		return typeof data?.pid === 'number' && typeof data?.at === 'number' ? data : null;
	} catch {
		return null;
	}
}

export type Lock = { release(): void; beat(): void };

/** Locks this process holds right now: a second run in the same process must wait too. */
const held = new Set<string>();

/**
 * One pipeline run at a time. The lock file holds the owner's pid and a
 * heartbeat; a lock whose process is gone, or whose heartbeat is stale, is
 * taken over. Returns null when another live run holds it.
 */
export function acquireLock(path: string, heartbeatMs = 60_000, now = () => Date.now()): Lock | null {
	if (held.has(path)) return null;
	const write = (flag: 'wx' | 'w') => writeFileSync(path, JSON.stringify({ pid: process.pid, at: now() }), { flag });

	try {
		write('wx');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		const owner = read(path);
		// A file with our own pid is left over from a run that died without cleaning up.
		if (owner && owner.pid !== process.pid && isAlive(owner.pid) && now() - owner.at < STALE_LOCK_MS) return null;
		try {
			unlinkSync(path);
		} catch {
			// Someone else removed it first.
		}
		try {
			write('wx');
		} catch {
			// Another run won the race to take over.
			return null;
		}
	}

	held.add(path);
	let released = false;
	const beat = () => {
		if (!released && read(path)?.pid === process.pid) write('w');
	};
	const timer = setInterval(beat, heartbeatMs);
	timer.unref();

	const release = () => {
		if (released) return;
		released = true;
		held.delete(path);
		clearInterval(timer);
		if (read(path)?.pid === process.pid) {
			try {
				unlinkSync(path);
			} catch {
				// Already gone.
			}
		}
	};
	process.once('exit', release);
	return { release, beat };
}
