const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const source = readFileSync(join(__dirname, "..", "extensions", "auto-compact.ts"), "utf8");
const compactSource = source.replace(/\s+/g, " ");

test("auto-compact continuation nudge is an extension custom message, not a user message", () => {
  assert.doesNotMatch(
    source,
    /sendUserMessage\(\s*AUTO_COMPACT_FOLLOW_UP/,
    "auto-compact follow-up should not be recorded as an injected user turn",
  );

  assert.match(
    source,
    /pi\.sendMessage\(/,
    "auto-compact follow-up should use the custom-message extension API",
  );
  assert.match(
    source,
    /customType:\s*["']auto-compact-follow-up["']/,
    "auto-compact follow-up should be identifiable as extension-generated",
  );
  assert.match(
    source,
    /display:\s*false/,
    "auto-compact follow-up should be hidden from the session UI",
  );
  assert.match(
    compactSource,
    /\{ triggerTurn: true \}/,
    "auto-compact follow-up should still resume the agent when idle",
  );
});
