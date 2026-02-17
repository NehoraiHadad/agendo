/** Gap between sort_order values when appending to a column */
export const SORT_ORDER_GAP = 1000;

/** Minimum gap before a reindex is needed */
export const SORT_ORDER_MIN_GAP = 1;

interface SortOrderResult {
  value: number;
  needsReindex: boolean;
}

/**
 * Compute a sort_order value between two neighbors.
 *
 * @param after  - sort_order of the item above (null = inserting at top)
 * @param before - sort_order of the item below (null = inserting at bottom)
 * @returns value to use and whether the column needs reindexing
 */
export function computeSortOrder(after: number | null, before: number | null): SortOrderResult {
  // Both null: first item in column
  if (after === null && before === null) {
    return { value: SORT_ORDER_GAP, needsReindex: false };
  }

  // Only after null: inserting at top, halve the first item's sort_order
  if (after === null && before !== null) {
    const value = Math.floor(before / 2);
    return { value, needsReindex: value < SORT_ORDER_MIN_GAP };
  }

  // Only before null: inserting at bottom
  if (after !== null && before === null) {
    return { value: after + SORT_ORDER_GAP, needsReindex: false };
  }

  // Both present: midpoint (after and before are guaranteed non-null here)
  const a = after as number;
  const b = before as number;
  const mid = Math.floor((a + b) / 2);
  const gap = b - a;
  return { value: mid, needsReindex: gap <= SORT_ORDER_MIN_GAP };
}
