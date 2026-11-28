/** True when the typed word is the name we asked for. Case and outer spaces do not matter. */
export function typedMatches(typed: string, wanted: string): boolean {
  // The screen shows a run of spaces as one space, so we compare them as one.
  const tidy = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const want = tidy(wanted);
  return want.length > 0 && tidy(typed) === want;
}

export interface ConfirmWords { title: string; text: string; action: string; typeToConfirm?: string; blocked?: boolean }

/**
 * The words for deleting a barber. A barber with bookings cannot be deleted, only turned off,
 * because their bookings and payments must keep their name for reports and taxes.
 */
export function staffDeleteWords(name: string, bookings: number, isLast: boolean): ConfirmWords {
  if (bookings > 0) {
    return {
      blocked: true,
      title: `${name} cannot be deleted`,
      text: `${name} has ${bookings} ${bookings === 1 ? "booking" : "bookings"}. Deleting would take their name off those bookings and payments. Deactivate ${name} instead. Your records stay whole.`,
      action: `Deactivate ${name}`,
    };
  }
  if (isLast) {
    return {
      blocked: true,
      title: `${name} cannot be deleted`,
      text: "This is your only barber. The shop needs at least one. Add another barber first.",
      action: "OK",
    };
  }
  return {
    title: `Delete ${name} for good?`,
    text: `${name} and their blocked time are removed. You cannot undo this.`,
    action: `Delete ${name}`,
    typeToConfirm: name,
  };
}

interface ThreadLike { display_name: string; phone: string | null; preview: string; needs_attention: boolean }

/** The inbox list after the search words and the "needs you" filter. */
export function filterThreads<T extends ThreadLike>(threads: T[], query: string, onlyNeedsYou: boolean): T[] {
  const words = query.trim().toLowerCase();
  const digits = words.replace(/\D/g, "");
  return threads.filter((t) => {
    if (onlyNeedsYou && !t.needs_attention) return false;
    if (!words) return true;
    if (t.display_name.toLowerCase().includes(words) || t.preview.toLowerCase().includes(words)) return true;
    // A phone number matches however it was typed: spaces, dashes or brackets.
    return digits.length >= 3 && !!t.phone && t.phone.replace(/\D/g, "").includes(digits);
  });
}
