# Testing the scripts

```bash
npm test               # unit tests: lib/*.test.mjs, fakes for every external call, ~5 s
npm run test:integration   # contracts with the real siblings on a loopback fixture site
npm run check          # line length and residue gates
```

The integration tests need the sibling `page-cache` skill (found next to this skill in the
repository, or installed under `.agents/skills`), `playwright-cli` and `aem` on `PATH`; a
test whose sibling is missing is skipped with the reason. They never reach the internet:
`integration/helpers.mjs` serves a fixture site on `127.0.0.1` (pages, a stylesheet, a cookie
banner, a 301, a 302 chain, a 404, a PDF, a client-side redirect, a sitemap). Browser tests
use their own playwright-cli sessions (`cpv2-test-*`), so a cache worker or an operator's
session on the same machine is not disturbed. `integration/e2e.test.mjs` runs the whole
cache path on the fixture site — import, approve, the worker in-process through the real
proxy and browser, `check cache`, and the dashboard rendered by `aem up` — in about 30 s.

`lib/fixtures/playwright-cli-output.json` is playwright-cli output recorded from the real
CLI; re-record it when the CLI's format changes and the contract test tells you so.
