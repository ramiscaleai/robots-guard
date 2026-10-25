// robots-rules.mjs: parse robots.txt and decide whether a path may be fetched (RFC 9309).
//
// Cautious reading (the same choices as ai-job-search's tools/robots_check.py, MIT):
//   - the group for our bot AND the group for all bots ("*") both apply; a Disallow in
//     either one blocks the request
//   - the longest matching rule wins; on a tie, Disallow wins
//   - blank lines do not end a group; a leading byte-order mark is skipped
//   - /robots.txt itself is always allowed

// One robots.txt line → { key, value } or null for comments, blanks and junk.
function parseLine(raw) {
  const line = raw.replace(/#.*/, '').trim();
  const sep = line.indexOf(':');
  if (sep < 0) return null;
  return { key: line.slice(0, sep).trim().toLowerCase(), value: line.slice(sep + 1).trim() };
}

// RFC 9309 §2.2.2: compare percent-encoded forms; decode unreserved characters.
export function canonical(s) {
  return s
    .replace(/[^\x21-\x7E]/gu, (ch) => encodeURIComponent(ch))
    .replace(/%([0-9a-fA-F]{2})/g, (m, hex) => {
      const ch = String.fromCharCode(parseInt(hex, 16));
      return /[A-Za-z0-9\-._~]/.test(ch) ? ch : `%${hex.toUpperCase()}`;
    });
}

function addRule(group, key, value) {
  if (!group || value === '') return;
  const label = key === 'allow' ? 'Allow' : 'Disallow';
  group.rules.push({ allow: key === 'allow', pattern: canonical(value), text: `${label}: ${value}` });
}

function addCrawlDelay(group, value) {
  const seconds = Number(value);
  if (group && Number.isFinite(seconds) && seconds > 0) {
    group.crawlDelayMs = Math.max(group.crawlDelayMs, seconds * 1000);
  }
}

export function parseRobots(text) {
  const groups = [];
  let group = null;
  let inAgentLines = false;
  for (const raw of String(text).replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    const parsed = parseLine(raw);
    if (!parsed) continue;
    const { key, value } = parsed;
    if (key === 'user-agent') {
      if (!inAgentLines) groups.push((group = { agents: [], rules: [], crawlDelayMs: 0 }));
      group.agents.push(value.toLowerCase().split(/[/\s]/)[0]);
    } else if (key === 'allow' || key === 'disallow') addRule(group, key, value);
    else if (key === 'crawl-delay') addCrawlDelay(group, value);
    inAgentLines = key === 'user-agent' || (inAgentLines && !['allow', 'disallow', 'crawl-delay'].includes(key));
  }
  return { groups };
}

const regexCache = new Map();

function compilePattern(pattern) {
  let p = pattern.startsWith('/') || pattern.startsWith('*') ? pattern : `/${pattern}`;
  const anchored = p.endsWith('$');
  if (anchored) p = p.slice(0, -1);
  const body = p.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

function matches(pattern, path) {
  if (!regexCache.has(pattern)) regexCache.set(pattern, compilePattern(pattern));
  return regexCache.get(pattern).test(path);
}

function decide(rules, path) {
  let best = null;
  for (const rule of rules) {
    if (!matches(rule.pattern, path)) continue;
    const longer = !best || rule.pattern.length > best.pattern.length;
    const tieToDisallow = best && rule.pattern.length === best.pattern.length && !rule.allow;
    if (longer || tieToDisallow) best = rule;
  }
  return best ? { allowed: best.allow, rule: best.text } : { allowed: true, rule: null };
}

// → { allowed, rule (the deciding line, or null), crawlDelayMs }
export function evaluate(parsed, pathAndQuery, agentTokens) {
  const path = canonical(pathAndQuery || '/');
  if (path === '/robots.txt') return { allowed: true, rule: null, crawlDelayMs: 0 };
  const tokens = agentTokens.map((t) => t.toLowerCase());
  const own = parsed.groups.filter((g) => g.agents.some((a) => a !== '*' && tokens.includes(a)));
  const all = parsed.groups.filter((g) => g.agents.includes('*'));
  const verdicts = [own, all].filter((gs) => gs.length > 0).map((gs) => decide(gs.flatMap((g) => g.rules), path));
  const blocking = verdicts.find((v) => !v.allowed);
  const deciding = blocking ?? verdicts.find((v) => v.rule);
  const crawlDelayMs = Math.max(0, ...[...own, ...all].map((g) => g.crawlDelayMs));
  return { allowed: !blocking, rule: deciding?.rule ?? null, crawlDelayMs };
}
