// robots-fetch.mjs: fetch a site's robots.txt and keep the answer on disk for a while.
//
// An answer is { origin, fetchedAt, status, body } or { origin, fetchedAt, error }. Real answers
// live 24 hours; server errors and network failures only 10 minutes, so a flaky site recovers.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DAY_MS = 24 * 3600 * 1000;
const UNREACHABLE_TTL_MS = 10 * 60 * 1000;
const MAX_ROBOTS_CHARS = 512 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

export function ttlOf(answer) {
  return answer.error || answer.status >= 500 ? UNREACHABLE_TTL_MS : DAY_MS;
}

function cacheFile(cacheDir, origin) {
  return join(cacheDir, `${createHash('sha256').update(origin).digest('hex').slice(0, 32)}.json`);
}

export function readCached(cacheDir, origin, now) {
  if (!cacheDir) return null;
  try {
    const answer = JSON.parse(readFileSync(cacheFile(cacheDir, origin), 'utf8'));
    return answer.origin === origin && now - answer.fetchedAt < ttlOf(answer) ? answer : null;
  } catch {
    return null; // no usable cache entry
  }
}

// Written to a temp file and renamed, so a crash never leaves a half-written entry.
export function writeCached(cacheDir, answer) {
  if (!cacheDir) return;
  const file = cacheFile(cacheDir, answer.origin);
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(answer));
    renameSync(`${file}.${process.pid}.tmp`, file);
  } catch (err) {
    process.stderr.write(`[robots-guard] could not cache robots.txt of ${answer.origin} in ${cacheDir}: ${err.message}\n`);
  }
}

export async function fetchRobots(fetchImpl, origin, userAgent, now) {
  const answer = { origin, fetchedAt: now };
  try {
    const res = await fetchImpl(`${origin}/robots.txt`, {
      headers: { 'user-agent': userAgent, accept: 'text/plain,*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    answer.status = res.status;
    answer.body = res.ok ? (await res.text()).slice(0, MAX_ROBOTS_CHARS) : '';
  } catch (err) {
    answer.error = err?.message || String(err);
  }
  return answer;
}
