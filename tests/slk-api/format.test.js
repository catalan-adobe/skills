import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanText, formatTime, messageBody, userIds } from "../../skills/slk-api/scripts/format.mjs";

describe("cleanText", () => {
  it("resolves user mentions, falling back to the ID", () => {
    const names = new Map([["U1", "ana"]]);
    assert.equal(cleanText("hi <@U1> and <@U2>", names), "hi @ana and @U2");
  });

  it("unwraps links and channel references", () => {
    assert.equal(
      cleanText("<https://a.dev|docs> <https://b.dev> <#C1|general>"),
      "docs (https://a.dev) https://b.dev #general",
    );
  });

  it("decodes HTML entities and collapses whitespace", () => {
    assert.equal(cleanText("a &amp; b\n\n &lt;c&gt;"), "a & b <c>");
  });
});

describe("messageBody", () => {
  it("prefers text", () => assert.equal(messageBody({ text: "x", attachments: [{ text: "y" }] }), "x"));

  it("falls back to attachments for bot posts", () => {
    const m = { text: "", attachments: [{ fallback: "build failed" }, { title: "log" }] };
    assert.equal(messageBody(m), "build failed | log");
  });

  it("returns an empty string when there is nothing", () => assert.equal(messageBody({ text: "" }), ""));
});

describe("userIds and formatTime", () => {
  it("finds mentioned users", () => assert.deepEqual(userIds("<@U1> <@W2|x>"), ["U1", "W2"]));
  it("formats a Slack ts as UTC", () => assert.equal(formatTime("1795615289.030329"), "2026-11-25 14:01"));
});
