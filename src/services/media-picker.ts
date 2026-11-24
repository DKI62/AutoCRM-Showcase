import * as ImagePicker from 'expo-image-picker';
import { File } from 'expo-file-system';
import type { ManagedImage } from '../repositories/crm-repository';
import { discardImage, importImage } from './image-files';
import { importBatch } from './media-copy';

export async function pickMedia(source: 'gallery' | 'camera' | 'files'): Promise<ManagedImage[]> {
  if (source === 'files') {
    const result = await File.pickFileAsync({ multipleFiles: true, mimeTypes: ['image/*', 'video/*'] });
    if (result.canceled) return [];
    return importBatch(result.result, file => importImage(file.uri, file.type, file.name), discardImage);
  }
  if (source === 'camera' && !(await ImagePicker.requestCameraPermissionsAsync()).granted)
    throw new Error('Доступ к камере закрыт. Разрешите его в настройках Android или выберите фото из галереи.');
  const result = source === 'camera'
    ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 })
    : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], allowsMultipleSelection: true, quality: 1, videoExportPreset: ImagePicker.VideoExportPreset.Passthrough });
  if (result.canceled) return [];
  return importBatch(result.assets, asset => importImage(asset.uri, asset.mimeType, asset.fileName || asset.uri), discardImage);
}
