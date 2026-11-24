export function vehicleRowLayout(contentWidth: number, fontScale: number, hasCall: boolean) {
  const thumbnailWidth = contentWidth < 316 ? 110 : 116;
  const textWidth = contentWidth - thumbnailWidth - 28 - (hasCall ? 44 : 0);
  return { thumbnailWidth, stacked: textWidth < 132 * fontScale };
}

export function coverAspectRatio(sourceRatio: number) {
  if (sourceRatio <= 0) return 2.2;
  return sourceRatio < 1 ? 1.36 : Math.max(1.55, Math.min(sourceRatio, 2.2));
}
