# Threshold Triggering Specification

## Purpose
TBD. Defines threshold-triggering behavior for pi-auto-compact.

## Requirements

### Requirement: Mid-turn checks recognize Pi tool calls
The extension SHALL perform the mid-turn auto-compaction threshold check after assistant messages that contain Pi tool-call content blocks, including blocks with `type: "toolCall"`.

#### Scenario: Tool-call assistant response reaches threshold
- **WHEN** an assistant message contains a `toolCall` content block
- **AND** the current context usage is greater than or equal to the configured auto-compaction threshold
- **THEN** the extension triggers mid-turn auto-compaction

#### Scenario: Non-tool assistant response reaches threshold
- **WHEN** an assistant message does not contain a recognized tool-call content block
- **AND** the current context usage is greater than or equal to the configured auto-compaction threshold
- **THEN** the extension does not trigger the mid-turn tool-call compaction path for that message

### Requirement: Emergency checks prefer measured context usage
The extension SHALL use Pi's measured context usage as the primary emergency threshold signal when Pi reports a non-null token count.

#### Scenario: Measured usage exceeds threshold despite local undercount
- **WHEN** Pi reports measured context usage greater than or equal to the configured auto-compaction threshold
- **AND** the extension's local message estimate is below that threshold
- **THEN** the emergency context path treats the threshold as reached
- **AND** applies the configured truncation strategy before triggering emergency auto-compaction

#### Scenario: Measured usage unavailable
- **WHEN** Pi reports context usage as unavailable or with a null token count
- **AND** the extension's local message estimate is greater than the configured auto-compaction threshold
- **THEN** the emergency context path uses the local estimate to apply the configured truncation strategy before triggering emergency auto-compaction

### Requirement: Threshold fixes preserve existing compaction behavior
The extension SHALL preserve existing settings, context-window limit calculation, compaction strategies, and replay/follow-up behavior while fixing threshold detection.

#### Scenario: Existing configuration remains valid
- **WHEN** a user has an existing `auto-compact-settings.json` file
- **THEN** the extension reads the existing threshold, keep-recent budget, and strategy fields without requiring migration

#### Scenario: Compaction trigger path continues existing continuation behavior
- **WHEN** auto-compaction completes after a mid-turn, emergency, or session-resume trigger
- **THEN** the extension continues to use the existing hidden follow-up behavior for resuming work
