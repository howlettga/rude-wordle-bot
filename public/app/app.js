// The General Store Mini App page (see docs/store-mini-app-plan.md, package D). Plain browser JS, no build step.
//
// Telegram opens this over the group chat from the /store card's "🛒 Open store" link. Everything comes from the
// same-origin HTTP API (src/webapp/api.ts), authenticated with the Mini App's signed initData:
//   GET  /app/api/state            the player's balance, bucket (with quotes), gear, and worms
//   POST /app/api/sell { fishId }  sell one fish
//   POST /app/api/buy  { item }    buy the next rod or boat tier, or one worm
//   POST /app/api/bottle { text, distance }  pay for a message in a bottle and throw it out to sea
// Tapping a row selects it, and Telegram's bottom button (MainButton) does the action. Typing a bottle note (or picking
// how far to throw it) makes the bottle the selection instead. After every sale or purchase the page re-fetches state,
// so it always shows what the server has.
//
// /app/?mock=1 runs on built-in fixture data with faked sell and buy responses, for reviewing the page in a normal
// browser, and draws a stand-in for the bottom button (MainButton only renders inside Telegram). Extra mock switches:
// &fishing=0 (fishing off), &empty=1 (empty bucket), &error=LINK_EXPIRED (or any error code: the state request fails),
// &balance=3 (start with that many beans), &bottlelimit=1 (start with too many bottles out there). The 3rd bottle thrown
// in a mock session is refused with a littering quip, the way the real API answers a player's 4th bottle in the water.
//
// All text from the API goes into the page with textContent, never innerHTML.
"use strict";

(function () {
  const BEAN = "🫘";
  // Holding any fish this long shows a quiet note under the bucket (same threshold as the card's old Wallet pop-up hint
  // in src/store.ts). Fish don't spoil yet; it's a nudge ahead of a planned cooler.
  const OLD_FISH_DAYS = 7;
  const NOTICE_MS = 3500;
  const ERROR_NOTICE_MS = 6000;
  const NOTICE_MS_PER_CHAR = 55; // long errors (like the littering quip) stay up long enough to read in full
  // Errors that mean the page can't be used at all; anything else is shown as a notice and the page stays up.
  const FATAL = new Set(["BAD_SESSION", "SESSION_EXPIRED", "BAD_LINK", "LINK_EXPIRED", "NOT_A_MEMBER", "STORE_OFF"]);

  const params = new URLSearchParams(window.location.search);
  const MOCK = params.get("mock") === "1";
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const initData = tg && typeof tg.initData === "string" ? tg.initData : "";

  const $ = (id) => document.getElementById(id);

  let state = null; // the last GET /app/api/state response
  let selected = null; // { kind: "fish", id } | { kind: "gear", line } | { kind: "worms" } | { kind: "bottle" }
  let bottleDistance = null; // the picked distance id for the bottle note; kept while something else is selected
  let busy = false;
  let noticeTimer = 0;

  // ---- Formatting ----

  function beans(amount) {
    return BEAN + amount.toLocaleString("en-US");
  }

  function beansPerLb(amount) {
    return BEAN + amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function pounds(weight) {
    return weight.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " lb";
  }

  function plural(n, word) {
    return n.toLocaleString("en-US") + " " + word + (n === 1 ? "" : "s");
  }

  // A bottle note the way the server will see it: newlines normalized, control characters (other than newlines)
  // dropped, runs of blank lines collapsed to one, and trimmed. Only for the counter's warning and the bottom button;
  // the raw text is what gets sent, and the server's own cleaning has the final say.
  function cleanNote(raw) {
    return raw
      .replace(/\r\n?/g, "\n")
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function noteLines(text) {
    return text ? text.split("\n").length : 0;
  }

  // A DOM element with an optional class and text (always textContent).
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---- The API ----

  class ApiError extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  async function api(method, path, body) {
    if (MOCK) return mockApi(method, path, body);
    const init = { method, cache: "no-store", headers: { Authorization: "tma " + initData } };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(path, init);
    } catch {
      throw new ApiError(0, "NETWORK", "Couldn't reach the store. Check your connection and try again.");
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      const code = data && typeof data.error === "string" ? data.error : "HTTP_" + response.status;
      const message = data && typeof data.message === "string" && data.message ? data.message : "Something went wrong. Try again.";
      throw new ApiError(response.status, code, message);
    }
    if (!data || typeof data !== "object") {
      throw new ApiError(response.status, "BAD_RESPONSE", "The store sent something odd back. Try again.");
    }
    return data;
  }

  // The text for an error that ends the session. Some codes have fixed wording; the rest use the API's message.
  function fatalText(err) {
    switch (err.code) {
      case "LINK_EXPIRED":
        return "This store link expired. Send /store in the chat for a fresh one.";
      case "SESSION_EXPIRED":
        return "Close and reopen the store.";
      default:
        return err.message || "Open this from the 🏪 store card in your Telegram group.";
    }
  }

  // ---- The bottom button: Telegram's MainButton, or the mock stand-in ----

  function telegramBottom() {
    const button = tg.MainButton;
    button.onClick(act);
    return {
      show(text, active) {
        const theme = tg.themeParams || {};
        const options = { text, is_active: active, is_visible: true };
        // Telegram doesn't grey out an inactive MainButton by itself, so use the theme's muted colors.
        const color = active ? theme.button_color : theme.secondary_bg_color;
        const textColor = active ? theme.button_text_color : theme.hint_color;
        if (color) options.color = color;
        if (textColor) options.text_color = textColor;
        button.setParams(options);
      },
      hide() {
        button.hide();
      },
      progress(on) {
        if (on) button.showProgress(false);
        else button.hideProgress();
      },
    };
  }

  function mockBottom() {
    const bar = $("mock-bar");
    const button = $("mock-main");
    button.addEventListener("click", act);
    return {
      show(text, active) {
        button.textContent = text;
        button.disabled = !active;
        bar.hidden = false;
      },
      hide() {
        bar.hidden = true;
      },
      progress(on) {
        button.classList.toggle("busy", on);
        button.setAttribute("aria-busy", on ? "true" : "false");
        if (on) {
          button.disabled = true;
          button.textContent = "Working…";
        }
      },
    };
  }

  const bottom = MOCK || !tg ? mockBottom() : telegramBottom();

  function haptic(type) {
    if (MOCK || !tg || !tg.HapticFeedback) return;
    try {
      if (type === "select") tg.HapticFeedback.selectionChanged();
      else tg.HapticFeedback.notificationOccurred(type);
    } catch {
      // Older clients without haptics.
    }
  }

  // ---- What the bottom button does for the current selection ----

  // { label, active, path, body, clear, done(result) }, or null when nothing (valid) is selected.
  function currentAction() {
    if (!state || !state.fishing || !selected) return null;
    if (selected.kind === "fish") {
      const fish = state.bucket.find((f) => f.id === selected.id);
      if (!fish) return null;
      const what = fish.emoji + " " + pounds(fish.weight) + " " + fish.species;
      return {
        label: "Sell " + what + " for " + beans(fish.quote),
        active: true,
        path: "/app/api/sell",
        body: { fishId: fish.id },
        clear: true,
        done(result) {
          const sold = result.fish ? result.fish.emoji + " " + pounds(result.fish.weight) + " " + result.fish.species : what;
          return "Sold " + sold + " for " + beans(result.amount) + ". You have " + beans(result.balance) + ".";
        },
      };
    }
    if (selected.kind === "gear") {
      const gear = state.gear.find((g) => g.line === selected.line);
      if (!gear || !gear.next) return null;
      const next = gear.next;
      if (state.balance < next.price) return { label: "Not enough beans", active: false };
      return {
        label: "Buy " + next.name + " for " + beans(next.price),
        active: true,
        path: "/app/api/buy",
        body: { item: gear.line },
        clear: true,
        done(result) {
          return gear.emoji + " Bought " + result.name + " for " + beans(result.price) + ". You have " + beans(result.balance) + ".";
        },
      };
    }
    if (selected.kind === "bottle") {
      const bottles = state.bottles;
      if (!bottles) return null;
      const raw = $("bottle-text").value;
      const text = cleanNote(raw);
      if (!text && !bottleDistance) return null;
      if (bottles.atLimit) return { label: "Too many bottles out there", active: false };
      if (state.balance < bottles.price) return { label: "Not enough beans", active: false };
      if (!text) return { label: "Write your note first", active: false };
      if (noteLines(text) > bottles.maxLines) return { label: "Keep it to " + plural(bottles.maxLines, "line"), active: false };
      if (!bottleDistance) return { label: "Pick how far to throw it", active: false };
      return {
        label: "Throw it for " + beans(bottles.price),
        active: true,
        path: "/app/api/bottle",
        body: { text: raw, distance: bottleDistance },
        clear: true,
        after: clearBottle,
        done() {
          return "🍾 Off it goes. Someone will find it… eventually.";
        },
      };
    }
    if (selected.kind === "worms") {
      const worms = state.worms;
      if (worms.count >= worms.max) return { label: "Your worm can is full", active: false };
      if (state.balance < worms.price) return { label: "Not enough beans", active: false };
      return {
        label: "Buy a worm for " + beans(worms.price),
        active: true,
        path: "/app/api/buy",
        body: { item: "worms" },
        clear: false, // keep it selected, so buying a few is a few taps
        done(result) {
          const count = typeof result.worms === "number" ? result.worms : worms.count + 1;
          return "🪱 Bought a worm for " + beans(result.price) + ". " + plural(count, "worm") + " in the can.";
        },
      };
    }
    return null;
  }

  function updateBottom() {
    const action = currentAction();
    if (!action) {
      if (selected) {
        selected = null;
        markSelection();
      }
      bottom.hide();
      return;
    }
    bottom.show(action.label, action.active);
  }

  async function act() {
    if (busy) return;
    const action = currentAction();
    if (!action || !action.active) return;
    busy = true;
    bottom.progress(true);
    const note = $("bottle-text");
    note.readOnly = true; // so the note can't change under a throw in flight
    note.blur(); // drops the on-screen keyboard, which would cover the notice
    try {
      const result = await api("POST", action.path, action.body);
      haptic("success");
      showNotice(action.done(result), false);
      if (typeof result.balance === "number") state.balance = result.balance; // in case the re-fetch fails
      if (action.clear) selected = null;
      if (action.after) action.after();
      await refresh();
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      haptic("error");
      if (FATAL.has(err.code)) {
        showFatal(err);
        return;
      }
      showNotice(err.message, true);
      await refresh(); // GONE, FISHING_OFF, CANT_AFFORD, etc.: show what the server has now
    } finally {
      busy = false;
      note.readOnly = false;
      bottom.progress(false);
      markSelection();
      updateBottom();
    }
  }

  // ---- Loading state ----

  async function refresh() {
    try {
      state = normalize(await api("GET", "/app/api/state"));
      render();
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (FATAL.has(err.code)) showFatal(err);
      else if (state) showNotice(err.message, true);
      else showMessage(err.message, true);
    }
  }

  // Defensive copies, so a missing list can't break rendering. Heaviest fish first, as the API also sends them.
  function normalize(data) {
    const bucket = Array.isArray(data.bucket) ? data.bucket.slice() : [];
    bucket.sort((a, b) => b.weight - a.weight);
    return {
      firstName: typeof data.firstName === "string" ? data.firstName : "",
      balance: typeof data.balance === "number" ? data.balance : 0,
      fishing: data.fishing === true,
      price: data.price && typeof data.price.perLb === "number" ? data.price : null,
      bucket,
      worms: data.worms || { count: 0, max: 0, price: 0 },
      gear: Array.isArray(data.gear) ? data.gear : [],
      bottles: normalizeBottles(data.bottles),
    };
  }

  // null (and the section stays hidden) unless the state has a usable bottles block.
  function normalizeBottles(bottles) {
    if (!bottles || typeof bottles !== "object" || typeof bottles.price !== "number") return null;
    const distances = Array.isArray(bottles.distances) ? bottles.distances.filter((d) => d && typeof d.id === "string") : [];
    if (!distances.length) return null;
    return {
      price: bottles.price,
      maxChars: typeof bottles.maxChars === "number" && bottles.maxChars > 0 ? bottles.maxChars : 200,
      maxLines: typeof bottles.maxLines === "number" && bottles.maxLines > 0 ? bottles.maxLines : 3,
      atLimit: bottles.atLimit === true,
      distances,
    };
  }

  // ---- Rendering ----

  function showMessage(text, retry) {
    $("message-text").textContent = text;
    $("retry").hidden = !retry;
    $("message").hidden = false;
    $("store").hidden = true;
  }

  function showFatal(err) {
    state = null;
    selected = null;
    $("stats").hidden = true;
    $("who").hidden = true;
    bottom.hide();
    hideNotice();
    showMessage(fatalText(err), false);
  }

  function render() {
    if (!state) return;
    $("who").textContent = state.firstName ? "Shopping as " + state.firstName : "";
    $("who").hidden = !state.firstName;
    renderStats();
    $("stats").hidden = false;

    if (!state.fishing) {
      selected = null;
      showMessage("Fishing is off in this chat, so there's nothing to sell or buy.", false);
      updateBottom();
      return;
    }
    $("message").hidden = true;
    $("store").hidden = false;
    renderBucket();
    renderGear();
    renderWorms();
    renderBottle();
    markSelection();
    updateBottom();
  }

  function renderStats() {
    $("balance").textContent = beans(state.balance);
    const priceStat = $("price").parentElement;
    const note = $("price-change");
    note.textContent = "";
    note.className = "stat-note";
    if (!state.fishing || !state.price) {
      priceStat.hidden = true;
      return;
    }
    priceStat.hidden = false;
    const { perLb, yesterdayPerLb } = state.price;
    $("price").textContent = beansPerLb(perLb) + "/lb";
    if (typeof yesterdayPerLb !== "number") return;
    if (perLb === yesterdayPerLb) {
      note.textContent = "Same as yesterday";
      return;
    }
    const up = perLb > yesterdayPerLb;
    note.classList.add(up ? "up" : "down");
    note.append(el("span", "arrow", up ? "▲" : "▼"), document.createTextNode(" from " + beansPerLb(yesterdayPerLb) + " yesterday"));
  }

  // One row: emoji, title and subtitle, and a price on the right. A button when it can be selected.
  function row({ key, emoji, title, sub, subClass, price, priceClass, dim, label }) {
    const item = el("li");
    const node = el(key ? "button" : "div", "row" + (dim ? " dim" : ""));
    if (key) {
      node.type = "button";
      node.dataset.key = key;
      node.setAttribute("aria-pressed", "false");
      if (label) node.setAttribute("aria-label", label);
      node.addEventListener("click", () => select(key));
    }
    const main = el("span", "row-main");
    main.append(el("span", "row-title", title));
    if (sub) main.append(el("span", "row-sub" + (subClass ? " " + subClass : ""), sub));
    node.append(el("span", "row-emoji", emoji), main);
    if (price) node.append(el("span", "row-price" + (priceClass ? " " + priceClass : ""), price));
    item.append(node);
    return item;
  }

  function renderBucket() {
    const list = $("bucket");
    const bucket = state.bucket;
    $("bucket-count").textContent = bucket.length ? "· " + bucket.length.toLocaleString("en-US") : "";
    $("bucket-empty").hidden = bucket.length > 0;
    list.hidden = bucket.length === 0;
    $("bucket-old").hidden = !bucket.some((fish) => typeof fish.daysHeld === "number" && fish.daysHeld >= OLD_FISH_DAYS);
    list.replaceChildren(
      ...bucket.map((fish) => {
        return row({
          key: "fish:" + fish.id,
          emoji: fish.emoji,
          title: fish.species,
          sub: pounds(fish.weight),
          price: beans(fish.quote),
          label: "Sell " + pounds(fish.weight) + " " + fish.species + " for " + beans(fish.quote),
        });
      })
    );
  }

  function renderGear() {
    $("gear").replaceChildren(
      ...state.gear.map((gear) => {
        if (!gear.next) {
          return row({ emoji: gear.emoji, title: gear.current, sub: "Top of the line" });
        }
        return row({
          key: "gear:" + gear.line,
          emoji: gear.emoji,
          title: gear.current,
          sub: "Upgrade to " + gear.next.name + ": " + gear.next.pitch,
          price: beans(gear.next.price),
          dim: state.balance < gear.next.price,
          label: "Upgrade to " + gear.next.name + " for " + beans(gear.next.price),
        });
      })
    );
  }

  function renderWorms() {
    const worms = state.worms;
    const full = worms.count >= worms.max;
    $("worms-count").textContent = "· " + worms.count.toLocaleString("en-US") + "/" + worms.max.toLocaleString("en-US");
    $("worms").replaceChildren(
      row({
        key: "worms",
        emoji: "🪱",
        title: "Buy a worm",
        sub: full ? "Your worm can is full. Go use some." : "Goes on your next cast",
        price: beans(worms.price),
        dim: full || state.balance < worms.price,
        label: "Buy a worm for " + beans(worms.price),
      })
    );
  }

  // The note box keeps its text across re-renders; only the limits, the price, and the distance options are redrawn.
  function renderBottle() {
    const bottles = state.bottles;
    $("bottle-section").hidden = !bottles;
    if (!bottles) {
      if (selected && selected.kind === "bottle") selected = null;
      return;
    }
    $("bottle-price").textContent = "· " + beans(bottles.price) + " a bottle";
    $("bottle-limit").hidden = !bottles.atLimit;
    $("bottle-text").maxLength = bottles.maxChars;
    if (bottleDistance && !bottles.distances.some((d) => d.id === bottleDistance)) bottleDistance = null;
    $("bottle-distances").replaceChildren(
      ...bottles.distances.map((distance) => {
        const chip = el("button", "chip");
        chip.type = "button";
        chip.dataset.distance = distance.id;
        chip.setAttribute("aria-label", distance.label);
        chip.append(el("span", "chip-emoji", distance.emoji), el("span", "chip-label", distance.label));
        chip.addEventListener("click", () => pickDistance(distance.id));
        return chip;
      })
    );
    markDistances();
    updateMeter();
  }

  function markDistances() {
    for (const chip of document.querySelectorAll(".chip[data-distance]")) {
      const on = chip.dataset.distance === bottleDistance;
      chip.classList.toggle("selected", on);
      chip.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  // The live "0/200" counter, and a warning once the note runs past the line limit.
  function updateMeter() {
    const bottles = state && state.bottles;
    if (!bottles) return;
    const raw = $("bottle-text").value;
    const over = noteLines(cleanNote(raw)) > bottles.maxLines;
    $("bottle-count").textContent = raw.length.toLocaleString("en-US") + "/" + bottles.maxChars.toLocaleString("en-US");
    $("bottle-lines").textContent = over ? "Keep it to " + plural(bottles.maxLines, "line") + "." : "";
    $("bottle-meter").classList.toggle("over", over);
  }

  function clearBottle() {
    $("bottle-text").value = "";
    bottleDistance = null;
    markDistances();
    updateMeter();
  }

  // Typing makes the bottle the selection (replacing any fish or gear), as does coming back to a note already written.
  function onNoteInput() {
    updateMeter();
    if (busy || !state || !state.bottles) return;
    if ($("bottle-text").value.trim()) selectBottle();
    updateBottom();
  }

  function onNoteFocus() {
    if (busy || !state || !state.bottles || !$("bottle-text").value.trim()) return;
    selectBottle();
    updateBottom();
  }

  function selectBottle() {
    if (selected && selected.kind === "bottle") return;
    selected = { kind: "bottle" };
    markSelection();
  }

  // Picking a distance also selects the bottle. Tapping the picked one again keeps it: a bottle needs a distance.
  function pickDistance(id) {
    if (busy) return;
    bottleDistance = id;
    haptic("select");
    markDistances();
    selected = { kind: "bottle" };
    markSelection();
    updateBottom();
  }

  function selectionKey() {
    if (!selected) return null;
    if (selected.kind === "fish") return "fish:" + selected.id;
    if (selected.kind === "gear") return "gear:" + selected.line;
    if (selected.kind === "bottle") return "bottle";
    return "worms";
  }

  function markSelection() {
    const key = selectionKey();
    for (const node of document.querySelectorAll(".row[data-key]")) {
      const on = node.dataset.key === key;
      node.classList.toggle("selected", on);
      node.setAttribute("aria-pressed", on ? "true" : "false");
    }
    $("bottle-compose").classList.toggle("selected", key === "bottle");
  }

  // Tapping a row selects it; tapping it again deselects it.
  function select(key) {
    if (busy) return;
    if (key === selectionKey()) {
      selected = null;
    } else if (key.startsWith("fish:")) {
      selected = { kind: "fish", id: Number(key.slice(5)) };
    } else if (key.startsWith("gear:")) {
      selected = { kind: "gear", line: key.slice(5) };
    } else {
      selected = { kind: "worms" };
    }
    haptic("select");
    markSelection();
    updateBottom();
  }

  // ---- The notice (confirmations and errors) ----

  function showNotice(text, isError) {
    const notice = $("notice");
    notice.textContent = text;
    notice.classList.toggle("error", isError);
    notice.setAttribute("role", isError ? "alert" : "status");
    notice.hidden = false;
    window.clearTimeout(noticeTimer);
    const ms = isError ? Math.max(ERROR_NOTICE_MS, 1500 + text.length * NOTICE_MS_PER_CHAR) : NOTICE_MS;
    noticeTimer = window.setTimeout(hideNotice, ms);
  }

  function hideNotice() {
    window.clearTimeout(noticeTimer);
    $("notice").hidden = true;
  }

  // ---- Mock mode ----

  // Same tiers as src/gear.ts, for faking purchases.
  const MOCK_GEAR = {
    rod: {
      emoji: "🎣",
      pitch: "bigger fish on every cast",
      tiers: [
        { name: "Basic rod", price: 0 },
        { name: "Fiberglass rod", price: 40 },
        { name: "Carbon rod", price: 350 },
        { name: "Legendary rod", price: 1500 },
      ],
    },
    boat: {
      emoji: "🚣",
      pitch: "fish away from the crowd when the lake's busy",
      tiers: [
        { name: "Inner tube", price: 0 },
        { name: "Rowboat", price: 60 },
        { name: "Bass boat", price: 600 },
        { name: "Yacht", price: 2500 },
      ],
    },
  };

  // 140 beans: the Rowboat is affordable, the Carbon rod isn't. Quotes are weight * 0.38/lb * rarity (koi is rare: 3x).
  // Same as BOTTLE_DISTANCES in src/bottles.ts.
  const MOCK_BOTTLE_DISTANCES = [
    { id: "shore", emoji: "🏖️", label: "Close to shore" },
    { id: "buoys", emoji: "🛟", label: "Past the buoys" },
    { id: "sea", emoji: "🌊", label: "Out to sea" },
  ];

  // Stand-ins for LITTER_LINES in src/bottles.ts, so the refusal can be reviewed at full length.
  const MOCK_LITTER_LINES = [
    "🚯 You've already got 3 bottles bobbing around out there. The fish are drafting a lawsuit. Wait till someone finds one.",
    "🚯 Three bottles in the lake is littering. Four is a Superfund site.",
  ];

  const mockBalance = Number(params.get("balance"));

  const mock = {
    firstName: "Galen",
    balance: params.has("balance") && Number.isFinite(mockBalance) && mockBalance >= 0 ? Math.floor(mockBalance) : 140,
    fishing: params.get("fishing") !== "0",
    perLb: 0.38,
    yesterdayPerLb: 0.35,
    rod: 1,
    boat: 0,
    worms: 2,
    bottleThrows: 0, // this session's throw attempts; the 3rd is refused as littering
    bottlesAtLimit: params.get("bottlelimit") === "1",
    bucket:
      params.get("empty") === "1"
        ? []
        : [
            { id: 12, species: "koi", emoji: "🎏", weight: 8.1, quote: 9, daysHeld: 2.4 },
            { id: 15, species: "salmon", emoji: "🐟", weight: 11.4, quote: 4, daysHeld: 0.3 },
            { id: 9, species: "catfish", emoji: "🐟", weight: 6.2, quote: 2, daysHeld: 4.1 },
            { id: 4, species: "bass", emoji: "🐟", weight: 3.7, quote: 1, daysHeld: 9.6 },
            { id: 17, species: "sunfish", emoji: "🐠", weight: 0.6, quote: 1, daysHeld: 0.1 },
          ],
  };

  const MOCK_ERRORS = {
    BAD_SESSION: [401, "Open this from the 🏪 store card in your Telegram group."],
    SESSION_EXPIRED: [401, "This store session expired."],
    BAD_LINK: [403, "That store link isn't valid. Send /store in the chat for a fresh one."],
    LINK_EXPIRED: [401, "This store link expired."],
    NOT_A_MEMBER: [403, "You need to be in this group to use its store."],
    STORE_OFF: [403, "The store is turned off in this chat."],
  };

  function mockState() {
    const gear = ["rod", "boat"].map((line) => {
      const spec = MOCK_GEAR[line];
      const tier = mock[line];
      const next = spec.tiers[tier + 1];
      return {
        line,
        emoji: spec.emoji,
        current: spec.tiers[tier].name,
        next: next ? { name: next.name, price: next.price, pitch: spec.pitch } : null,
      };
    });
    return JSON.parse(
      JSON.stringify({
        firstName: mock.firstName,
        balance: mock.balance,
        fishing: mock.fishing,
        price: { perLb: mock.perLb, yesterdayPerLb: mock.yesterdayPerLb },
        bucket: mock.fishing ? mock.bucket : [],
        worms: { count: mock.worms, max: 5, price: 2 },
        gear,
        bottles: { price: 5, maxChars: 200, maxLines: 3, atLimit: mock.bottlesAtLimit, distances: MOCK_BOTTLE_DISTANCES },
      })
    );
  }

  async function mockApi(method, path, body) {
    // A little latency, so the progress state shows; reads are quicker than writes.
    await new Promise((resolve) => window.setTimeout(resolve, method === "GET" ? 200 : 450));
    const fail = (status, code, message) => {
      throw new ApiError(status, code, message);
    };
    const forced = params.get("error");
    if (forced) {
      const [status, message] = MOCK_ERRORS[forced] || [500, "Something went wrong. Try again."];
      fail(status, forced, message);
    }
    if (method === "GET" && path === "/app/api/state") return mockState();
    if (!mock.fishing) fail(409, "FISHING_OFF", "Fishing is off in this chat.");

    if (method === "POST" && path === "/app/api/sell") {
      const index = mock.bucket.findIndex((fish) => fish.id === body.fishId);
      if (index < 0) fail(409, "GONE", "That fish isn't in your bucket anymore.");
      const [fish] = mock.bucket.splice(index, 1);
      mock.balance += fish.quote;
      return { amount: fish.quote, balance: mock.balance, fish: { species: fish.species, emoji: fish.emoji, weight: fish.weight } };
    }

    if (method === "POST" && path === "/app/api/buy") {
      if (body.item === "worms") {
        if (mock.worms >= 5) fail(409, "FULL", "🪱 Your worm can is full (5). Go use some.");
        if (mock.balance < 2) fail(409, "CANT_AFFORD", "A worm costs " + beans(2) + ". You have " + beans(mock.balance) + ".");
        mock.balance -= 2;
        mock.worms += 1;
        return { name: "Worm", price: 2, balance: mock.balance, worms: mock.worms };
      }
      const spec = MOCK_GEAR[body.item];
      if (!spec) fail(400, "BAD_REQUEST", "There's nothing like that for sale.");
      const next = spec.tiers[mock[body.item] + 1];
      if (!next) fail(409, "MAXED", "You've already got the best there is.");
      if (mock.balance < next.price) {
        fail(409, "CANT_AFFORD", "The " + next.name + " costs " + beans(next.price) + ". You have " + beans(mock.balance) + ".");
      }
      mock.balance -= next.price;
      mock[body.item] += 1;
      return { name: next.name, price: next.price, balance: mock.balance, worms: mock.worms };
    }
    if (method === "POST" && path === "/app/api/bottle") {
      if (!MOCK_BOTTLE_DISTANCES.some((d) => d.id === body.distance)) fail(400, "BAD_REQUEST", "Pick how far to throw it.");
      const text = cleanNote(typeof body.text === "string" ? body.text : "");
      if (!text) fail(400, "BAD_REQUEST", "Write something first.");
      if (text.length > 200) fail(400, "BAD_REQUEST", "That's too long for a bottle (200 characters max).");
      if (noteLines(text) > 3) fail(400, "BAD_REQUEST", "Keep it to 3 lines.");
      if (mock.balance < 5) {
        fail(409, "CANT_AFFORD", "A bottle costs " + beans(5) + ". You have " + beans(mock.balance) + ". Sell some fish.");
      }
      mock.bottleThrows += 1;
      // The real API charges first and refunds on LIMIT, so the balance ends up the same as never charging.
      if (mock.bottlesAtLimit || mock.bottleThrows >= 3) {
        mock.bottlesAtLimit = true;
        fail(409, "LIMIT", MOCK_LITTER_LINES[Math.floor(Math.random() * MOCK_LITTER_LINES.length)]);
      }
      mock.balance -= 5;
      return { balance: mock.balance };
    }
    return fail(404, "NOT_FOUND", "Not found.");
  }

  // ---- Start ----

  function start() {
    $("retry").addEventListener("click", () => {
      showMessage("Opening the store…", false);
      refresh();
    });
    $("notice").addEventListener("click", hideNotice);
    $("bottle-text").addEventListener("input", onNoteInput);
    $("bottle-text").addEventListener("focus", onNoteFocus);
    if (MOCK) {
      document.body.classList.add("mock");
      $("mock-tag").hidden = false;
    }
    if (tg) {
      try {
        tg.ready();
        tg.expand();
      } catch {
        // Not inside Telegram; the checks below handle it.
      }
    }
    if (!MOCK && !initData) {
      showMessage("Open this from the 🏪 store card in your Telegram group.", false);
      return;
    }
    showMessage("Opening the store…", false);
    refresh();
  }

  start();
})();
