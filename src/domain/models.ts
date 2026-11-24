import { vehicleLink } from './vehicle-links';

export type LotType = 'regular' | 'corporate';
export type VehicleStatus = 'cold' | 'in_progress' | 'completed';
export type CompletionReason = 'bought' | 'sold_elsewhere' | 'declined' | 'other';
export type MoneyText = string;
export type Substatus = '' | 'bargaining' | 'awaiting_decision' | 'documents';
export const detailFields = ['seller', 'phone', 'year', 'mileage', 'listing_price', 'buyout_price', 'market_price', 'prep_cost',
  'purchase_price', 'purchase_date', 'autoteka_url', 'inspection_place', 'inspection_at'] as const;
export type DetailField = typeof detailFields[number];
export type VehicleFields = Record<DetailField, string>;

export interface Vehicle extends VehicleFields {
  id: string;
  lot_type: LotType;
  status: VehicleStatus;
  completion_reason: CompletionReason | null;
  archived_at: number | null;
  last_contact_at?: number | null;
  review_after?: number | null;
  make: string;
  model: string;
  title: string | null;
  source_url: string | null;
  substatus: Substatus;
  cover_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface Note {
  id: string;
  vehicle_id: string;
  body: string;
  created_at: number;
  updated_at: number;
}

export interface Attachment {
  id: string;
  vehicle_id: string;
  relative_path: string;
  mime_type: string;
  caption: string;
  created_at: number;
  updated_at: number;
  byte_size: number;
}

export interface Task {
  id: string;
  vehicle_id: string;
  title: string;
  description: string;
  important?: 0 | 1;
  due_at: number;
  status: 'pending' | 'done';
  repeat_mode: 'none' | 'daily' | 'weekly';
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface HistoryEvent { id: string; vehicle_id: string; kind: string; body: string; created_at: number }

export interface VehicleDetail {
  vehicle: Vehicle;
  notes: Note[];
  attachments: Attachment[];
  events: HistoryEvent[];
}

export interface VehicleInput extends Partial<VehicleFields> {
  make: string;
  model: string;
  title?: string;
  note: string;
  sourceUrl?: string;
  lot_type?: LotType;
  substatus?: Substatus;
}

export function validateVehicle(input: VehicleInput): VehicleInput {
  const make = input.make.trim();
  const model = input.model.trim();
  if (!(input.title?.trim() || input.phone?.trim() || (make && model)))
    throw new Error('Укажите название, телефон или марку и модель. Фото необязательно.');
  if (make.length > 100 || model.length > 100 || (input.title?.length ?? 0) > 160)
    throw new Error('Марка и модель — до 100 символов, заголовок — до 160.');
  if (input.note.length > 10000) throw new Error('Заметка слишком длинная: максимум 10 000 символов.');
  if (input.sourceUrl?.trim() && !vehicleLink(input.sourceUrl)) throw new Error('Допустимы только ссылки http и https.');
  if (input.autoteka_url?.trim() && !vehicleLink(input.autoteka_url)) throw new Error('Укажите корректную ссылку Автотеки.');
  for (const key of detailFields) if ((input[key]?.length ?? 0) > 2000) throw new Error('Поле слишком длинное: максимум 2 000 символов.');
  if (input.lot_type && !['regular', 'corporate'].includes(input.lot_type)) throw new Error('Некорректный тип лота.');
  if (input.substatus && !['bargaining', 'awaiting_decision', 'documents'].includes(input.substatus)) throw new Error('Некорректный подстатус.');
  return { ...input, make, model, note: input.note.trim() };
}

export function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !!url.hostname;
  } catch { return false; }
}

export const vehicleName = (vehicle: Pick<Vehicle, 'title' | 'make' | 'model'> & { phone?: string }) => vehicle.title || [vehicle.make, vehicle.model].filter(Boolean).join(' ') || vehicle.phone || 'Автомобиль';

export const statusLabels: Record<VehicleStatus, string> = { cold: 'Контакт', in_progress: 'Осмотр / в работе', completed: 'Завершено' };
export const reasonLabels: Record<CompletionReason, string> = { bought: 'Куплено', sold_elsewhere: 'Продано другому', declined: 'Отказ', other: 'Другая причина' };
export const substatusLabels: Record<Substatus, string> = { '': 'Без подстатуса', bargaining: 'Торгуемся', awaiting_decision: 'Ждём решение', documents: 'Документы' };

export function nextRepeatDate(due: number, repeat: Task['repeat_mode'], now: number): number {
  const base = new Date(due), step = repeat === 'weekly' ? 7 : 1;
  for (let days = step; ; days += step) {
    const candidate = new Date(due);
    candidate.setDate(base.getDate() + days);
    if (!Number.isFinite(candidate.getTime())) throw new Error('Не удалось вычислить следующий срок.');
    if (candidate.getTime() > now) return candidate.getTime();
  }
}
