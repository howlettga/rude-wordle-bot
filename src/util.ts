export function random(arr:any[]) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Telegram's HTML parse mode rejects the whole message on a stray <, >, or & — and names (people's, pets')
// are user-controlled.
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// "a" or "an" before a weight as it's read aloud: "an 8.1 lb", "an 11 lb", "an 18 lb", "a 14.2 lb".
export function weightArticle(weightText: string): string {
  const whole = weightText.split(".")[0]!;
  return whole.startsWith("8") || whole === "11" || whole === "18" ? "an" : "a";
}
