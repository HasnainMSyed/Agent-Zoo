// The Browser pane's address bar: what was typed, as a web address.

/** Turns what was typed into a URL: "localhost:3000", "3000", "example.com", a full address, or a search. */
export function toUrl(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  if (/^\d{2,5}$/.test(t)) return `http://localhost:${t}`;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/.*)?$/i.test(t)) return `http://${t}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(t)) return `https://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

/** Why a page didn't load, in words (Chromium's error codes). */
export function loadError(code: number, description: string): string {
  if (code === -105 || code === -137) return "That site couldn't be found. Check the address.";
  if (code === -102) return "Nothing answered at that address. If it's a dev server, is it running?";
  if (code === -106) return "You're offline.";
  if (code <= -200 && code > -300) return "The site's security certificate isn't valid, so the page wasn't opened.";
  return `The page didn't load (${description || code}).`;
}
