// Per-chat feature switches, flipped by the owner with /features (see feature-control.ts). Each chat
// only stores the switches the owner has actually flipped (see the ChatPause DO) — everything else falls
// back to defaultEnabled here, so adding a feature is just a new entry below plus a gate() line in
// bot.ts. Keys are stored in the DB and typed into /features, so never rename one; retire it instead.
//
// Pure data on purpose: storage-service.ts and the cron jobs import this too, without pulling in any
// composer. Order here is display order in /features, not handler order (that's bot.ts's job).
export const FEATURES = [
  { key: "wordle", label: "Wordle Golf", description: "Rounds, score submissions, nightly reminders", defaultEnabled: true },
  { key: "market", label: "Stock market", description: "Every market command, price tracking, and market cron jobs", defaultEnabled: true },
  { key: "beans", label: "Been/bean counter", description: "Counts \"been\", posts the tally on \"bean\"", defaultEnabled: true },
  { key: "replies", label: "Talk-back", description: "Replies when someone names the bot, replies to its jokes, or says \"galen\"", defaultEnabled: true },
  { key: "eastereggs", label: "Easter eggs", description: "Keyword jokes in normal conversation (gas, commute, raise, ...)", defaultEnabled: true },
  { key: "spicy", label: "Spicy", description: "The spank chain, butthole replies, and the crudest easter-egg lines", defaultEnabled: true },
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
