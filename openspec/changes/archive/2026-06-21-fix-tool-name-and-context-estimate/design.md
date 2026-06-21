## Context

`pi-auto-compact` provides proactive compaction before Pi's built-in post-agent compaction can run. The current extension has several trigger points: pre-turn input interception, mid-turn checks after tool-calling assistant messages, an emergency `context` hook, and session-resume checks.

A real Pi transcript showed the configured threshold was exceeded during an OpenSpec implementation session, but proactive compaction did not run until after the assistant's final response. Two gaps caused this: mid-turn detection checked for an assistant content block type named `tool_use`, while Pi session JSONL uses `toolCall`; and the emergency path compared only the extension's local message-token estimate, which can be materially lower than Pi/provider context usage.

## Goals / Non-Goals

**Goals:**
- Make mid-turn threshold checks run for Pi's actual assistant tool-call representation.
- Make emergency threshold checks use Pi's measured context usage when available, so undercounted local estimates cannot suppress compaction.
- Preserve the existing compaction strategies, settings format, and follow-up/replay behavior.
- Add focused regression tests for the observed failure modes.

**Non-Goals:**
- Redesign compaction summarization or truncation strategy selection.
- Change user-facing defaults for thresholds or keep-recent budgets.
- Add new dependencies or require changes in Pi core.

## Decisions

1. **Treat `toolCall` as the primary Pi tool-call block type.**
   - Rationale: Pi's persisted assistant messages and session statistics use `toolCall`, so checking only `tool_use` misses real tool calls.
   - Alternative considered: rely only on `stopReason === "toolUse"`. That is less precise because the current code's intent is to compact only after assistant messages that actually issued tool calls. The implementation can use both stop reason and content shape defensively, but the content check must include `toolCall`.

2. **Use measured context usage before the local emergency estimate.**
   - Rationale: `estimateTotalTokens(event.messages)` only sees the event message array and can undercount model/system/tool overhead or Pi's broader context accounting. If Pi exposes a non-null context-usage value, it is a better threshold signal.
   - Alternative considered: add a static safety margin to the local estimate. This would be brittle across models and still fail when the undercount varies by tool schema or prompt composition.

3. **Keep fallback behavior when measured usage is unknown.**
   - Rationale: Pi intentionally reports `tokens: null` immediately after compaction until a trustworthy post-compaction assistant response exists. The extension should still use local estimates in those cases without repeatedly compacting from stale pre-compaction usage.

4. **Test the trigger predicates in isolation.**
   - Rationale: The bug is in the extension's threshold-decision logic. Focused Node tests can cover transcript-style assistant content and measured-vs-estimated usage without needing a full Pi runtime or external model call.

## Risks / Trade-offs

- [Risk] Supporting multiple content block names could over-trigger if a future block type is misclassified. → Mitigate by limiting recognized names to known Pi/tool-call shapes and testing the no-tool-call path.
- [Risk] Measured usage can be unavailable after compaction. → Mitigate by preserving the existing fallback to local estimates only when measured usage is null or undefined.
- [Risk] A measured threshold trigger in the `context` hook still performs truncation based on the event message array. → Mitigate by keeping the existing truncation strategy and using the measured value only to decide that protection is needed.
