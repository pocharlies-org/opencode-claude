/**
 * Resolve the `claude` CLI binary (from OpenChamber harness executable-path).
 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildClaudeCodeChildEnv } from "./auth-env.js";

function probeClaude(
  candidate: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): boolean {
  try {
    const result = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      timeout: 4000,
      env: buildClaudeCodeChildEnv(env) as NodeJS.ProcessEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) return false;
    return result.status === 0 || Boolean((result.stdout || "").trim());
  } catch {
    return false;
  }
}

/**
 * Install locations a service manager's PATH commonly misses because it is
 * not a login shell's PATH: the official installer's `~/.local/bin` and the
 * npm global bin. The systemd unit serving the proxy hit exactly this on
 * 2026-09-09 (SC-51): `claude` lived in `~/.local/bin`, the unit's PATH did
 * not include it, token refresh died with "no claude binary found", and the
 * quota store silently stopped updating for days.
 */
function knownClaudeLocations(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string[] {
  const home = typeof env.HOME === "string" && env.HOME ? env.HOME : homedir();
  const candidates = [join(home, ".local", "bin", "claude")];

  try {
    // The provided env, not the ambient one: resolution must be reproducible
    // (tests) and must not resurrect the very PATH the caller declared blind.
    const prefix = spawnSync("npm", ["prefix", "-g"], {
      encoding: "utf8",
      timeout: 6000,
      env: buildClaudeCodeChildEnv(env) as NodeJS.ProcessEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const dir = `${prefix.stdout || ""}`.trim();
    if (dir) candidates.push(join(dir, "bin", "claude"));
  } catch {
    // no npm prefix available — PATH and ~/.local/bin remain
  }
  return candidates;
}

export function findBinaryOnPath(
  name: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | null {
  const pathEnv = typeof env.PATH === "string" ? env.PATH : "";
  const parts = pathEnv.split(process.platform === "win32" ? ";" : ":");
  const exts =
    process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of parts) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = `${dir.replace(/[/\\]$/, "")}/${name}${ext}`;
      if (probeClaude(candidate, env)) return candidate;
    }
  }

  try {
    if (probeClaude(name, env)) return name;
  } catch {
    // missing
  }
  return null;
}

/**
 * `claude` as a service sees it: PATH first, then the install locations a
 * clean service environment usually cannot see.
 *
 * Resolution is memoized per PATH+HOME: each probe is a synchronous spawn
 * (`npm prefix -g`, `claude --version`) that blocks the event loop, and this
 * runs on every Agent SDK query and every token refresh. Only positive hits
 * are memoized — a CLI installed mid-process must be found on the next call.
 */
let cachedResolution: { key: string; path: string } | null = null;

export function resolveClaudeCli(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | null {
  const key = `${env.PATH ?? ""} ${env.HOME ?? ""}`;
  if (cachedResolution && cachedResolution.key === key) {
    return cachedResolution.path;
  }
  const resolved =
    findBinaryOnPath("claude", env) ??
    knownClaudeLocations(env).find((candidate) => probeClaude(candidate, env)) ??
    null;
  if (resolved) cachedResolution = { key, path: resolved };
  return resolved;
}

/** Test hook: drop the memoized resolution. */
export function resetClaudeCliResolutionCache(): void {
  cachedResolution = null;
}

export function resolveClaudeCodeExecutable(options?: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): string | null {
  return resolveClaudeCli(options?.env ?? process.env);
}

export function assertClaudeWorkingDirectory(cwd: unknown): string {
  return typeof cwd === "string" && cwd.trim() ? cwd.trim() : process.cwd();
}
