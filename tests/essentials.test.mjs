import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, test, after } from 'node:test';
import { useTempDatabase } from './helpers.mjs';

useTempDatabase('essentials');

const { checkEssentials, findChrome, requiredFor, SCREENS } = await import('../scripts/pipeline/browser.ts');
const chrome = findChrome();
const skip = chrome ? false : 'no Chrome or Chromium on this machine (set CHROME_PATH)';

/** The shared parts, laid out like the real header and footer. */
const HEADER = `<header><a data-essential="logo" href="/">THESEUS</a>
<a data-essential="status-pill" href="/build">Cycle 044 is live</a>
<nav><a data-essential="nav-ideas" href="/ideas">Ideas</a> <a data-essential="nav-build" href="/build">Live build</a>
<a data-essential="nav-changelog" href="/changelog">Changelog</a> <a data-essential="nav-rules" href="/rules">Rules</a></nav>
<a data-essential="account-signin" href="/signin?returnTo=%2F">Sign in</a></header>`;
const FOOTER = `<footer><a data-essential="footer-propose" href="/ideas">Propose an idea</a>
<div class="big">THESEUS<span class="dot">.</span></div>
<a data-essential="footer-rules" href="/rules">Rules</a> <a data-essential="footer-privacy" href="/privacy">Privacy</a></footer>`;
const COUNTDOWN = `<aside data-essential="countdown">00:04:59</aside>`;
const page = ({ head = '', header = HEADER, main = COUNTDOWN, footer = FOOTER, script = '' } = {}) =>
	`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html{scroll-behavior:smooth} body{margin:0;font:16px sans-serif} main{min-height:1400px} a{display:inline-block;padding:8px} aside{padding:20px} .big{font-size:40px}${head}</style></head>
<body>${header}<main>${main}</main>${footer}<script>${script}</script></body></html>`;

/** Every page of the fake site is the same markup, with one tweak per test. */
function serve(html) {
	let current = html;
	const server = createServer((request, response) => {
		response.writeHead(200, { 'content-type': 'text/html' });
		response.end(current);
	});
	return new Promise((resolve) =>
		server.listen(0, '127.0.0.1', () =>
			resolve({
				base: `http://127.0.0.1:${server.address().port}`,
				set: (next) => (current = next),
				close: () => server.close(),
			}),
		),
	);
}

const site = await serve(page());
after(() => site.close());
const check = async (html, routes = ['/']) => {
	site.set(html);
	return checkEssentials(site.base, routes, { chrome, settleMs: 300 });
};

describe('the real browser check', { skip }, () => {
	test('an untouched site passes on phone and desktop', async () => {
		assert.equal(await check(page()), null);
	});

	test('changes that only change how it looks pass', async () => {
		// The pink O from the earlier cycle, a logo, a new colour, an extra safe link, a bigger header.
		const pinkO = `document.querySelector('.big').innerHTML = ''; const s = document.createElement('span'); s.textContent = 'O'; s.style.color = '#ff4fa3'; document.querySelector('.big').append('PUBLIC W', s, 'RKS.');`;
		assert.equal(await check(page({ script: pinkO })), null);
		assert.equal(await check(page({ head: 'header{background:#111} header a{color:#fff;font-size:20px;padding:20px}' })), null);
		assert.equal(await check(page({ header: HEADER.replace('</header>', '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="40" alt="logo"><a href="/gallery">Gallery</a></header>') })), null);
		assert.equal(await check(page({ footer: FOOTER.replace('</footer>', '<p>Made with care by everyone.</p></footer>') })), null);
	});

	const attacks = {
		'sign-in removed by a script': [{ script: `document.querySelector('[data-essential="account-signin"]').remove()` }, /sign-in \/ sign-out is missing/],
		'sign-in hidden with display:none': [{ head: '[data-essential="account-signin"]{display:none}' }, /account-signin: it is not displayed/],
		'sign-in made invisible': [{ head: '[data-essential="account-signin"]{visibility:hidden}' }, /it is invisible/],
		'status pill faded out': [{ head: '[data-essential="status-pill"]{opacity:0.05}' }, /status-pill: it is see-through/],
		'nav link shrunk to nothing': [{ head: '[data-essential="nav-rules"]{font-size:0;padding:0}' }, /nav-rules: it has no size/],
		'rules link moved off screen': [{ head: '[data-essential="footer-rules"]{position:absolute;left:-9999px}' }, /footer-rules: it is off screen/],
		'privacy link covered by an overlay': [{ head: '.cover{position:fixed;inset:0;z-index:99;background:#fff}', main: '<div class="cover"></div>' + COUNTDOWN }, /something covers it/],
		'privacy link text made transparent': [{ head: '[data-essential="footer-privacy"]{color:rgba(0,0,0,0)}' }, /footer-privacy: its text is transparent/],
		'countdown removed': [{ main: '<p>no timer</p>' }, /countdown is missing/],
		'a link re-pointed to another site': [{ script: `document.querySelector('[data-essential="nav-rules"]').href = 'https://evil.example/'` }, /nav-rules: its link now goes to https:\/\/evil\.example\/ instead of \/rules/],
		'sign-in re-pointed': [{ script: `document.querySelector('[data-essential="account-signin"]').setAttribute('href', '/free-gift')` }, /no longer goes to \/signin/],
		'a second, fake sign-in': [{ header: HEADER.replace('</header>', '<a data-essential="account-signin" href="/signin?x">Sign in</a></header>') }, /there are 2 of them/],
		'both sign-in and sign-out': [{ header: HEADER.replace('</header>', '<form action="/api/auth/logout" method="post"><button data-essential="account-signout">Sign out</button></form></header>') }, /both sign-in and sign-out/],
		'a login form added to the header': [{ header: HEADER.replace('</header>', '<form action="/steal"><input name="u"><input type="password" name="p"></form></header>') }, /a form field was added to the header/],
		'an input added to the footer': [{ footer: FOOTER.replace('</footer>', '<input name="email"></footer>') }, /a form field was added to the footer/],
		'a link to another site in the footer': [{ footer: FOOTER.replace('</footer>', '<a href="https://evil.example/">Free tokens</a></footer>') }, /a link to https:\/\/evil\.example\/ was added to the footer/],
		'a password field anywhere': [{ main: COUNTDOWN + '<input type="password">' }, /a password field was added/],
		'the logo hidden on phones only': [{ head: '@media (max-width:600px){[data-essential="logo"]{display:none}}' }, /phone screen: logo: it is not displayed/],
	};
	for (const [name, [options, expected]] of Object.entries(attacks)) {
		test(`refuses: ${name}`, async () => {
			const failure = await check(page(options));
			assert.ok(failure, 'the change was let through');
			assert.match(`${failure.reason}\n${failure.details}`, expected);
		});
	}

	test('the reason says what a visitor would lose, in words the AI can act on', async () => {
		const failure = await check(page({ head: '[data-essential="account-signin"]{display:none}' }));
		assert.match(failure.reason, /^\/ on a desktop screen: account-signin: it is not displayed$/);
		assert.match(failure.details, /may be restyled and extended/);
	});

	test('core pages need their own parts: voting and the idea form on /ideas', async () => {
		assert.equal(await check(page({ main: '<div data-essential="votes">votes</div><div data-essential="propose">form</div>' }), ['/ideas']), null);
		const failure = await check(page({ main: '<div data-essential="votes">votes</div>' }), ['/ideas']);
		assert.match(failure.reason, /\/ideas on a desktop screen: propose is missing/);
	});

	test('every route is checked on both screens', async () => {
		const seen = [];
		site.set(page());
		const failing = createServer((request, response) => {
			seen.push(request.url);
			response.writeHead(200, { 'content-type': 'text/html' });
			response.end(page());
		});
		await new Promise((resolve) => failing.listen(0, '127.0.0.1', resolve));
		try {
			const base = `http://127.0.0.1:${failing.address().port}`;
			assert.equal(await checkEssentials(base, ['/', '/garden'], { chrome, settleMs: 200 }), null);
			const pages = seen.filter((url) => url === '/' || url === '/garden');
			assert.equal(pages.length, 2 * SCREENS.length);
		} finally {
			failing.close();
		}
	});
});

describe('without a browser', () => {
	test('a missing browser fails closed, with the way out', async () => {
		const failure = await checkEssentials('http://127.0.0.1:9', ['/'], { chrome: null });
		assert.match(failure.reason, /no browser/);
		assert.match(failure.details, /BROWSER_CHECK=off/);
	});

	test('the route lists', () => {
		assert.ok(requiredFor('/').some((item) => item.id === 'countdown'));
		assert.ok(requiredFor('/ideas').some((item) => item.id === 'propose'));
		assert.ok(!requiredFor('/garden').some((item) => item.id === 'countdown'));
		assert.ok(requiredFor('/garden').length >= 9);
	});
});
