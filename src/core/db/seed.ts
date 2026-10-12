import { currentWindow } from '../cycle/windows';
import { get, run, transaction } from './client';

/** Demo rows are recognisable by these markers, so a re-seed replaces them cleanly. */
const DEMO_PREFIX = 'demo:';

const AUTHORS = ['lena_k', 'mkovalenko', 'oskar', 'ana.p', 'dmytro', 'sunny'];

const IDEAS: { author: string; body: string; minutesAgo: number; votes: number }[] = [
	{
		author: 'lena_k',
		body: 'A shared music box: everyone adds one note, together it plays a song',
		minutesAgo: 120,
		votes: 14,
	},
	{
		author: 'mkovalenko',
		body: 'A “time machine” slider that shows how the site looked on any day',
		minutesAgo: 240,
		votes: 11,
	},
	{
		author: 'oskar',
		body: 'Let visitors leave a tiny paper plane that flies across everyone’s screen',
		minutesAgo: 60,
		votes: 9,
	},
	{
		author: 'ana.p',
		body: 'A daily riddle on the front page — solvers get their name in the footer',
		minutesAgo: 180,
		votes: 6,
	},
	{
		author: 'dmytro',
		body: 'Show a little city skyline that grows one building per shipped idea',
		minutesAgo: 25,
		votes: 4,
	},
	{
		author: 'sunny',
		body: 'Weather-aware background: rain on the page when it rains where you are',
		minutesAgo: 300,
		votes: 2,
	},
];

/** Enough silent voters that every idea can reach its count at 3 votes each. */
const VOTER_COUNT = 20;

type DemoBuild = {
	cycle: number;
	ideaText: string;
	author: string;
	votes: number;
	status: 'building' | 'live' | 'rolled_back';
	note: string | null;
	sha: string | null;
	added: number;
	removed: number;
	files: string[];
	log: [tag: string, message: string][];
};

const BUILDS: DemoBuild[] = [
	{
		cycle: 37,
		ideaText: 'Night mode that follows the phase of the moon',
		author: 'mira',
		votes: 38,
		status: 'building',
		note: null,
		sha: null,
		added: 184,
		removed: 12,
		files: [
			'src/components/MoonTheme.astro',
			'src/lib/moon.ts',
			'src/layouts/Layout.astro',
			'src/styles/global.css',
		],
		log: [
			['window', 'closed · 52 ideas, 3 duplicates merged'],
			['winner', '“Night mode that follows the phase of the moon”'],
			['ai', 'reading the site, planning the change'],
			['ai', 'wrote src/lib/moon.ts (+46)'],
			['ai', 'wrote src/components/MoonTheme.astro (+128)'],
			['ai', 'edited src/layouts/Layout.astro (+6 −2)'],
			['checks', 'allowed paths ✓'],
			['checks', 'no outside requests ✓  no secrets ✓'],
			['checks', 'size 196 lines ✓'],
			['build', 'compiling…'],
		],
	},
	{
		cycle: 36,
		ideaText: 'Dark mode for night owls',
		author: 'nightowl',
		votes: 29,
		status: 'live',
		note: null,
		sha: 'a41f9c2',
		added: 212,
		removed: 8,
		files: ['src/components/ThemeToggle.astro', 'src/styles/global.css', 'src/layouts/Layout.astro'],
		log: shippedLog('Dark mode for night owls', 'a41f9c2', 36, 41),
	},
	{
		cycle: 35,
		ideaText: 'A shared pixel canvas',
		author: 'pixelpat',
		votes: 27,
		status: 'live',
		note: 'fixed on 2nd try',
		sha: '7c03be1',
		added: 346,
		removed: 21,
		files: ['src/pages/canvas.astro', 'src/components/PixelCanvas.astro', 'src/collections/canvas.json'],
		log: [
			['window', 'closed · 47 ideas, 5 duplicates merged'],
			['winner', '“A shared pixel canvas”'],
			['ai', 'reading the site, planning the change'],
			['ai', 'wrote src/components/PixelCanvas.astro (+214)'],
			['ai', 'wrote src/pages/canvas.astro (+118)'],
			['checks', 'allowed paths ✓  no outside requests ✓  size ✓'],
			['build', 'failed · type error in PixelCanvas.astro'],
			['repair', 'attempt 1 · fixing the type error'],
			['build', 'restarted · health check 200 ✓'],
			['smoke', '/, /ideas, /changelog respond ✓'],
			['git', 'pushed 7c03be1 to main'],
			['live', 'cycle 035 shipped'],
		],
	},
	{
		cycle: 34,
		ideaText: '3D globe of where visitors are',
		author: 'globetrotter',
		votes: 22,
		status: 'rolled_back',
		note: 'build failed',
		sha: null,
		added: 0,
		removed: 0,
		files: [],
		log: [
			['window', 'closed · 39 ideas, 2 duplicates merged'],
			['winner', '“3D globe of where visitors are”'],
			['ai', 'reading the site, planning the change'],
			['ai', 'wrote src/components/Globe.astro (+402)'],
			['checks', 'allowed paths ✓  no outside requests ✓'],
			['build', 'failed · bundle too large'],
			['repair', 'attempt 1 · failed'],
			['repair', 'attempt 2 · failed'],
			['rollback', 'site restored to cycle 033'],
		],
	},
	{
		cycle: 33,
		ideaText: 'Guestbook that never forgets',
		author: 'quill',
		votes: 25,
		status: 'live',
		note: null,
		sha: 'e9d1a07',
		added: 158,
		removed: 3,
		files: ['src/pages/guestbook.astro', 'src/collections/guestbook.json'],
		log: shippedLog('Guestbook that never forgets', 'e9d1a07', 33, 35),
	},
	{
		cycle: 32,
		ideaText: 'Keyboard-only snake',
		author: 'arrowkeys',
		votes: 19,
		status: 'live',
		note: null,
		sha: '3b8e4d1',
		added: 274,
		removed: 0,
		files: ['src/pages/snake.astro', 'src/components/Snake.astro'],
		log: shippedLog('Keyboard-only snake', '3b8e4d1', 32, 31),
	},
];

function shippedLog(title: string, sha: string, cycle: number, ideas: number): [string, string][] {
	return [
		['window', `closed · ${ideas} ideas`],
		['winner', `“${title}”`],
		['ai', 'reading the site, planning the change'],
		['ai', 'wrote the change'],
		['checks', 'allowed paths ✓  no outside requests ✓  size ✓'],
		['build', 'restarted · health check 200 ✓'],
		['smoke', '/, /ideas, /changelog respond ✓'],
		['git', `pushed ${sha} to main`],
		['live', `cycle ${String(cycle).padStart(3, '0')} shipped`],
	];
}

const SIX_HOURS = 6 * 60 * 60 * 1000;

function iso(ms: number) {
	return new Date(ms).toISOString();
}

function seedBuilds(now: number) {
	return transaction(() => {
		run('DELETE FROM builds WHERE is_demo = 1');
		const latest = Math.max(...BUILDS.map((build) => build.cycle));
		for (const build of BUILDS) {
			// The newest build started 25 minutes ago; each earlier one, six hours before.
			const started = now - 25 * 60 * 1000 - (latest - build.cycle) * SIX_HOURS;
			const finished = build.status === 'building' ? null : iso(started + 5 * 60 * 1000 + 45 * 1000);
			const row = get<{ id: number }>(
				`INSERT INTO builds (cycle, idea_text, author_handle, votes, status, note, commit_sha,
					lines_added, lines_removed, files, started_at, finished_at, is_demo)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1) RETURNING id`,
				build.cycle,
				build.ideaText,
				build.author,
				build.votes,
				build.status,
				build.note,
				build.sha,
				build.added,
				build.removed,
				JSON.stringify(build.files),
				iso(started),
				finished,
			);
			build.log.forEach(([tag, message], index) => {
				// Spread the lines over roughly five minutes.
				const ts = iso(started + 2000 + index * 30 * 1000);
				run('INSERT INTO build_events (build_id, ts, tag, message) VALUES (?, ?, ?, ?)', row!.id, ts, tag, message);
			});
		}
		return BUILDS.length;
	});
}

/**
 * Replaces the demo ideas and votes in the open window, and the demo builds.
 * Real users, ideas and votes are left alone, and so is the history of closed
 * windows: demo people are reused, never deleted, so a past winner keeps its
 * text. Builds go in first, so a window opened here gets the cycle number
 * after them.
 */
export function seedDemo(now = Date.now()) {
	const builds = seedBuilds(now);
	const window = currentWindow(now);
	const windowStart = Date.parse(window.openedAt);

	return transaction(() => {
		const demoUsers = "SELECT id FROM users WHERE provider = 'dev' AND provider_id LIKE ?";
		// Deleting an idea deletes the votes on it, real ones included.
		run(`DELETE FROM ideas WHERE window_id = ? AND status = 'open' AND user_id IN (${demoUsers})`, window.id, `${DEMO_PREFIX}%`);
		run(`DELETE FROM votes WHERE window_id = ? AND user_id IN (${demoUsers})`, window.id, `${DEMO_PREFIX}%`);

		const userId = (handle: string) => {
			const row = get<{ id: number }>(
				`INSERT INTO users (provider, provider_id, handle, name, avatar_url, created_at)
				 VALUES ('dev', ?, ?, NULL, NULL, ?)
				 ON CONFLICT (provider, provider_id) DO UPDATE SET handle = excluded.handle
				 RETURNING id`,
				`${DEMO_PREFIX}${handle}`,
				handle,
				iso(now - 30 * 24 * 60 * 60 * 1000),
			);
			if (!row) throw new Error(`Could not create demo user ${handle}`);
			return row.id;
		};

		const authorIds = new Map(AUTHORS.map((handle) => [handle, userId(handle)]));
		const voters = Array.from({ length: VOTER_COUNT }, (_, i) => userId(`voter_${String(i + 1).padStart(2, '0')}`));

		const votesLeft = new Map(voters.map((id) => [id, 3]));
		let voteCount = 0;

		for (const idea of IDEAS) {
			// An idea can't be older than the window it belongs to.
			const created = iso(Math.max(windowStart, now - idea.minutesAgo * 60 * 1000));
			const row = get<{ id: number }>(
				`INSERT INTO ideas (user_id, window_id, body, status, edits, created_at, updated_at)
				 VALUES (?, ?, ?, 'open', 0, ?, ?) RETURNING id`,
				authorIds.get(idea.author)!,
				window.id,
				idea.body,
				created,
				created,
			);

			// Hand out votes from whoever still has some left.
			let given = 0;
			for (const voter of voters) {
				if (given === idea.votes) break;
				const left = votesLeft.get(voter)!;
				if (left === 0) continue;
				run(
					'INSERT INTO votes (user_id, idea_id, window_id, created_at) VALUES (?, ?, ?, ?)',
					voter,
					row!.id,
					window.id,
					created,
				);
				votesLeft.set(voter, left - 1);
				given++;
				voteCount++;
			}
		}

		return { users: AUTHORS.length + VOTER_COUNT, ideas: IDEAS.length, votes: voteCount, builds, window: window.number };
	});
}

