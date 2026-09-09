/**
 * Automatic quota failover between Claude accounts (SC-102 / SC-17).
 *
 * When the rate-limit gate confirms a hard subscription limit on the account
 * serving a conversation, the turn used to end there — 429 + Retry-After for
 * hours while other subscriptions sat idle. This module decides, at that
 * exact point, whether the conversation can continue on another account.
 *
 * Eligibility matrix (CA-8) — what may trigger a switch:
 *   quota hard limit (rateLimitGate blocked)            YES
 *   auth / 401, 400 invalid input, model incompatibility,
 *   tool failure, local error, unclassified 5xx         NO (never reaches here)
 *   Anthropic `anthropic-ratelimit-unified-fallback`    NO — provider metadata
 *     header                                              only; it neither
 *                                                           triggers failover
 *                                                           nor records it
 *
 * Selection rules:
 * - CA-2: destinations are ranked by USABLE quota from the single existing
 *   source (quota.ts store + rate-limit.ts snapshots). No poller, no fresh
 *   usage fetch (CA-7) — a second source of quota truth is forbidden.
 *   Absent, stale or inconclusive data NEVER counts as available; it is
 *   distinguished from a measured zero in the trace.
 * - CA-3: accounts sharing a login (identity) or an organization (quota
 *   store) with the origin are the SAME budget and are never destinations.
 * - CA-4: a just-failed account/pool is not re-elected until a declared
 *   cooldown expires (naturally its window's resetsAt, floored at a
 *   configurable minimum). Switches per request are bounded. Cooldowns are
 *   per account — an exhausted pool never blocks another one's failover.
 * - CA-5: every decision is traced (see FailoverEvent) with quota source and
 *   age, no secrets. The trace is separate from the provider `fallback`
 *   metadata by construction.
 *
 * Store: $XDG_DATA_HOME/opencode-claude/failover.json
 * Env:
 * - OPENCODE_CLAUDE_FAILOVER=off                  — rollback: stop new switches (CA-11)
 * - OPENCODE_CLAUDE_FAILOVER_STORE                — override store path (tests)
 * - OPENCODE_CLAUDE_FAILOVER_MAX_QUOTA_AGE_MS     — freshest quota accepted as a destination verdict (default 900000 = 15 min)
 * - OPENCODE_CLAUDE_FAILOVER_MIN_COOLDOWN_MS      — cooldown floor when no reset time is known (default 300000 = 5 min)
 * - OPENCODE_CLAUDE_FAILOVER_MAX_SWITCHES         — max switches per request (default 1; destinations are never chained within one request)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAccounts, type ClaudeAccount } from "./accounts.js";
import { accountsSharingLogin } from "./identity.js";
import { accountsSharingSubscription, getAccountQuota } from "./quota.js";
import { rateLimitGate } from "./rate-limit.js";

export type FailoverOutcome = "switched" | "no_destination";

export type FailoverQuotaRef = {
  /** Where the number came from: the quota store's own source field. */
  source?: string;
  /** Age of the reading at decision time. */
  ageMs: number;
  /** Smallest fraction left across measured windows, when any. */
  headroom?: number;
};

export type FailoverCandidateView = {
  account: string;
  eligible: boolean;
  /** Why eligible, or the exclusion. Stable vocabulary, no secrets. */
  reason: string;
  headroom?: number;
};

export type FailoverEvent = {
  /** Event type tag — CA-5's `account_failover` trace. */
  type: "account_failover";
  ts: number;
  /** OpenCode session / conversation key. Never a credential. */
  sessionId: string;
  /** 1-based count of failover decisions for this session. */
  attempt: number;
  from: string;
  to: string | null;
  /** What triggered the decision: only the quota gate today. */
  reason: "quota_gate_429";
  fromQuota: FailoverQuotaRef;
  toQuota?: FailoverQuotaRef;
  outcome: FailoverOutcome;
  candidates: FailoverCandidateView[];
};

type CooldownEntry = { until: number; reason: string; setAt: number };

type FailoverStore = {
  version: 1;
  cooldowns: Record<string, CooldownEntry>;
  events: FailoverEvent[];
};

const MAX_EVENTS = 200;

const WINDOWS: ReadonlyArray<["fiveHour" | "sevenDay" | "opus", string]> = [
  ["fiveHour", "5h"],
  ["sevenDay", "7d"],
  ["opus", "opus"],
];

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** CA-11 rollback: `OPENCODE_CLAUDE_FAILOVER=off` ceases new switches. */
export function failoverEnabled(): boolean {
  const flag = (process.env.OPENCODE_CLAUDE_FAILOVER ?? "").toLowerCase();
  return flag !== "off" && flag !== "0" && flag !== "false";
}

/** Max destination switches within one request. Never chained beyond this. */
export function maxSwitchesPerRequest(): number {
  return Math.max(0, envInt("OPENCODE_CLAUDE_FAILOVER_MAX_SWITCHES", 1));
}

function maxQuotaAgeMs(): number {
  return envInt("OPENCODE_CLAUDE_FAILOVER_MAX_QUOTA_AGE_MS", 900_000);
}

function minCooldownMs(): number {
  return envInt("OPENCODE_CLAUDE_FAILOVER_MIN_COOLDOWN_MS", 300_000);
}

function storePath(): string {
  const override = process.env.OPENCODE_CLAUDE_FAILOVER_STORE;
  if (override && override.trim()) return override.trim();
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ? xdg : join(homedir(), ".local", "share");
  return join(base, "opencode-claude", "failover.json");
}

function normalizeKey(accountId?: string): string {
  const key = accountId?.trim().toLowerCase();
  return key || "default";
}

function readStore(): FailoverStore {
  const path = storePath();
  if (!existsSync(path)) return { version: 1, cooldowns: {}, events: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const root = (parsed ?? {}) as Record<string, unknown>;
    return {
      version: 1,
      cooldowns:
        root.cooldowns && typeof root.cooldowns === "object"
          ? (root.cooldowns as Record<string, CooldownEntry>)
          : {},
      events: Array.isArray(root.events) ? (root.events as FailoverEvent[]) : [],
    };
  } catch {
    return { version: 1, cooldowns: {}, events: [] };
  }
}

function writeStore(store: FailoverStore): void {
  try {
    const path = storePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf8");
  } catch {
    // failover bookkeeping must never break a turn
  }
}

/**
 * Cooldown for an account that just failed over away from (CA-4). Durable on
 * purpose: a process restart must not resurrect the pool that was just
 * proven exhausted (CA-10).
 */
export function failoverCooldown(
  accountId: string,
  now: number = Date.now(),
): CooldownEntry | null {
  const entry = readStore().cooldowns[normalizeKey(accountId)];
  if (!entry || entry.until <= now) return null;
  return entry;
}

/**
 * Put an account out of the destination pool until `until`. The natural end
 * is the exhausted window's resetsAt; with no reset time known, the floor is
 * OPENCODE_CLAUDE_FAILOVER_MIN_COOLDOWN_MS.
 */
export function recordFailoverCooldown(
  accountId: string,
  until: number | undefined,
  reason: string,
  now: number = Date.now(),
): CooldownEntry {
  const store = readStore();
  const entry: CooldownEntry = {
    until: Math.max(until ?? 0, now + minCooldownMs()),
    reason,
    setAt: now,
  };
  store.cooldowns[normalizeKey(accountId)] = entry;
  writeStore(store);
  return entry;
}

export type FailoverDecision = {
  /** Best eligible destination, if any. */
  destination?: ClaudeAccount;
  candidates: FailoverCandidateView[];
  /** One-line summary of why nothing was usable, for the 429 message. */
  summary?: string;
};

function quotaRef(accountId: string, now: number): FailoverQuotaRef {
  const quota = getAccountQuota(accountId);
  if (!quota) return { ageMs: now };
  let headroom: number | undefined;
  for (const [key] of WINDOWS) {
    const remaining = quota.windows[key]?.remaining;
    if (typeof remaining === "number") {
      headroom = headroom === undefined ? remaining : Math.min(headroom, remaining);
    }
  }
  return {
    source: quota.source,
    ageMs: Math.max(0, now - quota.fetchedAt),
    ...(headroom !== undefined ? { headroom } : {}),
  };
}

/**
 * Evaluate every registry account as a failover destination for `originId`.
 *
 * Reads ONLY the existing stores (quota.json, rate-limit.json, identity.json,
 * accounts.json) — the single-source rule (CA-7). The verdict vocabulary
 * distinguishes a measured zero from stale/unknown/inconclusive data (CA-2):
 * all of them disqualify a destination, but the trace says which one it was.
 *
 * `isAuthenticated` is injected like pickAccountForNewConversation: whether
 * an account has credentials on disk is the proxy's question.
 */
export function selectFailoverDestination(
  originId: string,
  opts?: {
    now?: number;
    isAuthenticated?: (account: ClaudeAccount) => boolean;
  },
): FailoverDecision {
  const now = opts?.now ?? Date.now();
  const maxAge = maxQuotaAgeMs();
  const authenticated = opts?.isAuthenticated ?? (() => true);
  const origin = normalizeKey(originId);

  // CA-3: same login or same organization = one budget. Neither half of a
  // shared budget may be the destination for the other.
  const sharedBudget = new Set<string>([
    origin,
    ...accountsSharingLogin(origin).map(normalizeKey),
    ...accountsSharingSubscription(origin).map(normalizeKey),
  ]);

  const candidates: FailoverCandidateView[] = [];
  for (const account of getAccounts()) {
    const id = normalizeKey(account.id);
    if (sharedBudget.has(id)) {
      candidates.push({
        account: id,
        eligible: false,
        reason: id === origin ? "origin" : "shares budget with origin (login/org)",
      });
      continue;
    }
    if (!authenticated(account)) {
      candidates.push({ account: id, eligible: false, reason: "not authenticated" });
      continue;
    }
    const cooldown = failoverCooldown(id, now);
    if (cooldown) {
      candidates.push({
        account: id,
        eligible: false,
        reason: `in cooldown until ${new Date(cooldown.until).toISOString()} (${cooldown.reason})`,
      });
      continue;
    }
    if (rateLimitGate(now, id).blocked) {
      candidates.push({ account: id, eligible: false, reason: "rate limit hit" });
      continue;
    }
    const quota = getAccountQuota(id);
    if (!quota) {
      candidates.push({ account: id, eligible: false, reason: "no quota data (unknown)" });
      continue;
    }
    const ageMs = now - quota.fetchedAt;
    if (ageMs > maxAge) {
      candidates.push({
        account: id,
        eligible: false,
        reason: `quota data stale (${Math.round(ageMs / 60_000)}m old > ${Math.round(maxAge / 60_000)}m)`,
      });
      continue;
    }
    let headroom: number | undefined;
    let disqualified: string | undefined;
    for (const [key, label] of WINDOWS) {
      const win = quota.windows[key];
      if (!win || typeof win.remaining !== "number") continue;
      if (win.remaining <= 0) {
        disqualified =
          win.resetsAt !== undefined && win.resetsAt > now
            ? `${label} window spent (resets ${new Date(win.resetsAt).toISOString()})`
            : `${label} window at zero with no reset stamp (inconclusive)`;
        break;
      }
      headroom = headroom === undefined ? win.remaining : Math.min(headroom, win.remaining);
    }
    if (disqualified) {
      candidates.push({ account: id, eligible: false, reason: disqualified });
      continue;
    }
    if (headroom === undefined) {
      candidates.push({
        account: id,
        eligible: false,
        reason: "no quota windows measured (unknown)",
      });
      continue;
    }
    if (headroom <= 0) {
      candidates.push({ account: id, eligible: false, reason: "no headroom" });
      continue;
    }
    candidates.push({
      account: id,
      eligible: true,
      reason: `usable (${Math.round(headroom * 100)}% left, ${Math.round(ageMs / 60_000)}m old)`,
      headroom,
    });
  }

  const eligible = candidates
    .filter((c) => c.eligible)
    .sort(
      (a, b) =>
        (b.headroom ?? -1) - (a.headroom ?? -1) || a.account.localeCompare(b.account),
    );
  const best = eligible[0];
  if (!best) {
    return {
      candidates,
      summary: candidates
        .filter((c) => c.account !== origin)
        .map((c) => `${c.account}: ${c.reason}`)
        .join("; ") || "no other accounts in the registry",
    };
  }
  const destination = getAccounts().find((a) => normalizeKey(a.id) === best.account);
  return destination ? { destination, candidates } : { candidates, summary: "destination vanished from registry" };
}

/** Number of failover decisions already traced for a session, this one included. */
export function failoverAttempt(sessionId: string): number {
  return (
    readStore().events.filter((event) => event.sessionId === sessionId).length + 1
  );
}

/** CA-5 trace. Appended durably, newest kept, bounded. */
export function recordFailoverEvent(event: FailoverEvent): void {
  const store = readStore();
  store.events.push(event);
  if (store.events.length > MAX_EVENTS) {
    store.events = store.events.slice(-MAX_EVENTS);
  }
  writeStore(store);
}

export function listFailoverEvents(): FailoverEvent[] {
  return readStore().events.slice().reverse();
}

/** Test helper. */
export function __resetFailoverStore(): void {
  writeStore({ version: 1, cooldowns: {}, events: [] });
}

/** Build the quota reference a trace event carries (source + age, no secrets). */
export function failoverQuotaRef(accountId: string, now: number = Date.now()): FailoverQuotaRef {
  return quotaRef(accountId, now);
}
