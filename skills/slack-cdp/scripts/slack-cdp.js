#!/usr/bin/env node
'use strict';

// --- Constants ---
const API_BASE = 'https://app.slack.com/api';
const DEFAULT_PORT = 9222;
const DEFAULT_TIMEOUT = 8000;
const NAV_SETTLE_MS = 2000; // Time for channel content to load after navigation

// --- Arg parsing (follows cdp.js convention) ---
function parseArgs(argv) {
  const flags = { port: DEFAULT_PORT, channel: null, limit: null };
  const positional = [];
  const raw = argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    switch (raw[i]) {
      case '--port': flags.port = parseInt(raw[++i], 10); break;
      case '--channel': flags.channel = raw[++i]; break;
      case '--limit': flags.limit = parseInt(raw[++i], 10); break;
      default: positional.push(raw[i]);
    }
  }
  return { command: positional[0], args: positional.slice(1), ...flags };
}

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- CDP connection (Slack-specific target discovery) ---
async function findSlackTarget(port) {
  let res;
  try {
    res = await fetch(`http://localhost:${port}/json`);
  } catch {
    die(
      `Cannot connect to CDP on port ${port}.\n` +
      `Start Slack with: /Applications/Slack.app/Contents/MacOS/Slack --remote-debugging-port=${port}`
    );
  }
  const targets = await res.json();
  const slack = targets.find(
    (t) => t.type === 'page' && t.url?.includes('app.slack.com')
  );
  if (!slack) die('No Slack page target found. Is Slack running?');
  return slack;
}

async function connectSlack(port) {
  const target = await findSlackTarget(port);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('WebSocket connection failed'));
  });
  return ws;
}

let nextId = 0;
function send(ws, method, params = {}, timeout = DEFAULT_TIMEOUT) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timeout after ${timeout}ms: ${method}`));
    }, timeout);
    const handler = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id === id) {
        ws.removeEventListener('message', handler);
        clearTimeout(timer);
        if (msg.error) reject(new Error(`CDP ${method}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// --- Slack API via renderer eval ---
// Params are double-encoded to prevent code injection: JSON.stringify twice
// produces a JS string literal that the renderer JSON.parse's back safely.
async function slackEval(ws, apiMethod, params = {}) {
  const safeParams = JSON.stringify(JSON.stringify(params));
  const result = await send(ws, 'Runtime.evaluate', {
    expression: `(async () => {
      const cfg = JSON.parse(localStorage.localConfig_v2);
      const pathTeam = window.location.pathname.split('/')[2];
      const teamId = (pathTeam && cfg.teams[pathTeam]) ? pathTeam : cfg.lastActiveTeamId;
      const tk = cfg.teams[teamId].token;
      const p = JSON.parse(${safeParams});
      const body = new URLSearchParams(Object.assign({ token: tk }, p));
      const resp = await fetch('${API_BASE}/${apiMethod}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        credentials: 'include'
      });
      return JSON.stringify(await resp.json());
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    die(`API error (${apiMethod}): ${result.exceptionDetails.text}`);
  }
  return JSON.parse(result.result?.value || '{"ok":false,"error":"empty"}');
}

// --- DOM eval helper ---
async function domEval(ws, expression) {
  const result = await send(ws, 'Runtime.evaluate', {
    expression: `(() => { ${expression} })()`,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    die(`Eval error: ${result.exceptionDetails.text}`);
  }
  return result.result?.value;
}

// --- Key input helpers ---
async function sendKey(ws, key, code, vk, modifiers = 0) {
  await send(ws, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key, code,
    windowsVirtualKeyCode: vk, modifiers,
  });
  await send(ws, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key, code,
    windowsVirtualKeyCode: vk, modifiers,
  });
}

async function insertText(ws, text) {
  await send(ws, 'Input.insertText', { text });
}

// --- Helpers ---
async function getCurrentChannel(ws) {
  const path = await domEval(ws, `return window.location.pathname;`);
  const parts = path.split('/');
  const candidate = parts[3] || '';
  if (/^[CDG][A-Z0-9]+$/.test(candidate)) return candidate;
  die('Not in a channel view. Navigate to a channel first, or use --channel <id>.');
}

// --- Commands ---

async function cmdConnect(port) {
  const ws = await connectSlack(port);
  const auth = await slackEval(ws, 'auth.test');
  ws.close();
  if (!auth.ok) die(`Auth failed: ${auth.error}`);
  console.log(`Connected to: Slack (${auth.team})`);
  console.log(`User: ${auth.user} — ${auth.user_id}`);
  console.log(`Team: ${auth.team} — ${auth.team_id}`);
  console.log(`Enterprise: ${auth.is_enterprise_install ? 'yes' : 'no'}`);
}

async function cmdWhoami(port) {
  const ws = await connectSlack(port);
  const auth = await slackEval(ws, 'auth.test');
  if (!auth.ok) { ws.close(); die(`Auth failed: ${auth.error}`); }
  const user = await slackEval(ws, 'users.info', { user: auth.user_id });
  ws.close();
  const u = user.user;
  const status = u.profile?.status_emoji
    ? `${u.profile.status_emoji} ${u.profile.status_text || ''}`
    : '(none)';
  console.log(`User: ${u.real_name} (@${u.name}) — ${u.id}`);
  console.log(`Team: ${auth.team} — ${auth.team_id}`);
  console.log(`Enterprise: ${auth.is_enterprise_install ? 'yes' : 'no'}`);
  console.log(`Status: ${status}`);
}

async function cmdWhere(port) {
  const ws = await connectSlack(port);
  const info = await domEval(ws, `
    const path = window.location.pathname;
    const parts = path.split('/');
    const tab = document.querySelector('[role=tab][aria-selected=true]');
    return JSON.stringify({
      title: document.title.replace(/ - Slack$/, ''),
      channel: parts[3] || null,
      tab: tab ? tab.textContent.trim() : null,
      path: path,
    });
  `);
  ws.close();
  const d = JSON.parse(info);
  console.log(`Title: ${d.title}`);
  if (d.channel) console.log(`Channel: ${d.channel}`);
  if (d.tab) console.log(`Tab: ${d.tab} (selected)`);
  console.log(`URL: ${d.path}`);
}

async function cmdNavigate(query, port) {
  if (!query) die('Usage: slack-cdp.js navigate <query>');
  const ws = await connectSlack(port);
  try {
    await sendKey(ws, 'k', 'KeyK', 75, 4);
    await wait(600);    // Wait for quick-switcher to open
    await insertText(ws, query);
    await wait(1500);   // Wait for search results to populate
    await sendKey(ws, 'Enter', 'Enter', 13);
    await wait(NAV_SETTLE_MS);
    const title = await domEval(ws, `return document.title.replace(/ - Slack$/, '');`);
    console.log(`Navigated to: ${title}`);
  } finally {
    ws.close();
  }
}

async function cmdSearch(query, limit, port) {
  if (!query) die('Usage: slack-cdp.js search <query>');
  const ws = await connectSlack(port);
  const data = await slackEval(ws, 'search.messages', {
    query, count: String(limit || 5),
  });
  ws.close();
  if (!data.ok) die(`Search failed: ${data.error}`);
  const total = data.messages?.total || 0;
  const matches = data.messages?.matches || [];
  console.log(`Search: "${query}" — ${total} results (showing ${matches.length})`);
  console.log('');
  for (const m of matches) {
    const chan = m.channel?.name ? `#${m.channel.name}` : m.channel?.id || '?';
    const user = m.username || m.user || '?';
    const date = m.ts
      ? new Date(parseFloat(m.ts) * 1000).toISOString().slice(0, 10)
      : '?';
    const text = (m.text || '').replace(/\n/g, ' ').slice(0, 120);
    console.log(`  [${chan}] @${user} (${date}): ${text}`);
  }
}

async function cmdRead(channelFlag, limit, port) {
  const ws = await connectSlack(port);
  const channel = channelFlag || await getCurrentChannel(ws);
  const data = await slackEval(ws, 'conversations.history', {
    channel, limit: String(limit || 10),
  });
  ws.close();
  if (!data.ok) {
    if (data.error === 'enterprise_is_restricted') {
      die('conversations.history is restricted. Use search or navigate to the channel.');
    }
    die(`Read failed: ${data.error}`);
  }
  const msgs = (data.messages || []).reverse();
  console.log(`${channel} — ${msgs.length} messages`);
  console.log('');
  for (const m of msgs) {
    const ts = m.ts
      ? new Date(parseFloat(m.ts) * 1000).toLocaleString()
      : '?';
    const user = m.user || m.username || m.bot_id || '?';
    const text = (m.text || '').replace(/\n/g, ' ').slice(0, 200);
    console.log(`  [${ts}] ${user}: ${text}`);
  }
}

async function cmdSend(channelArg, message, port) {
  if (!message) die('Usage: slack-cdp.js send <channel|current> <message>');
  const ws = await connectSlack(port);
  const channel = channelArg === 'current'
    ? await getCurrentChannel(ws)
    : channelArg;
  const data = await slackEval(ws, 'chat.postMessage', {
    channel, text: message,
  });
  ws.close();
  if (!data.ok) die(`Send failed: ${data.error}`);
  console.log(`Sent to ${data.channel} (ts: ${data.ts})`);
}

async function cmdUnread(port) {
  const ws = await connectSlack(port);
  const data = await slackEval(ws, 'client.counts');
  if (data.ok && data.channels) {
    ws.close();
    const unread = data.channels
      .filter((c) => c.has_unreads || c.mention_count > 0)
      .sort((a, b) => (b.mention_count || 0) - (a.mention_count || 0));
    if (unread.length === 0) { console.log('No unread channels.'); return; }
    console.log('Unread channels:');
    for (const c of unread) {
      const count = c.mention_count || 'new';
      console.log(`  ${c.name || c.id} (${count})`);
    }
    return;
  }
  // Fallback: read sidebar DOM (returns display names, not channel IDs)
  if (!data.ok) {
    console.error(`Warning: client.counts failed (${data.error}), falling back to sidebar DOM`);
  }
  const sidebarText = await domEval(ws, `
    const items = [...document.querySelectorAll('.p-channel_sidebar__channel--unread')];
    return JSON.stringify(items.map(el => el.textContent.trim().substring(0, 60)));
  `);
  ws.close();
  const items = JSON.parse(sidebarText || '[]');
  if (items.length === 0) { console.log('No unread channels.'); return; }
  console.log('Unread channels:');
  for (const item of items) console.log(`  ${item}`);
}

async function cmdStatus(statusArg, port) {
  const ws = await connectSlack(port);
  if (!statusArg) {
    const auth = await slackEval(ws, 'auth.test');
    const user = await slackEval(ws, 'users.info', { user: auth.user_id });
    ws.close();
    const p = user.user?.profile;
    if (p?.status_emoji || p?.status_text) {
      console.log(`Status: ${p.status_emoji || ''} ${p.status_text || ''}`.trim());
      if (p.status_expiration) {
        const exp = new Date(p.status_expiration * 1000).toLocaleString();
        console.log(`Expires: ${exp}`);
      }
    } else {
      console.log('Status: (none)');
    }
    return;
  }
  const emojiMatch = statusArg.match(/^(:[\w+-]+:)\s*(.*)/);
  const emoji = emojiMatch ? emojiMatch[1] : '';
  const text = emojiMatch ? emojiMatch[2] : statusArg;
  const data = await slackEval(ws, 'users.profile.set', {
    profile: JSON.stringify({
      status_text: text,
      status_emoji: emoji,
    }),
  });
  ws.close();
  if (!data.ok) die(`Status update failed: ${data.error}`);
  console.log(`Status set: ${emoji} ${text}`.trim());
}

// --- Main ---
async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.command) {
    console.error([
      'Usage: slack-cdp.js <command> [args] [--port N]',
      '',
      'Commands:',
      '  connect                 Verify connection and auth',
      '  navigate <query>        Switch channel/DM via Cmd+K',
      '  read [--channel ID]     Read recent messages',
      '  send <channel> <msg>    Send a message',
      '  search <query>          Search messages',
      '  whoami                  Current user info',
      '  unread                  List unread channels',
      '  status [":emoji: text"] Get or set status',
      '  where                   Current view info',
    ].join('\n'));
    process.exit(0);
  }

  const cmds = {
    connect: () => cmdConnect(opts.port),
    whoami: () => cmdWhoami(opts.port),
    where: () => cmdWhere(opts.port),
    navigate: () => cmdNavigate(opts.args[0], opts.port),
    search: () => cmdSearch(opts.args[0], opts.limit, opts.port),
    read: () => cmdRead(opts.channel, opts.limit, opts.port),
    send: () => cmdSend(opts.args[0], opts.args.slice(1).join(' '), opts.port),
    unread: () => cmdUnread(opts.port),
    status: () => cmdStatus(opts.args.join(' ') || null, opts.port),
  };

  const fn = cmds[opts.command];
  if (!fn) die(`Unknown command: ${opts.command}`);
  await fn();
}

main().catch((err) => die(err.message));
