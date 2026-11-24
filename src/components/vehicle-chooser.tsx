import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { VehicleSummary } from '../repositories/crm-repository';
import { vehicleName } from '../domain/models';
import { useRepository } from '../storage/app-provider';
import { useTheme } from '../theme';
import { Field, LoadState, useLoad } from './kit';

export function VehicleChooser({ onChoose }: { onChoose: (vehicle: VehicleSummary) => void }) {
  const { colors, ui } = useTheme();
  const repository = useRepository(); const [query, setQuery] = useState('');
  const load = useLoad(useCallback(() => repository.listVehicles(0, 50, { query }), [repository, query]));
  return <View style={{ gap: 10 }}><Field label="Найти автомобиль" value={query} onChangeText={setQuery} placeholder="Название, продавец или телефон" />
    <LoadState loading={load.loading} error={load.error} retry={() => { void load.refresh(); }} />
    {load.data?.map(car => <Pressable key={car.id} accessibilityRole="button" onPress={() => onChoose(car)} style={ui.card}><Text style={ui.body}>{vehicleName(car)}</Text><Text style={{ color: colors.muted }}>{car.phone || car.seller}</Text></Pressable>)}
    {!load.loading && !load.error && !load.data?.length ? <Text style={ui.muted}>Нет активных автомобилей. Создайте карточку или уточните поиск.</Text> : null}
    {load.data?.length === 50 ? <Text style={ui.muted}>Первые 50 результатов. Уточните поиск.</Text> : null}
  </View>;
}
