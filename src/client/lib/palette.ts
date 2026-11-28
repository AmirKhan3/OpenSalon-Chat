// Colors that are saved as data or passed to inline styles, so they must be
// plain hex codes. Every other color is a semantic token in styles.css.
// Keep these in step with the tokens there.

/** Text on a light swatch. Same as --foreground. */
export const INK = "#1d1916";
/** Text on a dark swatch. */
export const PAPER = "#ffffff";

/** A booking with no barber. Warm grey. */
export const UNASSIGNED_COLOR = "#6f665c";
/** A barber with no saved color. Same as --primary. */
export const DEFAULT_STAFF_COLOR = "#3a4a5c";

/** Choices for a barber's or a service's color. From the barbershop palette. */
export const SWATCHES = [
  "#3a4a5c", // blued steel
  "#1e6650", // bottle green
  "#23508f", // pole blue
  "#b3261e", // pole red
  "#c4912f", // brass
  "#6d2e46", // oxblood
  "#2f7f86", // teal tile
  "#4a443e", // charcoal
] as const;
