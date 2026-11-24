export function focusedFieldScroll(offset: number, top: number, height: number, fieldTop: number, fieldHeight: number, gap = 12) {
  const start = top + gap;
  const end = top + height - gap;
  if (fieldHeight > end - start || fieldTop < start) return Math.max(0, offset + fieldTop - start);
  return offset + Math.max(0, fieldTop + fieldHeight - end);
}

export function keyboardOverlap(pageTop: number, pageHeight: number, keyboardTop: number) {
  return Math.max(0, Math.min(pageHeight, pageTop + pageHeight - keyboardTop));
}
