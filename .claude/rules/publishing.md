# Publishing Skills

When skills change (new skill, modified SKILL.md, updated scripts/references), all artifacts must be updated together — not in separate passes.

## Pre-publish checklist

Run for every skill being published:

1. **Lint** — `tessl skill lint skills/<name>` must pass with zero warnings
   - Orphaned file warnings mean `references/` files use backtick code spans instead of markdown links: use `[label](references/FILE.md)` syntax
2. **Publish** — `tessl skill publish --bump patch skills/<name>`
   - New skills need `--workspace catalan-adobe --public` on first publish
   - Verify the publish succeeded (check for moderation pass)

## Post-publish sync

After all skills are published, update these in a single commit:

3. **Plugin manifests** — `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`
   - Description lists all skills with short purpose
   - Keywords cover all skills
4. **Skills table** — `.claude/CLAUDE.md` "Available Skills" table lists every skill
5. **Local sync** — `./scripts/sync-skills.sh`

## Detecting unpublished changes

Compare the last publish timestamp (`tessl tile info catalan-adobe/<name>` → Updated field) against `git log --oneline --after="<timestamp>" -- skills/<name>/`. Any commits after the publish date mean the skill needs republishing.

## When to run this checklist

- After merging PRs that touch `skills/`
- When asked to publish, release, or check publish status
- After batch changes (security fixes, refactors) that touch multiple skills
