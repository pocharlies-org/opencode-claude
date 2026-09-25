/**
 * Provider naming, shared by the V1 (`index.ts`) and V2 (`opencode2.ts`)
 * entry points so both engines label the picker groups identically.
 */
import { accountIcon, isMultiAccount, type ClaudeAccount } from "./accounts.js";
import { getAccountIdentity } from "./identity.js";

/**
 * Provider name for an account: label plus the Claude login behind it.
 *
 * The host shows this under the model name when hovering, and as the group
 * header in the picker — the one place where "which subscription am I about to
 * spend" can be answered before spending it. The label alone does not answer
 * it: labels are operator-chosen and go stale the moment a Claude home is
 * re-logged to a different account, which is exactly when the question matters.
 */
export function providerNameForAccount(account: ClaudeAccount): string {
  const email = getAccountIdentity(account.id)?.email;
  const label = account.label.trim();
  // Do not repeat the address when the operator already named the account after
  // it, which is a natural thing to do.
  const showEmail = email && !label.toLowerCase().includes(email.toLowerCase());
  // The icon leads, matching the model rows underneath: the group header is the
  // legend that says which account a glyph stands for.
  const icon = isMultiAccount() ? `${accountIcon(account)} ` : "";
  return `${icon}Claude Code · ${label}${showEmail ? ` · ${email}` : ""}`;
}

/**
 * Name of the bare `claude-code` provider. In multi-account mode every
 * provider names its account, this one included: a group headed by a bare
 * "Claude Code" beside three labelled ones reads as the odd one out rather
 * than as the default account. A name the operator genuinely customised is
 * still respected.
 */
export function defaultProviderName(existingName: unknown): string {
  const customName =
    typeof existingName === "string" &&
    existingName.trim() &&
    existingName.trim() !== "Claude Code"
      ? existingName.trim()
      : "";
  return (
    customName ||
    (isMultiAccount() ? "Claude Code · this session’s account" : "Claude Code")
  );
}
