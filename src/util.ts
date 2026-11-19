export function random(arr:any[]) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Telegram's HTML parse mode rejects the whole message on a stray <, >, or & — and names (people's, pets')
// are user-controlled.
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
