## 1. Regression Coverage

- [x] 1.1 Add a regression test proving mid-turn detection treats Pi assistant content blocks with `type: "toolCall"` as tool calls eligible for threshold-triggered compaction.
- [x] 1.2 Add a regression test proving non-tool assistant messages do not trigger the mid-turn tool-call compaction path.
- [x] 1.3 Add a regression test proving the emergency context path treats the threshold as reached when measured context usage is above the limit even if the local message estimate is below it.
- [x] 1.4 Add a regression test proving the emergency context path still falls back to the local estimate when measured usage is unavailable.

## 2. Extension Implementation

- [x] 2.1 Update mid-turn tool-call detection in `extensions/auto-compact.ts` to recognize Pi's `toolCall` content blocks while preserving any existing compatible tool-call block support.
- [x] 2.2 Update the `context` emergency threshold decision to prefer non-null measured usage from `ctx.getContextUsage()` and fall back to the local message estimate only when measured usage is unavailable.
- [x] 2.3 Preserve existing cached context-window limit updates, `pendingCompaction` guards, truncation strategies, and hidden follow-up/replay behavior.

## 3. Verification and Documentation

- [x] 3.1 Run the repository test suite with `npm test` and confirm all tests pass.
- [x] 3.2 Update README or inline comments if the implementation changes documented trigger semantics.
- [x] 3.3 Re-check the OpenSpec task list and mark completed items only after the corresponding implementation and verification are done.
