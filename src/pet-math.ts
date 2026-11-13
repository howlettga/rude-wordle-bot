import { PET_CONFIG } from "./pet-config.js";

// The pet's meters, computed lazily: nothing ticks in the background. Each stored snapshot is "food and
// mood as of `at`", and advanceMeters works out what they are now from the elapsed time. All times are
// epoch seconds.
//
// food falls at a steady rate. mood falls at a steady rate too, faster once food drops below
// HUNGRY_BELOW — so mood's curve has two straight pieces, split at the moment food crosses that line.
// foodEmptySince / moodEmptySince record when a meter hit 0 (null while above it), which is what
// starving and running away are measured from.
export interface PetMeters {
  food: number;
  mood: number;
  at: number;
  foodEmptySince: number | null;
  moodEmptySince: number | null;
}

const foodRate = () => 100 / (PET_CONFIG.HOURS_TO_STARVE * 3600); // per second
const moodRate = () => 100 / (PET_CONFIG.HOURS_TO_MISERABLE * 3600);

export function advanceMeters(m: PetMeters, now: number): PetMeters {
  const t0 = m.at;
  if (now <= t0) {
    return m;
  }
  const fr = foodRate();
  const mr = moodRate();
  const hungryMr = mr * PET_CONFIG.HUNGRY_MOOD_DECAY_MULTIPLIER;

  const food = Math.max(0, m.food - fr * (now - t0));
  const foodZeroAt = m.food > 0 ? t0 + m.food / fr : (m.foodEmptySince ?? t0);

  // When food crosses HUNGRY_BELOW (t0 itself if it already has).
  const hungryAt = m.food > PET_CONFIG.HUNGRY_BELOW ? t0 + (m.food - PET_CONFIG.HUNGRY_BELOW) / fr : t0;
  const fedSeconds = Math.max(0, Math.min(now, hungryAt) - t0);
  const hungrySeconds = Math.max(0, now - Math.max(t0, hungryAt));
  const mood = Math.max(0, m.mood - mr * fedSeconds - hungryMr * hungrySeconds);

  let moodZeroAt: number;
  if (m.mood <= 0) {
    moodZeroAt = m.moodEmptySince ?? t0;
  } else {
    const dropBeforeHungry = mr * Math.max(0, hungryAt - t0);
    moodZeroAt =
      dropBeforeHungry >= m.mood ? t0 + m.mood / mr : Math.max(t0, hungryAt) + (m.mood - dropBeforeHungry) / hungryMr;
  }

  return {
    food,
    mood,
    at: now,
    foodEmptySince: food <= 0 ? foodZeroAt : null,
    moodEmptySince: mood <= 0 ? moodZeroAt : null,
  };
}

export type PetFate = { cause: "starved" | "ran_away"; at: number } | null;

// Whether the pet's already gone as of these (advanced) meters, and when it happened. If both deadlines
// have passed, whichever came first is what happened.
export function petFate(m: PetMeters): PetFate {
  const starveAt = m.foodEmptySince !== null ? m.foodEmptySince + PET_CONFIG.STARVE_AFTER_EMPTY_HOURS * 3600 : Infinity;
  const runAwayAt = m.moodEmptySince !== null ? m.moodEmptySince + PET_CONFIG.RUN_AWAY_AFTER_MISERABLE_HOURS * 3600 : Infinity;
  const at = Math.min(starveAt, runAwayAt);
  if (at > m.at) {
    return null;
  }
  return { cause: starveAt <= runAwayAt ? "starved" : "ran_away", at };
}
