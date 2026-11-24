import { router, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';
import { Text } from 'react-native';
import { LoadState, Page, useLoad } from '../components/kit';
import { VehicleForm } from '../components/vehicle-form';
import { useRepository } from '../storage/app-provider';
import { useTheme } from '../theme';
export function EditVehicleScreen() {
  const { ui } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>(); const repository = useRepository();
  const load = useLoad(useCallback(() => repository.getVehicle(id), [repository, id]));
  if (load.data?.vehicle.id === id) return <VehicleForm key={id} initial={load.data.vehicle} onSaved={value => {
    if (router.canGoBack()) router.back(); else router.replace({ pathname: '/vehicle/[id]', params: { id: value } });
  }} />;
  return <Page>{load.loading || load.error ? <LoadState loading={load.loading} error={load.error} retry={() => { void load.refresh(); }} /> : <Text style={ui.error}>Автомобиль не найден.</Text>}</Page>;
}
