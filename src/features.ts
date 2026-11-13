// Per-chat feature switches, flipped by the owner with /features (see feature-control.ts). Each chat
// only stores the switches the owner has actually flipped (see the ChatPause DO) — everything else falls
// back to defaultEnabled here, so adding a feature is just a new entry below plus a gate() line in
// bot.ts. Keys are stored in the DB and typed into /features, so never rename one; retire it instead.
//
// Pure data on purpose: storage-service.ts and the cron jobs import this too, without pulling in any
// composer. Order here is display order in /features, not handler order (that's bot.ts's job).
//
// /features only ever shows the bare key (see feature-control.ts); label is only used in the "turned off
// in this chat" notice for stale buttons, which only the public features (wordle, market) have.
export const FEATURES = [
  // Rounds, score submissions, nightly reminders
  { key: "wordle", label: "Wordle Golf", defaultEnabled: true },
  // Every market command, price tracking, and the market's scheduled jobs
  { key: "market", label: "Stock market", defaultEnabled: true },
  // Counts "been", posts the tally on "bean"
  { key: "beans", label: "Been/bean counter", defaultEnabled: true },
  // Replies when someone names the bot, replies to one of its jokes, or says "galen"
  { key: "replies", label: "Talk-back", defaultEnabled: true },
  // Keyword jokes in normal conversation (gas, commute, raise, ...)
  { key: "eastereggs", label: "Easter eggs", defaultEnabled: true },
  // The spank chain, the butthole replies, and the crudest easter-egg lines
  { key: "spicy", label: "Spicy", defaultEnabled: true },
] as const;

export type FeatureKey = (typeof FEATURES)[number]["key"];

export interface FeatureState {
  enabled: boolean;
  // When the owner last flipped this switch (null if never — it's on its default). Epoch seconds via
  // SQLite's own strftime, never a JS parse of its space-separated UTC string. runDailyCleanup's ghost
  // purge grace period keys off market's.
  changedAtEpochSec: number | null;
}

export type FeatureFlags = Record<FeatureKey, FeatureState>;

export interface FeatureOverride {
  key: string;
  enabled: boolean;
  changedAtEpochSec: number;
}

export function isFeatureKey(key: string): key is FeatureKey {
  return FEATURES.some((feature) => feature.key === key);
}

// Overrides for keys that no longer exist (a retired feature) are ignored.
export function resolveFeatures(overrides: FeatureOverride[]): FeatureFlags {
  const flags = Object.fromEntries(
    FEATURES.map((feature) => [feature.key, { enabled: feature.defaultEnabled, changedAtEpochSec: null }])
  ) as FeatureFlags;
  for (const override of overrides) {
    if (isFeatureKey(override.key)) {
      flags[override.key] = { enabled: override.enabled, changedAtEpochSec: override.changedAtEpochSec };
    }
  }
  return flags;
}
