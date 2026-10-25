// Behaviour of src/. Run: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseRobots, evaluate, RobotsGuard, RobotsDisallowedError, wrapFetch, runHook,
} from '../src/robots-guard.mjs';

const GUARD_FILE = fileURLToPath(new URL('../src/robots-guard.mjs', import.meta.url));
const verdict = (robots, path, token = 'robots-guard') => evaluate(parseRobots(robots), path, [token]);

// A fetch double serving robots.txt per origin. `served` counts robots.txt requests.
function robotsServer(byOrigin) {
  const served = {};
  const fetchImpl = async (url) => {
    const { origin, pathname } = new URL(url);
    assert.equal(pathname, '/robots.txt', 'the guard must only fetch robots.txt itself');
    served[origin] = (served[origin] ?? 0) + 1;
    const r = byOrigin[origin];
    if (r instanceof Error) throw r;
    return new Response(r?.body ?? '', { status: r?.status ?? 200 });
  };
  return { fetchImpl, served };
}

function guardFor(byOrigin, opts = {}) {
  const server = robotsServer(byOrigin);
  const guard = new RobotsGuard({ fetchImpl: server.fetchImpl, cacheDir: null, exemptHosts: [], ...opts });
  return { guard, served: server.served };
}

describe('robots.txt rules (RFC 9309)', () => {
  it('allows everything when robots.txt is empty', () => {
    assert.equal(verdict('', '/jobs/1').allowed, true);
  });

  it('disallows a path under a Disallow prefix for all bots', () => {
    const robots = 'User-agent: *\nDisallow: /private';
    assert.equal(verdict(robots, '/private/x').allowed, false);
    assert.equal(verdict(robots, '/public').allowed, true);
  });

  it('lets the longest matching rule win', () => {
    const robots = 'User-agent: *\nDisallow: /a\nAllow: /a/b';
    assert.equal(verdict(robots, '/a/b/c').allowed, true);
    assert.equal(verdict(robots, '/a/c').allowed, false);
  });

  it('lets Disallow win a tie of equal length (cautious)', () => {
    assert.equal(verdict('User-agent: *\nAllow: /x\nDisallow: /x', '/x').allowed, false);
  });

  it('supports the * wildcard and the $ end anchor', () => {
    const robots = 'User-agent: *\nDisallow: /*.pdf$\nDisallow: /search*q=';
    assert.equal(verdict(robots, '/files/cv.pdf').allowed, false);
    assert.equal(verdict(robots, '/files/cv.pdf.html').allowed, true);
    assert.equal(verdict(robots, '/search/all?q=go').allowed, false);
  });

  it('matches the query string together with the path', () => {
    assert.equal(verdict('User-agent: *\nDisallow: /jobs?page=', '/jobs?page=2').allowed, false);
    assert.equal(verdict('User-agent: *\nDisallow: /jobs?page=', '/jobs').allowed, true);
  });

  it('applies the group for our bot and still applies the all-bots group (cautious)', () => {
    const robots = 'User-agent: *\nDisallow: /admin\n\nUser-agent: robots-guard\nAllow: /\nDisallow: /api';
    assert.equal(verdict(robots, '/api/jobs').allowed, false, 'our group disallows');
    assert.equal(verdict(robots, '/admin').allowed, false, 'the all-bots group disallows');
    assert.equal(verdict(robots, '/jobs').allowed, true);
  });

  it('matches our bot name case-insensitively and ignores a version suffix', () => {
    assert.equal(verdict('User-agent: Robots-Guard/1.0\nDisallow: /', '/x').allowed, false);
    assert.equal(verdict('User-agent: OtherBot\nDisallow: /', '/x').allowed, true);
  });

  it('keeps a group together across blank lines', () => {
    assert.equal(verdict('User-agent: *\n\nDisallow: /x', '/x').allowed, false);
  });

  it('reads the first group even after a byte-order mark', () => {
    assert.equal(verdict('﻿User-agent: *\nDisallow: /', '/x').allowed, false);
  });

  it('treats an empty Disallow as allow-all', () => {
    assert.equal(verdict('User-agent: *\nDisallow:', '/x').allowed, true);
  });

  it('starts a new group at a user-agent line that follows rules', () => {
    const robots = 'User-agent: a\nUser-agent: robots-guard\nDisallow: /x\nUser-agent: b\nDisallow: /y';
    assert.equal(verdict(robots, '/x').allowed, false);
    assert.equal(verdict(robots, '/y').allowed, true);
  });

  it('always allows /robots.txt itself', () => {
    assert.equal(verdict('User-agent: *\nDisallow: /', '/robots.txt').allowed, true);
  });

  it('reads Crawl-delay from the groups that apply', () => {
    assert.equal(verdict('User-agent: *\nCrawl-delay: 2', '/x').crawlDelayMs, 2000);
  });

  it('names the deciding rule', () => {
    assert.match(verdict('User-agent: *\nDisallow: /private', '/private').rule, /Disallow: \/private/);
  });
});

describe('RobotsGuard fetching robots.txt', () => {
  it('allows a site whose robots.txt is missing (4xx)', async () => {
    const { guard } = guardFor({ 'https://a.test': { status: 404 } });
    assert.equal((await guard.check('https://a.test/jobs')).allowed, true);
  });

  it('blocks a site whose robots.txt answers a server error', async () => {
    const { guard } = guardFor({ 'https://a.test': { status: 503 } });
    const v = await guard.check('https://a.test/jobs');
    assert.equal(v.allowed, false);
    assert.match(v.reason, /503/);
  });

  it('blocks a site whose robots.txt cannot be reached', async () => {
    const { guard } = guardFor({ 'https://a.test': new Error('ECONNREFUSED') });
    assert.equal((await guard.check('https://a.test/jobs')).allowed, false);
  });

  it('fetches robots.txt once per site, also under concurrent checks', async () => {
    const { guard, served } = guardFor({ 'https://a.test': { body: 'User-agent: *\nDisallow: /x' } });
    await Promise.all([guard.check('https://a.test/1'), guard.check('https://a.test/2'), guard.check('https://a.test/x')]);
    assert.equal(served['https://a.test'], 1);
  });

  it('reuses its disk cache for 24 hours, then fetches again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'robots-guard-'));
    try {
      let now = 1_000_000;
      const byOrigin = { 'https://a.test': { body: 'User-agent: *\nDisallow: /x' } };
      const first = guardFor(byOrigin, { cacheDir: dir, now: () => now });
      await first.guard.check('https://a.test/1');
      const second = guardFor(byOrigin, { cacheDir: dir, now: () => now });
      assert.equal((await second.guard.check('https://a.test/x')).allowed, false);
      assert.equal(second.served['https://a.test'], undefined, 'served from disk');
      now += 25 * 3600 * 1000;
      const third = guardFor(byOrigin, { cacheDir: dir, now: () => now });
      await third.guard.check('https://a.test/1');
      assert.equal(third.served['https://a.test'], 1, 'stale cache refetched');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not check exempt hosts', async () => {
    const { guard, served } = guardFor({}, { exemptHosts: ['localhost', 'api.example.com'] });
    assert.equal((await guard.check('http://localhost:3000/x')).allowed, true);
    assert.equal((await guard.check('https://eu.api.example.com/v1')).allowed, true);
    assert.deepEqual(served, {});
  });

  it('spaces requests to one site by its Crawl-delay', async () => {
    let now = 0;
    const waits = [];
    const sleep = async (ms) => { waits.push(ms); now += ms; };
    const { guard } = guardFor({ 'https://a.test': { body: 'User-agent: *\nCrawl-delay: 2' } }, { now: () => now, sleep });
    await guard.beforeRequest('https://a.test/1');
    await guard.beforeRequest('https://a.test/2');
    assert.deepEqual(waits, [2000]);
  });

  it('refuses a site whose Crawl-delay exceeds the cap instead of stalling', async () => {
    const { guard } = guardFor({ 'https://a.test': { body: 'User-agent: *\nCrawl-delay: 3600' } }, { maxCrawlDelayMs: 30_000 });
    await assert.rejects(guard.beforeRequest('https://a.test/1'), RobotsDisallowedError);
  });
});

describe('wrapFetch', () => {
  it('rejects a disallowed URL without requesting it', async () => {
    const calls = [];
    const { guard } = guardFor({ 'https://a.test': { body: 'User-agent: *\nDisallow: /private' } });
    const fetch = wrapFetch(async (input) => { calls.push(String(input)); return new Response('ok'); }, guard);
    await assert.rejects(fetch('https://a.test/private/1'), (err) => err instanceof RobotsDisallowedError && err.code === 'ROBOTS_DISALLOWED');
    assert.deepEqual(calls, []);
  });

  it('passes an allowed request through unchanged, Request objects included', async () => {
    const calls = [];
    const { guard } = guardFor({ 'https://a.test': { body: 'User-agent: *\nDisallow: /private' } });
    const fetch = wrapFetch(async (input, init) => { calls.push([input, init]); return new Response('ok'); }, guard);
    const req = new Request('https://a.test/jobs');
    assert.equal(await (await fetch(req, { method: 'GET' })).text(), 'ok');
    assert.equal(calls[0][0], req);
    assert.deepEqual(calls[0][1], { method: 'GET' });
  });
});

describe('Claude Code PreToolUse hook', () => {
  const hookInput = (tool_input) => JSON.stringify({ tool_name: 'WebFetch', tool_input });

  it('blocks a disallowed URL with exit code 2 and names the rule', async () => {
    const { guard } = guardFor({ 'https://a.test': { body: 'User-agent: *\nDisallow: /private' } });
    const r = await runHook(hookInput({ url: 'https://a.test/private/job' }), guard);
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /Disallow: \/private/);
  });

  it('allows a permitted URL with exit code 0', async () => {
    const { guard } = guardFor({ 'https://a.test': { body: 'User-agent: *\nDisallow: /private' } });
    assert.equal((await runHook(hookInput({ url: 'https://a.test/jobs/1' }), guard)).exitCode, 0);
  });

  it('allows a tool call that carries no URL', async () => {
    const { guard } = guardFor({});
    assert.equal((await runHook(hookInput({ prompt: 'hi' }), guard)).exitCode, 0);
  });

  it('blocks a curl or wget command that fetches a disallowed URL', async () => {
    const { guard } = guardFor({ 'https://a.test': { body: 'User-agent: *\nDisallow: /private' } });
    const bash = (command) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
    assert.equal((await runHook(bash('curl -sL "https://a.test/private/job" -o job.html'), guard)).exitCode, 2);
    assert.equal((await runHook(bash('cd /tmp && wget https://a.test/private/1'), guard)).exitCode, 2);
    assert.equal((await runHook(bash('curl -s https://a.test/jobs'), guard)).exitCode, 0);
  });

  it('blocks browser command-line tools that open a disallowed URL', async () => {
    const { guard } = guardFor({ 'https://a.test': { body: 'User-agent: *\nDisallow: /private' } });
    const bash = (command) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
    for (const cli of ['dev-browser goto', 'chrome-devtools navigate_page --url', 'npx playwright screenshot']) {
      assert.equal((await runHook(bash(`${cli} https://a.test/private/1`), guard)).exitCode, 2, cli);
    }
  });

  it('leaves URLs alone in shell commands that do not fetch web pages', async () => {
    const { guard, served } = guardFor({ 'https://a.test': { body: 'User-agent: *\nDisallow: /' } });
    const bash = (command) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
    assert.equal((await runHook(bash('git clone https://a.test/private/repo.git'), guard)).exitCode, 0);
    assert.deepEqual(served, {});
  });

  it('works end to end as a command against a real HTTP server', async () => {
    const server = await startServer('User-agent: *\nDisallow: /private');
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const blocked = await runHookProcess(hookInput({ url: `${base}/private/1` }));
      assert.equal(blocked.exitCode, 2, blocked.stderr);
      assert.equal((await runHookProcess(hookInput({ url: `${base}/jobs` }))).exitCode, 0);
    } finally {
      server.close();
    }
  });
});

// A local site that serves robotsTxt at /robots.txt and 404 everywhere else.
async function startServer(robotsTxt) {
  const server = createServer((req, res) => {
    res.statusCode = req.url === '/robots.txt' ? 200 : 404;
    res.end(req.url === '/robots.txt' ? robotsTxt : '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

// Runs `robots-guard.mjs hook` as Claude Code would, with no exempt hosts and no disk cache.
function runHookProcess(stdinText) {
  return new Promise((resolve) => {
    const env = { ...process.env, ROBOTS_GUARD_EXEMPT_HOSTS: '', ROBOTS_GUARD_CACHE_DIR: '' };
    const child = spawn(process.execPath, [GUARD_FILE, 'hook'], { env });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (exitCode) => resolve({ exitCode, stderr }));
    child.stdin.end(stdinText);
  });
}

describe('command line', () => {
  it('prints usage and exits 0 on --help and -h, without fetching anything', () => {
    for (const flag of ['--help', '-h']) {
      const r = spawnSync(process.execPath, [GUARD_FILE, flag], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /check <url>/);
      assert.match(r.stdout, /hook/);
    }
  });

  it('exits 64 with usage on stderr for an unknown command', () => {
    const r = spawnSync(process.execPath, [GUARD_FILE, 'crawl'], { encoding: 'utf8' });
    assert.equal(r.status, 64);
    assert.match(r.stderr, /usage/);
  });
});
