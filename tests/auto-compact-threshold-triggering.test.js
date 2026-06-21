const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const source = readFileSync(join(__dirname, "..", "extensions", "auto-compact.ts"), "utf8");
const compactSource = source.replace(/\s+/g, " ");

function extractReturnExpression(name) {
  const match = source.match(new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*:[^{]+\\{\\s*return\\s+([^;]+);\\s*\\}`));
  assert.ok(match, `expected to find ${name} return expression`);
  return match[1];
}

const isToolCallContentBlock = new Function(
  "block",
  `return (${extractReturnExpression("isToolCallContentBlock")});`,
);
const selectThresholdTokenUsage = new Function(
  "measuredTokens",
  "estimatedTokens",
  `return (${extractReturnExpression("selectThresholdTokenUsage")});`,
);
const isAtOrAboveLimit = new Function(
  "tokens",
  "limit",
  `return (${extractReturnExpression("isAtOrAboveLimit")});`,
);

test("mid-turn detection treats Pi toolCall content blocks as tool calls", () => {
  assert.equal(isToolCallContentBlock({ type: "toolCall" }), true);
  assert.match(
    compactSource,
    /return message\.content\.some\(isToolCallContentBlock\);/,
    "turn_end should use the shared Pi-aware tool-call predicate",
  );
});

test("mid-turn detection does not treat non-tool assistant blocks as tool calls", () => {
  assert.equal(isToolCallContentBlock({ type: "text" }), false);
  assert.equal(isToolCallContentBlock({ type: "thinking" }), false);
  assert.equal(isToolCallContentBlock({ type: "toolResult" }), false);
});

test("emergency threshold checks prefer measured usage over an undercounted estimate", () => {
  const threshold = 1_000;
  const thresholdTokens = selectThresholdTokenUsage(1_200, 100);

  assert.equal(thresholdTokens, 1_200);
  assert.equal(isAtOrAboveLimit(thresholdTokens, threshold), true);
  assert.match(
    compactSource,
    /const measuredTokens = getMeasuredTokenUsage\(ctx as UsageContext\); const thresholdTokens = selectThresholdTokenUsage\(measuredTokens, estimatedTokens\); if \(isAtOrAboveLimit\(thresholdTokens, cachedAutoCompactLimit\) && !pendingCompaction\)/,
    "context hook should decide emergency compaction from measured-first threshold tokens",
  );
});

test("emergency threshold checks fall back to local estimate when measured usage is unavailable", () => {
  const threshold = 1_000;
  const thresholdTokens = selectThresholdTokenUsage(null, 1_200);

  assert.equal(thresholdTokens, 1_200);
  assert.equal(isAtOrAboveLimit(thresholdTokens, threshold), true);
  assert.match(
    compactSource,
    /const newMessages = applyTruncationStrategy\(messages, cachedKeepRecentTokens, config\.strategy\);/,
    "context hook should still apply the configured truncation strategy",
  );
});
