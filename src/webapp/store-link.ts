// Signed store links: the startapp value on the /store card's Open store button. No runtime imports, so
// scripts/test-webapp.mjs can load this file directly under Node.
//
// A Mini App opened from a direct link (t.me/<bot>/store?startapp=...) isn't told which chat it was opened
// in; it only gets the startapp value back as start_param. Anyone can type their own startapp, so the card
// puts the chat id in it and signs it with the bot's token, and the API trusts the chat id only if the
// signature checks out. The page then still checks the user is a member of that chat (see api.ts), so a
// forwarded link is no use to an outsider.
//
// Format, e.g. "n1a2b3c4_t5u6v7_Ab3xK9pQ2mZ7wR4e":
//   "n" (negative) or "p" (positive) + base36(|chatId|)   group and supergroup ids are negative
//   "_" + base36(issuedAtSec)
//   "_" + the first 16 base64url characters of HMAC_SHA256(key = botToken, message = "store-link:" + the above)
// Telegram doesn't document what startapp may hold, so it stays within [A-Za-z0-9_-] and 64 characters (a
// -100xxxxxxxxxx supergroup comes to 34). The signature's own alphabet includes "_", so it's found by its fixed
// length rather than by splitting on "_". 16 base64url characters is 96 bits, plenty for a value that also
// expires after a day.

export const STORE_APP_SHORT_NAME = "store";
// A link is good for a day from when the card was posted or last edited. Every card edit re-signs it.
export const STORE_LINK_TTL_SECONDS = 24 * 3600;
// How far ahead of our clock issuedAt may be before we call it bogus (clock skew between Worker instances).
const FUTURE_SKEW_SECONDS = 300;
const SIGNATURE_LENGTH = 16;
const PARAM_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BODY_PATTERN = /^([np])([0-9a-z]+)_([0-9a-z]+)$/;

const encoder = new TextEncoder();

// The first SIGNATURE_LENGTH characters of the base64url (no padding) HMAC of body.
async function signBody(body: string, botToken: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(botToken), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`store-link:${body}`)));
  let binary = "";
  for (const byte of mac) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, SIGNATURE_LENGTH);
}

// Compares every character and folds the differences together, so timing doesn't reveal how much of a
// guessed signature was right.
function constantTimeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// Parses canonical base36 only (no leading zeros, nothing past Number.MAX_SAFE_INTEGER), so each number has
// exactly one spelling.
function parseBase36(text: string): number | null {
  const n = parseInt(text, 36);
  return Number.isSafeInteger(n) && n.toString(36) === text ? n : null;
}

export async function signStoreLink(chatId: number, issuedAtSec: number, botToken: string): Promise<string> {
  if (!Number.isSafeInteger(chatId) || chatId === 0) throw new RangeError(`bad chat id for a store link: ${chatId}`);
  if (!Number.isSafeInteger(issuedAtSec) || issuedAtSec < 0) throw new RangeError(`bad issue time for a store link: ${issuedAtSec}`);
  const body = `${chatId < 0 ? "n" : "p"}${Math.abs(chatId).toString(36)}_${issuedAtSec.toString(36)}`;
  return `${body}_${await signBody(body, botToken)}`;
}

// Checks, in order: the shape (MALFORMED), the signature (BAD_SIGNATURE), then age (EXPIRED past
// STORE_LINK_TTL_SECONDS, or if issuedAt is more than 300 s in the future).
export async function verifyStoreLink(
  param: string,
  botToken: string,
  nowSec: number
): Promise<{ ok: true; chatId: number; issuedAt: number } | { ok: false; reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" }> {
  if (!PARAM_PATTERN.test(param) || param.length < SIGNATURE_LENGTH + 2) return { ok: false, reason: "MALFORMED" };
  const separator = param.length - SIGNATURE_LENGTH - 1;
  if (param[separator] !== "_") return { ok: false, reason: "MALFORMED" };
  const body = param.slice(0, separator);
  const signature = param.slice(separator + 1);
  const match = BODY_PATTERN.exec(body);
  if (match === null) return { ok: false, reason: "MALFORMED" };
  const [, sign, chatText = "", issuedText = ""] = match;
  const magnitude = parseBase36(chatText);
  const issuedAt = parseBase36(issuedText);
  if (magnitude === null || magnitude === 0 || issuedAt === null) return { ok: false, reason: "MALFORMED" };

  if (!constantTimeEqual(await signBody(body, botToken), signature)) return { ok: false, reason: "BAD_SIGNATURE" };
  if (nowSec - issuedAt > STORE_LINK_TTL_SECONDS || issuedAt - nowSec > FUTURE_SKEW_SECONDS) return { ok: false, reason: "EXPIRED" };
  return { ok: true, chatId: sign === "n" ? -magnitude : magnitude, issuedAt };
}

// https://t.me/<botUsername>/<STORE_APP_SHORT_NAME>?startapp=<param>
export function storeAppUrl(botUsername: string, param: string): string {
  return `https://t.me/${encodeURIComponent(botUsername)}/${STORE_APP_SHORT_NAME}?startapp=${encodeURIComponent(param)}`;
}
