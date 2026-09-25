/**
 * Host-side compaction for claude-code sessions: there is nothing to compact.
 *
 * The proxy resumes the same Claude Code session on every turn and sends it
 * only the new message; the conversation's context lives in Claude Code, which
 * compacts it on its own. The host's copy of the history never reaches Claude,
 * so summarising it buys nothing — and doing it cost a model call that could
 * fail and stop the turn (OpenCode 2 rejects any summary that misses its
 * template, and the fast Messages-API path is refused once the account has no
 * extra usage).
 *
 * So a compaction is answered locally, with a checkpoint that says so. On
 * OpenCode 2 the plugin supplies it through the `compaction` session hook and
 * the host never makes the request; the proxy gives the same answer to any
 * summary request that still reaches it (OpenCode 1, or a V2 host without the
 * hook), never calling Anthropic for it.
 */
import { extractTextContent } from "./prompt.js";

const CONTEXT_NOTE =
  "The conversation context is kept by Claude Code: the opencode-claude provider resumes the same Claude Code session on every turn, sends it only the new message, and Claude Code compacts that context itself. This checkpoint was written without a model call and does not summarise the conversation — the recent messages kept after it carry on from here.";

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/**
 * A checkpoint in OpenCode 2's summary template (its headings are what the host
 * checks), carrying the latest request so the checkpoint is not empty.
 */
export function claudeCodeCompactionCheckpoint(latestRequest?: string): string {
  const request = latestRequest ? oneLine(latestRequest, 300) : "";
  return [
    "## Objective",
    `- ${request || "(see the most recent messages)"}`,
    "",
    "## Requirements",
    "- (none)",
    "",
    "## Decisions",
    "- (none)",
    "",
    "## Work State",
    "### Completed",
    "- (none)",
    "",
    "### Active",
    "- (see the most recent messages)",
    "",
    "### Blocked",
    "- (none)",
    "",
    "## Next Move",
    "1. Continue from the most recent messages.",
    "",
    "## Relevant Files",
    "- (none)",
    "",
    "## Important Context",
    `- ${CONTEXT_NOTE}`,
  ].join("\n");
}

type ChatMessage = { role?: string; content?: unknown };

function lastText(messages: ChatMessage[], role: string, skipLast = false): string {
  const list = skipLast ? messages.slice(0, -1) : messages;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role !== role) continue;
    const text = extractTextContent(list[i].content).trim();
    if (text) return text;
  }
  return "";
}

/**
 * The proxy's answer to a summary request (OpenAI chat messages), with no
 * model call:
 * - OpenCode 2's compaction prompt (it carries the template) → the checkpoint;
 * - OpenCode 2's session summary ("write like a pull request description") →
 *   the opening of the last assistant reply, which is what that line is for;
 * - anything else (OpenCode 1's compaction) → the plain note.
 */
export function localSummaryAnswer(messages: ChatMessage[]): string {
  const prompt = lastText(messages, "user");
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => extractTextContent(m.content))
    .join("\n")
    .toLowerCase();
  if (prompt.includes("## Objective")) {
    // The template request is the last user message; the real latest request
    // sits before it.
    return claudeCodeCompactionCheckpoint(lastText(messages, "user", true));
  }
  if (
    system.includes("write like a pull request description") ||
    prompt.toLowerCase().includes("write like a pull request description")
  ) {
    const reply = lastText(messages, "assistant");
    if (reply) return oneLine(reply, 400);
  }
  return CONTEXT_NOTE;
}
