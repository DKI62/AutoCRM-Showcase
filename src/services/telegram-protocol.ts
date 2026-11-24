// No mobile import: this server receives only explicitly consented task data.
export interface RemoteTask {
  id: string; title: string; due_at: number; revision: number; status: 'pending' | 'done';
  vehicle_id?: string; vehicle?: string; stage?: string; call?: boolean; since?: number; promotable?: boolean;
}
export interface RemoteAction {
  seq: number; task_id: string; action: 'done' | 'snooze' | 'note' | 'keep' | 'later' | 'promote' | 'archive' | 'restore';
  due_at: number | null; revision: number; value?: string | null;
}
export type Receipt = { seq: number; state: 'applied' | 'conflict' };
export const isUuid = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
export const reviewKindOf = (id: string) => id.startsWith('cold:') ? 'cold' : id.startsWith('archive:') ? 'archive' : null;
export const validInstant = (at: unknown): at is number => typeof at === 'number' && Number.isSafeInteger(at) && at >= 0 && at <= 8640000000000000;
const validId = (id: unknown): id is string => typeof id === 'string' && (reviewKindOf(id) ? isUuid(id.slice(id.indexOf(':') + 1)) : isUuid(id));
export const archiveReasons = ['bought', 'sold_elsewhere', 'declined', 'other'] as const;
export const callTask = (title: string) => /(?:^|[^а-яёa-z])(?:перезвон\p{L}*|позвон\p{L}*|звонок|звонить|созвон\p{L}*|call)(?![а-яёa-z])/iu.test(title);
export function validAction(value: unknown): value is RemoteAction {
  if (!value || typeof value !== 'object') return false;
  const a = value as RemoteAction;
  if (!Number.isSafeInteger(a.seq) || a.seq <= 0 || !validId(a.task_id) || !Number.isSafeInteger(a.revision) || a.revision <= 0) return false;
  const review = reviewKindOf(a.task_id);
  if (a.action === 'note') return !review && a.due_at === null && typeof a.value === 'string' && !!a.value.trim() && a.value.length <= 2000;
  if (a.action === 'archive') return review === 'cold' && a.due_at === null && archiveReasons.some(reason => reason === a.value);
  if (a.value != null) return false;
  if (a.action === 'snooze') return !review && validInstant(a.due_at) && a.due_at > 0;
  if (a.action === 'later') return !!review && validInstant(a.due_at) && a.due_at > 0;
  return a.due_at === null && (a.action === 'done' ? !review : a.action === 'keep' ? !!review :
    a.action === 'promote' ? review === 'cold' : a.action === 'restore' && review === 'archive');
}
export function minimalTask(task: { id: string; title: string; due_at: number; updated_at: number; status: 'pending' | 'done' }): RemoteTask {
  return { id: task.id, title: task.title, due_at: task.due_at, revision: task.updated_at, status: task.status };
}
export function quietNow(now: number, timezone: string, start: number, end: number): boolean {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(now)));
  return start === end ? false : start < end ? hour >= start && hour < end : hour >= start || hour < end;
}
export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
}
export function validTask(value: unknown): value is RemoteTask {
  if (!value || typeof value !== 'object') return false;
  const t = value as Record<string, unknown>;
  return Object.keys(t).every(key => ['id','title','due_at','revision','status','vehicle_id','vehicle','stage','call','since','promotable'].includes(key))
    && validId(t.id) && typeof t.title === 'string' && !!t.title.trim() && t.title.length <= 200
    && validInstant(t.due_at) && Number.isSafeInteger(t.revision) && Number(t.revision) > 0 && (t.status === 'pending' || t.status === 'done')
    && (t.vehicle_id === undefined || isUuid(t.vehicle_id)) && (t.vehicle === undefined || typeof t.vehicle === 'string' && t.vehicle.length <= 120)
    && (t.stage === undefined || typeof t.stage === 'string' && t.stage.length <= 100) && (t.call === undefined || typeof t.call === 'boolean')
    && (t.since === undefined || validInstant(t.since)) && (t.promotable === undefined || typeof t.promotable === 'boolean')
    && (!reviewKindOf(t.id) || t.status === 'done' || t.vehicle_id === t.id.split(':')[1]);
}
