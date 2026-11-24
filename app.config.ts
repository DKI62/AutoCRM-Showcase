import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => {
  const development = process.env.APP_VARIANT === 'development';
  return {
    ...config,
    name: development ? 'Auto CRM Showcase Dev' : 'Auto CRM Showcase',
    slug: 'auto-crm-showcase',
    scheme: development ? 'autocrm-showcase-dev' : 'autocrm-showcase',
    android: { ...config.android, package: development ? 'com.autocrm.showcase.dev' : 'com.autocrm.showcase' },
    extra: { ...config.extra, appVariant: development ? 'development' : 'release' },
  };
};
