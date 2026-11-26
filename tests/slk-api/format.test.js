import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanText, formatTime, messageBody, stripControl, userIds } from "../../skills/slk-api/scripts/format.mjs";

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

describe("messageBody blocks", () => {
  it("reads a Block Kit attachment with no legacy text", () => {
    const m = {
      text: "",
      attachments: [{ blocks: [
        { type: "section", text: { type: "mrkdwn", text: "Build 42 failed" },
          fields: [{ type: "mrkdwn", text: "*Branch* main" }] },
        { type: "divider" },
        { type: "context", elements: [{ type: "mrkdwn", text: "ci-bot" }] },
      ] }],
    };
    assert.equal(messageBody(m), "Build 42 failed | *Branch* main | ci-bot");
  });

  it("reads top-level blocks when text is empty", () => {
    const m = { text: "", blocks: [{ type: "header", text: { type: "plain_text", text: "Deploy done" } }] };
    assert.equal(messageBody(m), "Deploy done");
  });

  it("prefers legacy attachment text over blocks", () => {
    const m = { text: "", attachments: [{ fallback: "legacy", blocks: [{ type: "section", text: { text: "blocks" } }] }] };
    assert.equal(messageBody(m), "legacy");
  });
});

describe("messageBody mixed blocks and attachments", () => {
  const section = [{ type: "section", text: { text: "Build failed" } }];

  it("falls back to top-level blocks when attachments carry no text", () => {
    const m = { text: "", attachments: [{ image_url: "https://x/y.png" }], blocks: section };
    assert.equal(messageBody(m), "Build failed");
  });

  it("keeps readable attachment text and still ignores empty ones", () => {
    const m = { text: "", attachments: [{ image_url: "x" }, { fallback: "legacy" }], blocks: section };
    assert.equal(messageBody(m), "legacy");
  });
});

describe("stripControl", () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const cases = [
    ["color codes", `${ESC}[1;31mred${ESC}[0m ok`, "red ok"],
    ["cursor and clear", `a${ESC}[2Jb${ESC}[H c`, "ab c"],
    ["window title ended by BEL", `x${ESC}]0;evil title${BEL}y`, "xy"],
    ["hyperlink ended by ESC backslash", `${ESC}]8;;http://a${ESC}\\link${ESC}]8;;${ESC}\\ z`, "link z"],
    ["lone ESC", `a${ESC}b`, "ab"],
    ["unterminated OSC keeps the text before it", `keep${ESC}]0;never ended`, "keep"],
    ["brackets that are not escapes", "a [31m not an escape ] ok", "a [31m not an escape ] ok"],
    ["unicode text", "héllo 日本語 🎉", "héllo 日本語 🎉"],
    ["C1 control byte", "a\u009b31mb", "a31mb"],
  ];
  for (const [name, input, want] of cases) {
    it(name, () => assert.equal(stripControl(input), want));
  }
});

describe("messageBody Block Kit shapes", () => {
  const top = [{ type: "section", text: { type: "mrkdwn", text: "Production deploy failed" } }];

  it("never prints [object Object] for button controls", () => {
    const m = {
      text: "",
      attachments: [{ blocks: [{ type: "actions", elements: [
        { type: "button", text: { type: "plain_text", text: "Retry" } },
      ] }] }],
      blocks: top,
    };
    assert.equal(messageBody(m), "Production deploy failed");
  });

  it("reads a markdown block whose text is a plain string", () => {
    const m = { text: "", blocks: [{ type: "markdown", text: "**Deploy** done" }] };
    assert.equal(messageBody(m), "**Deploy** done");
  });

  it("skips elements that carry no text, such as images", () => {
    const m = { text: "", blocks: [{ type: "context", elements: [
      { type: "image", image_url: "x", alt_text: "icon" }, { type: "mrkdwn", text: "ci-bot" },
    ] }] };
    assert.equal(messageBody(m), "ci-bot");
  });
});

describe("userIds and formatTime", () => {
  it("finds mentioned users", () => assert.deepEqual(userIds("<@U1> <@W2|x>"), ["U1", "W2"]));
  it("formats a Slack ts as UTC", () => assert.equal(formatTime("1795615289.030329"), "2026-11-25 14:01"));
});
