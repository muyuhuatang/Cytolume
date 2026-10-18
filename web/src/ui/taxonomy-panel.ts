/*
 * UI layer (reflection-1 §6) — NOT YET IMPLEMENTED.
 *
 * Replaces the ordinary legend with an interactive, collapsible taxonomy panel:
 * hover to emphasize, click to isolate, shift-click to compare, checkbox to
 * hide, expand to reveal subtypes, search by ontology name/id, with population
 * size + percentage beside each entry. The plot and this panel are meant to
 * feel like one coordinated interface.
 *
 * Built on top of the biology hierarchy (src/biology) and driving the renderer's
 * focus+context dimming. Lands with P2 (reflection-0 §7).
 */
export function mountTaxonomyPanel(): never {
  throw new Error("ui/taxonomy-panel: not implemented — see P2 in reflection-0 §7");
}
