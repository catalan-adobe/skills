# domain-mask Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a skill that masks a URL behind a custom domain for screencasts and demos, with trusted HTTPS and automatic cleanup.

**Architecture:** Single SKILL.md orchestration prompt + one Node.js script (`domain-mask.mjs`) that handles the full lifecycle: dep check, hosts entry, mkcert cert, HTTPS proxy, SIGINT cleanup.

**Tech Stack:** Node.js 22+ built-ins only, mkcert for trusted certs.

---

### Task 1: Create the proxy script

**Files:**
- Create: `skills/domain-mask/scripts/domain-mask.mjs`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p skills/domain-mask/scripts
```

- [ ] **Step 2: Write domain-mask.mjs**

```javascript
#!/usr/bin/env node
"use strict";

import { createServer as createHttpsServer } from "node:https";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const [displayDomain, targetUrl] = process.argv.slice(2);

if (!displayDomain || !targetUrl) {
  console.error(
    "Usage: domain-mask.mjs <display-domain> <target-url>\n" +
      "Example: domain-mask.mjs wknd.adventures https://gabrielwalt.github.io",
  );
  process.exit(1);
}

const HOSTS_FILE = "/etc/hosts";
const PORT = 443;
const HOSTS_ENTRY = `127.0.0.1 ${displayDomain}`;

// --- Dependency check ---

try {
  execSync("which mkcert", { stdio: "ignore" });
} catch {
  console.error(
    "Error: mkcert is not installed.\n" +
      "Install it with: brew install mkcert && mkcert -install",
  );
  process.exit(1);
}

// --- Parse target ---

const target = new URL(targetUrl);
const doRequest = target.protocol === "https:" ? httpsRequest : httpRequest;

// --- Hosts entry ---

function addHostsEntry() {
  const hosts = readFileSync(HOSTS_FILE, "utf8");
  if (hosts.includes(HOSTS_ENTRY)) {
    console.log(`Hosts entry already exists: ${HOSTS_ENTRY}`);
    return;
  }
  writeFileSync(HOSTS_FILE, hosts.trimEnd() + "\n" + HOSTS_ENTRY + "\n");
  console.log(`Added to ${HOSTS_FILE}: ${HOSTS_ENTRY}`);
}

function removeHostsEntry() {
  try {
    const hosts = readFileSync(HOSTS_FILE, "utf8");
    const filtered = hosts
      .split("\n")
      .filter((line) => line.trim() !== HOSTS_ENTRY)
      .join("\n");
    writeFileSync(HOSTS_FILE, filtered);
    console.log(`Removed from ${HOSTS_FILE}: ${HOSTS_ENTRY}`);
  } catch (err) {
    console.error(`Warning: could not clean ${HOSTS_FILE}: ${err.message}`);
  }
}

// --- Certificate ---

const tmpDir = mkdtempSync(join(tmpdir(), "domain-mask-"));
const keyPath = join(tmpDir, "key.pem");
const certPath = join(tmpDir, "cert.pem");

execSync(`mkcert -key-file ${keyPath} -cert-file ${certPath} ${displayDomain}`);
console.log("Generated trusted certificate via mkcert");

// --- Proxy ---

function proxy(req, res) {
  const url = new URL(req.url, target.origin);
  const headers = { ...req.headers, host: target.host };
  delete headers["accept-encoding"];

  const proxyReq = doRequest(
    url,
    { method: req.method, headers },
    (proxyRes) => {
      const responseHeaders = { ...proxyRes.headers };
      if (responseHeaders.location) {
        responseHeaders.location = responseHeaders.location.replace(
          target.origin,
          `https://${displayDomain}`,
        );
      }
      delete responseHeaders["strict-transport-security"];
      res.writeHead(proxyRes.statusCode, responseHeaders);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (err) => {
    console.error(`Proxy error: ${err.message}`);
    res.writeHead(502);
    res.end("Bad Gateway");
  });

  req.pipe(proxyReq);
}

// --- Lifecycle ---

addHostsEntry();

const server = createHttpsServer(
  { key: readFileSync(keyPath), cert: readFileSync(certPath) },
  proxy,
);

function cleanup() {
  console.log("\nShutting down...");
  server.close();
  removeHostsEntry();
  try {
    rmSync(tmpDir, { recursive: true });
  } catch {
    // temp dir cleanup is best-effort
  }
  console.log("Done.");
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

server.listen(PORT, () => {
  console.log(`\nhttps://${displayDomain} -> ${target.origin}`);
  console.log("Press Ctrl+C to stop and clean up.\n");
});
```

- [ ] **Step 3: Make script executable**

```bash
chmod +x skills/domain-mask/scripts/domain-mask.mjs
```

- [ ] **Step 4: Verify script runs**

```bash
sudo node skills/domain-mask/scripts/domain-mask.mjs test.local https://example.com
```

Expected: prints "Generated trusted certificate via mkcert", "Added to /etc/hosts", starts listening on 443. Ctrl+C should print cleanup messages and remove the hosts entry.

Verify cleanup:
```bash
grep "test.local" /etc/hosts
```
Expected: no output (entry was removed).

- [ ] **Step 5: Commit**

```bash
git add skills/domain-mask/scripts/domain-mask.mjs
git commit -m "feat(domain-mask): add proxy script with hosts/cert lifecycle"
```

---

### Task 2: Create SKILL.md

**Files:**
- Create: `skills/domain-mask/SKILL.md`

- [ ] **Step 1: Write SKILL.md**

```markdown
---
name: domain-mask
description: >-
  Mask a URL behind a custom domain for screencasts and demos. Adds a trusted
  HTTPS reverse proxy so the browser shows a clean display domain with a green
  padlock while serving content from the real target URL. Handles /etc/hosts,
  mkcert certificates, and cleanup automatically. Triggers on: "domain mask",
  "mask domain", "mock domain", "proxy URL", "demo URL", "fake domain",
  "screencast proxy", "mask URL for demo", "domain-mask".
---

# domain-mask

Mask a URL behind a custom domain for screencasts and demos. Opens an
HTTPS reverse proxy so the browser address bar shows a clean domain
(e.g., `wknd.adventures`) while content is served from the real URL
(e.g., `https://main--mysite--org.aem.page`). Trusted certificate via
mkcert — no browser warnings.

## Prerequisites

- Node 22+
- mkcert (`brew install mkcert && mkcert -install`)
- sudo access (for port 443 and /etc/hosts)

## Script Location

```bash
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  DOMAIN_MASK="${CLAUDE_SKILL_DIR}/scripts/domain-mask.mjs"
else
  DOMAIN_MASK="$(find ~/.claude -path "*/domain-mask/scripts/domain-mask.mjs" \
    -type f 2>/dev/null | head -1)"
fi
if [[ -z "$DOMAIN_MASK" || ! -f "$DOMAIN_MASK" ]]; then
  echo "Error: domain-mask.mjs not found." >&2
fi
```

## Workflow

### Step 1: Gather inputs

Ask the user for two values (or extract from their message):

- **Display domain** — the domain to show in the browser (e.g., `wknd.adventures`)
- **Target URL** — the real URL to proxy (e.g., `https://gabrielwalt.github.io`)

### Step 2: Check prerequisites

```bash
which mkcert || echo "Install mkcert: brew install mkcert && mkcert -install"
```

If mkcert is missing, tell the user to install it and run `mkcert -install`
once to set up the local CA.

### Step 3: Start the proxy

```bash
sudo node "$DOMAIN_MASK" <display-domain> <target-url>
```

The script handles everything automatically:

1. Adds `127.0.0.1 <display-domain>` to `/etc/hosts`
2. Generates a trusted HTTPS certificate via mkcert
3. Starts an HTTPS reverse proxy on port 443
4. Prints the URL to open

Tell the user:
- Open `https://<display-domain>` in their browser
- The address bar will show the display domain with a green padlock
- Press **Ctrl+C** when done — the script removes the hosts entry and
  cleans up temp certs automatically

### Step 4: Confirm cleanup

After the user stops the proxy, verify cleanup succeeded by checking
the script output. If it reports a warning about /etc/hosts cleanup,
help the user remove the entry manually:

```bash
sudo sed -i '' '/<display-domain>/d' /etc/hosts
```

## What the proxy does

- Forwards all requests to the target origin with rewritten `Host` header
- Rewrites `Location` headers in redirects back to the display domain
- Strips `strict-transport-security` headers (prevents cert conflicts)
- Strips `accept-encoding` (avoids compressed responses)
- Returns 502 on proxy errors

## Limitations

- macOS only (`/etc/hosts` path, `brew install mkcert`)
- Requires sudo (privileged port 443 + hosts file)
- One display domain per invocation
- Does not rewrite URLs inside HTML/CSS/JS response bodies
```

- [ ] **Step 2: Commit**

```bash
git add skills/domain-mask/SKILL.md
git commit -m "feat(domain-mask): add SKILL.md orchestration prompt"
```

---

### Task 3: Register skill in plugin manifests and docs

**Files:**
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `.claude/CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Update plugin.json**

Add `domain-mask (mask URLs behind custom domains for demos)` to the `description` string.

Add keywords: `"domain-mask"`, `"proxy"`, `"demo-domain"`, `"screencast-url"`, `"mock-domain"` to the `keywords` array.

- [ ] **Step 2: Update marketplace.json**

Add `domain-mask` to both `description` fields (top-level and plugin entry), matching the pattern used for other skills.

- [ ] **Step 3: Update .claude/CLAUDE.md**

Add a row to the "Available Skills" table:

```
| `domain-mask` | Mask URLs behind custom domains for screencasts and demos |
```

- [ ] **Step 4: Update README.md**

Add a `### domain-mask` section under "Available Skills":

```markdown
### domain-mask

Mask a URL behind a custom domain for screencasts and demos. Runs a trusted
HTTPS reverse proxy so the browser shows a clean display domain with a green
padlock. Handles `/etc/hosts`, mkcert certificates, and cleanup automatically.

**Dependencies:** Node 22+, mkcert, sudo
```

- [ ] **Step 5: Sync locally**

```bash
./scripts/sync-skills.sh
```

- [ ] **Step 6: Commit**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json \
  .claude/CLAUDE.md README.md
git commit -m "feat(domain-mask): register in manifests and docs"
```
