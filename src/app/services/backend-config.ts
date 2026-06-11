import { getApps, initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app';
import { getFirestore, type Firestore } from 'firebase/firestore';

import { environment } from '../../environments/environment';

function getBackendConfig(): FirebaseOptions {
  return environment.firebase;
}

export function hasBackendConfig(): boolean {
  const config = getBackendConfig();

  return Boolean(config.apiKey && config.authDomain && config.projectId && config.appId);
}

export function getConfiguredBackendApp(): FirebaseApp | undefined {
  if (!hasBackendConfig()) {
    return undefined;
  }

  return getApps()[0] ?? initializeApp(getBackendConfig());
}

export function getConfiguredFirestore(): Firestore | undefined {
  const app = getConfiguredBackendApp();

  return app ? getFirestore(app) : undefined;
}
