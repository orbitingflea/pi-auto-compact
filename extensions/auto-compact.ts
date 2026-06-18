/**
 * Pre-Turn Auto-Compaction for Pi
 *
 * This extension implements a proactive compaction strategy:
 * 1. Pre-turn check: When user input arrives, check token usage before the
 *    user message is handed to the agent
 * 2. Mid-turn check: After tool execution, before follow-up LLM calls
 * 3. Emergency: Synchronous truncation via `context` event as last resort
 *
 * Key difference from pi's default:
 * - Pi only checks after `agent_end`
 * - This extension checks BEFORE sending requests to LLM
 *
 * Follow-up after compaction:
 * `ctx.compact()` aborts the streaming agent internally, so the agent will be
 * idle once compaction finishes. Mid-turn, emergency, and session-resume
 * compactions therefore need a small follow-up user message to make pi resume
 * the in-flight task.
 *
 * Pre-turn compaction is different: the user's just-submitted message has not
 * reached pi's message history yet. If we compact from `turn_start`, the abort
 * can drop that message before `message_end` persists it. Instead, the
 * `input` handler intercepts the prompt, compacts while idle, then replays the
 * original user input after compaction completes.
 */

import type { ExtensionAPI, ExtensionContext, AgentMessage } from "@earendil-works/pi-coding-agent";
import { estimateTokens, getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// =========================================================================
// Compaction strategy types
// =========================================================================

/**
 * keep-recent   – Default. Keep only the most recent messages within
 *                 the keepRecentPercent budget. Everything older is discarded
 *                 and replaced by a truncation notice / summary.
 *
 * keep-bookends – Keep the oldest N messages AND the newest N messages;
 *                 compact the middle section. Useful when early context
 *                 (project setup, instructions) is valuable.
 *
 * summarize-all – Summarize the entire conversation. No raw messages are
 *                 preserved after compaction. Smallest footprint but loses
 *                 exact wording.
 */
type CompactionStrategy = "keep-recent" | "keep-bookends" | "summarize-all";

const STRATEGY_LABELS: Record<CompactionStrategy, string> = {
  "keep-recent":   "Keep recent only (default)",
  "keep-bookends": "Keep oldest + newest, compact middle",
  "summarize-all": "Summarize everything",
};

// =========================================================================
// Configuration
// =========================================================================

interface AutoCompactConfig {
  /**
   * Percentage of context window to trigger compaction.
   * Default: 90% of context window.
   * Set to 0 to use a fixed autoCompactTokenLimit instead.
   */
  autoCompactPercent: number;
  /**
   * Fixed token threshold (only used if autoCompactPercent is 0).
   * When autoCompactPercent > 0, this is ignored.
   */
  autoCompactTokenLimit: number;
  /**
   * Percentage of context window to keep as recent context.
   * Default 15% of context window.
   */
  keepRecentPercent: number;
  /** Compaction strategy. */
  strategy: CompactionStrategy;
}

const DEFAULT_CONFIG: AutoCompactConfig = {
  autoCompactPercent: 90,
  autoCompactTokenLimit: 0,
  keepRecentPercent: 15,
  strategy: "keep-recent",
};

const AUTO_COMPACT_PRESETS = [80, 85, 90, 95] as const;
const KEEP_RECENT_PRESETS  = [5, 10, 15, 20] as const;

// =========================================================================
// Settings persistence
// =========================================================================

const SETTINGS_PATH = path.join(getAgentDir(), "auto-compact-settings.json");

async function loadSettings(): Promise<Partial<AutoCompactConfig>> {
  try {
    const content = await readFile(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(content) as Partial<AutoCompactConfig>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function saveSettings(config: AutoCompactConfig): Promise<void> {
  await mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/**
 * Use pi's built-in token estimation for consistency.
 * Re-export as estimateMessageTokens for clarity.
 */
const estimateMessageTokens = estimateTokens;

/**
 * Estimate total tokens for an array of messages.
 */
function estimateTotalTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

/**
 * Snap a raw cut index forward to the nearest user-message boundary
 * so we never break a tool-call / tool-result pair.
 */
function snapToUserBoundary(messages: AgentMessage[], rawIndex: number): number {
  let idx = rawIndex;
  while (idx < messages.length) {
    if (messages[idx].role === "user") break;
    idx++;
  }
  return Math.min(idx, messages.length);
}

/**
 * Find the cut point for keeping recent messages ("keep-recent" strategy).
 * Returns the index of the first message to KEEP.
 */
function findCutPointRecent(messages: AgentMessage[], keepTokens: number): number {
  let accumulated = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = estimateMessageTokens(messages[i]);
    if (accumulated + tokens > keepTokens) {
      return snapToUserBoundary(messages, i + 1);
    }
    accumulated += tokens;
  }
  return 0;
}

/**
 * Find the cut range for the "keep-bookends" strategy.
 * Returns [removeStart, removeEnd) — the range of messages to remove.
 * Both the oldest and newest messages within the keepTokens budget are preserved;
 * the middle section is removed.
 */
function findBookendCutRange(
  messages: AgentMessage[],
  keepTokens: number,
): [number, number] {
  const halfBudget = Math.floor(keepTokens / 2);

  // Walk forward to find how many oldest messages fit in half the budget
  let headEnd = 0;
  let headTokens = 0;
  for (let i = 0; i < messages.length; i++) {
    const t = estimateMessageTokens(messages[i]);
    if (headTokens + t > halfBudget) break;
    headTokens += t;
    headEnd = i + 1;
  }
  headEnd = snapToUserBoundary(messages, headEnd);

  // Walk backward to find how many recent messages fit in the other half
  let tailStart = messages.length;
  let tailTokens = 0;
  for (let i = messages.length - 1; i >= headEnd; i--) {
    const t = estimateMessageTokens(messages[i]);
    if (tailTokens + t > halfBudget) break;
    tailTokens += t;
    tailStart = i;
  }
  // Snap tail start backward to a user boundary
  while (tailStart > headEnd && messages[tailStart]?.role !== "user") {
    tailStart--;
  }
  tailStart = Math.max(tailStart, headEnd);

  if (tailStart <= headEnd) return [0, 0]; // Nothing to remove
  return [headEnd, tailStart];
}

/**
 * Apply truncation according to the selected strategy.
 * Returns the new message array (with notice), or null if no truncation needed.
 */
function applyTruncationStrategy(
  messages: AgentMessage[],
  keepTokens: number,
  strategy: CompactionStrategy,
): AgentMessage[] | null {
  switch (strategy) {
    case "keep-recent": {
      const cutIndex = findCutPointRecent(messages, keepTokens);
      if (cutIndex <= 0) return null;
      const removed = messages.slice(0, cutIndex);
      const kept = messages.slice(cutIndex);
      const notice = createTruncationNotice(removed.length, estimateTotalTokens(removed));
      return [notice, ...kept];
    }

    case "keep-bookends": {
      const [removeStart, removeEnd] = findBookendCutRange(messages, keepTokens);
      if (removeStart >= removeEnd) return null;
      const removed = messages.slice(removeStart, removeEnd);
      const head = messages.slice(0, removeStart);
      const tail = messages.slice(removeEnd);
      const notice = createTruncationNotice(removed.length, estimateTotalTokens(removed));
      return [...head, notice, ...tail];
    }

    case "summarize-all": {
      // Remove everything except the very last user message
      if (messages.length <= 1) return null;
      const lastUserIdx = messages.length - 1;
      const removed = messages.slice(0, lastUserIdx);
      const notice = createTruncationNotice(removed.length, estimateTotalTokens(removed));
      return [notice, messages[lastUserIdx]];
    }

    default:
      return null;
  }
}

/**
 * Create a truncation notice message.
 */
function createTruncationNotice(removedCount: number, removedTokens: number): AgentMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `[Context compacted: ${removedCount} earlier messages (~${Math.round(removedTokens / 1000)}K tokens) were summarized. Full context is preserved in session history. Continue with the current task.]`,
      },
    ],
    timestamp: Date.now(),
  };
}

export default function autoCompact(pi: ExtensionAPI) {
  let config = { ...DEFAULT_CONFIG };
  
  // State tracking
  let pendingCompaction = false;
  let lastEstimatedTokens = 0;
  let truncationAppliedThisTurn = false;

  type UserReplayContent = Parameters<ExtensionAPI["sendUserMessage"]>[0];
  type UserReplayOptions = Parameters<ExtensionAPI["sendUserMessage"]>[1];

  const ownReplayInputs = new Map<string, number>();
  let pendingOwnReplayInputs = 0;

  const replayKey = (text: string, images: unknown): string => {
    return `${text}\u0000${JSON.stringify(Array.isArray(images) ? images : [])}`;
  };

  const normalizeReplayContent = (content: UserReplayContent): { text: string; images?: unknown[] } => {
    if (typeof content === "string") return { text: content };

    const textParts: string[] = [];
    const images: unknown[] = [];
    for (const part of content) {
      if (part.type === "text") {
        textParts.push(part.text);
      } else {
        images.push(part);
      }
    }
    return { text: textParts.join("\n"), images: images.length > 0 ? images : undefined };
  };

  const markOwnReplay = (content: UserReplayContent): void => {
    const { text, images } = normalizeReplayContent(content);
    const key = replayKey(text, images);
    pendingOwnReplayInputs += 1;
    ownReplayInputs.set(key, (ownReplayInputs.get(key) ?? 0) + 1);
  };

  const decrementAnyOwnReplay = (): void => {
    pendingOwnReplayInputs = Math.max(0, pendingOwnReplayInputs - 1);
    const first = ownReplayInputs.entries().next();
    if (first.done) return;
    const [key, count] = first.value;
    if (count <= 1) ownReplayInputs.delete(key);
    else ownReplayInputs.set(key, count - 1);
  };

  const consumeOwnReplay = (text: string, images: unknown): boolean => {
    const key = replayKey(text, images);
    const count = ownReplayInputs.get(key) ?? 0;
    if (count > 0) {
      pendingOwnReplayInputs = Math.max(0, pendingOwnReplayInputs - 1);
      if (count === 1) ownReplayInputs.delete(key);
      else ownReplayInputs.set(key, count - 1);
      return true;
    }

    // An earlier input transformer may have changed the replay text/images
    // before this handler runs. In that case, fall back to the pending replay
    // count so our own replay still cannot recursively trigger compaction.
    if (pendingOwnReplayInputs > 0) {
      decrementAnyOwnReplay();
      return true;
    }

    return false;
  };

  const sendOwnUserMessage = (content: UserReplayContent, options?: UserReplayOptions): void => {
    markOwnReplay(content);
    try {
      pi.sendUserMessage(content, options);
    } catch (error) {
      const { text, images } = normalizeReplayContent(content);
      consumeOwnReplay(text, images);
      throw error;
    }
  };

  // Phase-specific follow-up nudges, sent only when auto-compaction completes
  // and the agent is still idle. Manual `/compact` never reaches this path.
  type AutoCompactPhase = "pre-turn" | "mid-turn" | "emergency" | "session-resume";
  const AUTO_COMPACT_FOLLOW_UP: Record<Exclude<AutoCompactPhase, "pre-turn">, string> = {
    "mid-turn":       "Auto-compact ran mid-turn. Continue executing the remaining work.",
    "emergency":      "Emergency auto-compact ran. Resume where we left off.",
    "session-resume": "Auto-compact ran on session resume. Continue with the active task.",
  };

  const buildReplayContent = (text: string, images: unknown): UserReplayContent => {
    const imageParts = Array.isArray(images) ? images : [];
    if (imageParts.length === 0) return text;
    return [{ type: "text", text }, ...imageParts] as UserReplayContent;
  };

  const estimateInputTokens = (text: string, images: unknown): number => {
    const imageParts = Array.isArray(images) ? images : [];
    const content = [{ type: "text", text }, ...imageParts];
    return estimateMessageTokens({ role: "user", content, timestamp: Date.now() } as AgentMessage);
  };

  const replayUserMessage = (content: UserReplayContent): void => {
    // Always provide a queued delivery mode. When Pi is idle this starts a
    // normal turn; if another turn wins the race between our idle check and
    // Pi's async preflight, the captured prompt is queued instead of rejected.
    sendOwnUserMessage(content, { deliverAs: "followUp" });
  };

  const triggerAutoCompact = (
    ctx: ExtensionContext,
    phase: AutoCompactPhase,
    customInstructions?: string,
    replayAfterCompact?: UserReplayContent,
  ): void => {
    pendingCompaction = true;
    ctx.compact({
      customInstructions,
      onComplete: () => {
        pendingCompaction = false;
        // ctx.compact() aborts the running agent, so we generally see
        // isIdle() === true here. But pi also flushes its own
        // `compactionQueuedMessages` (anything the user typed during
        // summarisation) synchronously off the `compaction_end` event,
        // and that flush runs `session.prompt()` without streamingBehavior.
        //
        // If we send in the same tick we race that flush: whoever reaches
        // `agent.run()` first sets isStreaming=true, and the other prompt()
        // throws "Agent is already processing", which pi surfaces as
        // "Failed to send queued message: ...".
        //
        // Defer past all pending microtasks so that flush's prompt() has
        // settled into its final state. After setImmediate, isIdle()
        // honestly reflects whether anything else is about to drive a turn.
        setImmediate(() => {
          const content = replayAfterCompact ?? (phase === "pre-turn" ? undefined : AUTO_COMPACT_FOLLOW_UP[phase]);
          if (!content) return;

          if (replayAfterCompact !== undefined) {
            // The intercepted user prompt must not be dropped just because
            // another queued prompt won the post-compaction race. If another
            // turn is already running, preserve the original input as a
            // queued message rather than replacing it with a generic nudge.
            replayUserMessage(content);
          } else if (ctx.isIdle()) {
            sendOwnUserMessage(content);
          }
        });
      },
      onError: () => {
        pendingCompaction = false;
        if (replayAfterCompact !== undefined) {
          // The input handler already returned `{ action: "handled" }`, so Pi
          // will not process the user's prompt on the original path. If
          // summarization fails or is cancelled, re-submit the captured input
          // instead of silently dropping it.
          setImmediate(() => replayUserMessage(replayAfterCompact));
        }
      },
    });
  };

  // Cache computed limits per model
  let cachedContextWindow = 0;
  let cachedAutoCompactLimit = 0;
  let cachedKeepRecentTokens = 0;

  /**
   * Compute auto-compact limit as a percentage of context window.
   */
  const computeAutoCompactLimit = (contextWindow: number): number => {
    if (config.autoCompactPercent > 0) {
      return Math.floor(contextWindow * config.autoCompactPercent / 100);
    }
    return config.autoCompactTokenLimit;
  };

  const computeKeepRecentTokens = (contextWindow: number): number => {
    return Math.floor(contextWindow * config.keepRecentPercent / 100);
  };

  const updateCachedLimits = (ctx: { model?: { contextWindow?: number } }) => {
    const contextWindow = ctx.model?.contextWindow ?? 200000;
    if (contextWindow !== cachedContextWindow) {
      cachedContextWindow = contextWindow;
      cachedAutoCompactLimit = computeAutoCompactLimit(contextWindow);
      cachedKeepRecentTokens = computeKeepRecentTokens(contextWindow);
    }
  };

  type UsageContext = {
    getContextUsage: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
    model?: { contextWindow?: number };
  };

  /**
   * Get measured context usage from pi's API and update cached limits.
   * Returns null when pi intentionally reports usage as unknown, e.g. right
   * after compaction before a post-compaction assistant response exists.
   */
  const getMeasuredTokenUsage = (ctx: UsageContext): number | null => {
    const usage = ctx.getContextUsage();
    
    // Update cached limits based on current model
    if (usage?.contextWindow) {
      updateCachedLimits({ model: { contextWindow: usage.contextWindow } });
    } else {
      updateCachedLimits(ctx);
    }
    
    if (usage && usage.tokens !== null) {
      return usage.tokens;
    }
    return null;
  };

  /**
   * Get context usage, falling back to the last context-event estimate when
   * no measured usage exists. This is useful mid-turn but intentionally not
   * used for pre-turn input interception to avoid repeated compaction from a
   * stale pre-compaction estimate.
   */
  const getTokenUsage = (ctx: UsageContext): number => {
    return getMeasuredTokenUsage(ctx) ?? lastEstimatedTokens;
  };

  pi.on("input", async (event, ctx) => {
    // Extension-injected replay/follow-up messages from this extension must not
    // recursively trigger another pre-turn compaction. Other extensions' user
    // messages are still eligible for the same threshold check.
    if (event.source === "extension" && consumeOwnReplay(event.text, event.images)) {
      return { action: "continue" as const };
    }

    // Non-TUI callers (print/json/SDK/RPC) expect their session.prompt() call
    // to own the resulting turn. Replaying later via pi.sendUserMessage() would
    // detach the response from the original request, so only TUI input is
    // intercepted here.
    if (ctx.mode !== "tui") {
      return { action: "continue" as const };
    }

    // RPC callers should already be covered by ctx.mode, but keep the source
    // guard for clarity and future mixed-mode entry points.
    if (event.source === "rpc") {
      return { action: "continue" as const };
    }

    // Streaming steer/follow-up input arrives while an agent turn is already
    // running. Calling ctx.compact() here would abort that active turn before Pi
    // can queue the user's steer/follow-up. There is no safe extension-level
    // deferred pre-turn hook for the later queued prompt, so let Pi queue it and
    // rely on mid-turn/emergency protection instead of interrupting work now.
    if (event.streamingBehavior) {
      return { action: "continue" as const };
    }

    // Extension commands are handled before the input event, but interactive
    // prompt templates and /skill commands expand afterward. pi.sendUserMessage()
    // intentionally skips that expansion, so do not intercept interactive
    // slash-prefixed input unless pi exposes a replay path that preserves normal
    // expansion semantics.
    if (event.source === "interactive" && event.text.trimStart().startsWith("/")) {
      return { action: "continue" as const };
    }

    const tokens = getMeasuredTokenUsage(ctx);
    const projectedTokens = tokens === null ? null : tokens + estimateInputTokens(event.text, event.images);
    if (projectedTokens !== null && projectedTokens >= cachedAutoCompactLimit && !pendingCompaction) {
      // Returning handled necessarily owns replay for this event. Pi does not
      // currently expose a normal-source, post-middleware replay path, so keep
      // this path limited to TUI inputs where out-of-band replay preserves
      // caller expectations.
      triggerAutoCompact(
        ctx,
        "pre-turn",
        "Focus on preserving task context and recent work.",
        buildReplayContent(event.text, event.images),
      );
      return { action: "handled" as const };
    }

    return { action: "continue" as const };
  });

  pi.on("turn_start", async () => {
    truncationAppliedThisTurn = false;
  });

  pi.on("context", async (event, ctx) => {
    const messages = event.messages;
    const estimatedTokens = estimateTotalTokens(messages);
    lastEstimatedTokens = estimatedTokens;

    updateCachedLimits(ctx as unknown as { model?: { contextWindow?: number } });

    if (estimatedTokens > cachedAutoCompactLimit && !pendingCompaction) {
      const newMessages = applyTruncationStrategy(messages, cachedKeepRecentTokens, config.strategy);

      if (newMessages) {
        truncationAppliedThisTurn = true;
        setImmediate(() => {
          triggerAutoCompact(
            ctx,
            "emergency",
            "Emergency context truncation was applied. Generate a comprehensive summary.",
          );
        });
        return { messages: newMessages };
      }
    }
    return;
  });

  pi.on("turn_end", async (event, ctx) => {
    const { message } = event;

    let hasToolCalls = false;
    if (message.role === "assistant" && "content" in message && Array.isArray(message.content)) {
      hasToolCalls = message.content.some((block: { type: string }) => block.type === "tool_use");
    }
    if (!hasToolCalls) return;

    const tokens = getTokenUsage(ctx);
    if (tokens >= cachedAutoCompactLimit && !pendingCompaction) {
      triggerAutoCompact(
        ctx,
        "mid-turn",
        "Mid-turn compaction: preserve current task context and tool call results.",
      );
    }
  });

  pi.on("session_start", async (event, ctx) => {
    pendingCompaction = false;
    truncationAppliedThisTurn = false;
    lastEstimatedTokens = 0;

    await restoreSettings();

    if (event.reason === "resume" || event.reason === "fork") {
      const usage = ctx.getContextUsage();
      if (usage && usage.tokens !== null) {
        lastEstimatedTokens = usage.tokens;
        updateCachedLimits(ctx as unknown as { model?: { contextWindow?: number } });
        if (usage.tokens >= cachedAutoCompactLimit) {
          triggerAutoCompact(ctx, "session-resume");
        }
      }
    }
  });



  // =========================================================================
  // Settings persistence helpers
  // =========================================================================

  const applyConfig = (overrides: Partial<AutoCompactConfig>) => {
    config = { ...config, ...overrides };
    if (cachedContextWindow > 0) {
      cachedAutoCompactLimit = computeAutoCompactLimit(cachedContextWindow);
      cachedKeepRecentTokens = computeKeepRecentTokens(cachedContextWindow);
    }
  };

  const restoreSettings = async () => {
    const saved = await loadSettings();
    if (Object.keys(saved).length > 0) applyConfig(saved);
  };

  const persistAndApply = async (overrides: Partial<AutoCompactConfig>) => {
    applyConfig(overrides);
    await saveSettings(config);
  };

  // =========================================================================
  // Settings menu (interactive)
  // =========================================================================

  const formatCurrentConfig = (): string => {
    const strategyLabel = STRATEGY_LABELS[config.strategy];
    return [
      `Auto-compact threshold: ${config.autoCompactPercent}%`,
      `Keep recent budget:     ${config.keepRecentPercent}%`,
      `Strategy:               ${strategyLabel}`,
      "",
      `Context window: ${Math.round(cachedContextWindow / 1000)}K`,
      `Compact at:     ${Math.round(cachedAutoCompactLimit / 1000)}K tokens`,
      `Keep recent:    ${Math.round(cachedKeepRecentTokens / 1000)}K tokens`,
    ].join("\n");
  };

  const openSettingsMenu = async (ctx: ExtensionContext) => {
    // Update limits so the display is accurate
    updateCachedLimits(ctx as unknown as { model?: { contextWindow?: number } });

    while (true) {
      const choice = await ctx.ui.select(
        `Auto-Compact Settings\n\n${formatCurrentConfig()}\n\nWhat would you like to change?`,
        [
          `Auto-compact threshold  [${config.autoCompactPercent}%]`,
          `Keep recent budget      [${config.keepRecentPercent}%]`,
          `Compaction strategy     [${config.strategy}]`,
          "Reset to defaults",
          "Done",
        ],
      );

      if (!choice || choice === "Done") return;

      if (choice.startsWith("Auto-compact threshold")) {
        const picked = await ctx.ui.select(
          "Auto-compact threshold (% of context window)",
          AUTO_COMPACT_PRESETS.map((p) => `${p}%${p === config.autoCompactPercent ? " ✓" : ""}`),
        );
        if (picked) {
          const num = parseInt(picked, 10);
          if (!isNaN(num)) {
            await persistAndApply({ autoCompactPercent: num });
            ctx.ui.notify(`Auto-compact threshold → ${num}%`, "success");
          }
        }
        continue;
      }

      if (choice.startsWith("Keep recent budget")) {
        const picked = await ctx.ui.select(
          "Keep recent budget (% of context window to preserve)",
          KEEP_RECENT_PRESETS.map((p) => `${p}%${p === config.keepRecentPercent ? " ✓" : ""}`),
        );
        if (picked) {
          const num = parseInt(picked, 10);
          if (!isNaN(num)) {
            await persistAndApply({ keepRecentPercent: num });
            ctx.ui.notify(`Keep recent budget → ${num}%`, "success");
          }
        }
        continue;
      }

      if (choice.startsWith("Compaction strategy")) {
        const strategies = Object.entries(STRATEGY_LABELS) as [CompactionStrategy, string][];
        const picked = await ctx.ui.select(
          "Compaction strategy",
          strategies.map(([key, label]) => `${label}${key === config.strategy ? " ✓" : ""}`),
        );
        if (picked) {
          const entry = strategies.find(([, label]) => picked.startsWith(label));
          if (entry) {
            await persistAndApply({ strategy: entry[0] });
            ctx.ui.notify(`Strategy → ${entry[1]}`, "success");
          }
        }
        continue;
      }

      if (choice === "Reset to defaults") {
        const ok = await ctx.ui.confirm(
          "Reset to defaults?",
          "This will reset all auto-compact settings to their defaults.",
        );
        if (ok) {
          await persistAndApply({ ...DEFAULT_CONFIG });
          ctx.ui.notify("Settings reset to defaults.", "success");
        }
        continue;
      }
    }
  };

  // =========================================================================
  // Configuration command
  // =========================================================================

  pi.registerCommand("auto-compact", {
    description: "Configure auto-compaction settings",
    getArgumentCompletions: (prefix: string) => {
      const cmds = ["status", "settings", "reset"];
      return cmds
        .filter((c) => c.startsWith(prefix))
        .map((value) => ({ value }));
    },
    handler: async (args, ctx) => {
      updateCachedLimits(ctx as unknown as { model?: { contextWindow?: number } });
      const trimmed = args.trim();

      if (!trimmed || trimmed === "settings") {
        await openSettingsMenu(ctx);
        return;
      }

      if (trimmed === "status") {
        const usage = ctx.getContextUsage();
        const tokens = usage?.tokens ?? lastEstimatedTokens;
        const percent = usage?.percent ?? (cachedAutoCompactLimit > 0 ? (tokens / cachedAutoCompactLimit * 100) : 0);
        ctx.ui.notify(
          `Auto-Compact Status:\n` +
          `  Current tokens: ~${Math.round(tokens / 1000)}K\n` +
          `  Limit: ${Math.round(cachedAutoCompactLimit / 1000)}K (${config.autoCompactPercent}% of ${Math.round(cachedContextWindow / 1000)}K)\n` +
          `  Usage: ${percent.toFixed(1)}%\n` +
          `  Strategy: ${STRATEGY_LABELS[config.strategy]}\n` +
          `  Pending compaction: ${pendingCompaction}\n` +
          `  Truncation this turn: ${truncationAppliedThisTurn}`,
          "info"
        );
        return;
      }

      if (trimmed === "reset") {
        await persistAndApply({ ...DEFAULT_CONFIG });
        ctx.ui.notify("Auto-compact settings reset to defaults.", "success");
        return;
      }

      ctx.ui.notify("Usage: /auto-compact [settings|status|reset]", "warning");
    },
  });



  pi.on("model_select", async (event) => {
    updateCachedLimits({ model: { contextWindow: event.model?.contextWindow ?? 200000 } });
  });
}
