// The General Store Mini App page (see docs/store-mini-app-plan.md, package D). Plain browser JS, no build step.
//
// Telegram opens this over the group chat from the /store card's "🛒 Open store" link. Everything comes from the
// same-origin HTTP API (src/webapp/api.ts), authenticated with the Mini App's signed initData:
//   GET  /app/api/state            the player's balance, bucket (with quotes), gear, and worms
//   POST /app/api/sell { fishId }  sell one fish
//   POST /app/api/buy  { item }    buy the next rod or boat tier, or one worm
// Tapping a row selects it, and Telegram's bottom button (MainButton) does the action. After every sale or purchase
// the page re-fetches state, so it always shows what the server has.
//
// /app/?mock=1 runs on built-in fixture data with faked sell and buy responses, for reviewing the page in a normal
// browser, and draws a stand-in for the bottom button (MainButton only renders inside Telegram). Extra mock switches:
// &fishing=0 (fishing off), &empty=1 (empty bucket), &error=LINK_EXPIRED (or any error code: the state request fails).
//
// All text from the API goes into the page with textContent, never innerHTML.
"use strict";

(function () {
  const BEAN = "🫘";
  const OLD_FISH_DAYS = 7; // same as the card's Wallet pop-up hint (src/store.ts)
  const NOTICE_MS = 3500;
  const ERROR_NOTICE_MS = 6000;
  // Errors that mean the page can't be used at all; anything else is shown as a notice and the page stays up.
  const FATAL = new Set(["BAD_SESSION", "SESSION_EXPIRED", "BAD_LINK", "LINK_EXPIRED", "NOT_A_MEMBER", "STORE_OFF"]);

  const params = new URLSearchParams(window.location.search);
  const MOCK = params.get("mock") === "1";
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const initData = tg && typeof tg.initData === "string" ? tg.initData : "";

  const $ = (id) => document.getElementById(id);

  let state = null; // the last GET /app/api/state response
  let selected = null; // { kind: "fish", id } | { kind: "gear", line } | { kind: "worms" }
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
    try {
      const result = await api("POST", action.path, action.body);
      haptic("success");
      showNotice(action.done(result), false);
      if (typeof result.balance === "number") state.balance = result.balance; // in case the re-fetch fails
      if (action.clear) selected = null;
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
      bottom.progress(false);
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
    list.replaceChildren(
      ...bucket.map((fish) => {
        const old = typeof fish.daysHeld === "number" && fish.daysHeld >= OLD_FISH_DAYS;
        const sub = pounds(fish.weight) + (old ? " · " + plural(Math.floor(fish.daysHeld), "day") + " in the bucket" : "");
        return row({
          key: "fish:" + fish.id,
          emoji: fish.emoji,
          title: fish.species,
          sub,
          subClass: old ? "old" : "",
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
        sub: full ? "Your worm can is full. Go use some." : "Half the junk on your next cast",
        price: beans(worms.price),
        dim: full || state.balance < worms.price,
        label: "Buy a worm for " + beans(worms.price),
      })
    );
  }

  function selectionKey() {
    if (!selected) return null;
    if (selected.kind === "fish") return "fish:" + selected.id;
    if (selected.kind === "gear") return "gear:" + selected.line;
    return "worms";
  }

  function markSelection() {
    const key = selectionKey();
    for (const node of document.querySelectorAll(".row[data-key]")) {
      const on = node.dataset.key === key;
      node.classList.toggle("selected", on);
      node.setAttribute("aria-pressed", on ? "true" : "false");
    }
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
    noticeTimer = window.setTimeout(hideNotice, isError ? ERROR_NOTICE_MS : NOTICE_MS);
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
  const mock = {
    firstName: "Galen",
    balance: 140,
    fishing: params.get("fishing") !== "0",
    perLb: 0.38,
    yesterdayPerLb: 0.35,
    rod: 1,
    boat: 0,
    worms: 2,
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
    return fail(404, "NOT_FOUND", "Not found.");
  }

  // ---- Start ----

  function start() {
    $("retry").addEventListener("click", () => {
      showMessage("Opening the store…", false);
      refresh();
    });
    $("notice").addEventListener("click", hideNotice);
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
