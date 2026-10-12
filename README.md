# Theseus

> The Athenians kept the ship of Theseus in their harbour for centuries. Whenever a plank rotted, they replaced it with a new one. In time, not a single original timber was left, and philosophers have argued ever since: is it still the same ship?

**Theseus is a website that is rebuilt the same way, by the people who visit it.** Anyone can propose a change. Everyone votes. When the voting window closes, an AI coding agent builds the winning idea into the site, checks its own work, and ships it with no one approving it by hand. One plank at a time.

Leave it running long enough and nothing of the first version may remain. Whether it is still the same site is the experiment.

---

## How it works

Every idea goes through the same voyage, and every step is visible on the site.

| | Stage | What happens |
|---|---|---|
| 1 | **Propose** | Sign in with X, Google or GitHub (no wallets, nothing to pay) and describe a change in 16–280 characters. One open idea per person per window. Fixed rules and a fast AI review check it on the spot; if it's refused, only its author sees why. |
| 2 | **Vote** | Three free votes per person per window. Move them any time; you can't vote for your own idea. Counts update live. |
| 3 | **The window closes** | Every six hours the idea with the most votes wins, if it has enough of them. Ties go to the idea proposed first. The board empties and a new window opens straight away. |
| 4 | **One last look** | A stronger model reads the winner again, strictly. A paused site, a spent budget, or an idea that fails this check is skipped, publicly, with the reason. |
| 5 | **The build** | Claude Code implements the idea in a separate working copy, with no shell, no network and no access to secrets. |
| 6 | **The checks** | The change is reviewed line by line, built, started on a spare port and tested, then opened in a real browser on a phone and a desktop screen. If something fails, the AI gets up to two tries to repair it. |
| 7 | **Shipping** | The change is committed by a bot, credited to the idea's author, and applied to the site. The live site is checked once more; if it broke, the commit is reverted on its own. |

Watch a build happen on `/build`. Every cycle, shipped, skipped or rolled back, is listed on `/changelog`.

## Planks and keel

A ship can lose its planks and stay afloat. It can't lose its keel.

**The planks** are everything the AI may change: pages, components, styles, images, and the data its features keep. The header and footer can be restyled too.

**The keel** is `src/core/`: sign-in, voting, the voting cycle, moderation, the database, the API and the build pipeline. The AI can't edit it, and the checks refuse any change that tries.

Some things must survive every rebuild, however the planks change: the sign-in button, the main menu, the build status, the countdown, the voting buttons and the idea form, the Rules and Privacy links. They are marked in the core, and a real browser checks after every build that each is still there, visible and pointing where it should.

## Every layer assumes the one before it was fooled

Ideas are text from strangers that ends up in front of an AI allowed to change a live website. No single check is trusted to stop everything.

| Layer | When | What it stops |
|---|---|---|
| Fixed rules | On submit | Instructions aimed at the AI, requests for secrets, money and crypto, links, attempts to remove sign-in or voting, near-duplicates of open or already-built ideas |
| Fast AI review (Haiku) | On submit and edit | Anything subtler. If it can't answer in time, the idea goes up marked unverified and is reviewed again in the background |
| Final AI review (Sonnet) | Before the build | A last, strict read of the winner. No answer means no build |
| A fenced prompt | During the build | The idea reaches the agent marked as data, never as instructions; the agent checks it against the rules before touching any code |
| A sandboxed agent | During the build | Read, search and edit only; writes only inside `src/` and `public/` outside the core; no shell, web, or MCP; can't read `.env`, the database or `.git` |
| Diff guards | After the build | Core files, unknown packages, `eval`, `process`, SQL that writes, requests to other domains, raw HTML from visitors' text, leaked secrets, oversized changes |
| Build and smoke test | After the build | Pages that don't compile, answer with an error, lose the site's shell or its security policy |
| Browser check | After the build | Essential parts removed, hidden, covered, moved or re-linked; new forms or outside links in the header and footer; password fields |
| Live check | After shipping | A site that broke anyway: the change is reverted with a new commit |

A strict Content Security Policy keeps every page to its own origin, so even code that slips through can't load or send anything elsewhere.

## Features that remember things

A guestbook, a pixel canvas or a poll has to keep what visitors add. The AI never writes its own API or SQL for that. It declares a collection, and the core stores and checks the data:

```json
{ "name": "guestbook", "mode": "append", "fields": { "message": { "type": "text", "max": 140 } }, "perUserPerDay": 5 }
```

Collections live in `src/collections/`. A collection can be a list (`append`), one record per key such as a canvas cell (`upsert-by-key`), or one record per visitor (`one-per-user`). Fields can be `text`, `int`, `bool`, `enum` or `color`. Reading is public; writing needs a signed-in visitor. The core enforces its own limits whatever a declaration says: 2 KB per record, 10,000 records per collection, 60 writes per person per hour, and text that follows the same rules as ideas.

AI code uses `collection(name)` from `src/core/public/store.ts` in the browser and `storeItems(name)` from `src/core/public/data.ts` on the server.

---

## Running it locally

You need **Node.js 24** or newer (for the built-in `node:sqlite`) and **pnpm 10**. To moderate ideas and build winners with AI you also need [Claude Code](https://claude.com/claude-code), signed in. Chrome or Chromium is needed for the browser check.

```sh
pnpm install
cp .env.example .env    # add the sign-in keys you have
pnpm dev                # http://127.0.0.1:4321
```

Use **127.0.0.1**, not `localhost`: sign-in callbacks are registered for that address, and cookies are per host. The database is created on first start.

Without any sign-in keys you can still try everything with **Dev login** on `/signin`: sign in as any name to propose and vote as several people. It doesn't exist in production builds.

To let the cycle run by itself, start the daemon next to the site:

```sh
pnpm cycle:daemon       # closes due windows and builds each winner
```

By default builds are dry runs: tested and committed in a separate working copy, never applied. Set `DEPLOY_MODE=local` to apply them to this repository, where the dev server picks them up.

### Commands

| Command | |
|---|---|
| `pnpm dev` | Development server |
| `pnpm build`, `pnpm start` | Production build and server |
| `pnpm test` | All tests |
| `pnpm cycle:daemon` | Run the voting cycle and builds without supervision |
| `pnpm cycle:run` | Build the oldest waiting winner once |
| `pnpm cycle:close` | End the current voting window now |
| `pnpm cycle:canary` | Check that the agent's sandbox really blocks what it should |
| `pnpm build:simulate` | Play a fake build, to see `/build` without spending anything |
| `pnpm store:remove <collection> <id>` | Remove any record from a collection |
| `pnpm db:seed`, `pnpm db:reset` | Sample data for development; delete the database |

### Configuration

Everything is set in `.env`, read when the server starts. The most useful settings:

| Variable | Default | |
|---|---|---|
| `WINDOW_MINUTES` | `360` | Length of a voting window |
| `DEPLOY_MODE` | `preview` | `preview` builds dry runs; `local` applies changes to this repository and checks the running site |
| `MODERATION_PROVIDER` | `cli` | `cli` uses a signed-in Claude Code; `api` uses the Anthropic API with `ANTHROPIC_API_KEY`, for servers; `off` skips AI review |
| `MODERATION_MODEL` | `claude-haiku-5-5` | Review on submit |
| `FINAL_GATE_MODEL` | `claude-sonnet-5-5` | Review before a build |
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | The model that builds |
| `CLAUDE_AUTH` | `oauth` | `api-key` runs the agent with `ANTHROPIC_API_KEY` instead of a signed-in Claude Code |
| `PER_RUN_BUDGET_USD` | `3` | Spending cap per build; the monthly cap is a setting in the database (75) |
| `BROWSER_CHECK` | `required` | `off` skips the browser check on purpose. Without a browser the build fails rather than skip silently |
| `CHROME_PATH` | found automatically | Chrome or Chromium for the browser check |

Settings that change while the site runs (`min_votes`, `monthly_cap_usd`, `paused`) live in the `settings` table.

### Sign-in providers

Each provider turns on when both its keys are set. The callback for each is `http://127.0.0.1:4321/api/auth/<provider>/callback`.

| Provider | Where | Keys | Notes |
|---|---|---|---|
| GitHub | Settings → Developer settings → OAuth Apps | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | |
| Google | Cloud console → Google Auth Platform → OAuth client (Web application) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Only `openid profile` is requested; email is never read |
| X | Developer Console → your app → User authentication settings (Web App, Read) | `X_CLIENT_ID`, `X_CLIENT_SECRET` | Use the OAuth 2.0 client keys, not the API key or bearer token |

Keys stay in `.env`, which git ignores. Nothing in the site ever shows them.

---

## Inside

```
src/
  core/            the keel: the AI can't edit anything in here
    auth/          sessions and sign-in with X, Google and GitHub
    cycle/         voting windows, the countdown, the history
    ideas/ votes/  proposing, editing, voting, rules and duplicates
    moderation/    AI review of ideas
    store/         shared data for features the AI builds
    builds/        build records and the live log
    db/            SQLite schema, migrations, client
    public/        the only core modules AI code may import
    components/    the shell, header, footer and the core's UI
    site.ts        the project's name
  collections/     data declarations written by the AI
  pages/           pages and API routes (the home page is the AI's)
scripts/
  pipeline/        the build: agent, guards, build and checks, release
tests/             unit and end-to-end tests (node:test)
```

Built with Astro 7 (server-rendered on Node), Tailwind CSS 4, SQLite through `node:sqlite`, and Claude Code with the Anthropic SDK. The dependency list is short on purpose: Astro and its Node adapter, Tailwind, self-hosted fonts and icons, the Anthropic SDK, and `tsx` for the scripts.

## Status

Theseus runs end to end on a single machine: voting windows, AI review, the build pipeline with its checks and rollbacks, and the shared-data store. Next come a hosted deployment (server, domain, HTTPS, CI), bot protection for sign-in and votes, and a corpus of known attacks that every layer is tested against.

## Contributing

Changes to the site's pages arrive the way the site intends: through the vote. Changes to the keel (the core, the checks, the pipeline) are welcome as pull requests, with tests. If you change a defence, don't weaken it.

## License

[MIT](LICENSE)
