import { easternParts } from "./eastern-time.js";
import { fishingDay, type GeoLocation } from "./fishing-math.js";

// Today's fishing day, right now, at a location: the one call the Fishing DO (casts, the lake, the tide) and the
// Store DO (the fish price) both make, so they always agree on when the day turns over (sunrise; see fishingDay).
// Kept out of fishing-math.ts because that module has no runtime imports (the sim loads it directly).
export function fishingDayNow(location: GeoLocation, now: Date = new Date()): { date: string; dayNumber: number } {
  return fishingDay(easternParts(now), Math.floor(now.getTime() / 1000), location);
}
