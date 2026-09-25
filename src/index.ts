/**
 * OpenCode Claude Auth Plugin
 *
 * Enables Claude Code (subscription) inside OpenCode via:
 * 1. Claude CLI credential sync or browser OAuth (Pro/Max)
 * 2. Local OpenAI-compatible proxy backed by the Claude Agent SDK
 * 3. Native effort variants, session resume, tools, skills, and MCP
 *
 * Register in opencode.json:
 *   { "plugin": ["@otto-assistant/opencode-claude"] }
 */
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { type ClaudeOAuthTokens } from "./auth.js";
import {
  completeClaudeBrowserLogin,
  getPendingClaudeLogin,
  readStoredClaudeOAuth,
  resetPendingClaudeLogin,
  startClaudeBrowserLogin,
  syncClaudeCliCredentialsToOpenCode,
} from "./auth-login.js";
import {
  ACCOUNT_HEADER,
  accountIdFromProviderId,
  isClaudeProviderId,
  providerIdForAccount,
  DEFAULT_MODEL_ID,
  EFFORT_HEADER,
  OPENAI_COMPATIBLE_NPM,
  PROVIDER_ID,
} from "./constants.js";
import { applyClaudeRequestContextHeaders } from "./request-context.js";
import {
  configureAccounts,
  getAccounts,
  getDefaultAccount,
  isMultiAccount,
} from "./accounts.js";
import { defaultProviderName, providerNameForAccount } from "./provider-name.js";
import { resolveAccessToken, resolveScopedAccountToken } from "./token.js";
import { detectClaudeCode } from "./detect.js";
import { log } from "./log.js";
import {
  encodeClaudeModelSelection,
  resolveClaudeModelSelection,
} from "./model-selection.js";
import {
  buildConfigVariants,
  buildEffortVariants,
  getClaudeModels,
  getClaudeModelsForAccount,
  LOGIN_PLACEHOLDER_MODELS,
  modelCostDisabled,
  type ClaudeModel,
} from "./models.js";
import {
  getClaudeProxyBaseUrl,
  getProxyPort,
  startProxy,
} from "./proxy.js";
import { buildAccountTools } from "./tools.js";
import { createV2Plugin } from "./opencode2.js";
import { setHostCatalogRefresher } from "./host-refresh.js";

/**
 * What the turn WOULD cost on an API key, $/1M tokens.
 *
 * A subscription turn is paid in quota, not dollars, so this is a reference
 * price and not a bill. It is published anyway because the host computes the
 * per-response cost from this field: leaving it at zero does not render "no
 * cost", it renders "$0.00" — an answer, and the wrong one.
 *
 * Falls back to zeros for a model with no listed price, and when
 * OPENCODE_CLAUDE_MODEL_COST is turned off.
 */
function apiReferenceCost(model: ClaudeModel) {
  if (modelCostDisabled()) return zeroCost();
  return model.cost ?? zeroCost();
}

/**
 * Same prices in the shape the CONFIG merge reads, which is not the shape the
 * runtime provider hook uses. OpenCode reads nested `cost.cache.{read,write}`
 * from a provider's runtime models, but flat `cost.cache_read` /
 * `cost.cache_write` from config — anything nested there silently lands as 0.
 */
function apiReferenceConfigCost(model: ClaudeModel) {
  const cost = modelCostDisabled() ? undefined : model.cost;
  return {
    input: cost?.input ?? 0,
    output: cost?.output ?? 0,
    cache_read: cost?.cache.read ?? 0,
    cache_write: cost?.cache.write ?? 0,
  };
}

function zeroCost() {
  return {
    input: 0,
    output: 0,
    cache: { read: 0, write: 0 },
  };
}

function buildProviderModel(
  model: ClaudeModel,
  id: string,
  baseURL: string,
): Record<string, unknown> {
  const variants = buildEffortVariants(model);
  const hasEffort = Object.values(variants).some(
    (v) => v && typeof v === "object" && "effort" in v,
  );
  return {
    id,
    providerID: PROVIDER_ID,
    api: {
      id,
      url: baseURL,
      npm: OPENAI_COMPATIBLE_NPM,
    },
    name: id === DEFAULT_MODEL_ID && model.id !== DEFAULT_MODEL_ID
      ? `Default (${model.name})`
      : model.name,
    capabilities: {
      temperature: true,
      // Runtime models expose reasoning so streams can carry thinking deltas.
      reasoning: hasEffort,
      attachment: true,
      toolcall: true,
      input: {
        text: true,
        audio: false,
        image: true,
        video: false,
        pdf: true,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: true,
    },
    // OpenCode derives capabilities.input from modalities.input — include
    // "pdf" or PDFs are replaced with unsupported-modality errors.
    modalities: {
      input: ["text", "image", "pdf"],
      output: ["text"],
    },
    cost: apiReferenceCost(model),
    limit: {
      context: model.contextWindow,
      output: model.maxTokens,
    },
    status: "active",
    options: {
      includeUsage: true,
    },
    headers: {},
    release_date: "",
    variants,
  };
}

function buildConfigModelEntry(model: ClaudeModel): Record<string, unknown> {
  const variants = buildConfigVariants(model);
  return {
    name: model.name,
    // Keep config non-reasoning so OpenCode does not prepend generic
    // low/medium/high ahead of our explicit effort map (cursor pattern).
    reasoning: false,
    tool_call: true,
    // OpenCode config merge sets capabilities.input from modalities.input.
    // Missing "image"/"pdf" strips attachments before they reach the proxy.
    attachment: true,
    modalities: {
      input: ["text", "image", "pdf"],
      output: ["text"],
    },
    capabilities: {
      tools: true,
      input: ["text", "image", "pdf"],
      output: ["text"],
    },
    cost: apiReferenceConfigCost(model),
    limit: {
      context: model.contextWindow,
      output: model.maxTokens,
    },
    options: {
      includeUsage: true,
    },
    variants,
  };
}

function buildClaudeProviderModels(
  models: ClaudeModel[],
): Record<string, unknown> {
  const baseURL = getClaudeProxyBaseUrl();
  const providerModels = Object.fromEntries(
    models.map((model) => [model.id, buildProviderModel(model, model.id, baseURL)]),
  );
  const defaultModel =
    models.find((m) => m.id === DEFAULT_MODEL_ID) || models[0];
  if (defaultModel && !(DEFAULT_MODEL_ID in providerModels)) {
    providerModels[DEFAULT_MODEL_ID] = buildProviderModel(
      defaultModel,
      DEFAULT_MODEL_ID,
      baseURL,
    );
  }
  return providerModels;
}

/**
 * Declare one provider per account.
 *
 * The host groups the model picker by provider, so a single provider carrying
 * every account's models produces one flat list — 24 rows for four accounts,
 * each row repeating the account label. One provider per account turns that
 * into four labelled groups of six, which is how an operator actually reads it.
 *
 * The default account keeps the bare `claude-code` id, so nothing renames for
 * single-account installs or for sessions already pinned to it.
 */
function ensureAccountProviderConfigs(config: Record<string, any>): void {
  if (!config.provider || typeof config.provider !== "object") {
    config.provider = {};
  }
  for (const account of getAccounts()) {
    // The default account gets its own `claude-code-<id>` provider too. Being
    // reachable ONLY through the bare id made "choose this account" and "say
    // nothing" the same gesture, and that is the bug, not a shortcut.
    const id = providerIdForAccount(account.id, false);
    const existing = config.provider[id] ?? {};
    const port = getProxyPort();
    const baseURL = port ? `http://127.0.0.1:${port}/v1` : undefined;
    config.provider[id] = {
      ...existing,
      name: providerNameForAccount(account),
      npm: existing.npm ?? OPENAI_COMPATIBLE_NPM,
      options: {
        apiKey: "claude-code-proxy",
        includeUsage: true,
        ...(existing.options && typeof existing.options === "object"
          ? existing.options
          : {}),
        ...(baseURL ? { baseURL } : {}),
      },
      models: {
        ...Object.fromEntries(
          getClaudeModelsForAccount(account).map((model) => [
            model.id,
            buildConfigModelEntry(model),
          ]),
        ),
        ...(existing.models && typeof existing.models === "object"
          ? existing.models
          : {}),
      },
    };
    // `enabled_providers` is an allowlist: a provider missing from it is
    // filtered out of the picker entirely, however well it is configured.
    if (Array.isArray(config.enabled_providers)) {
      if (
        config.enabled_providers.includes(PROVIDER_ID) &&
        !config.enabled_providers.includes(id)
      ) {
        config.enabled_providers.push(id);
      }
    }
  }
}

function ensureClaudeProviderConfig(
  config: Record<string, any>,
  models: ClaudeModel[],
): void {
  if (!config.provider || typeof config.provider !== "object") {
    config.provider = {};
  }
  const existing = config.provider[PROVIDER_ID] ?? {};
  const existingOptions =
    existing.options && typeof existing.options === "object"
      ? existing.options
      : {};
  const existingModels =
    existing.models && typeof existing.models === "object"
      ? existing.models
      : {};

  const port = getProxyPort();
  const baseURL = port ? `http://127.0.0.1:${port}/v1` : undefined;
  const seededModels = Object.fromEntries(
    models.map((model) => [model.id, buildConfigModelEntry(model)]),
  );
  const defaultModel =
    models.find((m) => m.id === DEFAULT_MODEL_ID) || models[0];
  if (defaultModel && !(DEFAULT_MODEL_ID in seededModels)) {
    seededModels[DEFAULT_MODEL_ID] = {
      ...buildConfigModelEntry(defaultModel),
      name: `Default (${defaultModel.name})`,
    };
  }

  config.provider[PROVIDER_ID] = {
    ...existing,
    name: defaultProviderName(existing.name),
    npm: existing.npm ?? OPENAI_COMPATIBLE_NPM,
    options: {
      apiKey: "claude-code-proxy",
      includeUsage: true,
      ...existingOptions,
      // Live listener URL must win over any stale pinned baseURL in user config.
      ...(baseURL ? { baseURL } : {}),
    },
    // Seeded catalog first; user-declared model entries win.
    models: {
      ...seededModels,
      ...existingModels,
    },
  };
}

async function loadClaudeRuntime(
  input: PluginInput,
  getAuth: () => Promise<unknown>,
  provider?: { models?: Record<string, unknown> },
): Promise<{ port: number; providerModels: Record<string, unknown> } | undefined> {
  const detection = await detectClaudeCode();
  const accessToken = await resolveAccessToken(input, getAuth);

  // In multi-account mode a non-default account can be signed in while the
  // ambient one is not, so the catalog must not collapse to the login
  // placeholder just because the default account has no token yet.
  const anyAccountReady =
    accessToken ||
    detection.loggedIn ||
    Boolean(readStoredClaudeOAuth()) ||
    getAccounts().some(
      (a) => a.configDir && resolveScopedAccountToken(a) !== null,
    );

  const models = !anyAccountReady
    ? LOGIN_PLACEHOLDER_MODELS
    : isMultiAccount()
      ? getClaudeModelsForAccount(getDefaultAccount())
      : getClaudeModels();

  if (!anyAccountReady) {
    // Still seed placeholder models + a proxy so the provider stays visible.
    const port = await startProxy(async () => null);
    const providerModels = buildClaudeProviderModels(models);
    if (provider) provider.models = providerModels;
    return { port, providerModels };
  }

  const port = await startProxy(async (account) => {
    return resolveAccessToken(input, getAuth, account);
  });

  const providerModels = buildClaudeProviderModels(models);
  if (provider) provider.models = providerModels;
  return { port, providerModels };
}

/**
 * OpenCode plugin that provides Claude Code authentication and model access.
 */
export type ClaudeCodePluginOptions = {
  /**
   * Claude subscriptions to expose, each with its own CLAUDE_CONFIG_DIR:
   *   { "accounts": [
   *       { "id": "work", "label": "Work", "configDir": "~/.claude-work", "default": true },
   *       { "id": "personal", "label": "Personal", "configDir": "~/.claude-personal" }
   *   ] }
   * Omit it entirely for the classic single-subscription behaviour.
   */
  accounts?: unknown;
};

const ClaudeCodePlugin: Plugin = async (
  input: PluginInput,
  options?: ClaudeCodePluginOptions,
): Promise<Hooks> => {
  // Resolve the account registry before anything reads it: the model catalog,
  // the proxy and the credential probes all key off it.
  configureAccounts(options?.accounts);

  // The model picker caches the catalog, and the account label lives inside the
  // model name. An empty config patch makes the host re-run the config hook, so
  // a rename or a new account shows up without restarting OpenCode.
  setHostCatalogRefresher(async () => {
    const config = input.client.config as {
      update?: (args: { body: Record<string, unknown> }) => Promise<unknown>;
    };
    if (typeof config?.update !== "function") return;
    await config.update({ body: {} });
  });

  // Best-effort CLI sync on load so OpenChamber / headless hosts work without
  // an explicit auth.methods click when `claude` is already logged in.
  try {
    syncClaudeCliCredentialsToOpenCode();
  } catch (err) {
    log.warn(
      "[opencode-claude] CLI credential sync skipped",
      err instanceof Error ? err.message : err,
    );
  }

  return {
    // Account management from inside a session, so adding or dropping a
    // subscription does not require reaching a loopback page from whatever
    // machine the operator happens to be on.
    tool: buildAccountTools(),

    async config(config) {
      const detection = await detectClaudeCode();
      // Model visibility must not depend on the CLI's login state alone: a
      // valid plugin-owned OAuth entry in auth.json is just as logged-in.
      // (After a CLI logout the catalog collapsed to login+sonnet and the
      // provider looked broken despite a fresh plugin OAuth token.)
      const hasStoredAuth = Boolean(readStoredClaudeOAuth());
      const hasScopedAccount = getAccounts().some(
        (a) => a.configDir && resolveScopedAccountToken(a) !== null,
      );
      const ready =
        detection.loggedIn ||
        detection.status === "ready" ||
        hasStoredAuth ||
        hasScopedAccount;
      // With one provider per account, `claude-code` carries only the default
      // account's models — the others live in their own providers.
      const models = !ready
        ? LOGIN_PLACEHOLDER_MODELS
        : isMultiAccount()
          ? getClaudeModelsForAccount(getDefaultAccount())
          : getClaudeModels();

      // Bind first (ephemeral port by default), then seed provider baseURL so
      // OpenCode's static config matches the live listener for this process.
      try {
        await startProxy(async (account) => {
          if (account.configDir) {
            // Scoped accounts never consult the host auth store.
            return resolveAccessToken(input, async () => null, account);
          }
          try {
            const authClient = input.client.auth as {
              get?: (args: { path: { id: string } }) => Promise<unknown>;
            };
            if (typeof authClient.get === "function") {
              const auth = await authClient.get({ path: { id: PROVIDER_ID } });
              const payload =
                auth && typeof auth === "object" && "data" in auth
                  ? (auth as { data: unknown }).data
                  : auth;
              return resolveAccessToken(input, async () => payload, account);
            }
          } catch {
            // ignore
          }
          // Browser OAuth belongs to this plugin and is persisted in
          // auth.json. The host's auth client may not yet reflect that file
          // (notably during OpenChamber's provider-page reauthentication),
          // so use the normal resolver with an empty host response. It
          // falls back to the on-disk `claude-code` entry before considering
          // the optional Claude CLI credentials.
          return resolveAccessToken(input, async () => null, account);
        });
      } catch (err) {
        log.error(
          "[opencode-claude] proxy failed to start during config",
          err instanceof Error ? err.message : err,
        );
      }

      ensureClaudeProviderConfig(config as Record<string, any>, models);
      if (isMultiAccount()) {
        ensureAccountProviderConfigs(config as Record<string, any>);
      }
    },

    "chat.headers": async (hookInput, output) => {
      if (!isClaudeProviderId(hookInput.model.providerID)) return;
      const messageModel = hookInput.message.model as {
        variant?: unknown;
      };
      const variant =
        typeof messageModel.variant === "string"
          ? messageModel.variant
          : undefined;
      // The chosen model id carries the account (`opus@work`); the selection
      // splits it so the proxy gets both without a second switch to keep in
      // sync with the picker.
      const selected = resolveClaudeModelSelection(hookInput.model.id, variant);
      // With one provider per account the provider IS the account, and that now
      // includes the default one: every account is reachable as
      // `claude-code-<id>`. So a provider that names no account is not a
      // disguised vote for the default — it is silence, and silence must leave
      // the session on whatever it was already bound to.
      //
      // It used to send the default explicitly here, to fix picking the default
      // in the picker doing nothing. That made every legacy session pinned to
      // the bare provider assert the default account on every turn, and turned
      // `set-default` into a mass reassignment: 32 conversations moved, each one
      // then paying to rebuild its history against the only account with quota
      // left. Removing the ambiguity fixes both without that trade.
      //
      // The `model@account` form still works for anything pinned to it earlier.
      const providerAccount = isClaudeProviderId(hookInput.model.providerID)
        ? accountIdFromProviderId(hookInput.model.providerID)
        : null;
      const account = providerAccount ?? selected.account;
      if (account) {
        selected.account = account;
        output.headers[ACCOUNT_HEADER] = account;
      }
      output.headers[EFFORT_HEADER] = encodeClaudeModelSelection(selected);
      // The proxy runs in the long-lived OpenCode server process, whose cwd is
      // commonly the service account home (for example /home/ubuntu), not the
      // project attached to this plugin instance. Carry the authoritative
      // PluginInput directory on every request so Claude Code loads the right
      // project files, settings, and AGENTS.md.
      applyClaudeRequestContextHeaders(
        output.headers,
        input.directory,
        hookInput.sessionID,
      );
    },

    "chat.params": async (hookInput, output) => {
      if (!isClaudeProviderId(hookInput.model.providerID)) return;
      delete output.options.reasoningEffort;
    },

    provider: {
      id: PROVIDER_ID,
      async models(provider, ctx) {
        const runtime = await loadClaudeRuntime(
          input,
          async () => ctx.auth,
          provider,
        );
        return (runtime?.providerModels ?? {}) as Record<string, any>;
      },
    },

    auth: {
      provider: PROVIDER_ID,

      async loader(getAuth, provider) {
        const runtime = await loadClaudeRuntime(input, getAuth, provider);
        if (!runtime) return {};

        return {
          baseURL: `http://127.0.0.1:${runtime.port}/v1`,
          apiKey: "claude-code-proxy",
          async fetch(
            requestInput: RequestInfo | URL,
            init?: RequestInit,
          ) {
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("authorization");
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(
                  ([key]) => key.toLowerCase() !== "authorization",
                );
              } else {
                delete (init.headers as Record<string, string>).authorization;
                delete (init.headers as Record<string, string>).Authorization;
              }
            }
            return fetch(requestInput, init);
          },
        };
      },

      methods: [
        {
          type: "oauth",
          label: "Use Claude Code CLI login",
          async authorize() {
            const synced = syncClaudeCliCredentialsToOpenCode();
            if (synced) {
              return {
                url: "https://docs.anthropic.com/en/docs/claude-code",
                instructions:
                  "Claude Code CLI credentials were found and synced. Click Complete to finish.",
                method: "auto" as const,
                async callback() {
                  return {
                    type: "success" as const,
                    refresh: synced.refresh,
                    access: synced.access,
                    expires: synced.expires,
                  };
                },
              };
            }

            return {
              url: "https://docs.anthropic.com/en/docs/claude-code",
              instructions:
                "Run `claude auth login` in a terminal, then click Complete. Or choose browser OAuth instead.",
              method: "auto" as const,
              async callback() {
                const again = syncClaudeCliCredentialsToOpenCode();
                if (!again) {
                  return {
                    type: "failed" as const,
                  };
                }
                return {
                  type: "success" as const,
                  refresh: again.refresh,
                  access: again.access,
                  expires: again.expires,
                };
              },
            };
          },
        },
        {
          type: "oauth",
          label: "Login with Claude Pro/Max",
          async authorize() {
            let pending = getPendingClaudeLogin();
            if (!pending || pending.completed) {
              pending = await startClaudeBrowserLogin();
            }

            return {
              url: pending.url,
              instructions:
                "Open the URL, approve access, then paste the redirect URL (or code#state) and click Complete.",
              method: "code" as const,
              async callback(code: string) {
                try {
                  const tokens = await completeClaudeBrowserLogin(code);
                  return {
                    type: "success" as const,
                    refresh: tokens.refresh,
                    access: tokens.access,
                    expires: tokens.expires,
                  };
                } catch (err) {
                  resetPendingClaudeLogin();
                  log.error(
                    "[opencode-claude] OAuth callback failed",
                    err instanceof Error ? err.message : err,
                  );
                  return { type: "failed" as const };
                }
              },
            };
          },
        },
      ],
    },
  };
};

/**
 * Dual V1/V2 export (https://opencode.ai/v2/docs/build/plugins/migrate-v1,
 * understood by OpenCode from 1.18.29): OpenCode 2 runs `setup`, OpenCode 1
 * runs `server` — the V1 plugin above, unchanged.
 */
export default { ...createV2Plugin(), server: ClaudeCodePlugin };

export type { ClaudeOAuthTokens };
// Nada mas se exporta aqui: OpenCode 1 invoca CADA funcion exportada del
// entrypoint como si fuera otro plugin, asi que ni siquiera ClaudeCodePlugin
// va con nombre (se cargaria dos veces: suelto y como `server`). Los helpers
// viven en sus modulos (./detect.js, ./models.js, ./proxy.js,
// ./request-context.js) y se importan desde alli.
