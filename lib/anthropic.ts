// ---------------------------------------------------------------------------
// V2.5-B2 — COMPATIBILITY RE-EXPORT. The implementation moved to
// lib/providers/anthropic.ts when the provider boundary was introduced.
//
// WHY THIS FILE STILL EXISTS RATHER THAN THE IMPORTS BEING UPDATED.
//
// Eight call sites use this client and only two of them — the Racer seat — are
// in scope for provider selection. The other six are the Validator, the
// Adjudicator, the Integrity Review, the AI Composer (twice) and the
// question-edit judge, all of which stay on Anthropic permanently because they
// are the measuring instrument rather than a player.
//
// B2's acceptance criterion is that 513 existing tests pass UNMODIFIED. Editing
// six untouched call sites and a hermetic test file to chase an import path
// would have put real churn inside a change whose entire claim is that nothing
// changed. One re-export costs nothing and keeps that claim checkable.
//
// This is a seam, not a shim to be cleaned up later: `MODEL_PROVIDER` and the
// sampling-parameter cache are module-level state, and re-exporting keeps a
// single instance of both. Two modules each holding their own cache would
// re-learn the same deprecation once per module.
//
// New code should import from lib/providers.
// ---------------------------------------------------------------------------

export {
  MODEL_PROVIDER,
  callAnthropicTool,
  isSamplingParamRejection,
  resetSamplingParamCache,
  anthropicAdapter,
} from "./providers/anthropic";
