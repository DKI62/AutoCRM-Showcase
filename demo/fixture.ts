import { detailFields } from '../src/domain/models';
import { validateManifest } from '../src/services/backup-manifest';

const day = 86_400_000;
const id = (index: number) => '00000000-0000-4000-8000-' + String(index).padStart(12, '0');

export function demoBackup(now = Date.now()) {
  const cars = [
    { make: 'Toyota', model: 'Corolla', year: '2019', mileage: '76000', buyout_price: '1040000', market_price: '1170000',
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
  today.setHours(20, 0, 0, 0);
  const dueToday = Math.max(today.getTime(), now + 60_000);
  const taskNames = ['Сверить оценку выкупа', 'Уточнить комплектацию', 'Подготовить осмотр', 'Проверить историю'];
  return validateManifest({
    format: 'auto-crm-folder', version: 2, createdAt: now, files: [],
    tables: {
      lots: cars.map(({ note: _note, ...car }, i) => ({
        ...Object.fromEntries(detailFields.map(field => [field, ''])),
        ...car, id: id(i + 1), lot_type: i === 2 ? 'corporate' : 'regular', title: null,
        source_url: null, completion_reason: i === 4 ? 'bought' : null,
        cover_id: null, search_text: '', created_at: now - 3 * day, updated_at: now,
        archived_at: i === 4 ? now - day : null, last_contact_at: now - day, review_after: null,
      })),
      lot_notes: cars.map((car, i) => ({
        id: id(11+i), vehicle_id: id(i+1), body: car.note, created_at: now - day, updated_at: now - day,
      })),
      lot_events: cars.map((car, i) => ({
        id: id(21+i), vehicle_id: id(i+1), kind: 'stage', created_at: now - day,
        body: car.status === 'completed' ? 'Стадия: Завершено / Выкуплен' :
          car.status === 'in_progress' ? 'Стадия: Осмотр / в работе' : 'Стадия: Контакт',
      })),
      lot_media: [],
      lot_tasks: taskNames.map((title, i) => ({
        id: id(31+i), vehicle_id: id(i+1), title, due_at: dueToday + Math.max(0,i-1)*day,
        status: 'pending', repeat_mode: 'none', description: 'Синтетическая задача для демонстрации.',
        important: i === 0 ? 1 : 0, completed_at: null, created_at: now, updated_at: now,
      })),
    },
  });
}
