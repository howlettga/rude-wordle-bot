interface NYTWordle {
  id: number;
  solution: string;
  print_date: string;
  days_since_launch: number;
  editor: string;
}

// NYT rolls the puzzle over at midnight Eastern regardless of the caller's own timezone.
export async function getTodaysWordle(): Promise<NYTWordle> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const response = await fetch(`https://www.nytimes.com/svc/wordle/v2/${today}.json`);
  return response.json();
}

// Tomorrow's puzzle isn't live yet (the NYT endpoint 404s for future dates), but puzzle numbers are
// sequential, so tomorrow's date/number can be derived from today's without a second fetch.
export function nextDateString(dateString: string): string {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + 1)).toISOString().slice(0, 10);
}
