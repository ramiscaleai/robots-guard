// Load with `node --import robots-guard/preload <script>`: every fetch() in that process then
// obeys robots.txt (see robots-guard.mjs), and so do undici's own fetch and Playwright browsers once
// the script loads them (see robots-modules.mjs).
import { install } from './robots-guard.mjs';
import { guardOnLoad } from './robots-modules.mjs';

const { guard, onBlock } = install();
guardOnLoad(guard, onBlock);
