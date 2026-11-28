/**
 * The shop's only barber, or null when there are none or more than one.
 * With one barber the app stops asking "which barber?".
 */
export function soloBarber<T>(barbers: readonly T[] | null | undefined): T | null {
  return barbers && barbers.length === 1 ? barbers[0] : null;
}

/**
 * The barber a new booking or blocked time goes to.
 * A one-barber shop always uses that barber. Other shops use the choice on screen ("" is none).
 */
export function barberChoice(barbers: readonly { id: number }[], picked: string): string {
  const only = soloBarber(barbers);
  return only ? String(only.id) : picked;
}

/** The steps of the client booking page. A one-barber shop skips "Who do you want?". */
export type BookStep = "services" | "barber" | "time" | "details";
export function bookSteps(barberCount: number): BookStep[] {
  return barberCount === 1 ? ["services", "time", "details"] : ["services", "barber", "time", "details"];
}
