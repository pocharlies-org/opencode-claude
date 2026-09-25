/**
 * Convert Claude Agent SDK result usage into OpenAI-compatible usage objects.
 *
 * Prefer `modelUsage` for totals (includes compact / auxiliary pipeline calls).
 * Fall back to per-turn `usage` (main agent loop only).
 */

export type OpenAIUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  /** Estimated USD from the Agent SDK (not a billing statement). */
  cost_usd?: number;
  /** Per-model breakdown when the SDK provides modelUsage. */
  model_usage?: Record<
    string,
    {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens: number;
      cache_creation_input_tokens: number;
      cost_usd: number;
      context_window?: number;
    }
  >;
};

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function fromAnthropicUsage(usage: Record<string, unknown>): OpenAIUsage {
  const prompt = asNumber(usage.input_tokens);
  const completion = asNumber(usage.output_tokens);
  const cached = asNumber(usage.cache_read_input_tokens);
  const cacheWrite = asNumber(usage.cache_creation_input_tokens);
  const details: NonNullable<OpenAIUsage["prompt_tokens_details"]> = {};
  if (cached > 0) details.cached_tokens = cached;
  if (cacheWrite > 0) details.cache_write_tokens = cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(Object.keys(details).length ? { prompt_tokens_details: details } : {}),
  };
}

function fromModelUsage(
  modelUsage: Record<string, unknown>,
): OpenAIUsage | null {
  let prompt = 0;
  let completion = 0;
  let cached = 0;
  let cacheWrite = 0;
  let cost = 0;
  const breakdown: NonNullable<OpenAIUsage["model_usage"]> = {};
  let any = false;

  for (const [modelId, raw] of Object.entries(modelUsage)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    any = true;
    const input = asNumber(entry.inputTokens);
    const output = asNumber(entry.outputTokens);
    const cacheRead = asNumber(entry.cacheReadInputTokens);
    const cacheCreate = asNumber(entry.cacheCreationInputTokens);
    const costUSD = asNumber(entry.costUSD);
    prompt += input;
    completion += output;
    cached += cacheRead;
    cacheWrite += cacheCreate;
    cost += costUSD;
    breakdown[modelId] = {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreate,
      cost_usd: costUSD,
      ...(typeof entry.contextWindow === "number"
        ? { context_window: entry.contextWindow }
        : {}),
    };
  }

  if (!any) return null;
  const details: NonNullable<OpenAIUsage["prompt_tokens_details"]> = {};
  if (cached > 0) details.cached_tokens = cached;
  if (cacheWrite > 0) details.cache_write_tokens = cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(Object.keys(details).length ? { prompt_tokens_details: details } : {}),
    ...(cost > 0 ? { cost_usd: cost } : {}),
    ...(Object.keys(breakdown).length ? { model_usage: breakdown } : {}),
  };
}

/**
 * Extract OpenAI-compatible usage from an Agent SDK `result` event.
 */
export function usageFromSdkResult(event: unknown): OpenAIUsage | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  if (e.type !== "result") return null;

  if (e.modelUsage && typeof e.modelUsage === "object") {
    const fromModels = fromModelUsage(
      e.modelUsage as Record<string, unknown>,
    );
    if (fromModels) {
      if (
        typeof e.total_cost_usd === "number" &&
        Number.isFinite(e.total_cost_usd) &&
        fromModels.cost_usd === undefined
      ) {
        fromModels.cost_usd = e.total_cost_usd;
      }
      return fromModels;
    }
  }

  if (e.usage && typeof e.usage === "object") {
    const usage = fromAnthropicUsage(e.usage as Record<string, unknown>);
    if (
      typeof e.total_cost_usd === "number" &&
      Number.isFinite(e.total_cost_usd)
    ) {
      usage.cost_usd = e.total_cost_usd;
    }
    return usage;
  }

  return null;
}

export function formatCompactNote(meta: unknown): string {
  if (!meta || typeof meta !== "object") {
    return "[compact] Conversation compacted.\n";
  }
  const m = meta as Record<string, unknown>;
  const trigger = typeof m.trigger === "string" ? m.trigger : "auto";
  const pre = asNumber(m.pre_tokens);
  const post =
    typeof m.post_tokens === "number" && Number.isFinite(m.post_tokens)
      ? m.post_tokens
      : null;
  const duration =
    typeof m.duration_ms === "number" && Number.isFinite(m.duration_ms)
      ? m.duration_ms
      : null;
  const parts = [`[compact] Conversation compacted (${trigger})`];
  if (pre > 0) {
    parts.push(
      post !== null
        ? `tokens ${pre} → ${post}`
        : `pre_tokens ${pre}`,
    );
  }
  if (duration !== null) parts.push(`${duration}ms`);
  return `${parts.join("; ")}.\n`;
}

/**
 * Usage of ONE HTTP response (one host step), read call by call off the SDK
 * stream.
 *
 * The SDK `result` event is the wrong source for the host: it arrives once per
 * Claude turn — after the whole tool loop — and sums every API call of it, so
 * N calls against a 200k-token context read as N×200k of cache. Parked
 * tool-call responses got no usage at all. OpenCode 2 sizes the context from
 * the last step's usage and, finding nothing usable, estimated it from its own
 * copy of the history, then compacted sessions whose real context lives in
 * Claude Code.
 *
 * What a step's usage means to the host: the context of the LAST API call in
 * it (uncached input + cache read + cache write — the prompt that call sent)
 * and the output of every call in it. In OpenAI terms that is `prompt_tokens`
 * INCLUDING the cached part, which OpenAI-compatible hosts subtract back out
 * through `prompt_tokens_details`.
 *
 * Subagent calls (`parent_tool_use_id`) are skipped: they run in their own
 * context, not this conversation's.
 */
export type StepUsageTracker = {
  observe(event: unknown): void;
  /** OpenAI-shaped usage of the calls seen so far, or null if none. */
  snapshot(): OpenAIUsage | null;
};

type CallUsage = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
};

export function createStepUsageTracker(): StepUsageTracker {
  const calls = new Map<string, CallUsage>();
  let lastId: string | null = null;
  let anonymous = 0;

  const merge = (id: string, raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const u = raw as Record<string, unknown>;
    const current = calls.get(id) ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    // Fields are cumulative per call (message_start, then message_delta, then
    // the assembled assistant message): keep the largest value seen.
    current.input = Math.max(current.input, asNumber(u.input_tokens));
    current.cacheRead = Math.max(current.cacheRead, asNumber(u.cache_read_input_tokens));
    current.cacheWrite = Math.max(
      current.cacheWrite,
      asNumber(u.cache_creation_input_tokens),
    );
    current.output = Math.max(current.output, asNumber(u.output_tokens));
    if (!calls.has(id)) lastId = id;
    calls.set(id, current);
  };

  return {
    observe(event) {
      if (!event || typeof event !== "object") return;
      const e = event as Record<string, unknown>;
      if (e.parent_tool_use_id) return;
      if (e.type === "stream_event" && e.event && typeof e.event === "object") {
        const ev = e.event as Record<string, unknown>;
        if (ev.type === "message_start" && ev.message && typeof ev.message === "object") {
          const message = ev.message as Record<string, unknown>;
          const id = typeof message.id === "string" ? message.id : `call-${++anonymous}`;
          merge(id, message.usage);
        } else if (ev.type === "message_delta" && lastId) {
          merge(lastId, ev.usage);
        }
        return;
      }
      if (e.type === "assistant" && e.message && typeof e.message === "object") {
        const message = e.message as Record<string, unknown>;
        if (typeof message.id === "string") merge(message.id, message.usage);
      }
    },
    snapshot() {
      if (!lastId) return null;
      const last = calls.get(lastId)!;
      let output = 0;
      for (const call of calls.values()) output += call.output;
      const prompt = last.input + last.cacheRead + last.cacheWrite;
      const details: NonNullable<OpenAIUsage["prompt_tokens_details"]> = {};
      if (last.cacheRead > 0) details.cached_tokens = last.cacheRead;
      if (last.cacheWrite > 0) details.cache_write_tokens = last.cacheWrite;
      return {
        prompt_tokens: prompt,
        completion_tokens: output,
        total_tokens: prompt + output,
        ...(Object.keys(details).length ? { prompt_tokens_details: details } : {}),
      };
    },
  };
}

/**
 * The turn aggregate (`usageFromSdkResult`) in the shape an OpenAI-compatible
 * host reads: `prompt_tokens` there counts only uncached input, and the host
 * subtracts cache read and write from it — which zeroed the input. Used only
 * when the stream carried no per-call usage.
 */
export function hostUsageFromTurnTotal(usage: OpenAIUsage): OpenAIUsage {
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = usage.prompt_tokens_details?.cache_write_tokens ?? 0;
  const prompt = usage.prompt_tokens + cached + cacheWrite;
  return {
    ...usage,
    prompt_tokens: prompt,
    total_tokens: prompt + usage.completion_tokens,
  };
}
