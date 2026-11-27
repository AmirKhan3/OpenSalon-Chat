/** Trims a name part and turns runs of spaces into one space. */
function tidy(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** `"Jamie", "Rivera"` -> `"Jamie Rivera"`. Either part may be empty. */
export function joinName(first: string, last: string): string {
  return [tidy(first), tidy(last)].filter(Boolean).join(" ");
}

/** `"Mary Ann Smith"` -> first `"Mary"`, last `"Ann Smith"`. The first word is the first name. */
export function splitName(full: string): { first: string; last: string } {
  const name = tidy(full);
  const space = name.indexOf(" ");
  if (space < 0) return { first: name, last: "" };
  return { first: name.slice(0, space), last: name.slice(space + 1) };
}

/** True when two names are the same person's name: case and extra spaces do not count. */
export function sameName(a: string, b: string): boolean {
  return tidy(a).toLowerCase() === tidy(b).toLowerCase();
}

/** An optional phone number is fine when it is empty or has 10 to 15 digits. */
export function phoneLooksRight(phone: string): boolean {
  if (!phone.trim()) return true;
  const digits = phone.replace(/\D/g, "").length;
  return digits >= 10 && digits <= 15;
}

/** The phone number the way we store it: `"(555) 010-1234"` -> `"+15550101234"`. Empty stays empty. */
export function tidyPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (!digits) return "";
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}
