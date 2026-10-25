// is-main.mjs: was this module the file node was started with? Both paths are resolved first,
// because npm runs package commands through symlinks (node_modules/.bin/robots-guard).
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMain(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(process.argv[1]);
  } catch {
    return false; // argv[1] is no file, e.g. under node -e
  }
}
