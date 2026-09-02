/**
 * Operator-editable overlay for the model catalog.
 *
 * The shipped catalog lives in `models.ts`, in code, and that makes a new
 * model cost a rebuild AND a restart of the whole host: OpenCode imports a
 * plugin exactly once and the ESM module cache holds that copy for the life of
 * the process, so editing the source changes nothing until the server comes
 * back up. Anthropic ships faster than that is comfortable — `claude-fable-5-1`
 * was answering on the API while the installed CLI's own alias table still
 * read `["fable",[5]]`.
 *
 * So the catalog is data, not just code. This file is re-read on every catalog
 * build, which means adding a model is editing JSON: no rebuild, no
 * re-importing the plugin, and no dropping the sessions that are mid-turn.
 *
 * `~/.local/share/opencode-claude/models.json`, or wherever
 * `OPENCODE_CLAUDE_MODELS_FILE` points:
 *
 *     {
 *       "models": [
 *         {
 *           "id": "claude-fable-5-2",
 *           "name": "Fable 5.2",
 *           "contextWindow": 1000000,
 *           "maxTokens": 128000,
 *           "resolvedId": "claude-fable-5-2[1m]",
 *           "cost": { "input": 10, "output": 50 }
 *         }
 *       ]
 *     }
 *
 * An entry whose `id` matches a shipped model REPLACES it, so a wrong context
 * window or a stale price is fixable in place without waiting for a release.
 * `"hidden": true` drops one from the picker. Anything else is appended.
 *
 * Every failure here degrades to the shipped catalog: no file, a syntax error,
 * an entry with no id, a negative window. A hand-edited JSON must never be
 * able to empty the model picker — that would trade "restart to add a model"
 * for "one stray comma and the provider is dead", which is a worse deal than
 * the one we started with.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./log.js";

export type CatalogOverlayEntry = {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  resolvedId?: string;
  reasoning?: boolean;
  hidden?: boolean;
  cost?: { input: number; output: number };
};

export function catalogOverlayPath(): string {
  const override = process.env.OPENCODE_CLAUDE_MODELS_FILE;
  if (override && override.trim()) return override.trim();
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ? xdg : join(homedir(), ".local", "share");
  return join(base, "opencode-claude", "models.json");
}

/**
 * Read and parse on every call, deliberately.
 *
 * The first version cached on `mtime`+`size` to save a parse, and it was
 * wrong in the exact case this feature exists for: editing `claude-fable-5-1`
 * to `claude-fable-5-2` changes neither the size nor, within the same
 * millisecond, the mtime — so the edit was silently ignored and the operator
 * would be back to blaming the restart. A stale catalog that looks fresh is
 * worse than no cache at all. The file is under a couple of kilobytes and the
 * alternative to reading it is restarting a server, so this is not the place
 * to save microseconds.
 *
 * The only thing worth remembering between calls is the last failure, so a
 * broken file is reported once instead of once per `/v1/models` request.
 */
let lastFailure: string | null = null;

function reportFailure(signature: string, emit: () => void): void {
  if (lastFailure === signature) return;
  lastFailure = signature;
  emit();
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseCost(raw: unknown): { input: number; output: number } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const input = positive(source["input"]);
  const output = positive(source["output"]);
  if (input === undefined || output === undefined) return undefined;
  return { input, output };
}

/**
 * Returns null for anything unusable. The caller reports the skipped ones in
 * one message: this runs per request, so a warn per bad entry per call would
 * bury the log rather than inform it.
 */
function parseEntry(raw: unknown): CatalogOverlayEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const id = nonEmpty(source["id"]);
  if (!id) return null;
  const cost = parseCost(source["cost"]);
  return {
    id,
    ...(nonEmpty(source["name"]) ? { name: nonEmpty(source["name"])! } : {}),
    ...(positive(source["contextWindow"])
      ? { contextWindow: positive(source["contextWindow"])! }
      : {}),
    ...(positive(source["maxTokens"])
      ? { maxTokens: positive(source["maxTokens"])! }
      : {}),
    ...(nonEmpty(source["resolvedId"])
      ? { resolvedId: nonEmpty(source["resolvedId"])! }
      : {}),
    ...(typeof source["reasoning"] === "boolean"
      ? { reasoning: source["reasoning"] }
      : {}),
    ...(source["hidden"] === true ? { hidden: true as const } : {}),
    ...(cost ? { cost } : {}),
  };
}

export function readCatalogOverlay(): CatalogOverlayEntry[] {
  const path = catalogOverlayPath();

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // No file is the normal case — the shipped catalog is the whole story
    // until an operator decides otherwise.
    lastFailure = null;
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    const list =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)["models"]
        : undefined;
    if (!Array.isArray(list)) {
      reportFailure(`shape:${path}`, () =>
        log.warn(`[opencode-claude] models.json has no "models" array`, { path }),
      );
      return [];
    }
    const entries: CatalogOverlayEntry[] = [];
    const skipped: number[] = [];
    list.forEach((entry, index) => {
      const parsed = parseEntry(entry);
      if (parsed) entries.push(parsed);
      else skipped.push(index);
    });
    if (skipped.length) {
      reportFailure(`entries:${path}:${skipped.join(",")}`, () =>
        log.warn("[opencode-claude] models.json: skipped entries with no usable id", {
          path,
          index: skipped,
        }),
      );
    } else {
      lastFailure = null;
    }
    return entries;
  } catch (err) {
    // Keep serving the shipped catalog: a stray comma must not empty the
    // model picker.
    const message = err instanceof Error ? err.message : String(err);
    reportFailure(`parse:${path}:${message}`, () =>
      log.warn("[opencode-claude] could not parse models.json", { path, message }),
    );
    return [];
  }
}
