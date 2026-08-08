// ---------------------------------------------------------------------------
// The private clarification is OPTIONAL as of 0.3.1.1. A Composer whose target
// is already unambiguous ("the Eiffel Tower") should not be made to invent
// disambiguation for it.
//
// Three prompts consume it, and all three previously assumed it was present.
// An empty string rendered straight into a prompt produces a dangling
// `Private clarification:` label, which reads as a Composer who was asked and
// declined — subtly different from one who was never required to answer. This
// renders the absence explicitly instead, in one place, so the three prompts
// cannot drift apart.
// ---------------------------------------------------------------------------

export const NO_CLARIFICATION_MARKER =
  "(none provided — the Composer considered the target self-explanatory)";

export function renderClarification(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : NO_CLARIFICATION_MARKER;
}

/** True when the Composer supplied no clarification. */
export function hasClarification(value: string | null | undefined): boolean {
  return (value ?? "").trim().length > 0;
}
