---
name: memory-triage
description: Review Claude Code auto memory accumulated during a task and promote valuable findings to shared project config (CLAUDE.md, .claude/rules/, or global CLAUDE.md). Use this skill when finishing a branch, completing a task, wrapping up work, or anytime you want to review what Claude learned and decide what the team should know. Also use when the Stop hook reminds you about pending memory entries. Triggers on "triage memory", "review memory", "promote memory", "memory triage", "what did we learn", "clean up memory", "share learnings", "anything worth keeping", or when the user asks about knowledge accumulated during a session.
---

# Memory Triage

Review auto memory from the current project and promote valuable entries
to shared configuration files.

Claude Code auto memory is personal and machine-local. Debugging gotchas,
architecture decisions, and project conventions discovered during a task
stay invisible to teammates unless explicitly promoted to shared config.
This skill bridges that gap by reviewing what accumulated and helping you
decide what's worth sharing.

## Step 1: Discover Memory

Find the auto memory directory for the current project. Use the `/memory`
slash command output or resolve it directly:

1. Get the project root: `git rev-parse --show-toplevel` (or use cwd if
   not in a git repo)
2. Encode the path: strip leading `/`, replace remaining `/` with `-`,
   prepend `-`
3. Memory lives at: `~/.claude/projects/<encoded-path>/memory/`

Read `MEMORY.md` and every other `.md` file in that directory.

If the directory doesn't exist or contains no `.md` files with content:
> "No auto memory found for this project. Nothing to triage."

Stop here.

## Step 2: Classify Entries

Parse each file into distinct entries using markdown headers (`#`, `##`,
`###`) and top-level bullet groups as boundaries.

Classify each entry as either a **promote candidate** or **ephemeral**.
The core question: would a different developer benefit from knowing this?

**Promote candidate** — project knowledge worth sharing:
- Debugging findings and root causes
- Architecture decisions and rationale
- Build/CI/deploy gotchas and workarounds
- API quirks, schema details, data format notes
- Testing conventions and patterns
- Performance findings
- Integration details with external systems

**Ephemeral** — task-specific state that won't help others:
- In-progress status ("currently working on X")
- Intermediate debugging steps that led nowhere
- File paths specific to one developer's machine
- Session-specific context ("last time we discussed...")
- Temporary workarounds already resolved
- Personal workflow preferences (editor settings, port numbers)

When uncertain, classify as promote candidate. A false positive costs the
user one "discard" decision. A false negative buries useful knowledge.

## Step 3: Present Candidates

Show promote candidates grouped by theme:

```
## Memory Triage

### Worth promoting (N entries)

**[Theme: Debugging]**

> [The actual entry text from memory]

Rationale: Documents root cause of X — saves future debugging time.

---

**[Theme: Build/CI]**

> [The actual entry text from memory]

Rationale: Non-obvious CI behavior that caused a 2-hour investigation.

---

### Filtered as ephemeral (M entries)

These looked task-specific. Say "show filtered" to review them.
```

If there are no promote candidates:
> "All N entries look task-specific. Nothing to promote. Say 'show filtered'
> if you want to review them anyway."

## Step 4: Triage Decisions

For each promote candidate, ask: **promote or discard?**

When promoting, ask where it should go:
- **Project CLAUDE.md** — `./CLAUDE.md` or `./.claude/CLAUDE.md`
  (whichever exists; prefer `.claude/CLAUDE.md` if neither exists)
- **Rules file** — `.claude/rules/<topic>.md` (suggest a topic name
  based on the entry's theme, e.g., `debugging.md`, `ci.md`)
- **Global CLAUDE.md** — `~/.claude/CLAUDE.md` (for rules that apply
  across all projects on this machine)

Support batch decisions: if the user says "promote all debugging entries
to rules/debugging.md", do it in one pass.

If the user asks to "show filtered", present the ephemeral entries with
the same promote/discard options.

## Step 5: Apply

For each promoted entry:

1. Read the target file if it exists.
2. Find an appropriate section to append the entry (match by existing
   header if one fits, otherwise append under a relevant new header).
3. Write the entry using the Edit tool (append) or Write tool (new file).
4. Do NOT modify or delete the source memory files.

Report a summary when done:

```
## Triage Complete

- Promoted: 3 entries
  - ./CLAUDE.md: 1 entry (debugging gotcha)
  - .claude/rules/ci.md: 1 entry (CI workaround) [new file]
  - ~/.claude/CLAUDE.md: 1 entry (global preference)
- Discarded: 5 entries
- Unchanged: memory files left as-is

Remember to review and commit the changes to share them with your team.
```

## Important Notes

- **Read-only on memory files.** Never modify or delete auto memory. Those
  files are managed by Claude Code and get cleaned up with worktree
  removal or project pruning.
- **No automatic commits.** The user decides when and how to commit. The
  skill only writes to target config files.
- **Works anywhere.** No worktree requirement. Triages whatever auto
  memory exists for the current project context.
- **Hook-triggered invocations.** This skill may be invoked automatically
  by a Stop hook after PR creation or branch completion. When that
  happens, proceed normally — the user is still in control of every
  promote/discard decision.
