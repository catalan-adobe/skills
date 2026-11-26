const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">" };

/** Turn Slack message markup into plain text. `names` maps user IDs to display names. */
export function cleanText(text, names = new Map()) {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => `@${names.get(id) ?? id}`)
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&(amp|lt|gt);/g, (m) => ENTITIES[m])
    .replace(/\s+/g, " ")
    .trim();
}

/** Message text, falling back to attachment text for bot posts that have an empty `text`. */
export function messageBody(m) {
  if (m.text) return m.text;
  return (m.attachments ?? [])
    .map((a) => a.fallback || a.text || a.title)
    .filter(Boolean)
    .join(" | ");
}

export function userIds(text) {
  return [...text.matchAll(/<@([UW][A-Z0-9]+)/g)].map((m) => m[1]);
}

export const formatTime = (ts) =>
  new Date(Number(ts) * 1000).toISOString().slice(0, 16).replace("T", " ");
