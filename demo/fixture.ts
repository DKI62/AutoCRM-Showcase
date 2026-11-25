import { detailFields } from '../src/domain/models';
import { validateManifest } from '../src/services/backup-manifest';

const day = 86_400_000;
const id = (index: number) => '00000000-0000-4000-8000-' + String(index).padStart(12, '0');

export const demoPhotoName = id(42) + '.png';

export function demoBackup(now = Date.now(), photo?: { size: number; md5: string }) {
  const cars = [
    { make: 'Demo', model: 'Silver Sedan', year: '2019', mileage: '76000', buyout_price: '1040000', market_price: '1170000',
      status: 'in_progress', substatus: 'bargaining', note: 'На осмотре проверить пороги и передние фары.' },
    { make: 'Hyundai', model: 'Creta', year: '2021', mileage: '51000', buyout_price: '1450000', market_price: '1610000',
      status: 'cold', substatus: 'awaiting_decision', note: 'Уточнить комплектацию и срок ответа.' },
    { make: 'Škoda', model: 'Octavia', year: '2018', mileage: '84000', buyout_price: '1190000', market_price: '1320000',
      status: 'in_progress', substatus: 'documents', note: 'Подготовить список вопросов по документам.' },
    { make: 'Renault', model: 'Duster', year: '2020', mileage: '62100', buyout_price: '1020000', market_price: '1160000',
      status: 'cold', substatus: '', note: 'Согласовать дату осмотра на следующей неделе.' },
    { make: 'Kia', model: 'Rio', year: '2017', mileage: '93500', buyout_price: '710000', market_price: '825000',
      status: 'completed', substatus: '', note: 'Демонстрационная сделка завершена, карточка в архиве.' },
  ];
  const today = new Date(now);
  today.setHours(23, 59, 59, 0);
  const dueToday = Math.min(today.getTime(), now + 3_600_000);
  const taskNames = ['Сверить оценку выкупа', 'Уточнить комплектацию', 'Подготовить осмотр', 'Проверить историю'];
  return validateManifest({
    format: 'auto-crm-folder', version: 2, createdAt: now,
    files: photo ? [{ path: demoPhotoName, ...photo }] : [],
    tables: {
      lots: cars.map(({ note: _note, ...car }, i) => ({
        ...Object.fromEntries(detailFields.map(field => [field, ''])),
        ...car, id: id(i + 1), lot_type: i === 2 ? 'corporate' : 'regular', title: null,
        source_url: null, completion_reason: i === 4 ? 'bought' : null,
        cover_id: i === 0 && photo ? id(41) : null, search_text: '', created_at: now - 3 * day, updated_at: now,
        archived_at: i === 4 ? now - day : null, last_contact_at: now - day, review_after: null,
      })),
      lot_notes: cars.map((car, i) => ({
        id: id(11+i), vehicle_id: id(i+1), body: car.note, created_at: now - day, updated_at: now - day,
      })),
      lot_events: [...cars.map((car, i) => ({
        id: id(21+i), vehicle_id: id(i+1), kind: 'stage', created_at: now - day,
        body: car.status === 'completed' ? 'Стадия: Завершено / Выкуплен' :
          car.status === 'in_progress' ? 'Стадия: Осмотр / в работе' : 'Стадия: Контакт',
      })), {
        id: id(26), vehicle_id: id(1), kind: 'contact', created_at: now - 7200_000,
        body: 'Демо-звонок. Согласовали осмотр и список вопросов по состоянию кузова.',
      }],
      lot_media: photo ? [{
        id: id(41), vehicle_id: id(1), relative_path: demoPhotoName, mime_type: 'image/png',
        caption: 'Синтетическое фото, созданное для Showcase', byte_size: photo.size, created_at: now, updated_at: now,
      }] : [],
      lot_tasks: taskNames.map((title, i) => ({
        id: id(31+i), vehicle_id: id(i+1), title, due_at: dueToday + Math.max(0,i-1)*day,
        status: 'pending', repeat_mode: 'none', description: 'Синтетическая задача для демонстрации.',
        important: i === 0 ? 1 : 0, completed_at: null, created_at: now, updated_at: now,
      })),
    },
  });
}
