#!/usr/bin/env node
// robots-guard.mjs: never request a URL that the site's robots.txt disallows.
//
// Rules: robots-rules.mjs (RFC 9309, cautious). Fetching and caching: robots-fetch.mjs.
//   - a missing robots.txt (4xx) allows everything; a server error (5xx), a redirect loop or a
//     network failure blocks the whole site, as RFC 9309 requires
//   - Crawl-delay is honoured per site; a delay above the cap blocks the request instead of
//     stalling the run
//
// Entry points:
//   node --import robots-guard/preload app.mjs   every request in that process is checked
//                                                (fetch here; undici and Playwright in robots-modules.mjs)
//   robots-guard check <url>                     exit 0 allowed, 1 disallowed
//   robots-guard hook                            Claude Code PreToolUse hook (JSON on stdin):
//                                                checks tool_input.url and the URLs of curl/wget
//                                                and browser command-line tools
//
// Environment:
//   ROBOTS_GUARD_AGENT         product token matched against User-agent lines
//                              (default robots-guard; the hook defaults to Claude-User)
//   ROBOTS_GUARD_EXEMPT_HOSTS  comma-separated hosts, subdomains included, that are never
//                              checked: they are APIs, not websites. Default: DEFAULT_EXEMPT_HOSTS.
//                              An empty value exempts nothing.
//   ROBOTS_GUARD_CACHE_DIR     where robots.txt answers are kept for 24 hours
//                              (default ~/.cache/robots-guard). An empty value keeps them in memory only.
//   ROBOTS_GUARD_MAX_DELAY_S   largest Crawl-delay honoured by waiting (default 30)

import { homedir } from 'node:os';
import { join } from 'node:path';
import { isMain } from './is-main.mjs';
import { evaluate, parseRobots } from './robots-rules.mjs';
import { fetchRobots, readCached, ttlOf, writeCached } from './robots-fetch.mjs';

export { evaluate, parseRobots };

export const DEFAULT_USER_AGENT = 'robots-guard/1.0 (+https://github.com/ramiscaleai/robots-guard)';

export const DEFAULT_EXEMPT_HOSTS = Object.freeze([
  'localhost', '127.0.0.1', '::1',
  'api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com', 'openrouter.ai',
  'api.github.com', 'raw.githubusercontent.com', 'codeload.github.com',
]);

export class RobotsDisallowedError extends Error {
  constructor(url, reason) {
    super(`robots.txt disallows ${url}: ${reason}`);
    this.name = 'RobotsDisallowedError';
    this.code = 'ROBOTS_DISALLOWED';
    this.url = url;
    this.reason = reason;
  }
}

function defaultCacheDir() {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'robots-guard');
}

export function optionsFromEnv(env = process.env) {
  const options = {};
  if (env.ROBOTS_GUARD_AGENT) options.agentTokens = [env.ROBOTS_GUARD_AGENT];
  if (env.ROBOTS_GUARD_EXEMPT_HOSTS !== undefined) {
    options.exemptHosts = env.ROBOTS_GUARD_EXEMPT_HOSTS.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  }
  if (env.ROBOTS_GUARD_CACHE_DIR !== undefined) options.cacheDir = env.ROBOTS_GUARD_CACHE_DIR || null;
  if (env.ROBOTS_GUARD_MAX_DELAY_S) options.maxCrawlDelayMs = Number(env.ROBOTS_GUARD_MAX_DELAY_S) * 1000;
  return options;
}

const verdict = (allowed, reason, crawlDelayMs = 0) => ({ allowed, reason, crawlDelayMs });

export class RobotsGuard {
  constructor({
    fetchImpl = globalThis.fetch,
    agentTokens = ['robots-guard'],
    userAgent = DEFAULT_USER_AGENT,
    cacheDir = defaultCacheDir(),
    exemptHosts = DEFAULT_EXEMPT_HOSTS,
    maxCrawlDelayMs = 30_000,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    Object.assign(this, { fetchImpl, agentTokens, userAgent, cacheDir, exemptHosts, maxCrawlDelayMs, now, sleep });
    this.memory = new Map();
    this.nextSlot = new Map();
  }

  isExempt(hostname) {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return this.exemptHosts.some((h) => host === h || host.endsWith(`.${h}`));
  }

  // One robots.txt answer per origin, shared by concurrent checks.
  robotsFor(origin) {
    const cached = this.memory.get(origin);
    if (cached && cached.expiresAt > this.now()) return cached.promise;
    const entry = { promise: this.loadRobots(origin), expiresAt: Infinity };
    this.memory.set(origin, entry);
    entry.promise.then((answer) => { entry.expiresAt = answer.fetchedAt + ttlOf(answer); });
    return entry.promise;
  }

  async loadRobots(origin) {
    const cached = readCached(this.cacheDir, origin, this.now());
    if (cached) return cached;
    const answer = await fetchRobots(this.fetchImpl, origin, this.userAgent, this.now());
    writeCached(this.cacheDir, answer);
    return answer;
  }

  async check(url) {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return verdict(true, `${u.protocol} is not fetched over HTTP`);
    if (this.isExempt(u.hostname)) return verdict(true, 'exempt host');
    return this.verdictFor(u, await this.robotsFor(u.origin));
  }

  verdictFor(u, answer) {
    const source = `robots.txt of ${u.origin}`;
    if (answer.error || answer.status >= 500 || (answer.status >= 300 && answer.status < 400)) {
      const why = answer.error ?? `HTTP ${answer.status}`;
      return verdict(false, `${source} unreachable (${why}), so RFC 9309 treats the whole site as disallowed`);
    }
    if (answer.status >= 400) return verdict(true, `${source} is missing (HTTP ${answer.status})`);
    answer.parsed ??= parseRobots(answer.body);
    const v = evaluate(answer.parsed, u.pathname + u.search, this.agentTokens);
    return verdict(v.allowed, v.rule ? `${v.rule} (${source})` : `no rule in ${source} matches`, v.crawlDelayMs);
  }

  // Throws RobotsDisallowedError, or waits until the site's Crawl-delay has passed.
  async beforeRequest(url) {
    const v = await this.check(url);
    if (!v.allowed) throw new RobotsDisallowedError(url, v.reason);
    if (v.crawlDelayMs > this.maxCrawlDelayMs) {
      throw new RobotsDisallowedError(url, `Crawl-delay ${v.crawlDelayMs / 1000}s exceeds the ${this.maxCrawlDelayMs / 1000}s cap`);
    }
    if (v.crawlDelayMs > 0) await this.waitForSlot(new URL(url).origin, v.crawlDelayMs);
  }

  // The first request to a site never waits; each later one starts a Crawl-delay after the previous.
  async waitForSlot(origin, delayMs) {
    const slot = Math.max(this.now(), this.nextSlot.get(origin) ?? 0);
    this.nextSlot.set(origin, slot + delayMs);
    const wait = slot - this.now();
    if (wait > 0) await this.sleep(wait);
  }
}

// ── fetch() wrapper ─────────────────────────────────────────────────

export function wrapFetch(originalFetch, guard, onBlock = () => {}) {
  return async function robotsCheckedFetch(input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (url) {
      try {
        await guard.beforeRequest(url);
      } catch (err) {
        if (err instanceof RobotsDisallowedError) onBlock(err);
        throw err;
      }
    }
    return originalFetch(input, init);
  };
}

export function logOncePerSiteAndRule() {
  const logged = new Set();
  return (err) => {
    const key = `${new URL(err.url).origin} ${err.reason}`;
    if (logged.has(key)) return;
    logged.add(key);
    process.stderr.write(`[robots-guard] blocked ${err.url}: ${err.reason}\n`);
  };
}

// Wraps globalThis.fetch; returns { guard, onBlock } for guarding other HTTP stacks the same way.
export function install(options = {}) {
  if (globalThis.fetch?.robotsGuard) return { guard: globalThis.fetch.robotsGuard, onBlock: globalThis.fetch.onBlock };
  const original = globalThis.fetch;
  const guard = new RobotsGuard({ fetchImpl: original, ...optionsFromEnv(), ...options });
  const onBlock = logOncePerSiteAndRule();
  const wrapped = wrapFetch(original, guard, onBlock);
  Object.assign(wrapped, { robotsGuard: guard, onBlock, original });
  globalThis.fetch = wrapped;
  return { guard, onBlock };
}

// ── Claude Code PreToolUse hook ─────────────────────────────────────

// Shell commands whose URLs are web requests; any other command's URLs are left alone.
const FETCHING_COMMAND =
  /(^|[\s;&|(`])(curl|wget|http|https|xh|lynx|w3m|aria2c|dev-browser|chrome-devtools|playwright)(?=\s)/;
const URL_IN_COMMAND = /https?:\/\/[^\s'"`<>|;)\\]+/gi;

// The URLs a tool call would request: tool_input.url (WebFetch, browser tools) or,
// for Bash, the URLs of a curl/wget-style command.
function requestedUrls(toolInput) {
  const urls = [];
  if (typeof toolInput?.url === 'string') urls.push(toolInput.url);
  const command = toolInput?.command;
  if (typeof command === 'string' && FETCHING_COMMAND.test(command)) urls.push(...(command.match(URL_IN_COMMAND) ?? []));
  return urls.filter((u) => /^https?:\/\//i.test(u));
}

export async function runHook(stdinText, guard) {
  let urls;
  try {
    urls = requestedUrls(JSON.parse(stdinText)?.tool_input);
  } catch {
    return { exitCode: 0, stderr: '' };
  }
  for (const url of urls) {
    const v = await guard.check(url);
    if (!v.allowed) {
      return { exitCode: 2, stderr: `robots.txt disallows ${url}: ${v.reason}. Skip this page and do not fetch it another way.\n` };
    }
  }
  return { exitCode: 0, stderr: '' };
}

// ── CLI ─────────────────────────────────────────────────────────────

const USAGE = `usage: robots-guard <command>
  check <url>   say whether robots.txt allows <url>: exit 0 allowed, 1 disallowed
  hook          Claude Code PreToolUse hook: tool call JSON on stdin, exit 2 blocks the call
  --help, -h    print this help
`;

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function runCheck(url, fetchImpl) {
  const v = await new RobotsGuard({ fetchImpl, ...optionsFromEnv() }).check(url);
  const delay = v.crawlDelayMs ? ` (Crawl-delay ${v.crawlDelayMs / 1000}s)` : '';
  console.log(`${v.allowed ? 'allowed' : 'DISALLOWED'}: ${url}: ${v.reason}${delay}`);
  return v.allowed ? 0 : 1;
}

async function runHookCommand(fetchImpl) {
  const guard = new RobotsGuard({ fetchImpl, agentTokens: ['Claude-User'], ...optionsFromEnv() });
  const r = await runHook(await readStdin(), guard);
  process.stderr.write(r.stderr);
  return r.exitCode;
}

async function main([command, url]) {
  if (command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  const fetchImpl = globalThis.fetch.original ?? globalThis.fetch;
  if (command === 'check' && url) return runCheck(url, fetchImpl);
  if (command === 'hook') return runHookCommand(fetchImpl);
  process.stderr.write(USAGE);
  return 64;
}

if (isMain(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
