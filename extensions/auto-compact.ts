/**
 * Pre-Turn Auto-Compaction for Pi
 *
 * This extension implements a proactive compaction strategy:
 * 1. Pre-turn check: Before each LLM request, check token usage
 * 2. Mid-turn check: After tool execution, before follow-up LLM calls
 * 3. Emergency: Synchronous truncation via `context` event as last resort
 *
 * Key difference from pi's default:
 * - Pi only checks after `agent_end`
 * - This extension checks BEFORE sending requests to LLM
 *
 * After compaction, pi automatically continues with the summarized context —
 * no follow-up user message is needed.
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

  /**
   * Get context usage from pi's API and update cached limits.
   */
  const getTokenUsage = (ctx: { getContextUsage: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined; model?: { contextWindow?: number } }) => {
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
    return lastEstimatedTokens;
  };

  pi.on("turn_start", async (event, ctx) => {
    truncationAppliedThisTurn = false;
    const tokens = getTokenUsage(ctx);

    if (tokens >= cachedAutoCompactLimit) {
      pendingCompaction = true;
      ctx.compact({
        customInstructions: "Focus on preserving task context and recent work.",
        onComplete: () => { pendingCompaction = false; },
        onError: () => { pendingCompaction = false; },
      });
    }
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
        pendingCompaction = true;
        setImmediate(() => {
          ctx.compact({
            customInstructions: "Emergency context truncation was applied. Generate a comprehensive summary.",
            onComplete: () => { pendingCompaction = false; },
            onError: () => { pendingCompaction = false; },
          });
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
      pendingCompaction = true;
      ctx.compact({
        customInstructions: "Mid-turn compaction: preserve current task context and tool call results.",
        onComplete: () => { pendingCompaction = false; },
        onError: () => { pendingCompaction = false; },
      });
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
          ctx.compact({
            onComplete: () => {},
            onError: () => {},
          });
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
