// SPDX-License-Identifier: Apache-2.0

/** UTF-16 code-unit order (same as a bare `.sort()`): locale-independent, for stable keys and output. */
export function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
