#!/usr/bin/env node
// The cache step, always in the background: `warm.mjs` queues the approved selection as a
// job and makes sure one detached worker is running, then returns at once. The worker
// (`--worker`) takes jobs in order: proxy + browser + offline verification + cache.md.
// Usage: node warm.mjs [--pace <ms>] [--force] | status | stop   (from the project root)
// A rerun visits only the URLs not yet cached; --force visits all. See lib/warm-cli.mjs.
import { pathToFileURL } from 'node:url';
import { resolveProject } from './lib/project.mjs';
import { main } from './lib/warm-cli.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), resolveProject())
    .then((out) => console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2)))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
