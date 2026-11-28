import { Api, GrammyError } from "grammy";
import type { Env } from "../main.js";
import { buildStorage } from "../build-storage.js";
import type { StorageService } from "../storage-service.js";
import type { StoreBuyResult, StoreItem } from "../durable-objects/store.js";
import type { PetFundStatus, PetFundUnlock } from "../durable-objects/pet.js";
import type { AnglerStatus } from "../durable-objects/fishing.js";
import { GEAR_LINES, TIDE_CHART_ITEM, WORMS, type GearLine } from "../gear.js";
import { bestCastDay, lakeTier, spotRest, tideForecast, type SpotRest } from "../fishing-math.js";
import { BOTTLE_CONFIG, BOTTLE_DISTANCES, LITTER_LINES, cleanBottleText, isBottleDistance } from "../bottles.js";
import { PET_FUND } from "../pet-config.js";
import { formatBeans } from "../store-math.js";
import { buildStoreLinks, renderStoreCard, storeUrlFor, type StoreLinks } from "../store.js";
import { nowSec, random } from "../util.js";
import { validateInitData } from "./init-data.js";
import { verifyStoreLink } from "./store-link.js";

// The store page's API (public/app/ is the page; main.ts sends /app/api/* here). Same origin as the page, JSON
// in and out, never cached. Every request carries "Authorization: tma <Telegram.WebApp.initData>", and is checked
// in this order before anything else happens:
//   1. initData's hash (init-data.ts): proves Telegram opened the page for this user, recently.
//   2. start_param, the card's signed link (store-link.ts): says which chat, and that we put it on a card.
//   3. getChatMember: the user is in that chat now, so a forwarded link is no use to an outsider.
//   4. The chat has the store feature on.
// The page never sends a chat id; it only ever comes from the signed link.
//
//   GET  /app/api/state  the player's wallet, bucket (with quotes), gear and worms, today's fish price, the pet fund
//                        (null with the pet feature off), and their tide chart (null with fishing off; only the
//                        price unless they have one running)
//   POST /app/api/sell   { fishId } sells that fish, the same take-then-pay as the card's Sell buttons
//   POST /app/api/buy    { item: "rod" | "boat" | "worms" } buys it now (the page asks before it calls this)
//   POST /app/api/bottle { text, distance: "shore" | "buoys" | "sea" } pays for a message in a bottle and throws it
//                        out to sea (see bottles.ts)
//   POST /app/api/fund   { amount } chips in to the pet fund (see PET_FUND in pet-config.ts); reaching a goal posts a
//                        celebration in the chat
//   POST /app/api/chart  (no body) buys a tide chart, or adds its days to the one running (see TIDE_CHART_ITEM)
// A sale, a rod or boat upgrade, a bottle, or a donation also edits the chat's latest /store card (its activity line),
// after the response. A tide chart is private, so it doesn't.

const ROUTES: Record<string, { method: "GET" | "POST"; handle: (session: Session, request: Request) => Promise<Response> }> = {
  "/app/api/state": { method: "GET", handle: (session) => getState(session) },
  "/app/api/sell": { method: "POST", handle: (session, request) => sell(session, request) },
  "/app/api/buy": { method: "POST", handle: (session, request) => buy(session, request) },
  "/app/api/bottle": { method: "POST", handle: (session, request) => throwBottle(session, request) },
  "/app/api/fund": { method: "POST", handle: (session, request) => chipIn(session, request) },
  "/app/api/chart": { method: "POST", handle: (session) => buyTideChart(session) },
};

// Plain text for the player: the page shows message as it is.
const MESSAGES = {
  SESSION_EXPIRED: "This store session expired. Close and reopen the store.",
  BAD_SESSION: "Couldn't tell who you are. Close and reopen the store from the store card in your group.",
  LINK_EXPIRED: "This store link expired. Send /store in the chat for a fresh one.",
  BAD_LINK: "This store link isn't valid. Open the store from the store card in your group.",
  NOT_A_MEMBER: "Only members of this chat can use its store.",
  STORE_OFF: "The General Store is turned off in this chat.",
  FISHING_OFF: "Fishing is turned off in this chat, so there's nothing to sell or buy.",
  PET_OFF: "The group pet is turned off in this chat, so there's no pet fund.",
  NOT_YOURS: "That's not your fish.",
  GONE: "That fish is already gone.",
  NOT_FOUND: "There's nothing here.",
  SERVER_ERROR: "Something went wrong. Try again in a minute.",
} as const;

// Everything a route needs once the request has passed all four checks.
interface Session {
  env: Env;
  ctx: ExecutionContext;
  storage: StorageService;
  chatId: number;
  user: { id: number; first_name: string };
  fishing: boolean;
  pet: boolean;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function fail(status: number, error: string, message: string, headers?: Record<string, string>): Response {
  return json(status, { error, message }, headers);
}

export async function handleStoreApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { pathname } = new URL(request.url);
  const route = ROUTES[pathname];
  if (!route) {
    return fail(404, "NOT_FOUND", MESSAGES.NOT_FOUND);
  }
  if (request.method !== route.method) {
    return fail(405, "METHOD_NOT_ALLOWED", `Use ${route.method} for this.`, { Allow: route.method });
  }
  try {
    const session = await authenticate(request, env, ctx);
    return session instanceof Response ? session : await route.handle(session, request);
  } catch (err) {
    console.error("store api failed", request.method, pathname, err);
    return fail(500, "SERVER_ERROR", MESSAGES.SERVER_ERROR);
  }
}

// The four checks, in order. Returns the error response for the first one that fails.
async function authenticate(request: Request, env: Env, ctx: ExecutionContext): Promise<Session | Response> {
  const now = nowSec();

  const auth = request.headers.get("Authorization") ?? "";
  const initData = auth.startsWith("tma ") ? auth.slice("tma ".length) : null;
  const validated = initData ? await validateInitData(initData, env.BOT_TOKEN, now) : null;
  if (!validated?.ok) {
    return validated?.reason === "EXPIRED"
      ? fail(401, "SESSION_EXPIRED", MESSAGES.SESSION_EXPIRED)
      : fail(401, "BAD_SESSION", MESSAGES.BAD_SESSION);
  }
  const { user, startParam } = validated;

  const link = startParam === null ? null : await verifyStoreLink(startParam, env.BOT_TOKEN, now);
  if (!link?.ok) {
    return link?.reason === "EXPIRED" ? fail(401, "LINK_EXPIRED", MESSAGES.LINK_EXPIRED) : fail(403, "BAD_LINK", MESSAGES.BAD_LINK);
  }
  const { chatId } = link;

  if (!(await isMember(env, chatId, user.id))) {
    return fail(403, "NOT_A_MEMBER", MESSAGES.NOT_A_MEMBER);
  }

  const storage = buildStorage(env);
  const features = await storage.getChatFeatures(chatId);
  if (!features.store.enabled) {
    return fail(403, "STORE_OFF", MESSAGES.STORE_OFF);
  }

  return {
    env,
    ctx,
    storage,
    chatId,
    user: { id: user.id, first_name: user.first_name },
    fishing: features.fishing.enabled,
    pet: features.pet.enabled,
  };
}

// Telegram refusing the lookup (user or chat not found, bot no longer in the chat) counts as not a member; anything
// else (a network failure) is thrown and becomes a 500. A /store card in the bot's private chat with someone has
// that person's id as its chat id, and they're the only member.
async function isMember(env: Env, chatId: number, userId: number): Promise<boolean> {
  if (chatId === userId) {
    return true;
  }
  try {
    const member = await new Api(env.BOT_TOKEN).getChatMember(chatId, userId);
    return (
      member.status === "creator" ||
      member.status === "administrator" ||
      member.status === "member" ||
      (member.status === "restricted" && member.is_member)
    );
  } catch (err) {
    if (err instanceof GrammyError) {
      console.error("store api getChatMember refused", chatId, userId, err.description);
      return false;
    }
    throw err;
  }
}

async function getState(session: Session): Promise<Response> {
  const { storage, chatId, user, fishing, pet } = session;
  const [card, wallet, held, bottlesOut, fund, chartUntil, angler] = await Promise.all([
    storage.getStoreCard(chatId),
    storage.getWallet(chatId, user.id),
    fishing ? storage.getFishBucket(chatId, user.id) : Promise.resolve([]),
    fishing ? storage.countBottlesInWater(chatId, user.id) : Promise.resolve(0),
    pet ? storage.getPetFund(chatId) : Promise.resolve(null),
    fishing ? storage.getChartUntil(chatId, user.id) : Promise.resolve(null),
    fishing ? storage.getAnglerStatus(chatId, user.id) : Promise.resolve(null),
  ]);
  const quotes = held.length > 0 ? await storage.quoteFishes(chatId, held) : [];
  const bucket = held.map((fish, i) => ({
    id: fish.id,
    species: fish.species,
    emoji: fish.emoji,
    weight: fish.weight,
    quote: quotes[i] ?? 0,
    daysHeld: Math.round(fish.daysHeld * 10) / 10,
  }));
  const gear = (["rod", "boat"] as const satisfies GearLine[]).map((line) => {
    const { emoji, pitch, tiers } = GEAR_LINES[line];
    const tier = wallet.gear[line];
    const next = tiers[tier + 1];
    return {
      line,
      emoji,
      current: (tiers[tier] ?? tiers[0]!).name,
      next: next ? { name: next.name, price: next.price, pitch } : null,
    };
  });
  return json(200, {
    firstName: user.first_name,
    balance: wallet.balance,
    fishing,
    price: { perLb: card.fish.perLb, yesterdayPerLb: card.fish.yesterdayPerLb },
    bucket,
    worms: { count: wallet.gear.worms, max: WORMS.maxHeld, price: WORMS.price },
    gear,
    // atLimit is the only thing the page learns about the player's own bottles: there's no history, by design.
    bottles: {
      price: BOTTLE_CONFIG.PRICE,
      maxChars: BOTTLE_CONFIG.MAX_CHARS,
      maxLines: BOTTLE_CONFIG.MAX_LINES,
      atLimit: bottlesOut >= BOTTLE_CONFIG.MAX_IN_WATER,
      // No hint (the wash-up ranges) on purpose: how long a throw takes is part of the mystery.
      distances: Object.entries(BOTTLE_DISTANCES).map(([id, { emoji, label }]) => ({ id, emoji, label })),
    },
    petFund: fund ? petFundJson(fund) : null,
    tideChart: angler ? tideChartJson(session, chartUntil, angler) : null,
  });
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
// A fishing day's weekday ("Thu"), from its date: day 0 of the epoch was a Thursday.
const weekdayOf = (dayNumber: number) => WEEKDAYS[new Date(dayNumber * 86_400_000).getUTCDay()]!;
const SPOT_METER: Record<SpotRest, number> = { fished_out: 0, overfished: 1, recovering: 2, almost: 3, rested: 4 };
// Days of rest that make a spot fully rested (spotRest's "rested").
const RESTED_AFTER_DAYS = 4;

// The page's tideChart block. Without a chart running it's only the price and days, so the forecast, the spot, and
// the lake never leave the server unpaid for.
function tideChartJson(session: Session, chartUntil: number | null, angler: AnglerStatus) {
  const { price, days } = TIDE_CHART_ITEM;
  const now = nowSec();
  if (chartUntil === null || chartUntil <= now) {
    return { price, days, active: false };
  }
  // Today's fishing day comes from the Fishing DO, which knows the chat's location (the day turns over at sunrise).
  const { dayNumber } = angler;
  const forecast = tideForecast(session.env.TIDE_SECRET, session.chatId, dayNumber);
  const { daysSinceLastCast, castsToday } = angler;
  const best = bestCastDay(forecast, daysSinceLastCast);
  const rest = spotRest(daysSinceLastCast);
  return {
    price,
    days,
    active: true,
    until: chartUntil,
    daysLeft: daysLeft(chartUntil, now),
    forecast: forecast.map((day, i) => ({ weekday: weekdayOf(day.dayNumber), tide: day.tide, exact: day.exact, best: i === best })),
    spot: {
      rest,
      meter: SPOT_METER[rest],
      restedOn:
        daysSinceLastCast === null || daysSinceLastCast >= RESTED_AFTER_DAYS
          ? null
          : weekdayOf(dayNumber + RESTED_AFTER_DAYS - daysSinceLastCast),
    },
    lake: lakeTier(castsToday),
  };
}

// Whole days left on a chart, rounded up, so a chart bought just now says the full 7.
function daysLeft(until: number, now: number): number {
  return Math.ceil((until - now) / 86_400);
}

// The page's petFund block: the fund's status plus the amounts it offers. goal is null once every slot is unlocked.
function petFundJson(fund: PetFundStatus) {
  const { raised, goal, slots, maxSlots, livingPets } = fund;
  return { raised, goal, slots, maxSlots, livingPets, options: [...PET_FUND.DONATION_OPTIONS] };
}

// The body as a JSON object, or null if it isn't one.
async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Same order as StoreComposer.sellCaught: take the fish out of the bucket (marked sold), pay for it, and put it
// back if the payout fails, so a broken sale never just eats someone's fish.
async function sell(session: Session, request: Request): Promise<Response> {
  const body = await readBody(request);
  const fishId = body?.fishId;
  if (typeof fishId !== "number" || !Number.isSafeInteger(fishId) || fishId <= 0) {
    return fail(400, "BAD_REQUEST", "Pick a fish to sell.");
  }
  const { storage, chatId, user } = session;
  if (!session.fishing) {
    return fail(409, "FISHING_OFF", MESSAGES.FISHING_OFF);
  }

  const taken = await storage.takeFishById(chatId, user.id, fishId, "store", "sold");
  if (!taken.ok) {
    return taken.reason === "NOT_YOURS" ? fail(403, "NOT_YOURS", MESSAGES.NOT_YOURS) : fail(409, "GONE", MESSAGES.GONE);
  }
  const { fish } = taken;
  let sale;
  try {
    sale = await storage.sellFish(chatId, { userId: user.id, firstName: user.first_name, fish });
  } catch (err) {
    await storage.returnFish(chatId, fish.id).catch((refundErr) => console.error("returnFish failed", fish, refundErr));
    throw err;
  }

  refreshLatestCard(session);
  return json(200, {
    amount: sale.amount,
    balance: sale.balance,
    fish: { species: fish.species, emoji: fish.emoji, weight: fish.weight },
  });
}

async function buy(session: Session, request: Request): Promise<Response> {
  const body = await readBody(request);
  const item = body?.item;
  if (item !== "rod" && item !== "boat" && item !== "worms") {
    return fail(400, "BAD_REQUEST", "That's not something the store sells.");
  }
  const { storage, chatId, user } = session;
  if (!session.fishing) {
    return fail(409, "FISHING_OFF", MESSAGES.FISHING_OFF);
  }

  const result = await storage.buyStoreGear(chatId, { userId: user.id, firstName: user.first_name, item: item satisfies StoreItem });
  if (result.kind !== "BOUGHT") {
    return fail(409, result.kind, buyRefusal(result));
  }
  if (item !== "worms") {
    refreshLatestCard(session);
  }
  return json(200, { name: result.name, price: result.price, balance: result.balance, worms: result.gear.worms });
}

const BOTTLE_TEXT_ERRORS = {
  EMPTY: "Write something first.",
  TOO_LONG: `That's too long for a bottle (${BOTTLE_CONFIG.MAX_CHARS} characters max).`,
  TOO_MANY_LINES: `Keep it to ${BOTTLE_CONFIG.MAX_LINES} lines.`,
} as const;

// Pay first, then throw: the Store and Fishing DOs are separate, so there's no one transaction. If the throw is
// refused (the player already has MAX_IN_WATER out, maybe from another throw a moment ago) or fails, the beans go
// back. The card's activity line skips a refunded bottle (see Store.card).
async function throwBottle(session: Session, request: Request): Promise<Response> {
  const body = await readBody(request);
  const distance = body?.distance;
  if (!isBottleDistance(distance)) {
    return fail(400, "BAD_REQUEST", "Pick how far to throw it.");
  }
  const cleaned = cleanBottleText(typeof body?.text === "string" ? body.text : "");
  if (!cleaned.ok) {
    return fail(400, "BAD_REQUEST", BOTTLE_TEXT_ERRORS[cleaned.reason]);
  }
  const { storage, chatId, user } = session;
  if (!session.fishing) {
    return fail(409, "FISHING_OFF", MESSAGES.FISHING_OFF);
  }

  const purchase = { userId: user.id, firstName: user.first_name, amount: BOTTLE_CONFIG.PRICE, source: "bottle", label: "Message in a bottle" };
  const charged = await storage.chargeWallet(chatId, purchase);
  if (!charged.ok) {
    return fail(
      409,
      "CANT_AFFORD",
      `A bottle costs ${formatBeans(BOTTLE_CONFIG.PRICE)}. You have ${formatBeans(charged.balance)}. Sell some fish.`
    );
  }
  let thrown;
  try {
    thrown = await storage.throwBottle(chatId, { authorId: user.id, authorName: user.first_name, text: cleaned.text, distance });
  } catch (err) {
    await storage.refundWallet(chatId, purchase).catch((refundErr) => console.error("bottle refund failed", chatId, user.id, refundErr));
    throw err;
  }
  if (!thrown.ok) {
    await storage.refundWallet(chatId, purchase);
    return fail(409, "LIMIT", random([...LITTER_LINES]));
  }

  refreshLatestCard(session);
  return json(200, { balance: charged.balance });
}

function isDonationOption(amount: unknown): amount is (typeof PET_FUND.DONATION_OPTIONS)[number] {
  return typeof amount === "number" && (PET_FUND.DONATION_OPTIONS as readonly number[]).includes(amount);
}

// Same shape as throwBottle: pay first, then donate (the Store and Pet DOs are separate), and give the beans back if
// the fund refuses (every slot already unlocked, or more than it still needs) or the donation fails. The card's
// activity line skips a refunded donation (see Store.card). A donation that goes through is final.
async function chipIn(session: Session, request: Request): Promise<Response> {
  const body = await readBody(request);
  const amount = body?.amount;
  if (!isDonationOption(amount)) {
    return fail(400, "BAD_REQUEST", "Pick an amount.");
  }
  const { env, ctx, storage, chatId, user } = session;
  if (!session.pet) {
    return fail(409, "PET_OFF", MESSAGES.PET_OFF);
  }

  const purchase = { userId: user.id, firstName: user.first_name, amount, source: "fund", label: "pet fund" };
  const charged = await storage.chargeWallet(chatId, purchase);
  if (!charged.ok) {
    return fail(409, "CANT_AFFORD", `That's ${formatBeans(amount)}. You have ${formatBeans(charged.balance)}. Sell some fish.`);
  }
  let donated;
  try {
    donated = await storage.donateToPetFund(chatId, { userId: user.id, firstName: user.first_name, amount });
  } catch (err) {
    await storage.refundWallet(chatId, purchase).catch((refundErr) => console.error("fund refund failed", chatId, user.id, refundErr));
    throw err;
  }
  if (!donated.ok) {
    await storage.refundWallet(chatId, purchase);
    return donated.reason === "MAXED"
      ? fail(409, "MAXED", "Every pet slot is already unlocked.")
      : fail(409, "TOO_MUCH", `The fund only needs ${formatBeans(donated.max)} more.`);
  }

  refreshLatestCard(session);
  if (donated.unlocked.length > 0) {
    const unlocked = donated.unlocked;
    const celebrate = async () => {
      // Into the latest store card's topic, if it's in one, since that's where the store lives in this chat.
      const latest = await storage.getLatestStoreCard(chatId).catch((err) => {
        console.error("getLatestStoreCard failed", chatId, err);
        return null;
      });
      const api = new Api(env.BOT_TOKEN);
      for (const unlock of unlocked) {
        await api
          .sendMessage(chatId, celebration(unlock), {
            link_preview_options: { is_disabled: true },
            ...(latest?.threadId != null && { message_thread_id: latest.threadId }),
          })
          .catch((err) => console.error("pet fund celebration failed", chatId, unlock.slot, err));
      }
    };
    ctx.waitUntil(celebrate());
  }
  return json(200, { balance: charged.balance, fund: petFundJson(donated.fund), unlocked: donated.unlocked.length });
}

// One synchronous step in the Store DO: pay, and start the chart or add its days to the one running. Nothing to refund,
// since nothing happens in another DO.
async function buyTideChart(session: Session): Promise<Response> {
  const { storage, chatId, user } = session;
  if (!session.fishing) {
    return fail(409, "FISHING_OFF", MESSAGES.FISHING_OFF);
  }
  const result = await storage.buyTideChart(chatId, { userId: user.id, firstName: user.first_name });
  if (!result.ok) {
    return fail(
      409,
      "CANT_AFFORD",
      `A tide chart costs ${formatBeans(TIDE_CHART_ITEM.price)}. You have ${formatBeans(result.balance)}. Sell some fish.`
    );
  }
  return json(200, { balance: result.balance, until: result.until, daysLeft: daysLeft(result.until, nowSec()) });
}

// Plain text:
//   🎉 The pet fund hit 🫘100! There's room for another pet. Use /adopt.
//   Thanks to Galen (🫘60), Kyle (🫘30), and Sam (🫘10).
function celebration(unlock: PetFundUnlock): string {
  const names = unlock.topDonors.slice(0, PET_FUND.TOP_DONORS).map(({ firstName, amount }) => `${firstName} (${formatBeans(amount)})`);
  const headline = `🎉 The pet fund hit ${formatBeans(unlock.goal)}! There's room for another pet. Use /adopt.`;
  if (names.length === 0) {
    return headline;
  }
  const thanks =
    names.length === 1
      ? names[0]
      : names.length === 2
        ? `${names[0]} and ${names[1]}`
        : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
  return `${headline}\nThanks to ${thanks}.`;
}

// Plain text, like the card's gear pop-ups (see gearPopup in store.ts).
function buyRefusal(result: Exclude<StoreBuyResult, { kind: "BOUGHT" }>): string {
  switch (result.kind) {
    case "CANT_AFFORD": {
      // "A Carbon rod", "An Inner tube", "A worm".
      const name = result.item === "worms" ? "worm" : result.name;
      const article = /^[aeiou]/i.test(name) ? "An" : "A";
      return `${article} ${name} costs ${formatBeans(result.price)}. You have ${formatBeans(result.balance)}. Sell some fish.`;
    }
    case "MAXED":
      return `You already have the ${result.name}. It doesn't get better than this.`;
    case "FULL":
      return `Your worm can is full (${result.worms}). Go use some.`;
  }
}

// After the response goes out: puts the new activity line (and a freshly signed Open store link) on the chat's most
// recent /store card. Older cards are left alone. Fishing is on for a sale, upgrade, or bottle, but a pet fund
// donation doesn't need it, so the card follows the chat's switch. Failures, like "message is not modified" or a
// deleted card, are only logged.
function refreshLatestCard(session: Session) {
  const { env, ctx, storage, chatId, fishing } = session;
  const refresh = async () => {
    const latest = await storage.getLatestStoreCard(chatId);
    if (!latest) {
      return;
    }
    const [card, storeUrl] = await Promise.all([storage.getStoreCard(chatId), storeUrlFor(chatId, storeLinks(env))]);
    const links = storeLinks(env);
    const { text, reply_markup, link_preview_options } = renderStoreCard(card, fishing, storeUrl, links.bannerUrl);
    await new Api(env.BOT_TOKEN).editMessageText(chatId, latest.messageId, text, { parse_mode: "HTML", reply_markup, link_preview_options });
  };
  ctx.waitUntil(refresh().catch((err) => console.error("store card refresh failed", chatId, err)));
}

// The same link signing bot.ts gives StoreComposer, built from the env since there's no Bot here.
function storeLinks(env: Env): StoreLinks {
  let botUsername: string | undefined;
  try {
    const info: unknown = JSON.parse(env.BOT_INFO);
    const username = (info as { username?: unknown } | null)?.username;
    botUsername = typeof username === "string" ? username : undefined;
  } catch (err) {
    console.error("BOT_INFO is not valid JSON", err);
  }
  return buildStoreLinks({ token: env.BOT_TOKEN, botUsername, publicUrl: env.PUBLIC_URL });
}
