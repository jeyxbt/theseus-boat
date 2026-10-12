/**
 * The check no file review can do: open the built site in a real browser and
 * see what a visitor sees. AI code is free to restyle and extend the header,
 * the footer and its pages, but the parts that make the site work (sign-in,
 * navigation, the status pill, the countdown, voting, the idea form) must still
 * be there, visible, on top, and pointing where they should.
 *
 * Core components carry data-essential="…" markers. A change that removes,
 * hides, covers, moves off screen, duplicates or re-points one fails the build,
 * and the AI gets the reason in its repair turn.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Failure } from './deploy';
import { freePort, killTree } from './proc';

type Essential = { id: string; href?: string; hrefStart?: string; action?: string };

/** On every page. Hrefs are exact except sign-in, which carries a returnTo. */
export const ESSENTIALS: Essential[] = [
	{ id: 'logo', href: '/' },
	{ id: 'status-pill', href: '/build' },
	{ id: 'nav-ideas', href: '/ideas' },
	{ id: 'nav-build', href: '/build' },
	{ id: 'nav-changelog', href: '/changelog' },
	{ id: 'nav-rules', href: '/rules' },
	{ id: 'footer-propose', href: '/ideas' },
	{ id: 'footer-rules', href: '/rules' },
	{ id: 'footer-privacy', href: '/privacy' },
];
/** Exactly one of these: the visitor is either signed out or signed in. */
const ACCOUNT: Essential[] = [
	{ id: 'account-signin', hrefStart: '/signin' },
	{ id: 'account-signout', action: '/api/auth/logout' },
];
/** Only on these routes. The core pages' own markup can't be edited, but the check is cheap and catches leaks. */
const BY_ROUTE: Record<string, Essential[]> = {
	'/': [{ id: 'countdown' }],
	'/ideas': [{ id: 'votes' }, { id: 'propose' }],
};

/** Phone and desktop: a part can be hidden on one and not the other. */
export const SCREENS = [
	{ name: 'desktop', width: 1280, height: 800, mobile: false },
	{ name: 'phone', width: 375, height: 800, mobile: true },
] as const;

export function findChrome(env: NodeJS.ProcessEnv = process.env): string | null {
	const local = env.LOCALAPPDATA ?? '';
	const candidates = [
		env.CHROME_PATH,
		'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
		'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
		local && join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
		'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		'/usr/bin/google-chrome',
		'/usr/bin/google-chrome-stable',
		'/usr/bin/chromium',
		'/usr/bin/chromium-browser',
	];
	return candidates.find((path): path is string => Boolean(path) && existsSync(path as string)) ?? null;
}

/**
 * Runs in the page. A plain string, not a function: the build tool rewrites
 * function bodies with helpers that don't exist in the browser.
 */
const PAGE_CHECK = (required: Essential[], account: Essential[]) => `(() => {
	const problems = [];
	const required = ${JSON.stringify(required)};
	const account = ${JSON.stringify(account)};

	const alpha = (color) => {
		const m = /rgba?\\(([^)]+)\\)/.exec(color);
		if (!m) return 1;
		const parts = m[1].split(/[ ,\\/]+/).filter(Boolean);
		return parts.length > 3 ? Number(parts[3]) : 1;
	};

	// Why a visitor couldn't see and use this element, or null if they can.
	const hiddenBecause = (el) => {
		for (let n = el; n; n = n.parentElement) {
			const s = getComputedStyle(n);
			if (s.display === 'none') return 'it is not displayed';
			if (s.visibility === 'hidden' || s.visibility === 'collapse') return 'it is invisible';
			if (Number(s.opacity) < 0.3) return 'it is see-through';
		}
		// 'instant': with scroll-behavior: smooth the position would be read mid-animation.
		el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
		const r = el.getBoundingClientRect();
		if (r.width < 6 || r.height < 6) return 'it has no size';
		const x = r.left + r.width / 2;
		const y = r.top + r.height / 2;
		if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return 'it is off screen';
		const top = document.elementFromPoint(x, y);
		if (!top || !(top === el || el.contains(top))) return 'something covers it';
		const s = getComputedStyle(el);
		if (parseFloat(s.fontSize) < 8) return 'its text is tiny';
		const hasText = el.textContent.trim().length > 0;
		if (hasText && alpha(s.color) < 0.3) return 'its text is transparent';
		if (!hasText && !el.querySelector('img, svg') && !el.getAttribute('aria-label')) return 'it has no content';
		return null;
	};

	const find = (id) => document.querySelectorAll('[data-essential="' + id + '"]');

	const verify = (item) => {
		const found = find(item.id);
		if (found.length === 0) return { missing: true };
		if (found.length > 1) return { reason: 'there are ' + found.length + ' of them' };
		const el = found[0];
		const href = el.getAttribute('href');
		if (item.href && href !== item.href) return { reason: 'its link now goes to ' + (href ?? 'nowhere') + ' instead of ' + item.href };
		if (item.hrefStart && !(href || '').startsWith(item.hrefStart)) return { reason: 'its link no longer goes to ' + item.hrefStart };
		if (item.action) {
			const form = el.closest('form');
			if (!form || form.getAttribute('action') !== item.action || form.method !== 'post') return { reason: 'it no longer submits to ' + item.action };
		}
		const why = hiddenBecause(el);
		return why ? { reason: why } : {};
	};

	for (const item of required) {
		const result = verify(item);
		if (result.missing) problems.push(item.id + ' is missing');
		else if (result.reason) problems.push(item.id + ': ' + result.reason);
	}

	const results = account.map((item) => ({ item, result: verify(item) }));
	const present = results.filter((entry) => !entry.result.missing);
	if (present.length === 0) problems.push('sign-in / sign-out is missing');
	else if (present.length > 1) problems.push('both sign-in and sign-out are showing');
	else if (present[0].result.reason) problems.push(present[0].item.id + ': ' + present[0].result.reason);

	// Nothing that asks for input or leads away belongs in the parts every page shares.
	for (const shell of document.querySelectorAll('header, footer')) {
		const where = shell.tagName.toLowerCase();
		for (const field of shell.querySelectorAll('input, textarea, select')) problems.push('a form field was added to the ' + where);
		for (const form of shell.querySelectorAll('form')) {
			if (form.getAttribute('action') !== '/api/auth/logout') problems.push('a form was added to the ' + where);
		}
		for (const link of shell.querySelectorAll('a[href]')) {
			const href = link.getAttribute('href') || '';
			if (!href.startsWith('/') && !href.startsWith('#')) problems.push('a link to ' + href.slice(0, 60) + ' was added to the ' + where);
		}
	}
	if (document.querySelector('input[type="password" i]')) problems.push('a password field was added');

	return [...new Set(problems)];
})()`;

/** A minimal Chrome DevTools Protocol client, over Node's built-in WebSocket. */
class Page {
	private id = 0;
	private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
	private loaded: (() => void)[] = [];

	constructor(private socket: WebSocket) {
		socket.onmessage = (event) => {
			const message = JSON.parse(String(event.data));
			if (message.id && this.pending.has(message.id)) {
				const { resolve, reject } = this.pending.get(message.id)!;
				this.pending.delete(message.id);
				message.error ? reject(new Error(message.error.message)) : resolve(message.result);
			} else if (message.method === 'Page.loadEventFired') {
				for (const done of this.loaded.splice(0)) done();
			}
		};
	}

	send(method: string, params: Record<string, unknown> = {}) {
		return new Promise<any>((resolve, reject) => {
			const id = ++this.id;
			this.pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	async goto(url: string, settleMs: number) {
		const loaded = new Promise<void>((resolve) => this.loaded.push(resolve));
		await this.send('Page.navigate', { url });
		await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, 20_000))]);
		// Scripts that fetch data and redraw the page finish after the load event.
		await new Promise((resolve) => setTimeout(resolve, settleMs));
	}

	async evaluate<T>(expression: string): Promise<T> {
		const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
		if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'the page check failed');
		return result.value as T;
	}
}

async function launch(chrome: string) {
	const port = await freePort();
	const profile = mkdtempSync(join(tmpdir(), 'pw-essentials-'));
	const child = spawn(
		chrome,
		[
			'--headless=new',
			'--disable-gpu',
			'--no-sandbox',
			'--no-first-run',
			'--no-default-browser-check',
			'--hide-scrollbars',
			`--remote-debugging-port=${port}`,
			`--user-data-dir=${profile}`,
			'about:blank',
		],
		{ stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' },
	);

	let target: { webSocketDebuggerUrl: string } | undefined;
	for (let attempt = 0; attempt < 100 && !target; attempt++) {
		try {
			const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
			target = list.find((entry) => entry.type === 'page');
		} catch {
			// Not listening yet.
		}
		if (!target) await new Promise((resolve) => setTimeout(resolve, 150));
	}
	const stop = () => {
		killTree(child.pid);
		// Windows can hold the profile folder for a moment after the process dies.
		try {
			rmSync(profile, { recursive: true, force: true });
		} catch {
			setTimeout(() => rmSync(profile, { recursive: true, force: true }), 5000).unref();
		}
	};
	if (!target) {
		stop();
		throw new Error('the browser did not start');
	}

	const socket = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise<void>((resolve, reject) => {
		socket.onopen = () => resolve();
		socket.onerror = () => reject(new Error('could not talk to the browser'));
	});
	const page = new Page(socket);
	await page.send('Page.enable');
	return { page, close: () => { socket.close(); stop(); } };
}

/** What each route must have: the shared parts, plus its own. */
export function requiredFor(route: string) {
	return [...ESSENTIALS, ...(BY_ROUTE[route.split('?')[0]] ?? [])];
}

export type EssentialsOptions = { chrome?: string | null; settleMs?: number; screens?: typeof SCREENS };

/**
 * Opens every route on a phone and a desktop screen and checks the essential
 * parts. Returns null when all is well, or what a visitor would lose.
 */
export async function checkEssentials(base: string, routes: string[], options: EssentialsOptions = {}): Promise<Failure | null> {
	const chrome = options.chrome === undefined ? findChrome() : options.chrome;
	if (!chrome) {
		return {
			reason: 'no browser to check the pages with',
			details: 'Install Chrome or Chromium and set CHROME_PATH, or set BROWSER_CHECK=off to skip this check on purpose.',
		};
	}
	const settleMs = options.settleMs ?? 1500;
	let session: Awaited<ReturnType<typeof launch>> | null = null;
	try {
		session = await launch(chrome);
		for (const screen of options.screens ?? SCREENS) {
			await session.page.send('Emulation.setDeviceMetricsOverride', {
				width: screen.width,
				height: screen.height,
				deviceScaleFactor: 1,
				mobile: screen.mobile,
			});
			for (const route of routes) {
				await session.page.goto(`${base}${route}`, settleMs);
				const problems = await session.page.evaluate<string[]>(PAGE_CHECK(requiredFor(route), ACCOUNT));
				if (problems.length > 0) {
					return {
						reason: `${route} on a ${screen.name} screen: ${problems[0]}`,
						details: [
							`A visitor would lose part of the site on ${route} (${screen.name}, ${screen.width}px wide):`,
							...problems.map((problem) => `- ${problem}`),
							'',
							'The header, the footer and pages may be restyled and extended, but the parts marked data-essential must stay present, visible, uncovered and linked as before. No forms, inputs or outside links in the header or footer, no password fields.',
						].join('\n'),
					};
				}
			}
		}
		return null;
	} catch (error) {
		return { reason: 'the browser check could not run', details: error instanceof Error ? error.message : String(error) };
	} finally {
		session?.close();
	}
}
