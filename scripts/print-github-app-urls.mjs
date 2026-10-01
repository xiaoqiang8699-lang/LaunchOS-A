/**
 * Print exact GitHub App public URLs for External Alpha (no guessing).
 * Usage: node scripts/print-github-app-urls.mjs
 */
import { githubAppPublicSettingsUrls } from '../packages/github/dist/index.js';

const urls = githubAppPublicSettingsUrls();
console.log(JSON.stringify(urls, null, 2));
