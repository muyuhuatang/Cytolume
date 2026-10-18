/*
 * Biology layer (reflection-1 §4–§6) — NOT YET IMPLEMENTED.
 *
 * This is where the HRA hierarchy lives: broad cell classes get distinct hue
 * families, subtypes vary by lightness/saturation, low-confidence cells go
 * neutral gray. It drives color assignment, the collapsible taxonomy panel,
 * label placement, LOD and filtering — keeping the renderer ignorant of biology.
 *
 * Planned shape:
 *   buildHierarchy(records) → tree of { class → type → subtype }
 *   assignHierarchicalColors(tree) → category LUT respecting the hierarchy
 *   The "cap hues at ~24, then focus+context" rule (reflection-0 §4) is enforced
 *   here, not in the renderer.
 */
export interface HierarchyNode {
  label: string;
  count: number;
  children?: HierarchyNode[];
}

export function buildHierarchy(): HierarchyNode {
  throw new Error("biology/hierarchy: not implemented — see P2 in reflection-0 §7");
}
