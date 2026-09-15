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

## Mutation testing, when you want to know what the tests do not pin

Not a gate; run it on one module at a time, from a throwaway copy of the skill (Stryker's
in-place mode rewrites the working tree while it runs), with only that module's test files:

```bash
cp -R . /tmp/skill-copy && cd /tmp/skill-copy/scripts
cat > /tmp/stryker.json <<'JSON'
{ "mutate": ["lib/urls.mjs"], "testRunner": "command",
  "commandRunner": { "command": "node --test lib/urls.test.mjs" },
  "reporters": ["clear-text"], "concurrency": 1, "inPlace": true, "timeoutMS": 20000,
  "ignorePatterns": ["node_modules", "integration", ".stryker-tmp"] }
JSON
npx -y @stryker-mutator/core@9 run /tmp/stryker.json
```

Ten minutes per module. Read the survivors; the ones that change what an operator would see
or what a step does get a test, string literals in prose do not.
