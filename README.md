# Codex-Style Pre-Turn Auto-Compaction for Pi

This extension implements OpenAI Codex CLI's compaction strategy for pi.

## The Problem

Pi's default auto-compaction only checks **after `agent_end`** (when the LLM finishes responding). This means:

1. If a turn has many tool calls, context can grow unbounded during the turn
2. You can exceed the context window without compaction triggering
3. The LLM may return overflow errors before compaction has a chance to run

**Example scenario:**
```
Turn starts → 50K tokens
  Tool call 1 → +20K tokens = 70K
  Tool call 2 → +30K tokens = 100K
  Tool call 3 → +50K tokens = 150K
  ...keeps growing...
  Tool call N → 368K tokens (overflow!)
Agent ends → NOW pi checks for compaction (too late!)
```

## Codex's Solution

Codex CLI checks tokens at **two additional points**:

1. **Pre-turn (PreTurn phase):** Before sending ANY request to the LLM
2. **Mid-turn (MidTurn phase):** After each tool execution, before the follow-up LLM call

```rust
// From codex-rs/core/src/session/turn.rs

// Pre-turn check
async fn run_pre_sampling_compact(...) {
    if total_usage_tokens >= auto_compact_limit {
        run_auto_compact(..., CompactionPhase::PreTurn).await?;
    }
}

// Mid-turn check (after sampling, before follow-up)
if token_limit_reached && needs_follow_up {
    run_auto_compact(..., CompactionPhase::MidTurn).await?;
}
```

## This Extension's Strategy

Since pi's architecture doesn't support blocking compaction before requests, this extension uses a two-layer approach:

### Layer 1: Emergency Truncation (Synchronous)

The `context` event runs **before every LLM request** and can modify messages synchronously:

```typescript
pi.on("context", async (event, ctx) => {
  if (estimatedTokens > limit) {
    // Immediately truncate messages to prevent overflow
    return { messages: truncatedMessages };
  }
});
```

This provides **immediate protection** against overflow errors.

### Layer 2: Proper Compaction (Asynchronous)

At strategic points, trigger pi's built-in compaction with summary generation:

- **`turn_start`:** Check before the turn begins
- **`turn_end`:** Check after tool execution, if follow-up is needed
- **`session_start`:** Check when resuming a session

```typescript
pi.on("turn_start", async (event, ctx) => {
  if (tokens >= limit) {
    ctx.compact({ customInstructions: "..." });
  }
});
```

## Configuration

Use `/codex-compact-config` to adjust settings:

```
/codex-compact-config                     # Show current config + computed values
/codex-compact-config autoCompactPercent 85
/codex-compact-config keepRecentPercent 20
/codex-compact-config debug false
```

### Dynamic Limits (Codex Style)

Limits are computed dynamically based on the current model's context window:

```rust
// Codex's formula (from codex-rs/protocol/src/openai_models.rs):
pub fn auto_compact_token_limit(&self) -> Option<i64> {
    let context_limit = (context_window * 9) / 10;  // 90%
    ...
}
```

This extension uses the same approach:

```typescript
autoCompactLimit = contextWindow * autoCompactPercent / 100
keepRecentTokens = contextWindow * keepRecentPercent / 100
```

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `autoCompactPercent` | **90** | % of context window to trigger compaction (Codex default) |
| `keepRecentPercent` | **15** | % of context window to keep as recent context |
| `autoCompactTokenLimit` | 0 | Fixed limit (only used if `autoCompactPercent` = 0) |
| `debug` | true | Enable debug logging |

### Example

For a model with 276K context window:
- `autoCompactPercent: 90` → compact at **248K** tokens
- `keepRecentPercent: 15` → keep **41K** recent tokens

For a model with 1M context window:
- `autoCompactPercent: 90` → compact at **900K** tokens
- `keepRecentPercent: 15` → keep **150K** recent tokens

## Usage

### Install

```bash
# Add to your settings.json
{
  "extensions": [
    "/path/to/pi-codex-style-compact"
  ]
}

# Or run directly
pi -e ~/Developer/pi-codex-style-compact/src/index.ts
```

### Commands

- `/codex-compact-config` - View or modify configuration
- `/codex-compact-status` - Show current compaction status

## How It Differs from Pi's Default

| Aspect | Pi Default | This Extension |
|--------|-----------|----------------|
| Check timing | After `agent_end` only | Before requests + after tools |
| Overflow protection | None (relies on API error) | Emergency truncation |
| Mid-turn handling | None | Checks after each tool batch |
| Token estimation | From last LLM usage | Continuous estimation |
| Auto-continue | No | Yes (after auto-compact) |

## Auto-Continue After Compaction

Like Codex's design, this extension automatically continues the task after compaction:

### Codex's Approach

```rust
// codex-rs/core/src/session/turn.rs
if token_limit_reached && needs_follow_up {
    run_auto_compact(...).await?;
    continue;  // <-- Directly continue the turn loop
}
```

Codex's turn is a `loop {}` that simply `continue`s after compaction.

### This Extension's Approach

Since Pi uses an event-driven architecture, we simulate `continue` by sending a follow-up message:

```typescript
pi.on("session_compact", async (event, ctx) => {
  if (isAutoCompaction) {
    // Like Codex's `continue`, trigger the next iteration
    pi.sendUserMessage("Continue with the current task.", { deliverAs: "followUp" });
  }
});
```

### Behavior

| Compaction Type | Follow-up Message |
|-----------------|-------------------|
| **Automatic** (pre-turn, mid-turn, emergency) | ✅ Sends follow-up to continue |
| **Manual** (`/compact`) | ❌ No follow-up (waits for user) |

This matches Codex's behavior:
- Auto-compaction during work: silently compact and continue
- Manual compaction: user explicitly triggered, wait for next input

## Limitations

1. **Emergency truncation loses context:** When truncation happens, older messages are removed without a proper summary. The async compaction that follows will generate a summary, but there's a brief window where context is incomplete.

2. **Token estimation is approximate:** Uses pi's built-in `estimateTokens()` (chars/4 heuristic), which may differ from actual tokenization.

3. **Can't block for compaction:** Pi's architecture doesn't allow blocking the request pipeline for async operations, so we can't wait for compaction to complete before sending requests.

4. **Follow-up message visible:** Unlike Codex which seamlessly continues, the follow-up message is visible in the conversation. This is a limitation of Pi's architecture.

## Debug Output

With `debug: true`, you'll see logs like:

```
[codex-compact] turn_start: estimated tokens = 150000, limit = 260000
[codex-compact] context: 45 messages, ~152000 tokens
[codex-compact] turn_end: 180000 tokens, hasToolCalls=true
[codex-compact] Emergency truncation: 280000 tokens exceeds 260000
[codex-compact] Truncating: removing 25 messages (~100000 tokens), keeping 20 messages
```

## License

MIT
