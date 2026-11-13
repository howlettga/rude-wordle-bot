// Everything time-of-day in the bot (cron jobs, the 5pm trading day, the awake window) is defined in
// Eastern wall-clock time, which shifts an hour against UTC across DST. Cron Triggers and SQLite are both
// UTC-only, so these helpers do the conversion in JS via Intl rather than hardcoding a UTC offset.

const EASTERN = "America/New_York";

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: EASTERN,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  weekday: "short",
  hourCycle: "h23",
});

export interface EasternParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
  weekday: string; // "Mon", "Tue", ...
}

export function easternParts(date: Date): EasternParts {
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday!,
  };
}

// How far Eastern wall-clock time is ahead of UTC at this instant (negative: -4h in EDT, -5h in EST).
function easternOffsetMs(date: Date): number {
  const p = easternParts(date);
  const wallClockAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallClockAsUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// The UTC instant of an Eastern wall-clock time. Out-of-range days roll over the way Date.UTC does, so
// day + 1 past the end of a month is fine. Guesses with the offset at the wall-clock time read as UTC,
// then corrects once with the offset at the guess itself — enough for any hour that exists exactly once
// in Eastern time, which every hour this bot schedules around (midnight, 8am, 10am, 5pm, 10pm) does.
export function easternToUtc(year: number, month: number, day: number, hour: number): Date {
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour);
  const guess = wallClockAsUtc - easternOffsetMs(new Date(wallClockAsUtc));
  return new Date(wallClockAsUtc - easternOffsetMs(new Date(guess)));
}

// SQLite's own datetime() format ("YYYY-MM-DD HH:MM:SS", UTC), so results compare correctly as plain
// strings against created_at/expires_at columns.
export function toSqliteDatetime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}
