import { Injectable, computed, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  getAuth,
  getRedirectResult,
  onAuthStateChanged,
  setPersistence,
  signInWithRedirect,
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
  readonly canSeeHolaButton = computed(() => this.user()?.uid === environment.gpsWriterUid);
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
    void getRedirectResult(this.auth).catch((error) => {
      console.error('Google redirect login error', error);
    });

    onAuthStateChanged(this.auth, (user) => {
      this.user.set(user);
      this.isReady.set(true);
      this.resolveReady();
    });
  }

  async loginWithGoogle(): Promise<boolean> {
    if (!this.auth) {
      window.alert('Configura Firebase en src/environments/environment.ts para activar Google Login.');
      return false;
    }

    if (Capacitor.isNativePlatform()) {
      await signInWithRedirect(this.auth, this.provider);
      return false;
    }

    await signInWithPopup(this.auth, this.provider);
    return true;
  }

  async logout(): Promise<void> {
    if (!this.auth) {
      return;
    }

    await signOut(this.auth);
  }
}
