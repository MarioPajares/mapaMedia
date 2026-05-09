import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, computed, inject, signal } from '@angular/core';
import { FirebaseError, getApps, initializeApp } from 'firebase/app';
import { doc, getDoc, getFirestore, type Firestore } from 'firebase/firestore';
import * as L from 'leaflet';

import { environment } from '../../../environments/environment';
import { AuthService } from '../../services/auth.service';
import { GpsRecorderService } from '../../services/gps-recorder.service';

interface SharedLocation {
  accuracy?: number;
  capturedAtMs?: number;
  displayName?: string;
  latitude: number;
  longitude: number;
}

const ONE_MINUTE_MS = 60_000;

@Component({
  selector: 'app-mapa',
  standalone: true,
  templateUrl: './mapa.html',
  styleUrl: './mapa.css',
})
export class MapaComponent implements AfterViewInit, OnDestroy {
  @ViewChild('mapContainer', { static: true }) private readonly mapContainer?: ElementRef<HTMLDivElement>;

  protected readonly status = signal('Solicitando tu ubicacion al abrir el recorrido...');
  protected readonly isLoading = signal(false);
  protected readonly auth = inject(AuthService);
  protected readonly gpsRecorder = inject(GpsRecorderService);
  protected readonly isGpsWriter = computed(() => this.auth.user()?.uid === environment.gpsWriterUid);
  private readonly db: Firestore;

  private map?: L.Map;
  private routeBounds?: L.LatLngBounds;
  private userMarker?: L.Marker;
  private sharedMarker?: L.Marker;
  private startMarker?: L.CircleMarker;
  private locationWatchId?: number;
  private latestLocationIntervalId?: number;
  private hasCenteredOnUser = false;

  constructor() {
    const app = getApps()[0] ?? initializeApp(environment.firebase);
    this.db = getFirestore(app);
  }

  async ngAfterViewInit(): Promise<void> {
    const container = this.mapContainer?.nativeElement;

    if (!container) {
      return;
    }

    this.map = L.map(container, {
      center: [39.4762, -6.3722],
      zoom: 13,
      zoomControl: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(this.map);

    const routePoints = await this.loadRoutePoints();

    if (routePoints.length > 0) {
      const route = L.polyline(routePoints, {
        color: '#1368ce',
        weight: 5,
        opacity: 0.9,
      }).addTo(this.map);

      this.startMarker = L.circleMarker(routePoints[0], {
        radius: 6,
        color: '#1b5e20',
        fillColor: '#2f9e44',
        fillOpacity: 1,
        weight: 2,
      }).addTo(this.map);

      this.routeBounds = route.getBounds();
      this.map.fitBounds(this.routeBounds, { padding: [24, 24] });
      await this.startLocationFeatures();
      return;
    }

    this.map.setView([39.4762, -6.3722], 13);
    await this.startLocationFeatures();
  }

  ngOnDestroy(): void {
    if (this.locationWatchId !== undefined) {
      navigator.geolocation.clearWatch(this.locationWatchId);
    }

    this.stopSharedLocationPolling();
    this.gpsRecorder.stop();
    this.map?.remove();
  }

  private async startLocationFeatures(): Promise<void> {
    await this.auth.ready;

    if (this.auth.user()?.uid === environment.gpsWriterUid) {
      this.status.set('Pulsa Activar GPS para empezar a emitir ubicacion.');
      return;
    }

    this.startSharedLocationPolling();
    this.status.set('Mostrando la ultima ubicacion compartida.');
  }

  protected activateGps(): void {
    this.requestLocation();
    this.gpsRecorder.start();
  }

  protected async deactivateGps(): Promise<void> {
    if (this.locationWatchId !== undefined) {
      navigator.geolocation.clearWatch(this.locationWatchId);
      this.locationWatchId = undefined;
    }

    this.isLoading.set(false);
    this.userMarker?.remove();
    this.userMarker = undefined;
    this.hasCenteredOnUser = false;
    await this.gpsRecorder.stopAndDeleteLatestLocation();
    this.status.set('GPS desactivado.');
  }

  private startSharedLocationPolling(): void {
    this.stopSharedLocationPolling();
    void this.checkSharedLocation();

    this.latestLocationIntervalId = window.setInterval(() => {
      void this.checkSharedLocation();
    }, ONE_MINUTE_MS);
  }

  private stopSharedLocationPolling(): void {
    if (this.latestLocationIntervalId !== undefined) {
      window.clearInterval(this.latestLocationIntervalId);
      this.latestLocationIntervalId = undefined;
    }
  }

  private async checkSharedLocation(): Promise<void> {
    try {
      const snapshot = await getDoc(doc(this.db, 'latestLocations', environment.gpsWriterUid));

      if (!snapshot.exists()) {
        this.clearSharedLocation();
        this.status.set('Todavia no hay ninguna ubicacion compartida.');
        return;
      }

      const location = snapshot.data() as Partial<SharedLocation>;

      if (typeof location.latitude !== 'number' || typeof location.longitude !== 'number') {
        this.clearSharedLocation();
        this.status.set('La ultima ubicacion guardada no es valida.');
        return;
      }

      this.showSharedLocation(location as SharedLocation);
    } catch (error) {
      this.status.set(this.getFirestoreReadErrorMessage(error));
      console.error('Latest location read error', error);
    }
  }

  protected requestLocation(): void {
    if (!window.isSecureContext) {
      this.status.set('La ubicacion necesita HTTPS. Abre la app desde Netlify o localhost.');
      return;
    }

    if (!navigator.geolocation) {
      this.status.set('Tu navegador no soporta geolocalizacion.');
      return;
    }

    this.isLoading.set(true);
    this.status.set('Buscando tu ubicacion...');
    this.startLocationWatch();
  }

  private startLocationWatch(): void {
    if (this.locationWatchId !== undefined) {
      navigator.geolocation.clearWatch(this.locationWatchId);
    }

    this.locationWatchId = navigator.geolocation.watchPosition(
      (position) => {
        this.isLoading.set(false);
        this.showLocation(position);
      },
      (error) => {
        this.isLoading.set(false);
        this.status.set(this.getErrorMessage(error));
      },
      {
        enableHighAccuracy: true,
        timeout: 120000,
        maximumAge: 0,
      }
    );
  }

  private async loadRoutePoints(): Promise<L.LatLngTuple[]> {
    try {
      const response = await fetch('/routes/media-maraton-caceres.gpx');

      if (!response.ok) {
        return [];
      }

      const gpxText = await response.text();
      const xml = new DOMParser().parseFromString(gpxText, 'application/xml');
      const trackPoints = Array.from(xml.querySelectorAll('trkpt'));

      return trackPoints
        .map((point): L.LatLngTuple | null => {
          const lat = Number(point.getAttribute('lat'));
          const lon = Number(point.getAttribute('lon'));

          if (Number.isNaN(lat) || Number.isNaN(lon)) {
            return null;
          }

          return [lat, lon];
        })
        .filter((point): point is L.LatLngTuple => point !== null);
    } catch {
      return [];
    }
  }

  private showLocation(position: GeolocationPosition): void {
    const { latitude, longitude, accuracy } = position.coords;
    const currentPoint: L.LatLngTuple = [latitude, longitude];

    this.userMarker?.remove();

    this.userMarker = this.createLocationMarker(currentPoint).addTo(this.map!);

    if (!this.hasCenteredOnUser) {
      const focusBounds = this.routeBounds
        ? L.latLngBounds(this.routeBounds.getSouthWest(), this.routeBounds.getNorthEast()).extend(currentPoint)
        : L.latLngBounds([currentPoint]);

      this.map?.fitBounds(focusBounds, { padding: [24, 24] });
      this.hasCenteredOnUser = true;
    } else {
      this.map?.panTo(currentPoint, { animate: true });
    }

    this.status.set(`Ubicacion GPS detectada. Precision ${Math.round(accuracy)} m.`);
  }

  private showSharedLocation(location: SharedLocation): void {
    const currentPoint: L.LatLngTuple = [location.latitude, location.longitude];

    this.sharedMarker?.remove();

    this.sharedMarker = this.createLocationMarker(currentPoint).addTo(this.map!);

    if (!this.hasCenteredOnUser) {
      this.map?.setView(currentPoint, 16);
      this.hasCenteredOnUser = true;
    }

    const capturedAt = location.capturedAtMs ? new Date(location.capturedAtMs).toLocaleTimeString() : '';
    const suffix = capturedAt ? ` Actualizada a las ${capturedAt}.` : '';
    this.status.set(`Ultima ubicacion compartida visible.${suffix}`);
  }

  private clearSharedLocation(): void {
    this.sharedMarker?.remove();
    this.sharedMarker = undefined;
    this.hasCenteredOnUser = false;
  }

  private createLocationMarker(point: L.LatLngTuple): L.Marker {
    return L.marker(point, {
      icon: L.divIcon({
        className: 'location-letter-marker',
        html: '<span>M</span>',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      }),
    });
  }

  private getErrorMessage(error: GeolocationPositionError): string {
    switch (error.code) {
      case error.PERMISSION_DENIED:
        return 'Has denegado el permiso de ubicacion.';
      case error.POSITION_UNAVAILABLE:
        return 'No se pudo determinar tu ubicacion.';
      case error.TIMEOUT:
        return 'La solicitud de ubicacion tardo demasiado.';
      default:
        return 'Ha ocurrido un error al obtener la ubicacion.';
    }
  }

  private getFirestoreReadErrorMessage(error: unknown): string {
    if (error instanceof FirebaseError && error.code === 'permission-denied') {
      return 'No tienes permiso para leer la ultima ubicacion.';
    }

    return 'No se pudo leer la ultima ubicacion compartida.';
  }
}
