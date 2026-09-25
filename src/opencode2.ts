/**
 * OpenCode 2: the same provider, proxy, panel and tools, registered through
 * the V2 plugin API.
 *
 * V2 does not run V1 plugins (https://opencode.ai/v2/docs/build/plugins/migrate-v1),
 * so every V1 hook in `index.ts` has its counterpart here:
 *
 *   config                → ctx.provider.transform — one provider per account,
 *                           same catalog, pointed at the same local proxy
 *   auth.loader           → the provider's own settings (proxy baseURL and the
 *                           placeholder key); the proxy owns the real token
 *   auth.methods          → ctx.integration.transform — CLI sync and browser OAuth
 *   chat.headers          → ctx.session.hook("model.request")
 *   chat.params           → ctx.session.hook("context")
 *   tool                  → ctx.tool.transform
 *   config.update refresh → ctx.provider.reload()
 *
 * The proxy is the part that matters and it is not reimplemented: it is the
 * same `startProxy`, handed the same token resolver (token.ts). V1 persisted
 * refreshed tokens through the host's `client.auth.set`; V2 has no such
 * client, so that write goes straight to the plugin's own entry in auth.json,
 * which is where the resolver reads it back from on either engine.
 *
 * Nothing here is reachable from V1: `index.ts` exports it as `setup`, which
 * V1 ignores, and V1 keeps running `server`.
 */
import { tool as v1Tool, type PluginInput, type ToolDefinition } from "@opencode-ai/plugin";
import type { ClaudeOAuthTokens } from "./auth.js";
import {
  completeClaudeBrowserLogin,
  getPendingClaudeLogin,
  readStoredClaudeOAuth,
  resetPendingClaudeLogin,
  startClaudeBrowserLogin,
  syncClaudeCliCredentialsToOpenCode,
  writeClaudeAuth,
} from "./auth-login.js";
import {
  configureAccounts,
  getAccounts,
  getDefaultAccount,
  isMultiAccount,
} from "./accounts.js";
import {
  ACCOUNT_HEADER,
  accountIdFromProviderId,
  DEFAULT_MODEL_ID,
  EFFORT_HEADER,
  isClaudeProviderId,
  KIND_HEADER,
  PROVIDER_ID,
  providerIdForAccount,
} from "./constants.js";
import { detectClaudeCode } from "./detect.js";
import { setHostCatalogRefresher } from "./host-refresh.js";
import { log } from "./log.js";
import {
  encodeClaudeModelSelection,
  resolveClaudeModelSelection,
} from "./model-selection.js";
import {
  buildEffortVariants,
  getClaudeModels,
  getClaudeModelsForAccount,
  LOGIN_PLACEHOLDER_MODELS,
  modelCostDisabled,
  type ClaudeModel,
} from "./models.js";
import { defaultProviderName, providerNameForAccount } from "./provider-name.js";
import { startProxy } from "./proxy.js";
import { applyClaudeRequestContextHeaders } from "./request-context.js";
import {
  isClaudeOAuthAuth,
  resolveAccessToken,
  resolveScopedAccountToken,
} from "./token.js";
import { buildAccountTools } from "./tools.js";

/** The AI SDK driver V2 uses for an OpenAI-compatible endpoint — the proxy is one. */
const PACKAGE = "aisdk:@ai-sdk/openai-compatible";
const PROXY_API_KEY = "claude-code-proxy";
const INPUT_MODALITIES = ["text", "image", "pdf"];

// The slice of the V2 plugin context this plugin touches. Typed locally, like
// the V1 hook payloads: pulling in @opencode/plugin would drag the whole V2
// SDK (and effect) into a package that still has to load in OpenCode 1.
type V2Model = Record<string, unknown>;
type V2ProviderInfo = Record<string, unknown> & { id: string; name?: string; settings?: Record<string, unknown> };
type Registration = { dispose(): Promise<void> };
type ModelRef = { id: string; providerID: string; variant?: string };
type V2OAuthCredential = {
  type: "oauth";
  methodID: string;
  refresh: string;
  access: string;
  expires: number;
};
type V2ToolContext = {
  sessionID: string;
  messageID: string;
  agent: string;
  id: string;
  signal: AbortSignal;
};
type V2Context = {
  options?: Record<string, unknown>;
  location: { directory: string };
  provider: {
    transform(
      fn: (editor: {
        get(id: string): { provider: V2ProviderInfo } | undefined;
        add(input: { info: V2ProviderInfo; models: V2Model[] }): void;
      }) => void,
    ): Promise<Registration>;
    reload(): Promise<void>;
  };
  session: {
    hook(
      name: "model.request",
      fn: (event: {
        sessionID: string;
        model: ModelRef;
        kind: "primary" | "compaction" | "title" | "generate";
        headers: Record<string, string>;
      }) => void,
    ): Promise<Registration>;
    hook(
      name: "context",
      fn: (event: { model: ModelRef; options: Record<string, unknown> }) => void,
    ): Promise<Registration>;
  };
  tool: {
    transform(
      fn: (editor: {
        add(tool: {
          name: string;
          description: string;
          input: Record<string, unknown>;
          options?: { codemode?: boolean };
          execute(input: unknown, context: V2ToolContext): Promise<{
            content?: string;
            metadata?: Record<string, unknown>;
          }>;
        }): void;
      }) => void,
    ): Promise<Registration>;
  };
  integration: {
    transform(
      fn: (editor: {
        update(id: string, fn: (integration: { id: string; name: string }) => void): void;
        method: { update(input: Record<string, unknown>): void };
      }) => void,
    ): Promise<Registration>;
  };
};

function apiReferenceCost(model: ClaudeModel) {
  // V1 publishes zeros when cost is off, because its host renders a missing
  // price as "$0.00" anyway. V2 has a real "no price" — an empty list.
  if (modelCostDisabled() || !model.cost) return [];
  return [
    {
      input: model.cost.input,
      output: model.cost.output,
      cache: { read: model.cost.cache.read, write: model.cost.cache.write },
    },
  ];
}

function toV2Model(
  providerID: string,
  model: ClaudeModel,
  id = model.id,
  name = model.name,
): V2Model {
  // The effort map, minus the `disabled` entries V1 needs only to hide the
  // host's generated variants. The variant carries no settings: the effort
  // reaches the proxy through the selection header, like on V1.
  const variants = Object.entries(buildEffortVariants(model))
    .filter(([, value]) => "effort" in value)
    .map(([variant]) => ({ id: variant }));
  return {
    id,
    modelID: id,
    providerID,
    name,
    capabilities: { tools: true, input: INPUT_MODALITIES, output: ["text"] },
    variants,
    time: { released: 0 },
    cost: apiReferenceCost(model),
    status: "active",
    enabled: true,
    limit: { context: model.contextWindow, output: model.maxTokens },
  };
}

/** The bare provider's catalog, with the `sonnet` default alias V1 also seeds. */
function defaultProviderModels(models: ClaudeModel[]): V2Model[] {
  const out = models.map((model) => toV2Model(PROVIDER_ID, model));
  const fallback = models.find((m) => m.id === DEFAULT_MODEL_ID) || models[0];
  if (fallback && !models.some((m) => m.id === DEFAULT_MODEL_ID)) {
    out.push(
      toV2Model(PROVIDER_ID, fallback, DEFAULT_MODEL_ID, `Default (${fallback.name})`),
    );
  }
  return out;
}

/** Same readiness rule as the V1 config hook: any usable login shows the real catalog. */
function catalogReady(cliLoggedIn: boolean): boolean {
  return (
    cliLoggedIn ||
    Boolean(readStoredClaudeOAuth()) ||
    getAccounts().some((a) => a.configDir && resolveScopedAccountToken(a) !== null)
  );
}

/**
 * Token resolution for V2. There is no host auth store to consult: the
 * plugin's own auth.json entry IS the store, read fresh on every call so a
 * login or a CLI sync is picked up without a restart.
 */
function readPluginAuth(): unknown {
  const stored = readStoredClaudeOAuth();
  return stored ? { type: "oauth", ...stored } : null;
}

const hostInput = {
  client: {
    auth: {
      async set(args: { body: unknown }) {
        if (isClaudeOAuthAuth(args.body) && args.body.access) {
          writeClaudeAuth(args.body as ClaudeOAuthTokens);
        }
      },
    },
  },
} as unknown as PluginInput;

function toolResult(result: unknown): { content: string; metadata?: Record<string, unknown> } {
  if (typeof result === "string") return { content: result };
  if (result && typeof result === "object") {
    const r = result as { title?: unknown; output?: unknown; metadata?: unknown };
    const metadata = {
      ...(r.metadata && typeof r.metadata === "object" ? (r.metadata as Record<string, unknown>) : {}),
      ...(typeof r.title === "string" ? { title: r.title } : {}),
    };
    return {
      content: typeof r.output === "string" ? r.output : JSON.stringify(result),
      ...(Object.keys(metadata).length ? { metadata } : {}),
    };
  }
  return { content: String(result ?? "") };
}

/**
 * A V1 tool definition as a V2 tool. The arguments are the same zod shape; V2
 * gets it as JSON Schema (the zod bundled with the V1 SDK predates Standard
 * JSON Schema) and the V1 parser still applies defaults and coercion.
 */
function toV2Tool(name: string, def: ToolDefinition, directory: string) {
  const schema = v1Tool.schema.object(def.args);
  return {
    name,
    description: def.description,
    input: v1Tool.schema.toJSONSchema(schema) as Record<string, unknown>,
    // Direct tools, as on V1. V2 otherwise files plugin tools under Code Mode
    // (reachable only through its `execute` tool), and a model asked to "use
    // claude_accounts" then reports that no such tool exists — measured.
    options: { codemode: false },
    async execute(input: unknown, context: V2ToolContext) {
      try {
        const args = schema.parse(input ?? {});
        const result = await def.execute(args as never, {
          sessionID: context.sessionID,
          messageID: context.messageID,
          agent: context.agent,
          directory,
          worktree: directory,
          abort: context.signal,
          metadata() {},
          ask: async () => {},
        } as never);
        return toolResult(result);
      } catch (err) {
        // V2 turns a rejected promise-tool into a defect, not a tool error the
        // model can read. V1 showed the message to the model; so does this.
        return {
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          metadata: { error: true },
        };
      }
    },
  };
}

function oauthCredential(methodID: string, tokens: ClaudeOAuthTokens): V2OAuthCredential {
  return {
    type: "oauth",
    methodID,
    refresh: tokens.refresh,
    access: tokens.access,
    expires: tokens.expires,
  };
}

/** Wait for `claude auth login` to land credentials, like V1's "Complete" click. */
async function waitForCliLogin(signalMs: number): Promise<ClaudeOAuthTokens> {
  const deadline = Date.now() + signalMs;
  while (Date.now() < deadline) {
    const synced = syncClaudeCliCredentialsToOpenCode();
    if (synced) return synced;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("No Claude Code CLI login found. Run `claude auth login`, then try again.");
}

export function createV2Plugin(id = "opencode-claude") {
  return {
    id,
    async setup(ctx: V2Context) {
      configureAccounts(ctx.options?.accounts);

      // Best-effort CLI sync on load, as on V1: a host with `claude` already
      // logged in works without anyone clicking through an auth method.
      try {
        syncClaudeCliCredentialsToOpenCode();
      } catch (err) {
        log.warn(
          "[opencode-claude] CLI credential sync skipped",
          err instanceof Error ? err.message : err,
        );
      }

      // Bind the proxy before publishing the provider, so the baseURL below is
      // the live listener. startProxy is idempotent: a second location (or a
      // plugin reload) reuses the same listener.
      let baseURL: string | undefined;
      try {
        const port = await startProxy(async (account) =>
          resolveAccessToken(hostInput, async () => readPluginAuth(), account),
        );
        baseURL = `http://127.0.0.1:${port}/v1`;
      } catch (err) {
        log.error(
          "[opencode-claude] proxy failed to start",
          err instanceof Error ? err.message : err,
        );
      }

      const detection = await detectClaudeCode().catch(() => null);
      const cliLoggedIn = Boolean(
        detection && (detection.loggedIn || detection.status === "ready"),
      );

      await ctx.provider.transform((editor) => {
        if (!baseURL) return;
        const settings = { baseURL, apiKey: PROXY_API_KEY, includeUsage: true };
        const ready = catalogReady(cliLoggedIn);
        const models = !ready
          ? LOGIN_PLACEHOLDER_MODELS
          : isMultiAccount()
            ? getClaudeModelsForAccount(getDefaultAccount())
            : getClaudeModels();
        const existing = editor.get(PROVIDER_ID)?.provider;
        editor.add({
          info: {
            id: PROVIDER_ID,
            name: defaultProviderName(existing?.name),
            activation: "enabled",
            package: PACKAGE,
            settings: { ...(existing?.settings ?? {}), ...settings },
          },
          models: defaultProviderModels(models),
        });
        if (!isMultiAccount()) return;
        for (const account of getAccounts()) {
          const providerID = providerIdForAccount(account.id, false);
          editor.add({
            info: {
              id: providerID,
              name: providerNameForAccount(account),
              activation: "enabled",
              package: PACKAGE,
              settings,
            },
            models: getClaudeModelsForAccount(account).map((model) =>
              toV2Model(providerID, model),
            ),
          });
        }
      });

      // V2 can rebuild a provider in place; V1 needed an empty PATCH /config.
      // Still gated by OPENCODE_CLAUDE_HOST_REFRESH like on V1.
      setHostCatalogRefresher(() => ctx.provider.reload());

      await ctx.session.hook("model.request", (event) => {
        const providerID = event.model.providerID;
        if (!isClaudeProviderId(providerID)) return;
        // Same routing rules as V1 chat.headers: the provider names the
        // account; a bare `claude-code` names none and leaves the session
        // where it is bound.
        const selected = resolveClaudeModelSelection(event.model.id, event.model.variant);
        const account = accountIdFromProviderId(providerID) ?? selected.account;
        if (account) {
          selected.account = account;
          event.headers[ACCOUNT_HEADER] = account;
        }
        event.headers[EFFORT_HEADER] = encodeClaudeModelSelection(selected);
        applyClaudeRequestContextHeaders(
          event.headers,
          ctx.location.directory,
          event.sessionID,
        );
        // V2 says what the call is for; V1 only let the proxy guess from the
        // prompt, and V2's compaction prompt defeats that guess.
        if (event.kind === "title") event.headers[KIND_HEADER] = "title";
        if (event.kind === "compaction") event.headers[KIND_HEADER] = "summary";
      });

      await ctx.session.hook("context", (event) => {
        if (!isClaudeProviderId(event.model.providerID)) return;
        delete event.options.reasoningEffort;
      });

      const tools = buildAccountTools();
      if (Object.keys(tools).length) {
        await ctx.tool.transform((editor) => {
          for (const [name, def] of Object.entries(tools)) {
            editor.add(toV2Tool(name, def, ctx.location.directory));
          }
        });
      }

      await ctx.integration.transform((editor) => {
        editor.method.update({
          integrationID: PROVIDER_ID,
          method: { id: "claude-cli", type: "oauth", label: "Use Claude Code CLI login" },
          async authorize() {
            const synced = syncClaudeCliCredentialsToOpenCode();
            return {
              url: "https://docs.anthropic.com/en/docs/claude-code",
              instructions: synced
                ? "Claude Code CLI credentials were found and synced."
                : "Run `claude auth login` in a terminal; this completes on its own once the CLI is logged in.",
              mode: "auto",
              callback: (synced ? Promise.resolve(synced) : waitForCliLogin(5 * 60_000)).then(
                (tokens) => oauthCredential("claude-cli", tokens),
              ),
            };
          },
          // Deliberately no `refresh`: the chain belongs to the CLI or to this
          // plugin's resolver, and a second owner rotating it gets the whole
          // grant revoked. The proxy never reads the host credential anyway.
        });
        editor.method.update({
          integrationID: PROVIDER_ID,
          method: { id: "claude-browser", type: "oauth", label: "Login with Claude Pro/Max" },
          async authorize() {
            let pending = getPendingClaudeLogin();
            if (!pending || pending.completed) pending = await startClaudeBrowserLogin();
            return {
              url: pending.url,
              instructions:
                "Open the URL, approve access, then paste the redirect URL (or code#state).",
              mode: "code",
              async callback(code: string) {
                try {
                  // Also writes auth.json, which is what the proxy reads.
                  return oauthCredential("claude-browser", await completeClaudeBrowserLogin(code));
                } catch (err) {
                  resetPendingClaudeLogin();
                  throw err;
                }
              },
            };
          },
        });
        editor.update(PROVIDER_ID, (integration) => {
          integration.name = "Claude Code";
        });
      });

      // The proxy outlives this location on purpose: it is one listener per
      // process, shared by every location and by the panel.
    },
  };
}
