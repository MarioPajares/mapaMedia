import { Injectable, inject, signal } from '@angular/core';
import type {
  BackgroundGeolocationPlugin,
  CallbackError,
  Location as BackgroundLocation,
} from '@capacitor-community/background-geolocation';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Capacitor, registerPlugin } from '@capacitor/core';
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

const SAVE_INTERVAL_MS = 15_000;
const DEFAULT_RACE_START_TIME = '19:00';
const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

interface GpsPosition {
  accuracy: number;
  altitude: number | null;
  heading: number | null;
  latitude: number;
  longitude: number;
  speed: number | null;
  timestamp: number;
}

@Injectable({ providedIn: 'root' })
export class GpsRecorderService {
  private readonly auth = inject(AuthService);
  private readonly db: Firestore;
  private intervalId?: number;
  private watchId?: number;
  private backgroundWatchId?: string;
  private latestPosition?: GpsPosition;
  private isSaving = false;
  private lastSavedAt = 0;
  private raceStartTime = DEFAULT_RACE_START_TIME;

  readonly isRecording = signal(false);
  readonly status = signal('GPS no iniciado.');

  constructor() {
    const app = getApps()[0] ?? initializeApp(environment.firebase);
    this.db = getFirestore(app);
  }

  start(raceStartTime = DEFAULT_RACE_START_TIME): void {
    this.raceStartTime = raceStartTime;
    void this.startRecording();
  }

  async stopAndDeleteLatestLocation(): Promise<void> {
    this.stop();

    await this.auth.ready;
    const user = this.auth.user();

    if (!user) {
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
    if (this.intervalId !== undefined || this.watchId !== undefined || this.backgroundWatchId !== undefined) {
      return;
    }

    await this.auth.ready;

    const user = this.auth.user();

    if (!user) {
      this.status.set('Inicia sesion para guardar el GPS.');
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
    this.status.set('Iniciando GPS...');

    this.startBrowserPositionWatch();
    this.intervalId = window.setInterval(() => {
      void this.saveLatestPosition();
    }, SAVE_INTERVAL_MS);

    if (Capacitor.isNativePlatform()) {
      await this.requestNativeNotificationPermission();
      await this.startBackgroundPositionWatch();
      return;
    }
  }

  stop(): void {
    if (this.watchId !== undefined) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = undefined;
    }

    if (this.backgroundWatchId !== undefined) {
      const id = this.backgroundWatchId;
      this.backgroundWatchId = undefined;
      void BackgroundGeolocation.removeWatcher({ id });
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

  private async startBackgroundPositionWatch(): Promise<void> {
    this.backgroundWatchId = await BackgroundGeolocation.addWatcher(
      {
        backgroundTitle: 'Mapa Media',
        backgroundMessage: 'Compartiendo ubicacion en segundo plano.',
        requestPermissions: true,
        stale: false,
        distanceFilter: 0,
      },
      (location, error) => {
        if (error) {
          this.status.set(this.getBackgroundGeolocationErrorMessage(error));
          console.error('Background GPS position error', error);
          return;
        }

        if (!location) {
          return;
        }

        this.latestPosition = this.toGpsPosition(location);
        this.status.set('GPS activo en segundo plano.');

        if (this.shouldSaveNow()) {
          void this.saveLatestPosition();
        }
      }
    );
  }

  private async requestNativeNotificationPermission(): Promise<void> {
    const permissions = await LocalNotifications.checkPermissions();

    if (permissions.display === 'granted') {
      return;
    }

    const requestedPermissions = await LocalNotifications.requestPermissions();

    if (requestedPermissions.display !== 'granted') {
      this.status.set('Permite las notificaciones para mantener el GPS activo con el movil bloqueado.');
    }
  }

  private startBrowserPositionWatch(): void {
    if (this.watchId !== undefined) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = undefined;
    }

    this.watchId = navigator.geolocation.watchPosition(
      (position) => {
        this.latestPosition = this.toGpsPosition(position);
        this.status.set('Ubicacion lista.');

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

    if (!user) {
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
      latitude: position.latitude,
      longitude: position.longitude,
      accuracy: position.accuracy,
      altitude: position.altitude,
      heading: position.heading,
      speed: position.speed,
      capturedAtMs: position.timestamp,
      raceStartTime: this.raceStartTime,
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

  private shouldSaveNow(): boolean {
    return this.lastSavedAt === 0 || Date.now() - this.lastSavedAt >= SAVE_INTERVAL_MS;
  }

  private toGpsPosition(position: GeolocationPosition): GpsPosition;
  private toGpsPosition(position: BackgroundLocation): GpsPosition;
  private toGpsPosition(position: GeolocationPosition | BackgroundLocation): GpsPosition {
    if ('coords' in position) {
      return {
        accuracy: position.coords.accuracy,
        altitude: position.coords.altitude,
        heading: position.coords.heading,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        speed: position.coords.speed,
        timestamp: position.timestamp,
      };
    }

    return {
      accuracy: position.accuracy,
      altitude: position.altitude,
      heading: position.bearing,
      latitude: position.latitude,
      longitude: position.longitude,
      speed: position.speed,
      timestamp: position.time ?? Date.now(),
    };
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

  private getBackgroundGeolocationErrorMessage(error: CallbackError): string {
    if (error.code === 'NOT_AUTHORIZED') {
      return 'Activa el permiso de ubicacion para compartir en segundo plano.';
    }

    if (error.code === 'LOCATION_DISABLED') {
      return 'Activa la ubicacion del dispositivo.';
    }

    return 'No se pudo leer la ubicacion en segundo plano.';
  }

  private isGeolocationError(error: unknown): error is GeolocationPositionError {
    return typeof error === 'object' && error !== null && 'code' in error;
  }

  private getFirestoreErrorMessage(error: unknown): string {
    if (error instanceof FirebaseError) {
      if (error.code === 'permission-denied') {
        return 'Firestore rechazo el guardado: revisa las reglas y la sesion del usuario.';
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
        return 'Firestore rechazo el borrado: revisa las reglas y la sesion del usuario.';
      }

      return `Error de Firestore al borrar: ${error.code}`;
    }

    return 'No se pudo borrar la ultima ubicacion en Firestore.';
  }
}
