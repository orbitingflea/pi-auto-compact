/**
 * Codex-style Pre-Turn Auto-Compaction for Pi
 *
 * This extension implements Codex's compaction strategy:
 * 1. Pre-turn check: Before each LLM request, check token usage
 * 2. Mid-turn check: After tool execution, if follow-up needed, check again
 *
 * Key difference from pi's default:
 * - Pi only checks after `agent_end`
 * - This extension checks BEFORE sending requests to LLM
 *
 * Strategy:
 * - Use `context` event for emergency truncation (synchronous, immediate)
 * - Use `turn_start` to trigger proper compaction (async, with summary)
 * - Use `turn_end` to trigger mid-turn compaction if needed
 */

import type { ExtensionAPI, AgentMessage } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

// Configuration
interface CodexCompactConfig {
  /**
   * Percentage of context window to trigger compaction.
   * Codex uses 90% (context_window * 9 / 10).
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
   * Default 15% matches Codex's keepRecentTokens behavior.
   */
  keepRecentPercent: number;
  /** Enable debug logging */
  debug: boolean;
}

const DEFAULT_CONFIG: CodexCompactConfig = {
  autoCompactPercent: 90,      // Codex default: 90% of context window
  autoCompactTokenLimit: 0,    // Ignored when autoCompactPercent > 0
  keepRecentPercent: 15,       // Keep ~15% of context window as recent
  debug: true,
};

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
 * Find the cut point for keeping recent messages.
 * Returns the index of the first message to KEEP.
 */
function findCutPoint(messages: AgentMessage[], keepTokens: number): number {
  let accumulated = 0;
  
  // Walk backwards from the end
  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = estimateMessageTokens(messages[i]);
    if (accumulated + tokens > keepTokens) {
      // Found the cut point - return the next index (first to keep)
      // But ensure we don't cut in the middle of a tool call/result pair
      let cutIndex = i + 1;
      
      // Adjust cut point to not break user message boundaries
      // Walk forward to find a user message (turn boundary)
      while (cutIndex < messages.length) {
        const msg = messages[cutIndex];
        if (msg.role === "user") {
          break;
        }
        cutIndex++;
      }
      
      return Math.min(cutIndex, messages.length);
    }
    accumulated += tokens;
  }
  
  return 0; // Keep all messages
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

export default function codexStyleCompact(pi: ExtensionAPI) {
  const config = { ...DEFAULT_CONFIG };
  
  // State tracking
  let pendingCompaction = false;
  let lastEstimatedTokens = 0;
  let truncationAppliedThisTurn = false;
  
  // Track whether the current compaction is automatic (needs follow-up) or manual (no follow-up)
  let isAutoCompaction = false;
  // Track the reason for auto-compaction to generate appropriate follow-up
  let autoCompactionPhase: "pre-turn" | "mid-turn" | "emergency" | null = null;
  
  // Cache computed limits per model
  let cachedContextWindow = 0;
  let cachedAutoCompactLimit = 0;
  let cachedKeepRecentTokens = 0;

  const log = (msg: string, ...args: unknown[]) => {
    if (config.debug) {
      console.log(`[codex-compact] ${msg}`, ...args);
    }
  };

  /**
   * Compute auto-compact limit from context window.
   * Mimics Codex's auto_compact_token_limit() method:
   *   context_limit = (context_window * 9) / 10  // 90%
   *   return min(config_limit, context_limit) if config_limit set
   *   return context_limit otherwise
   */
  const computeAutoCompactLimit = (contextWindow: number): number => {
    if (config.autoCompactPercent > 0) {
      // Dynamic: percentage of context window (Codex default: 90%)
      return Math.floor(contextWindow * config.autoCompactPercent / 100);
    }
    // Fixed limit
    return config.autoCompactTokenLimit;
  };

  /**
   * Compute tokens to keep from recent context.
   */
  const computeKeepRecentTokens = (contextWindow: number): number => {
    return Math.floor(contextWindow * config.keepRecentPercent / 100);
  };

  /**
   * Update cached limits when model changes.
   */
  const updateCachedLimits = (ctx: { model?: { contextWindow?: number } }) => {
    const contextWindow = ctx.model?.contextWindow ?? 200000; // fallback
    if (contextWindow !== cachedContextWindow) {
      cachedContextWindow = contextWindow;
      cachedAutoCompactLimit = computeAutoCompactLimit(contextWindow);
      cachedKeepRecentTokens = computeKeepRecentTokens(contextWindow);
      log(`Model context window: ${contextWindow}, auto-compact limit: ${cachedAutoCompactLimit} (${config.autoCompactPercent}%), keep recent: ${cachedKeepRecentTokens}`);
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

  // =========================================================================
  // Pre-turn compaction check (like Codex's run_pre_sampling_compact)
  // =========================================================================
  
  pi.on("turn_start", async (event, ctx) => {
    truncationAppliedThisTurn = false;
    
    const tokens = getTokenUsage(ctx);
    log(`turn_start: estimated tokens = ${tokens}, limit = ${config.autoCompactTokenLimit}`);
    
    if (tokens >= cachedAutoCompactLimit) {
      log(`Pre-turn: Token limit reached (${tokens} >= ${cachedAutoCompactLimit}), triggering compaction`);
      pendingCompaction = true;
      isAutoCompaction = true;
      autoCompactionPhase = "pre-turn";
      
      // Trigger compaction asynchronously
      ctx.compact({
        customInstructions: "Focus on preserving task context and recent work.",
        onComplete: (result) => {
          log("Pre-turn compaction completed", result);
          pendingCompaction = false;
        },
        onError: (error) => {
          log("Pre-turn compaction failed:", error.message);
          pendingCompaction = false;
          isAutoCompaction = false;
          autoCompactionPhase = null;
        },
      });
    }
  });

  // =========================================================================
  // Context event: Emergency truncation guard
  // This runs BEFORE each LLM request and can modify messages synchronously
  // =========================================================================
  
  pi.on("context", async (event, ctx) => {
    const messages = event.messages;
    const estimatedTokens = estimateTotalTokens(messages);
    lastEstimatedTokens = estimatedTokens;
    
    log(`context: ${messages.length} messages, ~${estimatedTokens} tokens`);
    
    // Update limits based on messages (in case model changed)
    updateCachedLimits(ctx as unknown as { model?: { contextWindow?: number } });
    
    // If tokens exceed limit and compaction isn't already handling it,
    // apply emergency truncation to prevent overflow errors
    if (estimatedTokens > cachedAutoCompactLimit && !pendingCompaction) {
      log(`Emergency truncation: ${estimatedTokens} tokens exceeds ${cachedAutoCompactLimit}`);
      
      const cutIndex = findCutPoint(messages, cachedKeepRecentTokens);
      
      if (cutIndex > 0) {
        const removedMessages = messages.slice(0, cutIndex);
        const removedTokens = estimateTotalTokens(removedMessages);
        const keptMessages = messages.slice(cutIndex);
        
        log(`Truncating: removing ${removedMessages.length} messages (~${removedTokens} tokens), keeping ${keptMessages.length} messages`);
        
        // Create new message array with truncation notice
        const truncationNotice = createTruncationNotice(removedMessages.length, removedTokens);
        const newMessages = [truncationNotice, ...keptMessages];
        
        truncationAppliedThisTurn = true;
        
        // Schedule proper compaction for after this request
        pendingCompaction = true;
        isAutoCompaction = true;
        autoCompactionPhase = "emergency";
        setImmediate(() => {
          ctx.compact({
            customInstructions: "Emergency context truncation was applied. Generate a comprehensive summary.",
            onComplete: () => {
              log("Post-truncation compaction completed");
              pendingCompaction = false;
            },
            onError: (error) => {
              log("Post-truncation compaction failed:", error.message);
              pendingCompaction = false;
              isAutoCompaction = false;
              autoCompactionPhase = null;
            },
          });
        });
        
        return { messages: newMessages };
      }
    }
    
    // No modification needed
    return;
  });

  // =========================================================================
  // Mid-turn compaction check (like Codex's MidTurn phase)
  // After tool execution, if we need to continue and tokens are high, compact
  // =========================================================================
  
  pi.on("turn_end", async (event, ctx) => {
    const { message, toolResults } = event;
    
    // Check if there will be follow-up (tool calls that need processing)
    // Assistant messages have content array with potential tool_use blocks
    let hasToolCalls = false;
    if (message.role === "assistant" && "content" in message && Array.isArray(message.content)) {
      hasToolCalls = message.content.some(
        (block: { type: string }) => block.type === "tool_use"
      );
    }
    
    if (!hasToolCalls) {
      return; // No follow-up needed
    }
    
    const tokens = getTokenUsage(ctx);
    log(`turn_end: ${tokens} tokens, hasToolCalls=${hasToolCalls}`);
    
    // If tokens exceed limit and there will be follow-up, trigger compaction
    if (tokens >= cachedAutoCompactLimit && !pendingCompaction) {
      log(`Mid-turn: Token limit reached with pending follow-up, triggering compaction`);
      pendingCompaction = true;
      isAutoCompaction = true;
      autoCompactionPhase = "mid-turn";
      
      ctx.compact({
        customInstructions: "Mid-turn compaction: preserve current task context and tool call results.",
        onComplete: () => {
          log("Mid-turn compaction completed");
          pendingCompaction = false;
        },
        onError: (error) => {
          log("Mid-turn compaction failed:", error.message);
          pendingCompaction = false;
          isAutoCompaction = false;
          autoCompactionPhase = null;
        },
      });
    }
  });

  // =========================================================================
  // Session events
  // =========================================================================
  
  pi.on("session_start", async (event, ctx) => {
    pendingCompaction = false;
    truncationAppliedThisTurn = false;
    lastEstimatedTokens = 0;
    isAutoCompaction = false;
    autoCompactionPhase = null;
    
    // Check initial context on resume
    if (event.reason === "resume" || event.reason === "fork") {
      const usage = ctx.getContextUsage();
      if (usage && usage.tokens !== null) {
        lastEstimatedTokens = usage.tokens;
        log(`Session ${event.reason}: initial tokens = ${usage.tokens}`);
        
        // Update limits for resumed session
        updateCachedLimits(ctx as unknown as { model?: { contextWindow?: number } });
        
        if (usage.tokens >= cachedAutoCompactLimit) {
          log(`Session start: Token limit already exceeded, triggering compaction`);
          isAutoCompaction = true;
          autoCompactionPhase = "pre-turn";
          ctx.compact({
            onComplete: () => log("Initial compaction completed"),
            onError: (error) => {
              log("Initial compaction failed:", error.message);
              isAutoCompaction = false;
              autoCompactionPhase = null;
            },
          });
        }
      }
    }
  });

  // =========================================================================
  // Detect manual /compact to prevent auto-continue
  // =========================================================================
  
  pi.on("session_before_compact", async (event, ctx) => {
    // If this compaction was NOT triggered by our extension (no autoCompactionPhase set),
    // it's likely a manual /compact command - ensure we don't send follow-up
    if (!autoCompactionPhase) {
      log("session_before_compact: Manual compaction detected, disabling auto-continue");
      isAutoCompaction = false;
    }
    // Don't cancel or modify the compaction, just track the source
    return;
  });

  // =========================================================================
  // Compaction completion: Auto-continue after automatic compaction
  // Like Codex's `continue` after run_auto_compact
  // =========================================================================
  
  pi.on("session_compact", async (event, ctx) => {
    const { compactionEntry, fromExtension } = event;
    
    log(`session_compact: fromExtension=${fromExtension}, isAutoCompaction=${isAutoCompaction}, phase=${autoCompactionPhase}`);
    
    // Only send follow-up for automatic compaction, not manual /compact
    if (isAutoCompaction && autoCompactionPhase) {
      const phase = autoCompactionPhase;
      
      // Reset state
      isAutoCompaction = false;
      autoCompactionPhase = null;
      
      // Generate appropriate follow-up message based on phase
      let followUpMessage: string;
      switch (phase) {
        case "pre-turn":
          followUpMessage = "Context was compacted before processing. Continue with the current task.";
          break;
        case "mid-turn":
          followUpMessage = "Context was compacted mid-turn. Continue executing the remaining work.";
          break;
        case "emergency":
          followUpMessage = "Emergency context compaction was applied. Resume the current task where we left off.";
          break;
        default:
          followUpMessage = "Context compacted. Continue.";
      }
      
      log(`Sending auto-continue message: "${followUpMessage}"`);
      
      // Use followUp delivery to wait for agent to finish, then continue
      pi.sendUserMessage(followUpMessage, { deliverAs: "followUp" });
    }
  });

  // =========================================================================
  // Configuration command
  // =========================================================================
  
  pi.registerCommand("codex-compact-config", {
    description: "Configure Codex-style compaction settings",
    handler: async (args, ctx) => {
      // Update limits based on current model
      updateCachedLimits(ctx as unknown as { model?: { contextWindow?: number } });
      
      if (!args) {
        ctx.ui.notify(
          `Codex Compact Config:\n` +
          `  autoCompactPercent: ${config.autoCompactPercent}%\n` +
          `  autoCompactTokenLimit: ${config.autoCompactTokenLimit} (used if percent=0)\n` +
          `  keepRecentPercent: ${config.keepRecentPercent}%\n` +
          `  debug: ${config.debug}\n` +
          `\n` +
          `Computed (from ${cachedContextWindow} context window):\n` +
          `  Auto-compact at: ${cachedAutoCompactLimit} tokens\n` +
          `  Keep recent: ${cachedKeepRecentTokens} tokens`,
          "info"
        );
        return;
      }
      
      const parts = args.split(" ");
      const key = parts[0] as keyof CodexCompactConfig;
      const value = parts[1];
      
      if (key === "debug") {
        config.debug = value === "true";
      } else if (key === "autoCompactPercent" || key === "autoCompactTokenLimit" || key === "keepRecentPercent") {
        const num = parseInt(value, 10);
        if (!isNaN(num)) {
          config[key] = num;
          // Recompute cached limits
          cachedAutoCompactLimit = computeAutoCompactLimit(cachedContextWindow);
          cachedKeepRecentTokens = computeKeepRecentTokens(cachedContextWindow);
        }
      }
      
      ctx.ui.notify(`Set ${key} = ${config[key as keyof CodexCompactConfig]}`, "success");
    },
  });

  // =========================================================================
  // Status command
  // =========================================================================
  
  pi.registerCommand("codex-compact-status", {
    description: "Show current compaction status",
    handler: async (_args, ctx) => {
      const usage = ctx.getContextUsage();
      const tokens = usage?.tokens ?? lastEstimatedTokens;
      const percent = usage?.percent ?? (cachedAutoCompactLimit > 0 ? (tokens / cachedAutoCompactLimit * 100) : 0);
      
      ctx.ui.notify(
        `Codex Compact Status:\n` +
        `  Current tokens: ~${Math.round(tokens / 1000)}K\n` +
        `  Limit: ${Math.round(cachedAutoCompactLimit / 1000)}K (${config.autoCompactPercent}% of ${Math.round(cachedContextWindow / 1000)}K)\n` +
        `  Usage: ${percent.toFixed(1)}%\n` +
        `  Pending compaction: ${pendingCompaction}\n` +
        `  Auto compaction: ${isAutoCompaction} (${autoCompactionPhase ?? "none"})\n` +
        `  Truncation this turn: ${truncationAppliedThisTurn}`,
        "info"
      );
    },
  });

  // Listen for model changes to update limits
  pi.on("model_select", async (event, ctx) => {
    const contextWindow = event.model?.contextWindow ?? 200000;
    updateCachedLimits({ model: { contextWindow } });
    log(`Model changed to ${event.model?.id}, context window: ${contextWindow}`);
  });

  log("Codex-style compaction extension loaded");
  log(`Config: autoCompactPercent=${config.autoCompactPercent}%, keepRecentPercent=${config.keepRecentPercent}%`);
}
