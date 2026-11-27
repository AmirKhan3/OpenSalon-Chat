import { query } from "./db.js";

export interface ClientSuggestion { id: number; name: string; phone: string }

/** How many customers the booking form offers at once. */
export const SUGGESTION_LIMIT = 3;

/** Makes typed text safe inside a LIKE pattern: %, _ and \ lose their special meaning. */
export function likeText(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * The customers to offer while the barber types a name in the booking form.
 * With no text: the customers booked most recently. With text: customers whose
 * first name, last name or full name starts with it. Recent ones come first.
 * Staff only. Never call this for a client.
 */
export async function suggestClients(text: string, limit = SUGGESTION_LIMIT): Promise<ClientSuggestion[]> {
  const typed = text.trim().replace(/\s+/g, " ");
  const params: unknown[] = [];
  let where = "";
  if (typed) {
    where = "WHERE c.name ILIKE ? ESCAPE '\\' OR c.name ILIKE ? ESCAPE '\\'";
    params.push(`${likeText(typed)}%`, `% ${likeText(typed)}%`);
  }
  return query<ClientSuggestion>(
    `SELECT c.id, c.name, COALESCE(c.phone, '') AS phone
     FROM clients c
     ${where}
     ORDER BY GREATEST(
                COALESCE((SELECT MAX(a.created_at) FROM appointments a WHERE a.client_id = c.id), ''),
                COALESCE(c.created_at, '')
              ) DESC,
              c.id DESC
     LIMIT ?`,
    [...params, Math.min(Math.max(Math.trunc(limit) || SUGGESTION_LIMIT, 1), 10)],
  );
}

/**
 * Customers whose whole name is the given one. Case and extra spaces do not count.
 * The booking form uses it to ask before it adds a second customer with the same name.
 * Staff only. Never call this for a client.
 */
export async function clientsNamed(name: string): Promise<ClientSuggestion[]> {
  const typed = name.trim().replace(/\s+/g, " ");
  if (!typed) return [];
  return query<ClientSuggestion>(
    `SELECT c.id, c.name, COALESCE(c.phone, '') AS phone
     FROM clients c
     WHERE lower(regexp_replace(trim(c.name), '\\s+', ' ', 'g')) = lower(?)
     ORDER BY c.id DESC
     LIMIT ?`,
    [typed, SUGGESTION_LIMIT],
  );
}
