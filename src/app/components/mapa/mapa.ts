import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { FirebaseError, getApps, initializeApp } from 'firebase/app';
import { doc, getFirestore, onSnapshot, type Firestore, type Unsubscribe } from 'firebase/firestore';
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
  raceStartTime?: string;
}

interface RoutePoint {
  distanceM: number;
  elevation?: number;
  point: L.LatLngTuple;
}

interface DistanceMarker {
  kilometer: number;
  point: L.LatLngTuple;
  estimatedTime: string;
}

interface ElevationProfilePoint {
  distanceM: number;
  elevation: number;
}

const DEFAULT_RACE_START_TIME = '19:00';
const MARKER_INTERVAL_KM = 3;
const RACE_LAPS = 2;
const EARTH_RADIUS_M = 6_371_000;
const ELEVATION_CHART_WIDTH = 320;
const ELEVATION_CHART_HEIGHT = 170;
const ELEVATION_CHART_PADDING = 18;
const ESTIMATED_PACE_SECONDS_BY_KM = [
  5 * 60 + 10,
  4 * 60 + 54,
  4 * 60 + 51,
  4 * 60 + 53,
  5 * 60 + 4,
  4 * 60 + 49,
  5 * 60 + 6,
  4 * 60 + 50,
  4 * 60 + 42,
  4 * 60 + 51,
  4 * 60 + 56,
  5 * 60 + 3,
  4 * 60 + 55,
  4 * 60 + 57,
  4 * 60 + 48,
  5 * 60 + 5,
  4 * 60 + 50,
  5 * 60 + 6,
  4 * 60 + 47,
  4 * 60 + 41,
  4 * 60 + 49,
];

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
  protected readonly isGpsWriter = computed(() => this.auth.isGpsWriter());
  protected readonly selectedRaceStartTime = signal(DEFAULT_RACE_START_TIME);
  protected readonly raceName = signal('Media Maraton Caceres Patrimonio de la Humanidad 2026');
  protected readonly elevationPath = signal('');
  protected readonly elevationAreaPath = signal('');
  protected readonly elevationMin = signal(0);
  protected readonly elevationMax = signal(0);
  protected readonly elevationGain = signal(0);
  protected readonly elevationDistanceKm = signal(0);
  protected readonly hasElevationProfile = computed(() => this.elevationPath() !== '');
  private readonly router = inject(Router);
  private readonly db: Firestore;

  private map?: L.Map;
  private routeBounds?: L.LatLngBounds;
  private userMarker?: L.Marker;
  private sharedMarker?: L.Marker;
  private startMarker?: L.CircleMarker;
  private locationWatchId?: number;
  private sharedLocationUnsubscribe?: Unsubscribe;
  private distanceMarkerLayers: L.Marker[] = [];
  private raceStartTime = DEFAULT_RACE_START_TIME;
  private routePoints: RoutePoint[] = [];

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
    this.routePoints = routePoints;
    const routeLatLngs = routePoints.map(({ point }) => point);

    if (routeLatLngs.length > 0) {
      const route = L.polyline(routeLatLngs, {
        color: '#1368ce',
        weight: 3,
        opacity: 0.85,
      }).addTo(this.map);

      this.startMarker = L.circleMarker(routeLatLngs[0], {
        radius: 6,
        color: '#1b5e20',
        fillColor: '#2f9e44',
        fillOpacity: 1,
        weight: 2,
      }).addTo(this.map);

      this.updateDistanceMarkers();
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

    this.stopSharedLocationListener();
    this.gpsRecorder.stop();
    this.map?.remove();
  }

  private async startLocationFeatures(): Promise<void> {
    await this.auth.ready;

    if (this.auth.user()?.uid === environment.gpsWriterUid) {
      this.status.set('Pulsa Activar GPS para empezar a emitir ubicacion.');
      return;
    }

    this.startSharedLocationListener();
    this.status.set('Conectando con la ubicacion compartida.');
  }

  protected activateGps(): void {
    this.raceStartTime = this.normalizeRaceStartTime(this.selectedRaceStartTime());
    this.selectedRaceStartTime.set(this.raceStartTime);
    this.updateDistanceMarkers();
    this.requestLocation();
    this.gpsRecorder.start(this.raceStartTime);
  }

  protected updateRaceStartTime(event: Event): void {
    const value = event.target instanceof HTMLInputElement ? event.target.value : '';
    this.raceStartTime = this.normalizeRaceStartTime(value);
    this.selectedRaceStartTime.set(this.raceStartTime);

    if (!this.gpsRecorder.isRecording()) {
      this.updateDistanceMarkers();
    }
  }

  protected loginAsEmitter(): void {
    void this.router.navigateByUrl('/login');
  }

  protected async deactivateGps(): Promise<void> {
    if (this.locationWatchId !== undefined) {
      navigator.geolocation.clearWatch(this.locationWatchId);
      this.locationWatchId = undefined;
    }

    this.isLoading.set(false);
    this.userMarker?.remove();
    this.userMarker = undefined;
    await this.gpsRecorder.stopAndDeleteLatestLocation();
    this.status.set('GPS desactivado.');
  }

  private startSharedLocationListener(): void {
    this.stopSharedLocationListener();

    this.sharedLocationUnsubscribe = onSnapshot(
      doc(this.db, 'latestLocations', environment.gpsWriterUid),
      (snapshot) => {
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
      },
      (error) => {
        this.status.set(this.getFirestoreReadErrorMessage(error));
        console.warn('Latest location read error', error);
      }
    );
  }

  private stopSharedLocationListener(): void {
    if (this.sharedLocationUnsubscribe) {
      this.sharedLocationUnsubscribe();
      this.sharedLocationUnsubscribe = undefined;
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

  private async loadRoutePoints(): Promise<RoutePoint[]> {
    try {
      const response = await fetch('/routes/media-maraton-caceres.gpx');

      if (!response.ok) {
        return [];
      }

      const gpxText = await response.text();
      const xml = new DOMParser().parseFromString(gpxText, 'application/xml');
      this.raceName.set(this.getRouteName(xml));
      const trackPoints = Array.from(xml.querySelectorAll('trkpt'));

      const routePoints = trackPoints
        .map((point): RoutePoint | null => {
          const lat = Number(point.getAttribute('lat'));
          const lon = Number(point.getAttribute('lon'));
          const elevationText = point.querySelector('ele')?.textContent;
          const elevation = elevationText ? Number(elevationText) : undefined;

          if (Number.isNaN(lat) || Number.isNaN(lon)) {
            return null;
          }

          return {
            distanceM: 0,
            elevation: elevation !== undefined && !Number.isNaN(elevation) ? elevation : undefined,
            point: [lat, lon],
          };
        })
        .filter((point): point is RoutePoint => point !== null);

      this.addCumulativeDistances(routePoints);
      this.updateElevationProfile(routePoints);

      return routePoints;
    } catch {
      return [];
    }
  }

  private getRouteName(xml: Document): string {
    const name = xml.querySelector('metadata > name')?.textContent?.trim() || xml.querySelector('trk > name')?.textContent?.trim();

    return name?.replace(/^Wikiloc - /, '') || this.raceName();
  }

  private addCumulativeDistances(routePoints: RoutePoint[]): void {
    for (let index = 1; index < routePoints.length; index += 1) {
      routePoints[index].distanceM =
        routePoints[index - 1].distanceM +
        this.getDistanceBetweenPointsM(routePoints[index - 1].point, routePoints[index].point);
    }
  }

  private updateElevationProfile(routePoints: RoutePoint[]): void {
    const elevationPoints = this.getRaceElevationPoints(routePoints);

    if (elevationPoints.length < 2) {
      this.elevationPath.set('');
      this.elevationAreaPath.set('');
      return;
    }

    const elevations = elevationPoints.map((point) => point.elevation);
    const minElevation = Math.floor(Math.min(...elevations));
    const maxElevation = Math.ceil(Math.max(...elevations));
    const elevationRange = Math.max(maxElevation - minElevation, 1);
    const totalDistanceM = this.getRaceDistanceM(routePoints);
    const chartWidth = ELEVATION_CHART_WIDTH - ELEVATION_CHART_PADDING * 2;
    const chartHeight = ELEVATION_CHART_HEIGHT - ELEVATION_CHART_PADDING * 2;
    const coordinates = elevationPoints.map((point) => {
      const x = ELEVATION_CHART_PADDING + (point.distanceM / totalDistanceM) * chartWidth;
      const y =
        ELEVATION_CHART_HEIGHT -
        ELEVATION_CHART_PADDING -
        ((point.elevation - minElevation) / elevationRange) * chartHeight;

      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });
    const baselineY = ELEVATION_CHART_HEIGHT - ELEVATION_CHART_PADDING;
    const firstX = ELEVATION_CHART_PADDING;
    const lastX = ELEVATION_CHART_WIDTH - ELEVATION_CHART_PADDING;

    this.elevationPath.set(`M ${coordinates.join(' L ')}`);
    this.elevationAreaPath.set(`M ${firstX},${baselineY} L ${coordinates.join(' L ')} L ${lastX},${baselineY} Z`);
    this.elevationMin.set(minElevation);
    this.elevationMax.set(maxElevation);
    this.elevationGain.set(this.getElevationGain(elevationPoints));
    this.elevationDistanceKm.set(totalDistanceM / 1000);
  }

  private getElevationGain(elevationPoints: ElevationProfilePoint[]): number {
    let gain = 0;

    for (let index = 1; index < elevationPoints.length; index += 1) {
      const previousElevation = elevationPoints[index - 1].elevation;
      const currentElevation = elevationPoints[index].elevation;
      gain += Math.max(0, currentElevation - previousElevation);
    }

    return Math.round(gain);
  }

  private getRaceElevationPoints(routePoints: RoutePoint[]): ElevationProfilePoint[] {
    const routeDistanceM = routePoints[routePoints.length - 1]?.distanceM ?? 0;

    if (routeDistanceM === 0) {
      return [];
    }

    const elevationPoints: ElevationProfilePoint[] = [];

    for (let lap = 0; lap < RACE_LAPS; lap += 1) {
      for (const point of routePoints) {
        if (point.elevation === undefined) {
          continue;
        }

        elevationPoints.push({
          distanceM: lap * routeDistanceM + point.distanceM,
          elevation: point.elevation,
        });
      }
    }

    return elevationPoints;
  }

  private updateDistanceMarkers(): void {
    for (const marker of this.distanceMarkerLayers) {
      marker.remove();
    }

    this.distanceMarkerLayers = [];

    for (const marker of this.getDistanceMarkers(this.routePoints)) {
      const markerLayer = L.marker(marker.point, {
        icon: L.divIcon({
          className: 'distance-marker',
          html: `<span>${marker.kilometer}</span>`,
          iconSize: [30, 30],
          iconAnchor: [15, 15],
        }),
      }).bindTooltip(`Km ${marker.kilometer} · ${marker.estimatedTime}`, {
          direction: 'top',
          offset: [0, -12],
          opacity: 0.95,
        });

      markerLayer.addTo(this.map!);
      this.distanceMarkerLayers.push(markerLayer);
    }
  }

  private getDistanceMarkers(routePoints: RoutePoint[]): DistanceMarker[] {
    if (routePoints.length < 2) {
      return [];
    }

    const routeDistanceM = this.getRouteDistanceM(routePoints);
    const targetDistanceM = routeDistanceM * RACE_LAPS;
    const markerCount = Math.floor(targetDistanceM / (MARKER_INTERVAL_KM * 1000));
    const markers: DistanceMarker[] = [];

    for (let markerIndex = 1; markerIndex <= markerCount; markerIndex += 1) {
      const kilometer = markerIndex * MARKER_INTERVAL_KM;
      const distanceIntoRouteM = ((kilometer * 1000) % routeDistanceM) || routeDistanceM;
      const point = this.getPointAtDistance(routePoints, distanceIntoRouteM);

      if (!point) {
        continue;
      }

      markers.push({
        kilometer,
        point,
        estimatedTime: this.getEstimatedArrivalTime(kilometer),
      });
    }

    return markers;
  }

  private getRouteDistanceM(routePoints: RoutePoint[]): number {
    let distance = 0;

    for (let index = 1; index < routePoints.length; index += 1) {
      distance += this.getDistanceBetweenPointsM(routePoints[index - 1].point, routePoints[index].point);
    }

    return distance;
  }

  private getRaceDistanceM(routePoints: RoutePoint[]): number {
    return (routePoints[routePoints.length - 1]?.distanceM ?? 0) * RACE_LAPS;
  }

  private getPointAtDistance(routePoints: RoutePoint[], targetDistanceM: number): L.LatLngTuple | null {
    let walkedDistanceM = 0;

    for (let index = 1; index < routePoints.length; index += 1) {
      const previousPoint = routePoints[index - 1].point;
      const nextPoint = routePoints[index].point;
      const segmentDistanceM = this.getDistanceBetweenPointsM(previousPoint, nextPoint);
      const nextWalkedDistanceM = walkedDistanceM + segmentDistanceM;

      if (nextWalkedDistanceM >= targetDistanceM) {
        const ratio = segmentDistanceM === 0 ? 0 : (targetDistanceM - walkedDistanceM) / segmentDistanceM;

        return [
          previousPoint[0] + (nextPoint[0] - previousPoint[0]) * ratio,
          previousPoint[1] + (nextPoint[1] - previousPoint[1]) * ratio,
        ];
      }

      walkedDistanceM = nextWalkedDistanceM;
    }

    return routePoints[routePoints.length - 1].point;
  }

  private getDistanceBetweenPointsM(firstPoint: L.LatLngTuple, secondPoint: L.LatLngTuple): number {
    const firstLat = this.toRadians(firstPoint[0]);
    const secondLat = this.toRadians(secondPoint[0]);
    const latDelta = this.toRadians(secondPoint[0] - firstPoint[0]);
    const lonDelta = this.toRadians(secondPoint[1] - firstPoint[1]);
    const haversine =
      Math.sin(latDelta / 2) ** 2 +
      Math.cos(firstLat) * Math.cos(secondLat) * Math.sin(lonDelta / 2) ** 2;

    return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
  }

  private getEstimatedArrivalTime(kilometer: number): string {
    const estimatedArrival = new Date();
    const [startHour, startMinute] = this.getRaceStartTimeParts(this.raceStartTime);
    estimatedArrival.setHours(startHour, startMinute, 0, 0);
    estimatedArrival.setSeconds(estimatedArrival.getSeconds() + this.getEstimatedElapsedSeconds(kilometer));

    return estimatedArrival.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private getEstimatedElapsedSeconds(kilometer: number): number {
    const elapsedSeconds = ESTIMATED_PACE_SECONDS_BY_KM
      .slice(0, kilometer)
      .reduce((total, paceSeconds) => total + paceSeconds, 0);

    return Math.round(elapsedSeconds / 60) * 60;
  }

  private normalizeRaceStartTime(value: string): string {
    const [hours, minutes] = this.getRaceStartTimeParts(value);

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
  }

  private getRaceStartTimeParts(value: string): [number, number] {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value);

    if (!match) {
      return [19, 0];
    }

    const hours = Number(match[1]);
    const minutes = Number(match[2]);

    if (Number.isNaN(hours) || Number.isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      return [19, 0];
    }

    return [hours, minutes];
  }

  private toRadians(value: number): number {
    return (value * Math.PI) / 180;
  }

  private showLocation(position: GeolocationPosition): void {
    const { latitude, longitude, accuracy } = position.coords;
    const currentPoint: L.LatLngTuple = [latitude, longitude];

    this.userMarker?.remove();

    this.userMarker = this.createLocationMarker(currentPoint).addTo(this.map!);

    this.status.set(`Ubicacion GPS detectada. Precision ${Math.round(accuracy)} m.`);
  }

  private showSharedLocation(location: SharedLocation): void {
    if (location.raceStartTime) {
      const raceStartTime = this.normalizeRaceStartTime(location.raceStartTime);

      if (raceStartTime !== this.raceStartTime) {
        this.raceStartTime = raceStartTime;
        this.selectedRaceStartTime.set(raceStartTime);
        this.updateDistanceMarkers();
      }
    }

    const currentPoint: L.LatLngTuple = [location.latitude, location.longitude];

    this.sharedMarker?.remove();

    this.sharedMarker = this.createLocationMarker(currentPoint).addTo(this.map!);

    const capturedAt = location.capturedAtMs ? new Date(location.capturedAtMs).toLocaleTimeString() : '';
    const suffix = capturedAt ? ` Actualizada a las ${capturedAt}.` : '';
    this.status.set(`Ultima ubicacion compartida visible.${suffix}`);
  }

  private clearSharedLocation(): void {
    this.sharedMarker?.remove();
    this.sharedMarker = undefined;
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
