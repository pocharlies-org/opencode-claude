/**
 * Tool results as the host executed them, keyed by tool-call id.
 *
 * A parked Claude turn waits for the results of the tool calls it handed to
 * the host, and normally finds them as `role: "tool"` messages in the next
 * request. OpenCode 2 breaks that when it compacts in the middle of a turn: the
 * next request carries the recent history as TEXT inside the checkpoint, the
 * proxy finds no result for the pending call, and re-emits it — so the host
 * runs the same tool a second time (measured: `echo` executed twice around an
 * automatic compaction).
 *
 * The OpenCode 2 plugin runs in the same process as the proxy and sees every
 * tool execution (`tool.hook("execute.after")`), so it drops the result here;
 * the proxy uses it when the request does not carry it. OpenCode 1 never fills
 * this, so nothing changes there.
 */
const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 500;

// Process-global, not module-global: OpenCode 2 imports the plugin once per
// location, and only the first import runs the proxy — the location whose hook
// records a result is often not the one whose proxy reads it (measured: the
// store was empty on the proxy side until this lived on globalThis).
const STORE = Symbol.for("opencode-claude.tool-results");
const results: Map<string, { text: string; at: number }> =
  ((globalThis as Record<symbol, unknown>)[STORE] as Map<string, { text: string; at: number }>) ??
  ((globalThis as Record<symbol, unknown>)[STORE] = new Map());

function prune(now: number): void {
  for (const [id, entry] of results) {
    if (now - entry.at > TTL_MS || results.size > MAX_ENTRIES) results.delete(id);
    else break; // insertion order: the rest is newer
  }
}

export function rememberToolResult(callId: string, text: string): void {
  if (!callId) return;
  const now = Date.now();
  results.delete(callId);
  results.set(callId, { text, at: now });
  prune(now);
}

/** The remembered result for a call, forgotten on read. */
export function takeToolResult(callId: string): string | undefined {
  const entry = results.get(callId);
  if (!entry) return undefined;
  results.delete(callId);
  return Date.now() - entry.at > TTL_MS ? undefined : entry.text;
}

/** V2 `Tool.Result` / `Tool.Error` as the text a tool message would carry. */
export function toolResultText(result: unknown, error?: unknown): string {
  if (error) {
    const message =
      error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : String(error);
    return `Error: ${message}`;
  }
  if (!result || typeof result !== "object") return String(result ?? "");
  const r = result as { content?: unknown; output?: unknown };
  if (typeof r.content === "string") return r.content;
  if (Array.isArray(r.content)) {
    return r.content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const p = part as { type?: unknown; text?: unknown; uri?: unknown };
        if (p.type === "text" && typeof p.text === "string") return p.text;
        if (p.type === "file" && typeof p.uri === "string") return `[file ${p.uri}]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (r.output !== undefined) {
    return typeof r.output === "string" ? r.output : JSON.stringify(r.output);
  }
  return "";
}
