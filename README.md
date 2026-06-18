# pi-auto-compact

Pre-turn auto-compaction extension for pi. Proactively manages context window usage to prevent overflow errors.

## The Problem

Pi's default auto-compaction only checks **after `agent_end`**. This means context can overflow during long multi-tool turns before compaction triggers.

## Strategy

This extension checks tokens at **three points**:

1. **Pre-turn:** When user input arrives, before the prompt is handed to the agent (`input`)
2. **Mid-turn:** After tool execution, before follow-up LLM calls (`turn_end`)
3. **Emergency:** Synchronous truncation in the `context` event as a last resort

It also handles the **session resume** case: when an existing session is
reopened above the threshold, compaction kicks off as soon as the session
starts.

### Continuing After Auto-Compaction

`ctx.compact()` aborts the running agent internally, so without a nudge the
session would sit idle once the summary is written. For mid-turn, emergency,
and session-resume compactions, this extension sends a short English follow-up
user message to make pi resume the in-flight task.

Pre-turn compaction preserves the user's exact prompt instead. The `input`
handler counts the just-submitted prompt in the threshold check, intercepts it
when the projected request would cross the limit, and replays that original
user message after compaction. If compaction fails or is cancelled, the captured
prompt is re-submitted so the user's input is not lost. This avoids the
`turn_start` race where compaction could abort the newly-started turn before
the user's message reached chat history or `/tree`.

Interactive slash-prefixed inputs are left alone because pi expands prompt
templates and `/skill` commands after the `input` event, while extension replay
intentionally skips that expansion. RPC inputs are also left on Pi's normal path
so API callers keep ownership of the request/response. Streaming steer/follow-up
inputs are left alone as well: compacting during the `input` event would abort
the active turn before pi can queue the user's steer/follow-up.

The follow-up is suppressed in two cases:

- The user ran `/compact` manually — the callback path used here only fires
  for compactions this extension started, so manual compaction is never
  touched.
- For generic mid-turn/emergency/session-resume nudges, the agent is no longer
  idle when the summary finishes, e.g. the user already typed something or
  another extension started a turn while summarising. Their input acts as the
  kickoff and we stay quiet. Captured pre-turn prompts are different: once the
  extension has returned `{ action: "handled" }`, they are replayed even if
  that means queueing them behind another active turn.

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
| Check timing | After `agent_end` only | Before user prompts + after tools |
| Overflow protection | None | Emergency truncation |
| Mid-turn handling | None | Checks after each tool batch |
| Auto-continue | No | Yes — replays the original prompt for pre-turn compaction; otherwise sends an English follow-up nudge |

## License

MIT
