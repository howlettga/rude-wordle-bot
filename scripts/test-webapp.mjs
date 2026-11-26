// Tests the store Mini App's two security checks (Node 24+ runs the .ts imports directly): the signed store
// links in src/webapp/store-link.ts and the initData validation in src/webapp/init-data.ts. The initData here
// is signed with node:crypto, following Telegram's published algorithm independently of the code under test.
// Run after touching either file: `npm run test:webapp`. Exits non-zero if anything fails.
import { createHmac } from "node:crypto";
import { STORE_APP_SHORT_NAME, STORE_LINK_TTL_SECONDS, signStoreLink, storeAppUrl, verifyStoreLink } from "../src/webapp/store-link.ts";
import { INIT_DATA_MAX_AGE_SECONDS, validateInitData } from "../src/webapp/init-data.ts";

const TOKEN = "123456789:AAFakeTokenForTestsOnly_abcdefghijk";
const OTHER_TOKEN = "987654321:AAAnotherFakeToken-zyxwvutsrqponm";
const NOW = 1_764_000_000;
const PARAM = /^[A-Za-z0-9_-]{1,64}$/;

const failures = [];
const check = (ok, label) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures.push(label);
};
const show = (result) => JSON.stringify(result);

console.log("Store links");
for (const chatId of [42, 123456789, -987654321, -1001234567890, -1009999999999, 7_000_000_000]) {
  const param = await signStoreLink(chatId, NOW, TOKEN);
  const result = await verifyStoreLink(param, TOKEN, NOW + 60);
  check(result.ok && result.chatId === chatId && result.issuedAt === NOW, `round trip for chat ${chatId} (${param})`);
}

let allMatch = true;
let longest = 0;
for (let n = 0; n < 2000; n++) {
  const magnitude = Math.floor(Math.random() * 10 ** (1 + (n % 13))) + 1;
  const chatId = n % 3 === 0 ? magnitude : n % 3 === 1 ? -magnitude : -(1_000_000_000_000 + (magnitude % 1_000_000_000_000));
  const issuedAt = Math.floor(Math.random() * 4_000_000_000);
  const param = await signStoreLink(chatId, issuedAt, `${TOKEN}${n}`);
  if (!PARAM.test(param)) allMatch = false;
  longest = Math.max(longest, param.length);
  const result = await verifyStoreLink(param, `${TOKEN}${n}`, issuedAt);
  if (!result.ok || result.chatId !== chatId) allMatch = false;
}
check(allMatch, `2000 random links match ${PARAM} and round trip (longest ${longest} chars)`);
// Base64url uses "-" and "_"; make sure links whose signature has them still verify.
let sawDash = false;
let sawUnderscore = false;
for (let t = 0; t < 400 && !(sawDash && sawUnderscore); t++) {
  const param = await signStoreLink(-1001234567890, NOW + t, TOKEN);
  const signature = param.slice(-16);
  const ok = (await verifyStoreLink(param, TOKEN, NOW + t)).ok;
  if (ok && signature.includes("-")) sawDash = true;
  if (ok && signature.includes("_")) sawUnderscore = true;
}
check(sawDash && sawUnderscore, `signatures containing "-" and "_" verify`);

const base = await signStoreLink(-1001234567890, NOW, TOKEN);
const [, chatPart, timePart] = /^(n[0-9a-z]+)_([0-9a-z]+)_/.exec(base);
const signature = base.slice(-16);
const tamperedChat = `n${(1001234567891).toString(36)}_${timePart}_${signature}`;
check((await verifyStoreLink(tamperedChat, TOKEN, NOW)).reason === "BAD_SIGNATURE", `a tampered chat id gives BAD_SIGNATURE`);
const flippedSign = `p${chatPart.slice(1)}_${timePart}_${signature}`;
check((await verifyStoreLink(flippedSign, TOKEN, NOW)).reason === "BAD_SIGNATURE", `a flipped chat id sign gives BAD_SIGNATURE`);
const tamperedTime = `${chatPart}_${(NOW + 3600).toString(36)}_${signature}`;
check((await verifyStoreLink(tamperedTime, TOKEN, NOW)).reason === "BAD_SIGNATURE", `a tampered timestamp gives BAD_SIGNATURE`);
const lastChar = signature.at(-1) === "A" ? "B" : "A";
check((await verifyStoreLink(base.slice(0, -1) + lastChar, TOKEN, NOW)).reason === "BAD_SIGNATURE", `a changed signature gives BAD_SIGNATURE`);
check((await verifyStoreLink(base, OTHER_TOKEN, NOW)).reason === "BAD_SIGNATURE", `another bot's token gives BAD_SIGNATURE`);

check((await verifyStoreLink(base, TOKEN, NOW + STORE_LINK_TTL_SECONDS)).ok, `a link is still good at exactly ${STORE_LINK_TTL_SECONDS} s`);
check((await verifyStoreLink(base, TOKEN, NOW + STORE_LINK_TTL_SECONDS + 1)).reason === "EXPIRED", `past the TTL gives EXPIRED`);
check((await verifyStoreLink(base, TOKEN, NOW - 300)).ok, `issued 300 s in the future is accepted`);
check((await verifyStoreLink(base, TOKEN, NOW - 301)).reason === "EXPIRED", `issued more than 300 s in the future gives EXPIRED`);

const garbage = [
  "",
  "hello",
  "a".repeat(65),
  `${base}x`.padEnd(65, "x"),
  "p1_1_!!!!!!!!!!!!!!!!",
  "p1_1_AAAAAAAAAAAAAAA",
  "p1_1_AAAAAAAAAAAAAAAAA",
  "x1_1_AAAAAAAAAAAAAAAA",
  "P1_1_AAAAAAAAAAAAAAAA",
  "p01_1_AAAAAAAAAAAAAAAA",
  "n0_1_AAAAAAAAAAAAAAAA",
  "p1__AAAAAAAAAAAAAAAA",
  "p1_1AAAAAAAAAAAAAAAA",
  "p1_1_1_AAAAAAAAAAAAAAAA",
  "pzzzzzzzzzzzz_1_AAAAAAAAAAAAAAAA",
  "p1 1_AAAAAAAAAAAAAAAA",
  base.replace("_", "-"),
];
for (const param of garbage) {
  const result = await verifyStoreLink(param, TOKEN, NOW);
  check(!result.ok && result.reason === "MALFORMED", `${JSON.stringify(param)} gives MALFORMED (${show(result)})`);
}

let threw = 0;
for (const [chatId, issuedAt] of [[0, NOW], [1.5, NOW], [Number.MAX_SAFE_INTEGER + 2, NOW], [42, -1], [42, NaN]]) {
  try {
    await signStoreLink(chatId, issuedAt, TOKEN);
  } catch {
    threw++;
  }
}
check(threw === 5, `signStoreLink refuses a zero, fractional, or unsafe chat id and a bad issue time (${threw}/5)`);
check(
  storeAppUrl("rude_test_bot", base) === `https://t.me/rude_test_bot/${STORE_APP_SHORT_NAME}?startapp=${base}`,
  `storeAppUrl builds the direct link (${storeAppUrl("rude_test_bot", base)})`
);

// initData, signed the way Telegram describes: secret_key = HMAC_SHA256("WebAppData", token), then the hash
// over every field but hash, key=value, sorted, joined by "\n". hashOver picks which fields go into the hash, so
// a test can sign with the signature field included or left out.
const signInitData = (fields, { token = TOKEN, hashOver = Object.keys(fields) } = {}) => {
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const checkString = hashOver
    .filter((key) => key !== "hash")
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
  const hash = createHmac("sha256", secret).update(checkString).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
};
const USER = { id: 5512345678, first_name: "Galen & Co. 🎣", last_name: "H", username: "galen_h", language_code: "en", allows_write_to_pm: true };
const fields = (overrides = {}) => ({
  query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
  user: JSON.stringify(USER),
  chat_instance: "-3788475317572404878",
  chat_type: "supergroup",
  start_param: base,
  auth_date: String(NOW),
  ...overrides,
});
const SIGNATURE = "pgBgxdPGxAUGIy5ZfH8FpDGrMD9nhEDV6KZkmy_5yc0cL5B2ub3QH1Am9wXXjZBH6Wgz3kzDvOnvZdkKgwk7Bg";

console.log("\ninitData");
const plain = await validateInitData(signInitData(fields()), TOKEN, NOW + 10);
check(plain.ok, `initData without a signature field validates (${show(plain.ok ? { ok: true } : plain)})`);
const withSig = fields({ signature: SIGNATURE });
const sigIncluded = await validateInitData(signInitData(withSig), TOKEN, NOW + 10);
check(sigIncluded.ok, `initData with signature included in the hash validates`);
const sigExcluded = await validateInitData(signInitData(withSig, { hashOver: Object.keys(withSig).filter((k) => k !== "signature") }), TOKEN, NOW + 10);
check(sigExcluded.ok, `initData with signature left out of the hash validates`);

check(
  plain.ok && plain.user.id === USER.id && plain.user.first_name === USER.first_name && plain.user.username === USER.username,
  `the user JSON is parsed (${plain.ok ? show(plain.user) : "-"})`
);
check(
  plain.ok && plain.startParam === base && plain.authDate === NOW && plain.chatType === "supergroup" && plain.chatInstance === "-3788475317572404878",
  `start_param, auth_date, chat_type, and chat_instance come through`
);
const bare = await validateInitData(
  signInitData({ user: JSON.stringify({ id: 7, first_name: "Al" }), auth_date: String(NOW) }),
  TOKEN,
  NOW
);
check(
  bare.ok && bare.startParam === null && bare.chatType === null && bare.chatInstance === null && !("username" in bare.user),
  `missing optional fields come through as null, and no username means no username key`
);

const signed = new URLSearchParams(signInitData(fields()));
const changed = (key, value) => {
  const copy = new URLSearchParams(signed);
  copy.set(key, value);
  return copy.toString();
};
check((await validateInitData(changed("start_param", "p1_1_AAAAAAAAAAAAAAAA"), TOKEN, NOW)).reason === "BAD_HASH", `a changed start_param gives BAD_HASH`);
check((await validateInitData(changed("user", JSON.stringify({ ...USER, id: 1 })), TOKEN, NOW)).reason === "BAD_HASH", `a changed user gives BAD_HASH`);
check((await validateInitData(changed("auth_date", String(NOW + 3000)), TOKEN, NOW + 5000)).reason === "BAD_HASH", `a changed auth_date gives BAD_HASH`);
check((await validateInitData(changed("hash", "0".repeat(64)), TOKEN, NOW)).reason === "BAD_HASH", `a zeroed hash gives BAD_HASH`);
const added = new URLSearchParams(signed);
added.set("chat_type", "private");
added.append("extra", "1");
check((await validateInitData(added.toString(), TOKEN, NOW)).reason === "BAD_HASH", `an added field gives BAD_HASH`);
check((await validateInitData(signed.toString(), OTHER_TOKEN, NOW)).reason === "BAD_HASH", `another bot's token gives BAD_HASH`);
const forgedSig = new URLSearchParams(signInitData(withSig));
forgedSig.set("signature", "forged");
check((await validateInitData(forgedSig.toString(), TOKEN, NOW)).reason === "BAD_HASH", `a changed signature field gives BAD_HASH when it was hashed`);

check((await validateInitData(signed.toString(), TOKEN, NOW + INIT_DATA_MAX_AGE_SECONDS)).ok, `initData is still good at exactly ${INIT_DATA_MAX_AGE_SECONDS} s`);
check(
  (await validateInitData(signed.toString(), TOKEN, NOW + INIT_DATA_MAX_AGE_SECONDS + 1)).reason === "EXPIRED",
  `a stale auth_date gives EXPIRED`
);
check((await validateInitData(signed.toString(), TOKEN, NOW + 61, 60)).reason === "EXPIRED", `a custom maxAgeSec is honored`);

const malformed = [
  ["garbage", "not initData at all"],
  ["empty", ""],
  ["no hash", (() => { const c = new URLSearchParams(signed); c.delete("hash"); return c.toString(); })()],
  ["no auth_date", signInitData({ user: JSON.stringify(USER) })],
  ["no user", signInitData({ auth_date: String(NOW) })],
  ["unparseable user", signInitData({ user: "{not json", auth_date: String(NOW) })],
  ["user without an id", signInitData({ user: JSON.stringify({ first_name: "Al" }), auth_date: String(NOW) })],
  ["non-numeric auth_date", signInitData({ user: JSON.stringify(USER), auth_date: "yesterday" })],
  ["short hash", changed("hash", "abc123")],
  ["repeated field", `${signed.toString()}&auth_date=${NOW}`],
];
for (const [label, raw] of malformed) {
  const result = await validateInitData(raw, TOKEN, NOW);
  check(!result.ok && result.reason === "MALFORMED", `${label} gives MALFORMED (${show(result)})`);
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
