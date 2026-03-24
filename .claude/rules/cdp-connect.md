# cdp-connect Skill

## Architecture

- Zero-dep CDP client using Node 22 built-in WebSocket + fetch
- `cdp.js` script with 10 commands: list, navigate, eval, screenshot, ax-tree, dom, click, type, console, network
- Fire-and-forget pattern — each command opens/closes its own WebSocket
- Target selection by unique ID from `/json` endpoint (not URL/title — duplicates possible)
- `ax-tree` is the primary page understanding method (not DOM)
- Screenshots: save to `/tmp/`, then Read tool can view them
