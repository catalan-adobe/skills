# Output Format Templates

## Step 3: Present Candidates

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

## Step 5: Triage Summary

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
