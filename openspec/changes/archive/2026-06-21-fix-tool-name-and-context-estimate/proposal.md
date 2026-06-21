## Why

Pi sessions can exceed the configured auto-compaction threshold during long tool-heavy turns because mid-turn detection is looking for the wrong assistant tool-call block name and the emergency path can rely on an undercounted local message estimate. This change closes those gaps so auto-compaction triggers before sessions approach or exceed the model context window.

## What Changes

- Recognize Pi's actual assistant tool-call block shape when deciding whether a turn needs a mid-turn compaction check.
- Use measured context usage from Pi as the primary emergency threshold signal, with local estimation only as a fallback when measured usage is unavailable.
- Add regression coverage for Pi transcript-style `toolCall` blocks and measured-vs-estimated threshold behavior.
- Update documentation if behavior or terminology changes.

## Capabilities

### New Capabilities
- `threshold-triggering`: Auto-compaction threshold checks across pre-turn, mid-turn, emergency, and session-resume paths.

### Modified Capabilities

## Impact

- Affected code: `extensions/auto-compact.ts`.
- Affected tests: Node test files under `tests/`.
- No new runtime dependencies or breaking API changes are expected.
