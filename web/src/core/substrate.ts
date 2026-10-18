/*
 * substrate.ts — the ONE definition of what the marks are drawn on.
 *
 * This value was previously written as a literal in three places that could
 * disagree, and did: `CANVAS_LIGHT` (the GL clear), `PAPER` (the resolve's
 * Beer-Lambert base), and `inkFor().panel` in the composited key, which used pure
 * white while the plate behind it was #EEF0F3. The plate therefore inherited the
 * app's UI chrome colour by accident and printed as a dirty grey rectangle with a
 * white card floating on it.
 *
 * THREE substrates, not two. The screen substrates are chosen to avoid halation on
 * an emissive display; the PRINT substrate is paper, and paper is white. Print is
 * selected by the export path, never by the theme toggle — a reader's screen
 * preference is not a property of the figure.
 */

export type SubstrateKey = "screen-dark" | "screen-light" | "print";

export interface Substrate {
  hex: string;
  rgba: [number, number, number, number];
}

export const SUBSTRATE: Record<SubstrateKey, Substrate> = {
  "screen-dark": { hex: "#0b0e14", rgba: [11 / 255, 14 / 255, 20 / 255, 1] },
  "screen-light": { hex: "#eef0f3", rgba: [238 / 255, 240 / 255, 243 / 255, 1] },
  print: { hex: "#ffffff", rgba: [1, 1, 1, 1] },
};

/** The substrate a theme uses on screen. The export overrides this with "print". */
export function screenSubstrate(theme: "light" | "dark"): SubstrateKey {
  return theme === "light" ? "screen-light" : "screen-dark";
}
