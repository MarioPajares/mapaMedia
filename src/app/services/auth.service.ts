import { Injectable, computed, signal } from '@angular/core';
import { FirebaseAuthentication } from '@capacitor-firebase/authentication';
import { Capacitor } from '@capacitor/core';
import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithCredential,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth';

import { environment } from '../../environments/environment';

function hasFirebaseConfig(): boolean {
  return Boolean(
    environment.firebase.apiKey &&
      environment.firebase.authDomain &&
      environment.firebase.projectId &&
      environment.firebase.appId
  );
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly configured = hasFirebaseConfig();
  private readonly app?: FirebaseApp;
  private readonly auth?: Auth;
  private readonly provider = new GoogleAuthProvider();
  private resolveReady: () => void = () => {};

  readonly user = signal<User | null>(null);
  readonly isReady = signal(!this.configured);
  readonly isLoggedIn = computed(() => this.user() !== null);
  readonly displayName = computed(() => this.user()?.displayName ?? this.user()?.email ?? 'Usuario');
  readonly isGpsWriter = computed(() => this.user()?.uid === environment.gpsWriterUid);
  readonly ready = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });

  constructor() {
    if (!this.configured) {
      this.resolveReady();
      return;
    }

    this.app = initializeApp(environment.firebase);
    this.auth = getAuth(this.app);
    this.provider.setCustomParameters({ prompt: 'select_account' });
    void setPersistence(this.auth, browserLocalPersistence);

    onAuthStateChanged(this.auth, (user) => {
      this.user.set(user);
      this.isReady.set(true);
      this.resolveReady();
    });
  }

  async loginAsGpsWriter(): Promise<boolean> {
    const user = await this.loginWithGoogle();

    if (user.uid !== environment.gpsWriterUid) {
      await this.logout();
      return false;
    }

    return true;
  }

  private async loginWithGoogle(): Promise<User> {
    if (!this.auth) {
      window.alert('Configura Firebase en src/environments/environment.ts para activar Google Login.');
      throw new Error('Firebase auth is not configured.');
    }

    if (Capacitor.isNativePlatform()) {
      const result = await FirebaseAuthentication.signInWithGoogle({ skipNativeAuth: true });
      const credential = GoogleAuthProvider.credential(
        result.credential?.idToken,
        result.credential?.accessToken
      );

      const userCredential = await signInWithCredential(this.auth, credential);
      return userCredential.user;
    }

    const userCredential = await signInWithPopup(this.auth, this.provider);
    return userCredential.user;
  }

  async logout(): Promise<void> {
    if (!this.auth) {
      return;
    }

    await signOut(this.auth);

    if (Capacitor.isNativePlatform()) {
      await FirebaseAuthentication.signOut();
    }
  }
}
