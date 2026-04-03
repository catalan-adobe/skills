# playwright-cli Rules

## eval only accepts pure expressions

`playwright-cli eval "EXPR"` wraps the argument as `page.evaluate(() => (EXPR))`. This means:

- **Works:** pure expressions — `42`, `document.title`, `JSON.stringify(obj)`, comma expressions `(x = 1, x + 2)`
- **Fails:** statements — `var x = 1; x`, `return 42`, `if (x) { ... }`, block bodies `{ ... }`
- **Fails:** IIFEs with statements — `(() => { var x = 1; return x; })()` errors with "result is not a function"

If you need to run multi-statement code, use one of:
1. **`initScript`** — inject a script file before navigation via config: `{"browser":{"initScript":["path/to/script.js"]}}`. The script runs at global scope, can use `var`/`const`/`function`, and creates `window.*` globals accessible to later `eval` calls.
2. **Comma expressions** — chain pure expressions: `(window.x = compute(), window.y = transform(window.x), JSON.stringify({x: window.x, y: window.y}))`
3. **Two-step** — store to global in one eval, read in another: `eval "window.result = heavyComputation(), 'ok'"` then `eval "window.result.field"`

## Injecting large scripts (bundles, libraries)

Never inline a bundle into eval via `$(cat "file.js")` — it breaks shell quoting and hits the expression-only limitation.

Never serve from localhost and fetch/inject via `<script src>` — Chrome's Private Network Access (PNA) policy blocks HTTP requests from HTTPS pages to loopback addresses since Chrome 94.

**Always use `initScript`:**

```bash
CONFIG="/tmp/pw-config-$$.json"
echo '{"browser":{"initScript":["'"$BUNDLE_PATH"'"]}}' > "$CONFIG"
playwright-cli open "$URL" --config="$CONFIG"
# Bundle globals (e.g., window.__myLib) are now available
playwright-cli eval "JSON.stringify(window.__myLib.doThing())"
rm -f "$CONFIG"
```

The bundle file is read from disk by playwright-cli itself — no network request, no shell quoting, no expression limitation.

**Flag position:** `--config` is an option on the `open` subcommand — it goes after the URL: `playwright-cli open <url> --config=<path>`. Same for `--persistent`, `--browser`, `--headed`.

## Merging initScript with browser recipes

When combining a bundle injection with a browser recipe (from browser-probe), merge both into one config. The bundle should come first in the `initScript` array so it's available when the page loads:

```javascript
config.browser.initScript = ['bundle.js', ...existingInitScripts];
```

## Result size

`playwright-cli eval` returns results via stdout. For large results (100KB+), verify the output isn't truncated. If it is, use the two-step approach:

```bash
playwright-cli eval "window.__result = heavyComputation(), 'ok'"
playwright-cli eval "JSON.stringify(window.__result.field1)"
playwright-cli eval "JSON.stringify(window.__result.field2)"
```
