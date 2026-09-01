export function getRemainingPercent(
  remainingPercent: number | null,
  usedPercent: number | null,
): number | null {
  if (remainingPercent != null) return Math.max(0, Math.min(100, remainingPercent));
  if (usedPercent != null) return Math.max(0, Math.min(100, 100 - usedPercent));
  return null;
}
