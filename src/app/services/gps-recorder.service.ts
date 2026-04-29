import { Injectable, inject, signal } from '@angular/core';
import { initializeApp, getApps } from 'firebase/app';
import {
  addDoc,
  collection,
  doc,
  getFirestore,
  serverTimestamp,
  setDoc,
  type Firestore,
} from 'firebase/firestore';

import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';

const ONE_MINUTE_MS = 60_000;

@Injectable({ providedIn: 'root' })
export class GpsRecorderService {
  private readonly auth = inject(AuthService);
  private readonly db: Firestore;
  private intervalId?: number;

  readonly isRecording = signal(false);
  readonly status = signal('GPS no iniciado.');

  constructor() {
    const app = getApps()[0] ?? initializeApp(environment.firebase);
    this.db = getFirestore(app);
  }

  start(): void {
    if (this.intervalId !== undefined) {
      return;
    }

    const user = this.auth.user();

    if (!user) {
      this.status.set('Inicia sesion para guardar el GPS.');
      return;
    }

    if (user.uid !== environment.gpsWriterUid) {
      this.status.set('Este usuario no tiene permiso para guardar el GPS.');
      return;
    }

    if (!navigator.geolocation) {
      this.status.set('Este dispositivo no soporta geolocalizacion.');
      return;
    }

    this.isRecording.set(true);
    this.status.set('Guardando posicion GPS cada minuto.');
    void this.saveCurrentPosition();

    this.intervalId = window.setInterval(() => {
      void this.saveCurrentPosition();
    }, ONE_MINUTE_MS);
  }

  stop(): void {
    if (this.intervalId !== undefined) {
      window.clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    this.isRecording.set(false);
    this.status.set('GPS detenido.');
  }

  private async saveCurrentPosition(): Promise<void> {
    const user = this.auth.user();

    if (!user || user.uid !== environment.gpsWriterUid) {
      this.stop();
      return;
    }

    try {
      const position = await this.getCurrentPosition();
      const payload = {
        uid: user.uid,
        displayName: user.displayName ?? user.email ?? 'Usuario',
        email: user.email ?? '',
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
        altitude: position.coords.altitude,
        heading: position.coords.heading,
        speed: position.coords.speed,
        capturedAtMs: position.timestamp,
        savedAt: serverTimestamp(),
      };

      await setDoc(doc(this.db, 'latestLocations', user.uid), payload);
      await addDoc(collection(this.db, 'gpsPositions', user.uid, 'samples'), payload);

      this.status.set(`GPS guardado: ${new Date().toLocaleTimeString()}`);
    } catch {
      this.status.set('No se pudo guardar la posicion GPS.');
    }
  }

  private getCurrentPosition(): Promise<GeolocationPosition> {
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 15000,
      });
    });
  }
}
