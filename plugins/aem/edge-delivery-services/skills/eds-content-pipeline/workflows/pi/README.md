---
metadata:
  version: "0.1.0"
---

# The pi executor

An LLM-driven alternative to `scripts/lib/stage.mjs run --skip-llm` (the deterministic,
no-LLM runner). `workflows/pi/stage.mjs` runs one stage's `llm:` units for
real, through small/medium/big pi subagents, instead of skipping them.

## Files

- `stage.mjs` — plans one stage, runs every unit (`run:` and `llm:`) through an agent,
  gates each on its `done_when`, reworks a failed `review`, records the run. A pi
  dynamic-workflow script: no imports, no filesystem, no shell, no clock.
- `templates.mjs` — fans the `template` stage out over several templates in parallel,
  each as a call to the saved `eds-stage` workflow.
- `model-tiers.json` — the same `low`/`medium`/`high` → `small`/`medium`/`big` map that
  is inlined in `stage.mjs` (`TIERS`), plus the validation probe to run first.
- `tools/retro.mjs`, `tools/watch-run.mjs` — ordinary Node scripts (not pi workflows)
  that read pi's own run journals to build retros and watch a running workflow. See
  `SKILL.md`'s runner table.

## Save `stage.mjs` as the `eds-stage` workflow

`templates.mjs` calls `workflow('eds-stage', ...)`, which only resolves a workflow
already saved under that name. One-time setup:

1. Run the `workflow` tool once with `script` set to the contents of `stage.mjs` and
   any `args` (e.g. a `discover` run against a small fixture repo — see the probe
   below).
2. In pi, run `/workflows save eds-stage` (add the run id if it is not the latest run).
3. From then on, `workflow('eds-stage', { stage, params, skill, repo })` and the
   `workflow` tool with `name: 'eds-stage'` both work.

## Running a stage

Call the `workflow` tool with `script` set to `stage.mjs`'s contents (or `name:
'eds-stage'` once saved) and:

```json
{ "stage": "template", "params": { "template": "product" },
  "skill": "/abs/path/to/.agents/skills/eds-content-pipeline",
  "repo": "/abs/path/to/eds-repo" }
```

`stage` is `discover`, `template` or `bulk`; `params` matches the stage's `params` list
in `stages/<stage>.yaml` (e.g. `template` for `template` and `bulk`, none for
`discover`). `skill` and `repo` are absolute paths on the machine the agents run on.

The result is `{ stage, params, units: [{ id, verdict }], stopped: null | id }`.
`stopped` names the first unit whose `done_when` failed after one retry (and, for
`review`, after exhausting its rework rounds); `null` means every unit reached `done`.

## Running many templates

Call the `workflow` tool with `templates.mjs` (or `name: 'eds-templates'` once saved)
and `{ templates: ['product', 'page'], skill, repo }`. Pass `concurrency: 2` as a
workflow-tool option (not a script argument) to bound how many templates run at once;
`parallel()` inside the script has no concurrency option of its own:

```json
{ "name": "eds-templates", "concurrency": 2,
  "args": { "templates": ["product", "page"], "skill": "/abs/skill", "repo": "/abs/repo" } }
```

## The 30-second probe before a long run

Before spending agent time on a real stage, validate the stage specs and confirm the
runner still agrees with `stage.mjs run --skip-llm` on a small fixture repo:

```bash
node <skill>/scripts/lib/stage.mjs validate
```

(this is `model-tiers.json`'s `probe`). Then run `workflow` with `{ stage: 'discover',
skill, repo }` against a throwaway fixture repo and check the units it reports against
a `stage.mjs run discover --skip-llm` on the same repo before trusting a real run.
