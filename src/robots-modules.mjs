// robots-modules.mjs: the same robots.txt guard for HTTP stacks that do not go through globalThis.fetch.
//
//   - undici's own fetch, which code uses for proxies and custom dispatchers
//   - Playwright browsers launched from this process: every page load (navigation) is checked
//
// Each library is patched only when a script loads it, through a module load hook: loading them up
// front would add 0.1 to 0.4 s to every node process. Browsers reached with connect() or
// connectOverCDP() are not covered.

import { registerHooks } from 'node:module';
import { RobotsDisallowedError, wrapFetch } from './robots-guard.mjs';

const PATCH = Symbol.for('robots-guard.patch');
const ENTRY_FILES = [
  [/\/node_modules\/undici\/index\.js$/, 'undici'],
  [/\/node_modules\/playwright-core\/index\.js$/, 'playwright'],
];

function guardUndici(undici, guard, onBlock) {
  undici.fetch = wrapFetch(undici.fetch, guard, onBlock);
}

// Every navigation of every page in the context waits for the guard; a disallowed one is aborted.
async function guardContext(context, guard, onBlock) {
  if (context[PATCH]) return context;
  context[PATCH] = true;
  await context.route('**/*', async (route) => {
    if (!route.request().isNavigationRequest()) return route.fallback();
    try {
      await guard.beforeRequest(route.request().url());
    } catch (err) {
      if (!(err instanceof RobotsDisallowedError)) throw err;
      onBlock(err);
      return route.abort('blockedbyclient');
    }
    return route.fallback();
  });
  return context;
}

function guardBrowser(browser, guard, onBlock) {
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => guardContext(await newContext(...args), guard, onBlock);
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...args) => {
    const page = await newPage(...args);
    await guardContext(page.context(), guard, onBlock);
    return page;
  };
  return browser;
}

function guardPlaywright(playwright, guard, onBlock) {
  for (const type of [playwright.chromium, playwright.firefox, playwright.webkit]) {
    const launch = type.launch.bind(type);
    type.launch = async (...args) => guardBrowser(await launch(...args), guard, onBlock);
    const persistent = type.launchPersistentContext.bind(type);
    type.launchPersistentContext = async (...args) => guardContext(await persistent(...args), guard, onBlock);
  }
}

// Appends one call to each library's entry file; the call runs when that file has set module.exports.
export function guardOnLoad(guard, onBlock) {
  const patchers = { undici: guardUndici, playwright: guardPlaywright };
  globalThis[PATCH] = (kind, exports) => patchers[kind](exports, guard, onBlock);
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      const kind = ENTRY_FILES.find(([pattern]) => pattern.test(url))?.[1];
      if (!kind) return result;
      return { ...result, source: `${result.source}\n;globalThis[Symbol.for('robots-guard.patch')]('${kind}', module.exports);\n` };
    },
  });
}
