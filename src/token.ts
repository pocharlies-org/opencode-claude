/**
 * Access-token resolution, in its own module so BOTH engines can share it.
 *
 * The V1 plugin (`index.ts`) and the V2 plugin (`opencode2.ts`) hand the same
 * callback to `startProxy`, and that callback is the delicate part of the whole
 * install: single-flight refresh, CLI-owned-chain handling, and recovery from a
 * rotated grant. It was written once, against a race that burned real quota on
 * 2026-08-11, so it lives here rather than being reimplemented per engine.
 *
 * It only ever touches the host through `input.client.auth.set`, which is why
 * the V2 path can reuse it verbatim by passing a synthetic `input` whose
 * `auth.set` writes to the plugin's own auth.json.
 */
import type { PluginInput } from "@opencode-ai/plugin";
import {
  refreshClaudeToken,
  RefreshTokenInvalidError,
} from "./auth.js";
import {
  isCliOwnedRefreshToken,
  readStoredClaudeOAuth,
  syncClaudeCliCredentialsToOpenCode,
} from "./auth-login.js";
import { PROVIDER_ID } from "./constants.js";
import type { ClaudeAccount } from "./accounts.js";
import { readClaudeCliOAuthCredentials } from "./credentials.js";
import { log } from "./log.js";

export type ClaudeOAuthAuth = {
  type: "oauth";
  access?: string;
  refresh: string;
  expires: number;
};

export function isClaudeOAuthAuth(auth: unknown): auth is ClaudeOAuthAuth {
  return (
    !!auth &&
    typeof auth === "object" &&
    (auth as { type?: unknown }).type === "oauth" &&
    typeof (auth as { refresh?: unknown }).refresh === "string" &&
    typeof (auth as { expires?: unknown }).expires === "number"
  );
}

/**
 * Refresh the access token a little BEFORE it dies so turns never start with
 * a token that expires mid-flight. The 8h access-token TTL itself is fixed
 * Anthropic-side; what keeps the session alive indefinitely is a refresh
 * chain that never breaks.
 */
const REFRESH_MARGIN_MS = 120_000;

/**
 * In-flight refresh dedupe, keyed by refresh token. OpenCode fires the main
 * turn and the title meta request in parallel — without single-flight both
 * refresh with the SAME token, Anthropic rotates on the first, and the
 * second dies with invalid_grant, killing the whole chain (this exact race
 * burned quota on 2026-08-11).
 */
const refreshInFlight = new Map<string, Promise<string | null>>();

/**
 * Access token for an account that owns its own Claude home.
 *
 * Deliberately read-only: the CLI living in that config dir is the sole owner
 * of its refresh chain, and rotating it from here is exactly the two-owner
 * replay that gets the whole grant revoked (see auth-login.ts). An expired
 * token yields null, which makes the proxy spawn the CLI WITHOUT
 * CLAUDE_CODE_OAUTH_TOKEN so the CLI refreshes its own credentials file.
 */
export function resolveScopedAccountToken(account: ClaudeAccount): string | null {
  const creds = readClaudeCliOAuthCredentials({ configDir: account.configDir });
  if (!creds?.accessToken) return null;
  if (creds.expiresAt && creds.expiresAt <= Date.now() + 30_000) {
    log.info("[opencode-claude] account token expired; letting the CLI refresh", {
      account: account.id,
    });
    return null;
  }
  return creds.accessToken;
}

export async function resolveAccessToken(
  input: PluginInput,
  getAuth: () => Promise<unknown>,
  account?: ClaudeAccount,
): Promise<string | null> {
  // Accounts pinned to their own Claude home never touch auth.json: that file
  // has exactly one `claude-code` slot, and sharing it across subscriptions
  // would hand one account's token to another.
  if (account?.configDir) return resolveScopedAccountToken(account);
  let auth = await getAuth();
  // The host's in-memory auth store can lag auth.json (tokens written by a
  // sibling process, a headless login, or a race at server start). When the
  // host hands us nothing usable, trust the fresher on-disk entry instead of
  // falling into the logged-out placeholder path.
  if (
    !isClaudeOAuthAuth(auth) ||
    !(auth.access && auth.expires > Date.now() + REFRESH_MARGIN_MS)
  ) {
    const stored = readStoredClaudeOAuth();
    if (
      stored &&
      (!isClaudeOAuthAuth(auth) || stored.expires > (auth.expires ?? 0))
    ) {
      auth = { type: "oauth", ...stored };
    }
  }
  if (isClaudeOAuthAuth(auth)) {
    if (auth.access && auth.expires > Date.now() + REFRESH_MARGIN_MS) {
      return auth.access;
    }
    // CLI-owned chains are never rotated through the token endpoint by us
    // (rotation belongs to the CLI — see isCliOwnedRefreshToken); re-sync
    // from the CLI file instead.
    if (isCliOwnedRefreshToken(auth.refresh)) {
      const synced = syncClaudeCliCredentialsToOpenCode();
      if (synced) return synced.access;
      // Only hand out the stored access token while it is genuinely valid —
      // an expired token spawns a doomed turn (401) and blocks CLI self-heal.
      return auth.access && auth.expires > Date.now() ? auth.access : null;
    }

    const key = auth.refresh;
    let pending = refreshInFlight.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const refreshed = await refreshClaudeToken(key);
          await input.client.auth.set({
            path: { id: PROVIDER_ID },
            body: {
              type: "oauth",
              refresh: refreshed.refresh,
              access: refreshed.access,
              expires: refreshed.expires,
            },
          });
          return refreshed.access;
        } catch (err) {
          const permanent = err instanceof RefreshTokenInvalidError;
          log.error(
            `[opencode-claude] token refresh ${permanent ? "rejected" : "failed"}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          if (permanent) {
            // invalid_grant usually means another actor (claude CLI, a
            // parallel refresh) rotated the token first. Re-read the store:
            // fresher credentials may already be there.
            try {
              const latest = await getAuth();
              if (
                isClaudeOAuthAuth(latest) &&
                latest.refresh !== key &&
                latest.access &&
                latest.expires > Date.now() + REFRESH_MARGIN_MS
              ) {
                log.info(
                  "[opencode-claude] recovered newer OAuth credentials after refresh rejection",
                );
                return latest.access;
              }
            } catch {
              // fall through to CLI sync
            }
            const synced = syncClaudeCliCredentialsToOpenCode();
            return synced?.access ?? null;
          }
          // Transient refresh failure: the old access token is only useful
          // while actually valid; otherwise null lets the CLI self-heal.
          return auth.access && auth.expires > Date.now()
            ? auth.access
            : null;
        }
      })();
      refreshInFlight.set(key, pending);
      const cleanup = () => {
        refreshInFlight.delete(key);
      };
      pending.then(cleanup, cleanup);
    }
    return pending;
  }

  const synced = syncClaudeCliCredentialsToOpenCode();
  if (synced) {
    try {
      await input.client.auth.set({
        path: { id: PROVIDER_ID },
        body: {
          type: "oauth",
          refresh: synced.refresh,
          access: synced.access,
          expires: synced.expires,
        },
      });
    } catch {
      // auth.set may be unavailable in some hosts
    }
    return synced.access;
  }
  return null;
}
