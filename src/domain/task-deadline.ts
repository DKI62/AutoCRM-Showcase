/** Android date and time callbacks are separate edits to one local wall-clock value. */
export function mergeTaskDeadline(previous: Date, selected: Date, mode: 'date' | 'time'): Date {
  const day = mode === 'date' ? selected : previous;
  const clock = mode === 'time' ? selected : previous;
  const next = new Date(day.getFullYear(), day.getMonth(), day.getDate(), clock.getHours(), clock.getMinutes());
  if (next.getDate() !== day.getDate() || next.getHours() !== clock.getHours() || next.getMinutes() !== clock.getMinutes()) {
    throw new Error('Такого местного времени нет в выбранный день. Выберите другой час.');
  }
  // Confirming an unchanged picker must not round an existing timestamp or select a different DST occurrence.
  return previous.getFullYear() === next.getFullYear() && previous.getMonth() === next.getMonth()
    && previous.getDate() === next.getDate() && previous.getHours() === next.getHours()
    && previous.getMinutes() === next.getMinutes() ? previous : next;
}

export function quickTaskDeadline(now: number, action: '2m' | '30m' | '1h' | 'tomorrow'): Date {
  if (action !== 'tomorrow') return new Date(Math.ceil(now / 60000) * 60000 + (action === '2m' ? 2 : action === '30m' ? 30 : 60) * 60000);
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  date.setSeconds(0, 0);
  return date;
}

export function taskDeadlineOnDay(previous: Date, now: number, days: number) {
  const day = new Date(now);
  day.setDate(day.getDate() + days);
  return mergeTaskDeadline(previous, day, 'date');
}

export function isNewPastDeadline(value: Date, previous: number | undefined, now: number) {
  return value.getTime() !== previous && value.getTime() <= now;
}
