/**
 * The house account service (claude-account-switcher) as the single source of
 * Claude quota numbers for everything this panel SERVES.
 *
 * Discovery: ~/.config/claude-cuentas/service.json `{url, token}` — the bearer
 * goes only into the request header, never into a log, a response or an error.
 * The service reads each account's own `/api/oauth/usage` for free; the panel
 * no longer boots a CLI probe to answer «refresh» and shows no numbers of its
 * own: when the service cannot be reached the quota is simply absent, because
 * a second measurement is what made two tables disagree (SC-2453).
 *
 * `POST /v1/refresh` re-reads every account against Anthropic serially, so it
 * can take tens of seconds when the endpoint is slow; the timeout here is the
 * budget, and a timeout still serves the last state read after it.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountQuota, QuotaWindow } from "./quota.js";

const ESTADO_TIMEOUT_MS = 5_000;
const REFRESCO_TIMEOUT_MS = 30_000;

function discoveryPath(): string {
  const override = process.env.CLAUDE_CUENTAS_SERVICE_JSON;
  if (override && override.trim()) return override.trim();
  return join(homedir(), ".config", "claude-cuentas", "service.json");
}

function descubrir(): { url: string; token: string } | null {
  try {
    const doc = JSON.parse(readFileSync(discoveryPath(), "utf8"));
    const url = typeof doc?.url === "string" ? doc.url.trim().replace(/\/+$/, "") : "";
    const token = typeof doc?.token === "string" ? doc.token.trim() : "";
    if (!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(url) || !token) return null;
    return { url, token };
  } catch {
    return null;
  }
}

function ventanaServicio(v: unknown): QuotaWindow | undefined {
  if (!v || typeof v !== "object") return undefined;
  const { usedPct, resetsAt } = v as { usedPct?: unknown; resetsAt?: unknown };
  if (typeof usedPct !== "number" || !Number.isFinite(usedPct)) return undefined;
  const out: QuotaWindow = {
    utilization: Math.min(1, Math.max(0, usedPct / 100)),
    remaining: Math.min(1, Math.max(0, 1 - usedPct / 100)),
  };
  const ms = typeof resetsAt === "string" ? Date.parse(resetsAt) : NaN;
  if (Number.isFinite(ms)) out.resetsAt = ms;
  return out;
}

/** {id(lowercased): quota} from `GET /v1/state`; null when the service is not there.
 *  `forzar` asks `POST /v1/refresh` first — what the dashboard's «Refrescar» means. */
export async function cuotasDelServicio(forzar: boolean): Promise<Map<string, AccountQuota> | null> {
  const d = descubrir();
  if (!d) return null;
  const cabeceras = { Authorization: `Bearer ${d.token}`, "Content-Type": "application/json" };
  try {
    if (forzar) {
      // A failed refresh is not a failure to answer: the state below still carries the last reading.
      await fetch(`${d.url}/v1/refresh`, { method: "POST", headers: cabeceras, body: "{}", signal: AbortSignal.timeout(REFRESCO_TIMEOUT_MS) }).catch(() => undefined);
    }
    const r = await fetch(`${d.url}/v1/state`, { headers: cabeceras, signal: AbortSignal.timeout(ESTADO_TIMEOUT_MS) });
    if (!r.ok) return null;
    const doc = (await r.json()) as { accounts?: unknown };
    const salida = new Map<string, AccountQuota>();
    for (const a of Array.isArray(doc?.accounts) ? doc.accounts : []) {
      const q = (a as { quota?: Record<string, unknown> })?.quota;
      const id = (a as { id?: unknown })?.id;
      if (typeof id !== "string" || !q || typeof q !== "object") continue;
      const windows: AccountQuota["windows"] = {};
      const h5 = ventanaServicio(q.fiveHour);
      const d7 = ventanaServicio(q.sevenDay);
      if (h5) windows.fiveHour = h5;
      if (d7) windows.sevenDay = d7;
      const leido = typeof q.readAt === "string" ? Date.parse(q.readAt) : NaN;
      if (!Object.keys(windows).length || !Number.isFinite(leido)) continue;
      salida.set(id.trim().toLowerCase(), { windows, fetchedAt: leido, source: "plan-usage" });
    }
    return salida;
  } catch {
    return null;
  }
}
