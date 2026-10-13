/**
 * The maintainer's controls, for a running site:
 *
 *   pnpm admin status                 where things stand
 *   pnpm admin pause | resume         stop or restart building winners (voting carries on)
 *   pnpm admin cap <usd>              the monthly cap on AI spend
 *   pnpm admin min-votes <n>          votes a winner needs
 *   pnpm admin remove-idea <id>       take an idea off the board; its votes go back
 *   pnpm store:remove <collection> <id>   remove one record from a feature's data
 *
 * Each command works on the database directly and takes effect on the next
 * request or cycle: nothing needs restarting.
 */
import { resolve } from 'node:path';
import { spentThisMonth } from '../src/core/builds/writes';
import { currentWindow } from '../src/core/cycle/windows';
import { all, closeDb, get, nowIso, run, transaction } from '../src/core/db/client';
import { getNumberSetting, getSetting, setSetting } from '../src/core/settings';

export function adminCommand(args: string[]): string {
	const [command, value] = args;
	switch (command) {
		case 'status': {
			const window = currentWindow();
			const counts = get<{ ideas: number; votes: number }>(
				`SELECT (SELECT count(*) FROM ideas WHERE status = 'open') AS ideas,
					(SELECT count(*) FROM votes v JOIN ideas i ON i.id = v.idea_id WHERE i.status = 'open') AS votes`,
			)!;
			const waiting = get<{ number: number }>(
				`SELECT w.number FROM windows w LEFT JOIN builds b ON b.window_id = w.id
				 WHERE w.status = 'closed' AND w.winner_idea_id IS NOT NULL AND w.skip_reason IS NULL AND b.id IS NULL
				 ORDER BY w.number LIMIT 1`,
			);
			const recent = all<{ cycle: number; status: string; note: string | null }>('SELECT cycle, status, note FROM builds ORDER BY cycle DESC LIMIT 3');
			const cap = getNumberSetting('monthly_cap_usd', 75);
			return [
				`Building winners:  ${getSetting('paused') === '1' ? 'PAUSED' : 'on'}`,
				`Window:            cycle ${window.number}, closes ${window.closesAt}`,
				`Open board:        ${counts.ideas} ideas, ${counts.votes} votes (a winner needs ${getNumberSetting('min_votes', 3)})`,
				`AI spend:          $${spentThisMonth().toFixed(2)} of the $${cap} monthly cap`,
				`Waiting to build:  ${waiting ? `cycle ${waiting.number}` : 'nothing'}`,
				`Latest builds:     ${recent.length ? recent.map((b) => `${b.cycle} ${b.status}${b.note ? ` (${b.note})` : ''}`).join(', ') : 'none yet'}`,
			].join('\n');
		}
		case 'pause':
			setSetting('paused', '1');
			return 'Paused: winners are skipped as "paused" until you run resume. Voting carries on.';
		case 'resume':
			setSetting('paused', '0');
			return 'Resumed: the next winner will be built.';
		case 'cap': {
			const usd = Number(value);
			if (!Number.isFinite(usd) || usd < 0) throw new Error('usage: pnpm admin cap <dollars>, like 75');
			setSetting('monthly_cap_usd', usd);
			return `The monthly cap is now $${usd}. Spent so far this month: $${spentThisMonth().toFixed(2)}.`;
		}
		case 'min-votes': {
			const n = Number(value);
			if (!Number.isInteger(n) || n < 1) throw new Error('usage: pnpm admin min-votes <whole number, at least 1>');
			setSetting('min_votes', n);
			return `A winner now needs ${n} vote${n === 1 ? '' : 's'}.`;
		}
		case 'remove-idea': {
			const id = Number(value);
			if (!Number.isInteger(id) || id < 1) throw new Error('usage: pnpm admin remove-idea <id>');
			const removed = transaction(() => {
				const changed = run("UPDATE ideas SET status = 'removed', removed_reason = 'maintainer', verified = 1, updated_at = ? WHERE id = ? AND status = 'open'", nowIso(), id).changes;
				if (changed > 0) run('DELETE FROM votes WHERE idea_id = ?', id);
				return changed > 0;
			});
			return removed ? `Idea ${id} is off the board and its votes went back.` : `No open idea ${id}.`;
		}
		default:
			throw new Error('commands: status, pause, resume, cap <usd>, min-votes <n>, remove-idea <id>');
	}
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename ?? '')) {
	try {
		console.log(adminCommand(process.argv.slice(2)));
		closeDb();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
