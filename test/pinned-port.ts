/**
 * The pinned proxy port held by something that does not answer the health
 * probe must NOT cost the Claude catalogue (27-09-2026: every new OpenChamber
 * location retried the bind, the self-probe timed out on a busy event loop and
 * the location published no Claude provider).
 *
 *   1. a live pid published for the pinned port → reuse it
 *   2. nobody vouches for the listener         → serve on an ephemeral port
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const squatter = Bun.listen({
  hostname: "0.0.0.0",
  port: 0,
  socket: { data() {}, open() {} }, // accepts and never answers
});
const pinned = squatter.port;

const xdg = mkdtempSync(join(tmpdir(), "oc-claude-pinned-"));
process.env.XDG_DATA_HOME = xdg;
process.env.OPENCODE_CLAUDE_PROXY_PORT = String(pinned);
process.env.OPENCODE_CLAUDE_QUOTA_REFRESH_MS = "0";

function fail(message: string): never {
  console.error(`FAIL — ${message}`);
  process.exit(1);
}

// Case 2 first: no endpoint file → own listener on another port.
{
  const { startProxy, stopProxy } = await import(`../dist/proxy.js?case=stranger`);
  const port = await startProxy(async () => null);
  if (port === pinned) fail(`expected an ephemeral port, got the squatted ${pinned}`);
  const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
  if (!res.ok) fail(`own listener on ${port} did not answer /v1/models (${res.status})`);
  await stopProxy();
}

// Case 1: endpoint published by a live pid for the pinned port → reuse it.
{
  mkdirSync(join(xdg, "opencode-claude"), { recursive: true });
  writeFileSync(
    join(xdg, "opencode-claude", "endpoint.json"),
    JSON.stringify({ port: pinned, pid: process.pid }),
  );
  const { startProxy } = await import(`../dist/proxy.js?case=published`);
  const port = await startProxy(async () => null);
  if (port !== pinned) fail(`expected to reuse the published ${pinned}, got ${port}`);
}

squatter.stop(true);
console.log("ok — pinned-port fallback tests passed");
process.exit(0);
