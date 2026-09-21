# setup

Purpose: make sure everything the other steps need exists, installing what is missing in
project scope only. Tier: low. Runs first, always. Nothing is fetched from the site.

## Inputs

- `migration/project.json` (from `status.mjs init --origin <url>`).

## Sibling skill

None. The runner does the detection and the installs.

## Method

1. Run `node <skill>/scripts/status.mjs setup --install` from the project root.
   It looks for Node >= 22, `playwright-cli`, the `franklin-bulk-shared` package and the
   skills `browser-probe`, `page-prep`, `site-scan`, `page-cache`, `page-tree`. Missing
   pieces go to `migration/.work/` (npm `--prefix`) and `.agents/skills/` (`upskill`);
   never `-g`.
2. Read the output. `reasons` empty means every precondition is met.
3. If `reasons` says `install Node >= 22`, stop: the runner cannot install Node. Tell the
   operator and do not run any other step.
4. Run `node <skill>/scripts/status.mjs setup` again if anything was installed by hand.

## Outputs

- `migration/setup.json`: the resolved paths: `playwrightCli.path`,
  `packages["franklin-bulk-shared"].path`, `skills.<name>.path`, and `skills.<name>.source`
  (the repo and ref `setup` installed it from; `null` when it was already there). Every
  later brief reads the binary and skill locations from here instead of guessing.

## REPORT.md

`status.mjs setup` writes the `## setup` section itself (what was present, what was
installed, what is missing). Add to it only what the runner cannot know: the harness mode
you chose and the model each tier will run on — or that the harness cannot switch models.

## Done

```bash
node <skill>/scripts/status.mjs check setup
```

The check re-runs the detection; it never trusts `setup.json` for what is present. It fails
on a sibling installed from another source than `project.json` names (the reason says
what to remove and rerun); siblings of unknown source are a note, not a failure.
