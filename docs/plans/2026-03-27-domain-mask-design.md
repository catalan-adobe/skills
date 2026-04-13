# domain-mask Skill Design

**Date:** 2026-03-27
**Status:** Draft

## Overview

A Claude Code skill that masks a URL behind a custom domain for screencasts and demos. The browser address bar shows the display domain while content is served from the real target URL, with a trusted HTTPS certificate so there are no browser warnings.

## Problem

When recording screencasts or giving demos, the actual URL is often ugly or distracting (e.g., `https://main--mysite--org.aem.page/`). You want the audience to see a clean production-like URL (e.g., `https://wknd.adventures/`) without deploying anything.

## Solution

Single skill with a bundled Node.js script that handles the full lifecycle:

1. Verify mkcert is installed (fail fast with install instructions if not)
2. Add display domain to `/etc/hosts` pointing to `127.0.0.1`
3. Generate a trusted HTTPS certificate via mkcert
4. Start an HTTPS reverse proxy on port 443
5. On Ctrl+C: remove hosts entry, delete temp certs, exit cleanly

## Skill Structure

```
skills/domain-mask/
├── SKILL.md
└── scripts/
    └── domain-mask.mjs
```

No `references/` directory needed — the skill is simple enough for a single SKILL.md.

## SKILL.md Behavior

1. Extract display domain and target URL from user message, or ask if not provided
2. Locate script via `CLAUDE_SKILL_DIR` with fallback search
3. Run: `sudo node domain-mask.mjs <display-domain> <target-url>`
4. Tell the user to open `https://<display-domain>` and Ctrl+C when done

## Script Design

### CLI Interface

```
domain-mask.mjs <display-domain> <target-url>
```

- **display-domain**: The domain shown in the browser (e.g., `wknd.adventures`)
- **target-url**: The real URL to proxy to (e.g., `https://gabrielwalt.github.io`)
- Always HTTPS on port 443 (no HTTP mode, no port option)
- Requires `sudo` for port 443 and `/etc/hosts` modification

### Startup Sequence

1. Validate arguments (two required, exit with usage if missing)
2. Check `mkcert` is on PATH; if not, print `brew install mkcert && mkcert -install` and exit 1
3. Generate cert: `mkcert -key-file <tmp>/key.pem -cert-file <tmp>/cert.pem <display-domain>`
4. Append `127.0.0.1 <display-domain>` to `/etc/hosts` (skip if entry already exists)
5. Start HTTPS server on port 443 with the generated cert
6. Print: `https://<display-domain> -> <target-url>` and `Press Ctrl+C to stop`

### Proxy Behavior

- Forward all requests to target origin, rewriting the `Host` header
- Strip `accept-encoding` to avoid compressed responses the proxy can't rewrite
- Rewrite `Location` headers in redirects from target origin back to display domain
- Strip `strict-transport-security` headers
- Return 502 on proxy errors

### Shutdown (SIGINT Handler)

1. Remove the `<display-domain>` line from `/etc/hosts`
2. Delete temp cert directory
3. Print cleanup confirmation
4. Exit 0

### Dependencies

- Node.js built-ins only (`node:http`, `node:https`, `node:fs`, `node:child_process`, `node:os`, `node:path`)
- External: `mkcert` (checked at startup, not auto-installed)

## Trigger Phrases

`"domain mask"`, `"mask domain"`, `"mock domain"`, `"proxy URL"`, `"demo URL"`, `"fake domain"`, `"screencast proxy"`, `"url-proxy"`, `"mask URL for demo"`

## Limitations

- macOS only (uses `/etc/hosts` and `brew install mkcert`)
- Requires sudo (privileged port + hosts file)
- Single display domain per invocation
- Does not rewrite URLs inside HTML/CSS/JS response bodies — only `Location` headers
