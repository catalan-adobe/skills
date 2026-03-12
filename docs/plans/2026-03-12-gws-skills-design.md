# GWS CLI Skills — Research & Design

**Date:** 2026-03-12
**Status:** Research complete, awaiting decision
**Branch:** `worktree-gws-skills`

## What is GWS CLI?

Google Workspace CLI (`gws`) is an open-source, Rust-built CLI released by the
`googleworkspace` GitHub org on March 5, 2026. It provides unified terminal
access to all Google Workspace APIs through a single binary.

- **Repo:** github.com/googleworkspace/cli
- **Install:** `npm i -g @googleworkspace/cli`
- **License:** Apache 2.0
- **Status:** Pre-v1.0, not officially supported by Google, breaking changes expected
- **Stars:** 19,300+ (hit #1 on Hacker News within 3 days)

### Core architecture

Unlike static CLIs, `gws` reads Google's Discovery Service at runtime and builds
its entire command surface dynamically. New API endpoints appear automatically
with no tool update. Schema cached for ~24 hours.

```
gws <service> <resource> <method> [flags]
gws drive files list --params '{"pageSize": 5}'
gws gmail +send --to user@example.com --subject "Hi" --body "Hello"
gws schema drive.files.list   # introspect request/response schema
```

All responses are structured JSON. Supports `--dry-run`, `--page-all`
(auto-pagination with NDJSON), and `--sanitize` (Model Armor prompt injection
detection).

### Services covered

Gmail, Drive, Calendar, Sheets, Docs, Slides, Chat, Admin, Meet, Tasks, Forms,
Keep, Classroom, People, Cloud Identity, Alert Center.

### Authentication

Four credential sources (tried in order):

1. Interactive OAuth — `gws auth setup` (requires gcloud) or `gws auth login`
2. Manual OAuth — desktop app credentials at `~/.config/gws/client_secret.json`
3. Service Account — `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` env var
4. Access Token / ADC — `GOOGLE_WORKSPACE_CLI_TOKEN` env var or ADC

Credentials encrypted at rest with AES-256-GCM, stored in OS keyring (macOS
Keychain, Windows Credential Manager). Migrated from file-based in v0.9.1.

**Key constraint:** Unverified Cloud OAuth apps limited to ~25 scopes; the
recommended preset includes 85+, requiring verified app status.

### MCP — added then removed

MCP server (`gws mcp`) launched with the tool but was removed in v0.8.0 (March
7). Root cause: 200-400 tools across all APIs flooded the context window
(40k-100k tokens). A compact mode was attempted but proved insufficient. The
project now uses "CLI-as-agent-runtime" — agents call `gws` via shell execution.

A community fork (`kustomzone/gws-cli`) maintains MCP support.

## What GWS already ships for agents

### Three-tier skill system

| Layer | Count | Purpose |
|-------|-------|---------|
| Raw API skills | ~16 | One per service (`gws-drive`, `gws-gmail`, etc.) |
| Workflow recipes | 50+ | Cross-service automation (standup, meeting-prep, email-to-task) |
| Role personas | 10 | Executive Assistant, IT Admin, PM, Sales, etc. |

Install: `npx skills add https://github.com/googleworkspace/cli`

All skills follow the same SKILL.md pattern this repo uses, with a shared
`gws-shared` skill for auth and global flags.

### What the upstream skills cover well

- Teaching Claude correct API usage per service
- Common single-service workflows (send email, create doc, list files)
- Simple cross-service recipes (standup = meetings + tasks)
- Role-based bundles for non-developer personas

## Known pain points

### Authentication (biggest friction area)

| Issue | Problem |
|-------|---------|
| #220 | 401 "No Credentials" on Windows after successful login |
| #119 | Personal @gmail.com accounts can't use recommended scopes |
| #151 | 401 "Failed to parse credentials" on macOS |
| #168 | `--readonly` scopes not enforced on exported credentials |

Workarounds: `GOOGLE_WORKSPACE_CLI_TOKEN=$(gcloud auth print-access-token)` or
`GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/path/to/file`.

### Open feature gaps (47 open issues as of March 12)

- Shell completions (bash, zsh, fish) missing
- HTTP proxy support missing
- Non-ASCII Gmail headers produce mojibake
- No `gws auth status` command
- No draft-only mode for Gmail (agent review flows)
- No markdown formatting in doc-writing helpers
- No video conferencing support in Calendar event creation

### Stability concerns

- 10+ releases in 6 days (v0.6.0 through v0.11.1)
- MCP added and removed within the same week
- Multi-account/impersonation removed in v0.7.0
- Pre-v1.0 — more breaking changes expected

## Skill gap analysis — what's NOT covered

The upstream skills cover individual APIs and simple recipes. Missing:

### Developer-workflow skills (our opportunity)

| Skill | What it would do | Dependencies |
|-------|------------------|--------------|
| `gws-setup` | Walk through OAuth setup, API enablement, credential config | `gws` only |
| `gws-sprint-report` | GitHub Issues -> Sheets -> Docs summary -> Chat/Gmail | `gws` + `gh` |
| `gws-pr-doc` | GitHub PR -> Google Doc design note + Sheets tracker | `gws` + `gh` |
| `gws-incident-log` | Incident timeline -> Docs template -> Calendar postmortem | `gws` only |
| `gws-onboard` | Create Drive folder, copy templates, Calendar, welcome email | `gws` only |

### Cross-tool integration

- GitHub + Google Workspace pipelines (PR -> Doc, Issues -> Sheets)
- Sheets as lightweight agent state storage (read/write structured data)
- Export/archive pipelines (Drive folder -> CSV -> email report)

## Recommendation

### Build now (low risk)

**`gws-setup`** — Auth setup is the #1 blocker and the mechanics are unlikely to
change fundamentally. High value, low maintenance burden.

### Build when stable (medium risk)

**`gws-sprint-report`**, **`gws-pr-doc`** — valuable developer workflows but
depend on specific `gws` command syntax that may change pre-v1.0.

### Wait for v1.0 (high risk)

**`gws-incident-log`**, **`gws-onboard`** — destructive/side-effectful workflows
that need `disable-model-invocation: true` and stable API guarantees.

## Research sources

- github.com/googleworkspace/cli (README, releases, issues)
- npmjs.com/package/@googleworkspace/cli
- betterstack.com/community/guides/ai/cli-gws-ai-agents/
- venturebeat.com/orchestration/google-workspace-cli-brings-gmail-docs-sheets...
- dev.to/gys/not-everything-needs-mcp-...
- dev.to/manikandan/google-workspace-cli-is-here-...
- heise.de/en/news/Control-Gmail-Docs-and-Calendar-via-Terminal-Google-...
- grizzlypeaksoftware.com/articles/p/gws-googles-new-cli-...
- digitalapplied.com/blog/google-workspace-cli-gws-ai-agent-automation-guide

Full research artifacts in `/tmp/research_20260312_gws_*.md` (session-only).
