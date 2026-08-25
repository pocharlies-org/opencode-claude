/**
 * Where a conversation with no account of its own starts.
 *
 * The registry default answers that — until it cannot serve. An exhausted
 * default used to be handed the work anyway, so every conversation opened
 * while it was dry spent its first turn earning `You've hit your weekly limit`
 * before anything could happen, with healthy subscriptions sitting idle next to
 * it. The operator reads that as "Claude is down": on 2026-08-25 the default
 * account ran out of its seven-day window at 00:15 and kept being chosen until
 * 04:00 the following day, while two other accounts had 69% and 88% left.
 *
 * This covers ONLY conversations with no placement yet. A bound conversation
 * stays bound and an explicitly requested account is honoured even when it is
 * dry, because moving a live conversation strands its Claude transcript in
 * another account's home and makes the next turn rebuild the entire history
 * against a different subscription — the cost that emptied two of them on
 * 2026-08-20. A first turn has no transcript to strand and no history to
 * rebuild, which is precisely why the choice is free here and nowhere else.
 */
import {
  getAccounts,
  getDefaultAccount,
  isMultiAccount,
  type ClaudeAccount,
} from "./accounts.js";
import { getAccountQuota } from "./quota.js";
import { rateLimitGate } from "./rate-limit.js";

export type AccountAvailability = {
  /** Worth starting a conversation on right now. */
  usable: boolean;
  /**
   * Smallest fraction left across the windows we have numbers for, so the
   * binding constraint is the one that ranks the account. Absent when nothing
   * has been measured yet.
   */
  headroom?: number;
  /** Why it is not usable. Only set when `usable` is false. */
  reason?: string;
};

/** Quota windows, paired with the label used in the reason text. */
const WINDOWS: ReadonlyArray<readonly ["fiveHour" | "sevenDay" | "opus", string]> = [
  ["fiveHour", "5h"],
  ["sevenDay", "7d"],
  ["opus", "opus"],
];

/**
 * Can this account take a new conversation, and with how much room.
 *
 * Silence is not exhaustion: an account nothing has been measured on yet is
 * usable with unknown headroom. Only a recorded hard limit, or a window that
 * reads empty AND names a future refill, takes it out of the running — a zero
 * with no reset stamp says nothing about when it comes back, and treating it as
 * a verdict would retire an account permanently on one stale reading.
 */
export function accountAvailability(
  accountId: string,
  now: number = Date.now(),
): AccountAvailability {
  if (rateLimitGate(now, accountId).blocked) {
    return { usable: false, headroom: 0, reason: "rate limit hit" };
  }
  const quota = getAccountQuota(accountId);
  if (!quota) return { usable: true };
  let headroom: number | undefined;
  for (const [key, label] of WINDOWS) {
    const win = quota.windows[key];
    if (!win || typeof win.remaining !== "number") continue;
    if (win.remaining <= 0 && win.resetsAt !== undefined && win.resetsAt > now) {
      return { usable: false, headroom: 0, reason: `${label} quota spent` };
    }
    headroom = headroom === undefined ? win.remaining : Math.min(headroom, win.remaining);
  }
  return headroom === undefined ? { usable: true } : { usable: true, headroom };
}

export type AccountPlacement = {
  account: ClaudeAccount;
  /**
   * Set when the default could not serve and the conversation was placed
   * elsewhere. Carries what was skipped and why, for the log line.
   */
  divertedFrom?: { account: ClaudeAccount; reason: string };
};

/**
 * A measured account always outranks one nothing is known about: 88% left is
 * a fact and silence is a guess. Exhausted accounts never reach here.
 */
function rank(state: AccountAvailability): number {
  return state.headroom ?? -1;
}

/**
 * Account for a conversation that has none. The default when it can serve,
 * otherwise the usable account with the most room left.
 *
 * `isAuthenticated` is injected: whether an account has credentials on disk is
 * the proxy's question to answer, and a signed-out account is not a fallback.
 */
export function pickAccountForNewConversation(opts?: {
  now?: number;
  isAuthenticated?: (account: ClaudeAccount) => boolean;
}): AccountPlacement {
  const now = opts?.now ?? Date.now();
  const preferred = getDefaultAccount();
  // One account is not a choice, and diverting to a second slot of the same
  // login would just spend the same pool under another name.
  if (!isMultiAccount()) return { account: preferred };
  const preferredState = accountAvailability(preferred.id, now);
  if (preferredState.usable) return { account: preferred };
  const authenticated = opts?.isAuthenticated ?? (() => true);
  const best = getAccounts()
    .filter((account) => account.id !== preferred.id && authenticated(account))
    .map((account) => ({ account, state: accountAvailability(account.id, now) }))
    .filter((candidate) => candidate.state.usable)
    .sort((a, b) => rank(b.state) - rank(a.state))[0];
  // Nothing better on offer: let the default fail with its own honest message
  // rather than pin the failure on a second subscription.
  if (!best) return { account: preferred };
  return {
    account: best.account,
    divertedFrom: {
      account: preferred,
      reason: preferredState.reason ?? "unavailable",
    },
  };
}
