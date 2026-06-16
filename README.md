# pi-auto-compact

Pre-turn auto-compaction extension for pi. Proactively manages context window usage to prevent overflow errors.

## The Problem

Pi's default auto-compaction only checks **after `agent_end`**. This means context can overflow during long multi-tool turns before compaction triggers.

## Strategy

This extension checks tokens at **three points**:

1. **Pre-turn:** Before sending any request to the LLM (`turn_start`)
2. **Mid-turn:** After tool execution, before follow-up LLM calls (`turn_end`)
3. **Emergency:** Synchronous truncation in the `context` event as a last resort

It also handles the **session resume** case: when an existing session is
reopened above the threshold, compaction kicks off as soon as the session
starts.

### Continuing After Auto-Compaction

`ctx.compact()` aborts the running agent internally, so without a nudge the
session would sit idle once the summary is written. After every
**auto-triggered** compaction this extension sends a hidden custom follow-up
message to make pi resume the in-flight task without creating a visible user
turn. The exact wording depends on which check fired (pre-turn, mid-turn,
emergency, or session-resume).

The follow-up is suppressed in two cases:

- The user ran `/compact` manually — the callback path used here only fires
  for compactions this extension started, so manual compaction is never
  touched.
- The agent is no longer idle when the summary finishes, e.g. the user
  already typed something or another extension started a turn while
  summarising. Their input acts as the kickoff and we stay quiet.

### Compaction Strategies

| Strategy | Description |
|----------|-------------|
| `keep-recent` | Keep only the most recent messages (default) |
| `keep-bookends` | Keep oldest + newest messages, compact the middle |
| `summarize-all` | Remove everything except the last user message |

## Configuration

Use `/auto-compact` to open the interactive settings menu:

```
/auto-compact              # Open settings menu
/auto-compact status       # Show current status
/auto-compact reset        # Reset to defaults
```

### Settings

| Setting | Default | Options |
|---------|---------|---------|
| Auto-compact threshold | **90%** | 80%, 85%, 90%, 95% |
| Keep recent budget | **15%** | 5%, 10%, 15%, 20% |
| Strategy | **keep-recent** | keep-recent, keep-bookends, summarize-all |
| Debug logging | **off** | on/off |

### Example

For a 200K context window model:
- Compact at **180K** tokens (90%)
- Keep **30K** recent tokens (15%)

## Install

As a pi package:

```bash
pi install npm:@capyup/pi-auto-compact
```

Or via git:

```bash
pi install git:github.com/capyup/pi-auto-compact
```

Or run directly:

```bash
pi -e ./extensions/auto-compact.ts
```

## How It Differs from Pi's Default

| Aspect | Pi Default | This Extension |
|--------|-----------|----------------|
| Check timing | After `agent_end` only | Before requests + after tools |
| Overflow protection | None | Emergency truncation |
| Mid-turn handling | None | Checks after each tool batch |
| Auto-continue | No | Yes — sends a hidden custom follow-up nudge after auto-compaction |

## License

MIT
