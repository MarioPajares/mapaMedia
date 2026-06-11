import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mapamedia.app',
  appName: 'Mapa Media',
  webDir: 'dist/mapa-media/browser',
  android: {
    useLegacyBridge: true,
  },
  plugins: {
    FirebaseAuthentication: {
      skipNativeAuth: true,
      providers: ['google.com'],
    },
  },
};

export default config;
