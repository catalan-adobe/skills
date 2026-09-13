# probe

Purpose: find out whether a headless browser can load the site and which browser
configuration works, so every later browser step starts from a known-good recipe.
Tier: low.

## Inputs

- `migration/project.json`: `origin` is the URL to probe.
- `migration/setup.json`: `playwrightCli.path`, `skills["browser-probe"].path`.

## Sibling skill

Read and follow `.agents/skills/browser-probe/SKILL.md` (or the path `setup.json` gives).
Use the `playwright-cli` binary from `setup.json`; add its directory to `PATH` when the
skill's script expects the command by name.

## Method

1. Run the probe script from the skill with the origin and `migration/probe/` as the
   output directory. It writes `probe-report.json` there.
2. Read `firstSuccess` and `detectedSignals`. When `firstSuccess` is null, no headless
   configuration loads the site: write `probe/probe.md` saying so, list the signals and the
   skill's options for the operator, and stop without writing a recipe.
3. Otherwise write the recipe exactly as the skill describes.
4. Also write `migration/probe/playwright-config.json`: the recipe's `cliConfig` with
   `browser.initScript` set to `["<absolute path>/migration/probe/stealth-init.js"]` when a
   stealth script was needed (copy the skill's script there). Later steps pass this file to
   `playwright-cli open --config`, and `--persistent` when the recipe says so.

## Outputs

- `migration/probe/browser-recipe.json`: the recipe (`url`, `generated`, `cliConfig`,
  `stealthInitScript`, `notes`, optional `persistent`).
- `migration/probe/probe.md`: working configuration, detected signals, what the escalation
  ladder tried, and the `playwright-cli open` flags that reproduce it.
- `migration/probe/probe-report.json`, `playwright-config.json`, `stealth-init.js` (when
  needed): supporting files.

## REPORT.md

Append a `## probe` section: the configuration that worked (or that none did), the
protection detected, and the flags `prep`, `prep-verify` and `cache` must use.

## Done

```bash
node <skill>/scripts/status.mjs check probe
```

If it fails, fix the artefact: the recipe must parse as JSON and `probe.md` must not be
empty. Do not edit the check.
