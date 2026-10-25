// The package as another project gets it: packed, installed from the tarball, then used through the
// robots-guard command (an npm bin symlink) and through --import robots-guard/preload.
// Run: npm test
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENV = { ...process.env, NODE_OPTIONS: '', ROBOTS_GUARD_EXEMPT_HOSTS: '', ROBOTS_GUARD_CACHE_DIR: '' };
let project;
let server;
let base;

// A consumer project with the packed tarball installed, as an install from a registry would leave it.
function installPacked() {
  const dir = mkdtempSync(join(tmpdir(), 'robots-guard-consumer-'));
  const npm = (args, cwd) => execFileSync('npm', args, { cwd, env: ENV, encoding: 'utf8' });
  const [{ filename }] = JSON.parse(npm(['pack', '--json', '--pack-destination', dir], ROOT));
  writeFileSync(join(dir, 'package.json'), '{"name":"consumer","private":true,"type":"module"}');
  npm(['install', '--offline', '--no-audit', '--no-fund', join(dir, filename)], dir);
  return dir;
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: project, env: ENV });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

before(async () => {
  project = installPacked();
  server = createServer((req, res) => {
    const robots = req.url === '/robots.txt';
    res.writeHead(robots || req.url === '/open' ? 200 : 404, { 'content-type': 'text/plain' });
    res.end(robots ? 'User-agent: *\nDisallow: /private' : 'ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  if (project) rmSync(project, { recursive: true, force: true });
});

describe('installed package', () => {
  const bin = () => join(project, 'node_modules', '.bin', 'robots-guard');

  it('runs as the robots-guard command through the npm bin symlink', async () => {
    const r = await run(bin(), ['--help']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /usage: robots-guard <command>/);
  });

  it('checks a URL from the command line: exit 1 when disallowed, 0 when allowed', async () => {
    const blocked = await run(bin(), ['check', `${base}/private/1`]);
    assert.equal(blocked.code, 1, blocked.stderr);
    assert.match(blocked.stdout, /DISALLOWED.*Disallow: \/private/);
    assert.equal((await run(bin(), ['check', `${base}/open`])).code, 0);
  });

  it('guards fetch() of a script loaded with --import robots-guard/preload', async () => {
    const script = `const codeOf = (p) => p.then((res) => res.status, (err) => err.code);
      console.log(JSON.stringify([await codeOf(fetch('${base}/private/1')), await codeOf(fetch('${base}/open'))]));`;
    const r = await run(process.execPath, ['--import', 'robots-guard/preload', '--input-type=module', '-e', script]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), ['ROBOTS_DISALLOWED', 200]);
  });

  it('ships the files the example Claude Code settings point at', () => {
    const settings = readFileSync(join(ROOT, 'examples', 'claude-code-settings.json'), 'utf8');
    const paths = [...settings.matchAll(/\$CLAUDE_PROJECT_DIR\/(node_modules\/robots-guard\/[\w/.-]+\.mjs)/g)].map((m) => m[1]);
    assert.ok(paths.length >= 2, 'the example names the preload and the hook');
    for (const p of paths) assert.ok(existsSync(join(project, p)), `${p} is installed`);
  });
});
