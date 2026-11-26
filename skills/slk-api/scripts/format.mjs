const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">" };
// Whole CSI (colors, cursor) and OSC (window title) sequences, so no "[31m" residue stays visible.
const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
// C0 and C1 control characters, except tab and newline which cleanText collapses anyway.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Removes control characters so Slack text cannot move the cursor, recolor or retitle the terminal. */
export const stripControl = (text) =>
  String(text).replace(ANSI_SEQUENCE, "").replace(CONTROL_CHARS, "");

/** Turn Slack message markup into plain text. `names` maps user IDs to display names. */
export function cleanText(text, names = new Map()) {
  return stripControl(text)
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => `@${names.get(id) ?? id}`)
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&(amp|lt|gt);/g, (m) => ENTITIES[m])
    .replace(/\s+/g, " ")
    .trim();
}

// Each element or block can carry its text as {text: "..."}, {text: {text: "..."}} or nothing.
// Controls such as buttons carry a label object, so only strings are ever returned.
const textOf = (node) => {
  const t = node?.text;
  if (typeof t === "string") return t;
  return typeof t?.text === "string" ? t.text : undefined;
};

const blockTexts = (blocks = []) =>
  blocks.flatMap((b) => [
    textOf(b),
    ...(b.fields ?? []).map(textOf),
    ...(b.type === "actions" ? [] : (b.elements ?? []).map(textOf)),
  ]);

/** Message text. Bot posts often leave `text` empty and put the content in attachments or blocks. */
export function messageBody(m) {
  if (m.text) return m.text;
  const fromAttachments = (m.attachments ?? [])
    .map((a) => a.fallback || a.text || a.title || blockTexts(a.blocks).filter(Boolean).join(" | "))
    .filter(Boolean);
  const parts = fromAttachments.length > 0 ? fromAttachments : [blockTexts(m.blocks).filter(Boolean).join(" | ")];
  return parts.filter(Boolean).join(" | ");
}

export function userIds(text) {
  return [...text.matchAll(/<@([UW][A-Z0-9]+)/g)].map((m) => m[1]);
}

export const formatTime = (ts) =>
  new Date(Number(ts) * 1000).toISOString().slice(0, 16).replace("T", " ");
