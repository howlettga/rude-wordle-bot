// Checks the initData string Telegram hands a Mini App (Telegram.WebApp.initData), which the store page sends
// on every API call as "Authorization: tma <initData>". No runtime imports, so scripts/test-webapp.mjs can load
// this file directly under Node.
//
// Telegram signs initData with the bot's token (core.telegram.org/bots/webapps, "Validating data received via
// the Mini App"):
//   secret_key        = HMAC_SHA256(key = "WebAppData", message = bot_token)
//   data_check_string = every field except hash, as key=value (values URL-decoded), sorted by key, joined by "\n"
//   hash              = hex(HMAC_SHA256(key = secret_key, message = data_check_string))
// Newer clients also send a signature field, meant for third parties checking an Ed25519 signature without the
// token. It isn't clear whether real clients fold it into the HMAC's data-check-string, so we accept the hash
// computed either way: both are keyed by our token, so neither can be forged without it.
//
// A valid hash only proves Telegram issued this initData to this user. It says nothing about which group the
// page was opened from (start_param is whatever the link said), which is what store-link.ts is for.

// How long after the page was opened its initData is still accepted. After that the page asks to be reopened.
export const INIT_DATA_MAX_AGE_SECONDS = 3600;

export interface InitDataUser {
  id: number;
  first_name: string;
  username?: string;
}

export type InitDataResult =
  | { ok: true; user: InitDataUser; startParam: string | null; authDate: number; chatType: string | null; chatInstance: string | null }
  | { ok: false; reason: "MALFORMED" | "BAD_HASH" | "EXPIRED" };

const encoder = new TextEncoder();

async function hmacSha256(key: Uint8Array<ArrayBuffer>, message: string): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message)));
}

// Compares every byte and folds the differences together, so how long it takes doesn't depend on where the
// first mismatch is.
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// hash is 64 hex characters (a SHA-256 digest); anything else is null.
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function dataCheckString(fields: Map<string, string>, without: string[]): string {
  return [...fields.keys()]
    .filter((key) => !without.includes(key))
    .sort()
    .map((key) => `${key}=${fields.get(key)}`)
    .join("\n");
}

function parseUser(json: string): InitDataUser | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { id, first_name, username } = value as Record<string, unknown>;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || typeof first_name !== "string") return null;
  return typeof username === "string" ? { id, first_name, username } : { id, first_name };
}

// raw: the exact Telegram.WebApp.initData string. Checks, in order: the shape (MALFORMED), the hash (BAD_HASH),
// the user JSON (MALFORMED), then age (EXPIRED when nowSec - auth_date > maxAgeSec). auth_date is only trusted
// once the hash checks out.
export async function validateInitData(
  raw: string,
  botToken: string,
  nowSec: number,
  maxAgeSec: number = INIT_DATA_MAX_AGE_SECONDS
): Promise<InitDataResult> {
  const fields = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(raw)) {
    // Telegram never repeats a field; a repeat would make the data-check-string ambiguous.
    if (fields.has(key)) return { ok: false, reason: "MALFORMED" };
    fields.set(key, value);
  }
  const hashHex = fields.get("hash");
  const authDateText = fields.get("auth_date");
  const userJson = fields.get("user");
  if (hashHex === undefined || authDateText === undefined || userJson === undefined) return { ok: false, reason: "MALFORMED" };
  const hash = hexToBytes(hashHex);
  if (hash === null || !/^\d{1,15}$/.test(authDateText)) return { ok: false, reason: "MALFORMED" };

  const secretKey = await hmacSha256(encoder.encode("WebAppData"), botToken);
  let matches = bytesEqual(await hmacSha256(secretKey, dataCheckString(fields, ["hash"])), hash);
  if (!matches && fields.has("signature")) {
    matches = bytesEqual(await hmacSha256(secretKey, dataCheckString(fields, ["hash", "signature"])), hash);
  }
  if (!matches) return { ok: false, reason: "BAD_HASH" };

  const user = parseUser(userJson);
  if (user === null) return { ok: false, reason: "MALFORMED" };
  const authDate = Number(authDateText);
  if (nowSec - authDate > maxAgeSec) return { ok: false, reason: "EXPIRED" };

  return {
    ok: true,
    user,
    startParam: fields.get("start_param") ?? null,
    authDate,
    chatType: fields.get("chat_type") ?? null,
    chatInstance: fields.get("chat_instance") ?? null,
  };
}
