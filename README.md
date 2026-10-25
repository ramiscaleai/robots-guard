# robots-guard

[![tests](https://github.com/ramiscaleai/robots-guard/actions/workflows/tests.yml/badge.svg)](https://github.com/ramiscaleai/robots-guard/actions/workflows/tests.yml)

Make a Node.js process obey `robots.txt` without changing its code. Loaded with `--import`, it checks
every `fetch()`, every request through undici's own `fetch` and every Playwright page load before it
leaves the machine. The same check runs as a Claude Code hook, so an AI agent's web fetches, browser
tools and `curl`/`wget` commands obey `robots.txt` too.

## Install

```bash
npm install github:ramiscaleai/robots-guard   # Node.js 22.15 or newer; no runtime dependencies
```

## Use

| To | Run |
|---|---|
| Guard every request of a script | `node --import robots-guard/preload app.mjs` |
| Check one URL | `npx robots-guard check https://example.com/page` (exit 0 allowed, 1 disallowed) |
| Guard a Claude Code agent | merge [`examples/claude-code-settings.json`](examples/claude-code-settings.json) into `.claude/settings.json` |
| Use it from code | `import { RobotsGuard, wrapFetch, install } from 'robots-guard'` |

A blocked request rejects with `RobotsDisallowedError` (`code: 'ROBOTS_DISALLOWED'`) and writes one
`[robots-guard] blocked …` line to stderr per site and rule. The hook exits 2, which makes Claude Code
skip the call and tell the agent why.

## How it decides

RFC 9309, read cautiously:

- the group for your bot and the group for all bots (`*`) both apply; a `Disallow` in either one blocks
- the longest matching rule wins; on a tie, `Disallow` wins; `*` and `$` patterns are supported
- `robots.txt` missing (4xx): everything is allowed; a server error (5xx), a redirect loop or a network
  failure blocks the whole site
- `Crawl-delay` spaces requests per site; a delay above the cap blocks the request instead of stalling
- answers are cached on disk for 24 hours (10 minutes for errors), and concurrent checks share one fetch

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `ROBOTS_GUARD_AGENT` | `robots-guard` (the hook: `Claude-User`) | product token matched against `User-agent` lines |
| `ROBOTS_GUARD_EXEMPT_HOSTS` | localhost and common AI and GitHub API hosts | comma-separated hosts, subdomains included, that are APIs rather than websites; empty exempts nothing |
| `ROBOTS_GUARD_CACHE_DIR` | `~/.cache/robots-guard` | where answers are kept; empty keeps them in memory only |
| `ROBOTS_GUARD_MAX_DELAY_S` | `30` | largest `Crawl-delay` honoured by waiting |

## Files

| File | Holds |
|---|---|
| `src/robots-rules.mjs` | parsing and the allow/disallow decision |
| `src/robots-fetch.mjs` | fetching `robots.txt` and the disk cache |
| `src/robots-guard.mjs` | the guard, the `fetch()` wrapper, the hook and the command line |
| `src/robots-modules.mjs` | the same guard for undici's own fetch and for Playwright, patched in when a script loads them |
| `src/preload.mjs` | the `--import` entry that installs all of the above |

## Test

```bash
npm install
npx playwright install chromium   # optional: without it the Playwright test is skipped
npm test
```

## License

MIT, see [LICENSE](LICENSE).
