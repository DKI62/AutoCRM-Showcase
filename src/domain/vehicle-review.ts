export type ReviewKind = 'cold' | 'archive';
export const reviewSetting = { cold: 'review_cold_days', archive: 'review_archive_days' } as const;
export const reviewChoices = { cold: [0, 7, 14, 30], archive: [0, 7, 14, 30, 60] } as const;

export function reviewDays(kind: ReviewKind, stored: string | null) {
  const days = stored === null ? (kind === 'cold' ? 7 : 14) : Number(stored);
  return (reviewChoices[kind] as readonly number[]).includes(days) ? days : (kind === 'cold' ? 7 : 14);
}

export function calendarDaysAfter(at: number, days: number) {
  const date = new Date(at);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

export function vehicleReviewDue(car: { status: string; archived_at: number | null; created_at: number; last_contact_at?: number | null; review_after?: number | null }, kind: ReviewKind, days: number) {
  const base = kind === 'cold' && car.status === 'cold' ? car.last_contact_at ?? car.created_at
    : kind === 'archive' && car.status === 'completed' ? car.archived_at : null;
  return days && base !== null ? Math.max(calendarDaysAfter(base, days), car.review_after ?? 0) : null;
}
