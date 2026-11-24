export type PhotoLoad = 'expo' | 'native' | 'expo-ready' | 'native-ready' | 'failed';

export function updatePhotoLoad(current: PhotoLoad, decoder: 'expo' | 'native', succeeded: boolean): PhotoLoad {
  if (current !== decoder) return current;
  if (succeeded) return decoder === 'expo' ? 'expo-ready' : 'native-ready';
  return decoder === 'expo' ? 'native' : 'failed';
}
