import { Api, GrammyError } from "grammy";
import type { Env } from "../main.js";
import { buildStorage } from "../build-storage.js";
import type { StorageService } from "../storage-service.js";
import type { StoreBuyResult, StoreItem } from "../durable-objects/store.js";
import { GEAR_LINES, WORMS, type GearLine } from "../gear.js";
import { BOTTLE_CONFIG, BOTTLE_DISTANCES, LITTER_LINES, cleanBottleText, isBottleDistance } from "../bottles.js";
import { formatBeans } from "../store-math.js";
import { renderStoreCard, storeUrlFor, type StoreLinks } from "../store.js";
import { random } from "../util.js";
import { validateInitData } from "./init-data.js";
import { signStoreLink, verifyStoreLink } from "./store-link.js";

// The store page's API (public/app/ is the page; main.ts sends /app/api/* here). Same origin as the page, JSON
// in and out, never cached. Every request carries "Authorization: tma <Telegram.WebApp.initData>", and is checked
// in this order before anything else happens:
//   1. initData's hash (init-data.ts): proves Telegram opened the page for this user, recently.
//   2. start_param, the card's signed link (store-link.ts): says which chat, and that we put it on a card.
//   3. getChatMember: the user is in that chat now, so a forwarded link is no use to an outsider.
//   4. The chat has the store feature on.
// The page never sends a chat id; it only ever comes from the signed link.
//
//   GET  /app/api/state  the player's wallet, bucket (with quotes), gear and worms, and today's fish price
//   POST /app/api/sell   { fishId } sells that fish, the same take-then-pay as the card's Sell buttons
//   POST /app/api/buy    { item: "rod" | "boat" | "worms" } buys it now (the page asks before it calls this)
//   POST /app/api/bottle { text, distance: "shore" | "buoys" | "sea" } pays for a message in a bottle and throws it
//                        out to sea (see bottles.ts)
// A sale, a rod or boat upgrade, or a bottle also edits the chat's latest /store card (its activity line), after the
// response.

const ROUTES: Record<string, { method: "GET" | "POST"; handle: (session: Session, request: Request) => Promise<Response> }> = {
  "/app/api/state": { method: "GET", handle: (session) => getState(session) },
  "/app/api/sell": { method: "POST", handle: (session, request) => sell(session, request) },
  "/app/api/buy": { method: "POST", handle: (session, request) => buy(session, request) },
  "/app/api/bottle": { method: "POST", handle: (session, request) => throwBottle(session, request) },
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
  const nowSec = Math.floor(Date.now() / 1000);

  const auth = request.headers.get("Authorization") ?? "";
  const initData = auth.startsWith("tma ") ? auth.slice("tma ".length) : null;
  const validated = initData ? await validateInitData(initData, env.BOT_TOKEN, nowSec) : null;
  if (!validated?.ok) {
    return validated?.reason === "EXPIRED"
      ? fail(401, "SESSION_EXPIRED", MESSAGES.SESSION_EXPIRED)
      : fail(401, "BAD_SESSION", MESSAGES.BAD_SESSION);
  }
  const { user, startParam } = validated;

  const link = startParam === null ? null : await verifyStoreLink(startParam, env.BOT_TOKEN, nowSec);
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

  return { env, ctx, storage, chatId, user: { id: user.id, first_name: user.first_name }, fishing: features.fishing.enabled };
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
  const { storage, chatId, user, fishing } = session;
  const [card, wallet, held, bottlesOut] = await Promise.all([
    storage.getStoreCard(chatId),
    storage.getWallet(chatId, user.id),
    fishing ? storage.getFishBucket(chatId, user.id) : Promise.resolve([]),
    fishing ? storage.countBottlesInWater(chatId, user.id) : Promise.resolve(0),
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
      distances: Object.entries(BOTTLE_DISTANCES).map(([id, { emoji, label, hint }]) => ({ id, emoji, label, hint })),
    },
  });
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
// recent /store card. Older cards are left alone. Fishing is on here, or there'd have been no sale, upgrade, or bottle.
// Failures, like "message is not modified" or a deleted card, are only logged.
function refreshLatestCard(session: Session) {
  const { env, ctx, storage, chatId } = session;
  const refresh = async () => {
    const latest = await storage.getLatestStoreCard(chatId);
    if (!latest) {
      return;
    }
    const [card, storeUrl] = await Promise.all([storage.getStoreCard(chatId), storeUrlFor(chatId, storeLinks(env))]);
    const { text, reply_markup } = renderStoreCard(card, true, storeUrl);
    await new Api(env.BOT_TOKEN).editMessageText(chatId, latest.messageId, text, { parse_mode: "HTML", reply_markup });
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
  return { botUsername, signLink: (chatId) => signStoreLink(chatId, Math.floor(Date.now() / 1000), env.BOT_TOKEN) };
}
