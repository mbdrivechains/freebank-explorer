// Whether the explorer shows gold: grams beside ECX amounts, the gold fix (/gold and its tiles), and the gold
// oracle's Goggles filter. Off unless the FREEBANK_GOLD setting is true (docker/frontend/entrypoint.sh).
// FreeBank mainnet launches ECX-only, with no gold claims and no gram display; gold opens later at a height
// Michael sets, and this setting is then switched on without a new release (D-2026-09-29-5 in the drivechains
// inbox/DECISIONS.md). The node's *_grams fields still come through the API; only the display is switched.
// Read from window.__env like filters.utils.ts reads its settings, so pipes and pure helpers can use it too.

export const GOLD_SHOWN: boolean = typeof window !== 'undefined' && (window as any)?.__env?.FREEBANK_GOLD === true;
