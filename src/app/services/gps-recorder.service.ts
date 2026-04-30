import { Injectable, inject, signal } from '@angular/core';
import { FirebaseError, initializeApp, getApps } from 'firebase/app';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getFirestore,
  serverTimestamp,
  setDoc,
  type Firestore,
} from 'firebase/firestore';

import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';

const ONE_MINUTE_MS = 60_000;
const MAX_GPS_ACCURACY_METERS = 100;

@Injectable({ providedIn: 'root' })
export class GpsRecorderService {
  private readonly auth = inject(AuthService);
  private readonly db: Firestore;
  private intervalId?: number;
  private watchId?: number;
  private latestPosition?: GeolocationPosition;
  private isSaving = false;
  private lastSavedAt = 0;

  readonly isRecording = signal(false);
  readonly status = signal('GPS no iniciado.');

  constructor() {
    const app = getApps()[0] ?? initializeApp(environment.firebase);
    this.db = getFirestore(app);
  }

  start(): void {
    void this.startRecording();
  }

  async stopAndDeleteLatestLocation(): Promise<void> {
    this.stop();

    await this.auth.ready;
    const user = this.auth.user();

    if (!user || user.uid !== environment.gpsWriterUid) {
      this.status.set('Este usuario no tiene permiso para borrar el GPS.');
      return;
    }

    try {
      await deleteDoc(doc(this.db, 'latestLocations', user.uid));
      this.status.set('GPS desactivado y ultima ubicacion eliminada.');
    } catch (error) {
      this.status.set(this.getFirestoreDeleteErrorMessage(error));
      console.error('Firestore GPS delete error', error);
    }
  }

  private async startRecording(): Promise<void> {
    if (this.intervalId !== undefined || this.watchId !== undefined) {
      return;
    }

    await this.auth.ready;

    const user = this.auth.user();

    if (!user) {
      this.status.set('Inicia sesion para guardar el GPS.');
      return;
    }

    if (user.uid !== environment.gpsWriterUid) {
      this.status.set('Este usuario no tiene permiso para guardar el GPS.');
      return;
    }

    if (!window.isSecureContext) {
      this.status.set('El guardado GPS necesita HTTPS o localhost.');
      return;
    }

    if (!navigator.geolocation) {
      this.status.set('Este dispositivo no soporta geolocalizacion.');
      return;
    }

    this.isRecording.set(true);
    this.status.set('Buscando ubicacion para guardar cada minuto.');
    this.startPositionWatch();

    this.intervalId = window.setInterval(() => {
      void this.saveLatestPosition();
    }, ONE_MINUTE_MS);
  }

  stop(): void {
    if (this.watchId !== undefined) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = undefined;
    }

    if (this.intervalId !== undefined) {
      window.clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    this.latestPosition = undefined;
    this.isSaving = false;
    this.lastSavedAt = 0;
    this.isRecording.set(false);
    this.status.set('GPS detenido.');
  }

  private startPositionWatch(): void {
    if (this.watchId !== undefined) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = undefined;
    }

    this.watchId = navigator.geolocation.watchPosition(
      (position) => {
        if (position.coords.accuracy > MAX_GPS_ACCURACY_METERS) {
          this.status.set(
            `GPS impreciso (${Math.round(position.coords.accuracy)} m). Esperando mejor precision.`
          );
          return;
        }

        this.latestPosition = position;
        this.status.set('Ubicacion lista. Se guardara cada minuto.');

        if (this.lastSavedAt === 0) {
          void this.saveLatestPosition();
        }
      },
      (error) => {
        this.status.set(this.getGeolocationErrorMessage(error));
        console.error('GPS position error', error);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 120000,
      }
    );
  }

  private async saveLatestPosition(): Promise<void> {
    if (this.isSaving) {
      return;
    }

    const user = this.auth.user();

    if (!user || user.uid !== environment.gpsWriterUid) {
      this.stop();
      return;
    }

    if (!this.latestPosition) {
      this.status.set('Esperando una posicion valida para guardar.');
      return;
    }

    this.isSaving = true;
    const position = this.latestPosition;
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

    try {
      await setDoc(doc(this.db, 'latestLocations', user.uid), payload);
      await addDoc(collection(this.db, 'gpsPositions', user.uid, 'samples'), payload);
      this.lastSavedAt = Date.now();
      this.status.set(`GPS guardado: ${new Date().toLocaleTimeString()}`);
    } catch (error) {
      this.status.set(this.getFirestoreErrorMessage(error));
      console.error('Firestore GPS save error', error);
    } finally {
      this.isSaving = false;
    }
  }

  private getGeolocationErrorMessage(error: unknown): string {
    if (this.isGeolocationError(error)) {
      switch (error.code) {
        case 1:
          return 'Permiso de ubicacion denegado.';
        case 2:
          return 'La ubicacion no esta disponible.';
        case 3:
          return 'El GPS ha tardado demasiado en responder.';
      }
    }

    return 'No se pudo leer la posicion GPS.';
  }

  private isGeolocationError(error: unknown): error is GeolocationPositionError {
    return typeof error === 'object' && error !== null && 'code' in error;
  }

  private getFirestoreErrorMessage(error: unknown): string {
    if (error instanceof FirebaseError) {
      if (error.code === 'permission-denied') {
        return 'Firestore rechazo el guardado: revisa reglas y UID autorizado.';
      }

      if (error.code === 'unavailable') {
        return 'Firestore no esta disponible ahora mismo.';
      }

      return `Error de Firestore: ${error.code}`;
    }

    return 'No se pudo guardar la posicion GPS en Firestore.';
  }

  private getFirestoreDeleteErrorMessage(error: unknown): string {
    if (error instanceof FirebaseError) {
      if (error.code === 'permission-denied') {
        return 'Firestore rechazo el borrado: revisa reglas y UID autorizado.';
      }

      return `Error de Firestore al borrar: ${error.code}`;
    }

    return 'No se pudo borrar la ultima ubicacion en Firestore.';
  }
}
