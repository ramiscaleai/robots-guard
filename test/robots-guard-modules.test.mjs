// Behaviour of src/robots-modules.mjs through the real preload: HTTP stacks that bypass
// globalThis.fetch (undici's own fetch, Playwright browsers) are guarded once a script loads them.
// Run: npm test
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRELOAD = fileURLToPath(new URL('../src/preload.mjs', import.meta.url));

let server;
let base;

// Runs `script` as an ES module with the preload, as NODE_OPTIONS does in a guarded session.
function runGuarded(script) {
  return new Promise((resolve) => {
    const env = { ...process.env, NODE_OPTIONS: '', ROBOTS_GUARD_EXEMPT_HOSTS: '', ROBOTS_GUARD_CACHE_DIR: '' };
    const child = spawn(process.execPath, ['--import', PRELOAD, '--input-type=module', '-e', script],
      { cwd: ROOT, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

before(async () => {
  server = createServer((req, res) => {
    const robots = req.url === '/robots.txt';
    res.writeHead(robots || req.url === '/jobs' ? 200 : 404, { 'content-type': robots ? 'text/plain' : 'text/html' });
    res.end(robots ? 'User-agent: *\nDisallow: /private' : '<p>jobs</p>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

describe('undici', () => {
  it('guards its own fetch, imported or required', async () => {
    const r = await runGuarded(`
      const { createRequire } = await import('node:module');
      const imported = await import('undici');
      const required = createRequire(process.cwd() + '/x.js')('undici');
      const codeOf = (p) => p.then((res) => res.status, (err) => err.code);
      console.log(JSON.stringify(await Promise.all([
        codeOf(imported.fetch('${base}/private/1')), codeOf(required.fetch('${base}/private/2')),
        codeOf(imported.fetch('${base}/jobs'))])));`);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), ['ROBOTS_DISALLOWED', 'ROBOTS_DISALLOWED', 200]);
  });
});

const CHROMIUM = await (async () => {
  try {
    const { chromium } = await import('playwright');
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

describe('Playwright', { skip: !CHROMIUM && 'Chromium is not installed (npx playwright install chromium)' }, () => {
  it('blocks a disallowed page load in pages from newPage and newContext', async () => {
    const r = await runGuarded(`
      const { chromium } = await import('playwright');
      const browser = await chromium.launch();
      const outcome = (p) => p.then((res) => res.status(), (err) => /ERR_BLOCKED_BY_CLIENT/.test(err.message) ? 'blocked' : err.message);
      const page = await browser.newPage();
      const other = await (await browser.newContext()).newPage();
      console.log(JSON.stringify([await outcome(page.goto('${base}/jobs')), await outcome(page.goto('${base}/private/1')),
        await outcome(other.goto('${base}/private/2'))]));
      await browser.close();`);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [200, 'blocked', 'blocked']);
    assert.match(r.stderr, /\[robots-guard\] blocked .*\/private\/1/);
  });
});
