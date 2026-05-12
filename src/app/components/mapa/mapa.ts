import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FirebaseError, getApps, initializeApp } from 'firebase/app';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore';
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

interface RaceConfig {
  gpxText?: string;
  laps?: number;
  markerIntervalKm?: number;
  name?: string;
}

interface SavedRace extends RaceConfig {
  id: string;
}

const DEFAULT_RACE_START_TIME = '19:00';
const DEFAULT_MARKER_INTERVAL_KM = 3;
const DEFAULT_RACE_LAPS = 2;
const EARTH_RADIUS_M = 6_371_000;
const ELEVATION_CHART_WIDTH = 320;
const ELEVATION_CHART_HEIGHT = 90;
const ELEVATION_CHART_PADDING = 10;
const ELEVATION_GAIN_THRESHOLD_M = 2.25;
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
  imports: [RouterLink],
  standalone: true,
  templateUrl: './mapa.html',
  styleUrl: './mapa.css',
})
export class MapaComponent implements AfterViewInit, OnDestroy {
  @ViewChild('mapContainer') private set mapContainerRef(container: ElementRef<HTMLDivElement> | undefined) {
    this.mapContainer = container;

    if (!container) {
      return;
    }

    if (this.map && this.map.getContainer() !== container.nativeElement) {
      this.map.remove();
      this.map = undefined;
      this.routeLayer = undefined;
      this.startMarker = undefined;
      this.userMarker = undefined;
      this.sharedMarker = undefined;
      this.distanceMarkerLayers = [];
    }

    if (!this.map) {
      void this.initializeMap();
    }
  }

  @ViewChild('gpxFileInput') private readonly gpxFileInput?: ElementRef<HTMLInputElement>;

  protected readonly status = signal('Solicitando tu ubicacion al abrir el recorrido...');
  protected readonly isLoading = signal(false);
  protected readonly auth = inject(AuthService);
  protected readonly gpsRecorder = inject(GpsRecorderService);
  protected readonly isGpsWriter = computed(() => this.auth.isGpsWriter());
  protected readonly selectedRaceStartTime = signal(DEFAULT_RACE_START_TIME);
  protected readonly raceName = signal('Media Maraton Caceres Patrimonio de la Humanidad 2026');
  protected readonly raceFormName = signal('');
  protected readonly raceFormLaps = signal(DEFAULT_RACE_LAPS);
  protected readonly raceFormMarkerIntervalKm = signal(DEFAULT_MARKER_INTERVAL_KM);
  protected readonly gpxFileName = signal('');
  protected readonly raceConfigStatus = signal('');
  protected readonly savedRaces = signal<SavedRace[]>([]);
  protected readonly selectedRaceId = signal('');
  protected readonly activeRaceId = signal('');
  protected readonly adminPanel = signal<'existing' | 'add' | ''>('');
  protected readonly pendingCreatedRaceId = signal('');
  protected readonly isSavingRaceConfig = signal(false);
  protected readonly elevationPath = signal('');
  protected readonly elevationAreaPath = signal('');
  protected readonly elevationMin = signal(0);
  protected readonly elevationMax = signal(0);
  protected readonly elevationGain = signal(0);
  protected readonly elevationDistanceKm = signal(0);
  protected readonly hasElevationProfile = computed(() => this.elevationPath() !== '');
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly db: Firestore;

  private mapContainer?: ElementRef<HTMLDivElement>;
  private map?: L.Map;
  private routeBounds?: L.LatLngBounds;
  private userMarker?: L.Marker;
  private sharedMarker?: L.Marker;
  private startMarker?: L.CircleMarker;
  private locationWatchId?: number;
  private sharedLocationUnsubscribe?: Unsubscribe;
  private savedRacesUnsubscribe?: Unsubscribe;
  private activeRaceUnsubscribe?: Unsubscribe;
  private distanceMarkerLayers: L.Marker[] = [];
  private routeLayer?: L.Polyline;
  private raceStartTime = DEFAULT_RACE_START_TIME;
  private raceLaps = DEFAULT_RACE_LAPS;
  private markerIntervalKm = DEFAULT_MARKER_INTERVAL_KM;
  private routePoints: RoutePoint[] = [];
  private selectedGpxText = '';
  private hasEditedRaceFormName = false;

  constructor() {
    const app = getApps()[0] ?? initializeApp(environment.firebase);
    this.db = getFirestore(app);
    this.route.queryParamMap.subscribe((params) => {
      const panel = params.get('panel');
      const nextPanel = panel === 'existing' || panel === 'add' ? panel : '';
      const previousPanel = this.adminPanel();
      this.adminPanel.set(nextPanel);

      if (nextPanel === 'add' && previousPanel !== 'add') {
        this.resetRaceForm();
        this.raceConfigStatus.set('');
        this.pendingCreatedRaceId.set('');
      }
    });
  }

  async ngAfterViewInit(): Promise<void> {
    await this.initializeMap();
  }

  private async initializeMap(): Promise<void> {
    if (this.map) {
      return;
    }

    const container = this.mapContainer?.nativeElement;

    if (!container) {
      await this.loadSavedRaces();
      return;
    }

    this.map = L.map(container, {
      center: [39.4762, -6.3722],
      zoom: 13,
      zoomControl: true,
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      maxZoom: 19,
    }).addTo(this.map);

    this.startRaceConfigListeners();
    const routePoints = await this.loadRoutePoints();
    this.renderRoute(routePoints);

    if (routePoints.length > 0) {
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
    this.stopRaceConfigListeners();
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

  protected updateRaceName(event: Event): void {
    const value = event.target instanceof HTMLInputElement ? event.target.value : '';
    this.hasEditedRaceFormName = true;
    this.raceFormName.set(value);
  }

  protected updateRaceLaps(event: Event): void {
    const value = event.target instanceof HTMLInputElement ? Number(event.target.value) : DEFAULT_RACE_LAPS;
    this.raceFormLaps.set(this.normalizeRaceLaps(value));
  }

  protected updateRaceMarkerInterval(event: Event): void {
    const value = event.target instanceof HTMLInputElement ? Number(event.target.value) : DEFAULT_MARKER_INTERVAL_KM;
    this.raceFormMarkerIntervalKm.set(this.normalizeMarkerInterval(value));
  }

  protected async updateSavedRaceMarkerInterval(raceId: string, event: Event): Promise<void> {
    const markerIntervalKm = this.normalizeMarkerInterval(
      event.target instanceof HTMLInputElement ? Number(event.target.value) : DEFAULT_MARKER_INTERVAL_KM
    );
    const races = this.savedRaces().map((race) => (race.id === raceId ? { ...race, markerIntervalKm } : race));
    this.savedRaces.set(races);
    await updateDoc(doc(this.db, 'races', raceId), {
      markerIntervalKm,
      updatedAt: serverTimestamp(),
      updatedBy: this.auth.user()?.uid ?? null,
    });

    if (this.activeRaceId() === raceId) {
      const race = races.find((savedRace) => savedRace.id === raceId);

      if (race?.gpxText) {
        this.applyRaceConfig(race);
        this.renderRoute(this.parseGpxRoutePoints(race.gpxText, race.name));
      }
    }

    this.raceConfigStatus.set('Puntos actualizados.');
  }

  protected async updateGpxFile(event: Event): Promise<void> {
    const file = event.target instanceof HTMLInputElement ? event.target.files?.[0] : undefined;

    if (!file) {
      return;
    }

    if (!file.name.toLowerCase().endsWith('.gpx')) {
      this.raceConfigStatus.set('Selecciona un archivo .gpx.');
      return;
    }

    this.selectedGpxText = await file.text();
    const gpxName = this.getRouteName(new DOMParser().parseFromString(this.selectedGpxText, 'application/xml'));

    if (!this.hasEditedRaceFormName || !this.raceFormName().trim()) {
      this.raceFormName.set(gpxName);
      this.hasEditedRaceFormName = false;
    }

    this.gpxFileName.set(file.name);
    this.raceConfigStatus.set('GPX cargado, listo para guardar.');
  }

  protected async saveRaceConfig(): Promise<void> {
    const name = this.raceFormName().trim();
    const laps = this.normalizeRaceLaps(this.raceFormLaps());
    const markerIntervalKm = this.normalizeMarkerInterval(this.raceFormMarkerIntervalKm());

    if (!name) {
      this.raceConfigStatus.set('Indica el nombre de la carrera.');
      return;
    }

    if (!this.selectedGpxText) {
      this.raceConfigStatus.set('Selecciona el archivo GPX.');
      return;
    }

    const routePoints = this.parseGpxRoutePoints(this.selectedGpxText, name);

    if (routePoints.length < 2) {
      this.raceConfigStatus.set('El GPX no tiene puntos validos.');
      return;
    }

    this.isSavingRaceConfig.set(true);

    try {
      const raceDoc = await addDoc(collection(this.db, 'races'), {
        gpxText: this.selectedGpxText,
        laps,
        markerIntervalKm,
        name,
        updatedAt: serverTimestamp(),
        updatedBy: this.auth.user()?.uid ?? null,
      });
      this.applyRaceConfig({ gpxText: this.selectedGpxText, laps, markerIntervalKm, name });
      this.selectedRaceId.set(raceDoc.id);
      this.pendingCreatedRaceId.set(raceDoc.id);
      await this.loadSavedRaces();
      this.renderRoute(routePoints);
      this.resetRaceForm();
      this.raceConfigStatus.set('Carrera guardada. ¿Quieres activarla?');
    } catch (error) {
      this.raceConfigStatus.set(this.getRaceConfigSaveErrorMessage(error));
      console.warn('Race config save error', error);
    } finally {
      this.isSavingRaceConfig.set(false);
    }
  }

  protected async updateSelectedRace(event: Event): Promise<void> {
    const raceId = event.target instanceof HTMLSelectElement ? event.target.value : '';

    if (!raceId) {
      return;
    }

    await this.activateRace(raceId);
  }

  protected async activateRace(raceId: string): Promise<void> {
    const race = this.savedRaces().find((savedRace) => savedRace.id === raceId);

    if (!race?.gpxText) {
      this.raceConfigStatus.set('No se pudo cargar esa carrera.');
      return;
    }

    await setDoc(doc(this.db, 'activeRace', 'current'), {
      raceId,
      updatedAt: serverTimestamp(),
      updatedBy: this.auth.user()?.uid ?? null,
    });
    this.activeRaceId.set(raceId);
    this.selectedRaceId.set(raceId);
    this.pendingCreatedRaceId.set('');
    this.applyRaceConfig(race);
    this.renderRoute(this.parseGpxRoutePoints(race.gpxText, race.name));
    this.raceConfigStatus.set('Carrera activa actualizada.');
  }

  protected async deactivateRace(raceId: string): Promise<void> {
    if (this.activeRaceId() !== raceId) {
      return;
    }

    await deleteDoc(doc(this.db, 'activeRace', 'current'));
    this.activeRaceId.set('');
    this.selectedRaceId.set('');
    this.clearRoute();
    this.raceName.set('Actualmente no hay carreras activas');
    this.raceConfigStatus.set('Carrera desactivada.');
  }

  protected async deleteRace(raceId: string): Promise<void> {
    const race = this.savedRaces().find((savedRace) => savedRace.id === raceId);

    if (!race || !window.confirm(`¿Eliminar "${race.name}"?`)) {
      return;
    }

    await deleteDoc(doc(this.db, 'races', raceId));

    if (this.activeRaceId() === raceId) {
      await deleteDoc(doc(this.db, 'activeRace', 'current'));
      this.activeRaceId.set('');
      this.selectedRaceId.set('');
      this.clearRoute();
      this.raceName.set('Actualmente no hay carreras activas');
    }

    if (this.pendingCreatedRaceId() === raceId) {
      this.pendingCreatedRaceId.set('');
    }

    await this.loadSavedRaces();
    this.raceConfigStatus.set('Carrera eliminada.');
  }

  protected dismissActivationPrompt(): void {
    this.pendingCreatedRaceId.set('');
    this.raceConfigStatus.set('Carrera guardada.');
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

  private startRaceConfigListeners(): void {
    this.stopRaceConfigListeners();

    this.savedRacesUnsubscribe = onSnapshot(
      collection(this.db, 'races'),
      (snapshot) => {
        const races = this.parseSavedRacesSnapshot(snapshot.docs.map((raceDoc) => ({ id: raceDoc.id, data: raceDoc.data() })));
        this.savedRaces.set(races);
        this.renderActiveRaceFromSavedRaces();
      },
      (error) => {
        this.raceConfigStatus.set('No se pudieron actualizar las carreras.');
        console.warn('Races realtime read error', error);
      }
    );

    this.activeRaceUnsubscribe = onSnapshot(
      doc(this.db, 'activeRace', 'current'),
      (snapshot) => {
        const activeRaceId = snapshot.exists() ? snapshot.data()['raceId'] : '';

        if (typeof activeRaceId !== 'string' || !activeRaceId) {
          this.activeRaceId.set('');
          this.selectedRaceId.set('');
          this.clearRoute();
          this.raceName.set('Actualmente no hay carreras activas');
          return;
        }

        this.activeRaceId.set(activeRaceId);
        this.selectedRaceId.set(activeRaceId);
        this.renderActiveRaceFromSavedRaces();
      },
      (error) => {
        this.raceConfigStatus.set('No se pudo actualizar la carrera activa.');
        console.warn('Active race realtime read error', error);
      }
    );
  }

  private stopRaceConfigListeners(): void {
    if (this.savedRacesUnsubscribe) {
      this.savedRacesUnsubscribe();
      this.savedRacesUnsubscribe = undefined;
    }

    if (this.activeRaceUnsubscribe) {
      this.activeRaceUnsubscribe();
      this.activeRaceUnsubscribe = undefined;
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
      await this.loadSavedRaces();
      const activeSnapshot = await getDoc(doc(this.db, 'activeRace', 'current'));
      const activeRaceId = activeSnapshot.exists() ? activeSnapshot.data()['raceId'] : '';

      if (typeof activeRaceId === 'string' && activeRaceId) {
        const activeRace = this.savedRaces().find((race) => race.id === activeRaceId);

        if (activeRace?.gpxText) {
          this.activeRaceId.set(activeRace.id);
          this.selectedRaceId.set(activeRace.id);
          this.applyRaceConfig(activeRace);
          return this.parseGpxRoutePoints(activeRace.gpxText, activeRace.name);
        }
      }

      this.raceName.set('Actualmente no hay carreras activas');
      return [];
    } catch {
      this.raceName.set('Actualmente no hay carreras activas');
      return [];
    }
  }

  private async loadSavedRaces(): Promise<void> {
    const snapshot = await getDocs(collection(this.db, 'races'));
    this.savedRaces.set(this.parseSavedRacesSnapshot(snapshot.docs.map((raceDoc) => ({ id: raceDoc.id, data: raceDoc.data() }))));
  }

  private parseSavedRacesSnapshot(raceDocs: Array<{ id: string; data: unknown }>): SavedRace[] {
    return raceDocs
      .map((raceDoc): SavedRace => ({ id: raceDoc.id, ...(raceDoc.data as RaceConfig) }))
      .filter((race) => typeof race.name === 'string' && typeof race.gpxText === 'string')
      .sort((first, second) => (first.name ?? '').localeCompare(second.name ?? ''));
  }

  private renderActiveRaceFromSavedRaces(): void {
    const activeRaceId = this.activeRaceId();

    if (!activeRaceId) {
      return;
    }

    const activeRace = this.savedRaces().find((race) => race.id === activeRaceId);

    if (!activeRace?.gpxText) {
      return;
    }

    this.applyRaceConfig(activeRace);
    this.renderRoute(this.parseGpxRoutePoints(activeRace.gpxText, activeRace.name));
  }

  private resetRaceForm(): void {
    this.raceFormName.set('');
    this.raceFormLaps.set(DEFAULT_RACE_LAPS);
    this.raceFormMarkerIntervalKm.set(DEFAULT_MARKER_INTERVAL_KM);
    this.gpxFileName.set('');
    this.selectedGpxText = '';
    this.hasEditedRaceFormName = false;

    if (this.gpxFileInput) {
      this.gpxFileInput.nativeElement.value = '';
    }
  }

  private parseGpxRoutePoints(gpxText: string, configuredName?: string): RoutePoint[] {
    const xml = new DOMParser().parseFromString(gpxText, 'application/xml');
    const parsedName = configuredName?.trim() || this.getRouteName(xml);
    this.raceName.set(parsedName);
    this.raceFormName.set(parsedName);
    const trackPoints = Array.from(this.getXmlElements(xml, 'trkpt'));

    const routePoints = trackPoints
      .map((point): RoutePoint | null => {
        const lat = Number(point.getAttribute('lat'));
        const lon = Number(point.getAttribute('lon'));
        const elevationText = this.getXmlElementText(point, 'ele');
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
  }

  private applyRaceConfig(config: RaceConfig): void {
    const name = config.name?.trim();
    const laps = this.normalizeRaceLaps(config.laps ?? DEFAULT_RACE_LAPS);
    const markerIntervalKm = this.normalizeMarkerInterval(config.markerIntervalKm ?? DEFAULT_MARKER_INTERVAL_KM);

    if (typeof config.gpxText === 'string' && config.gpxText.trim()) {
      this.selectedGpxText = config.gpxText;
      this.gpxFileName.set('GPX guardado');
    }

    if (name) {
      this.raceName.set(name);
      this.raceFormName.set(name);
    }

    this.raceLaps = laps;
    this.markerIntervalKm = markerIntervalKm;
    this.raceFormLaps.set(laps);
    this.raceFormMarkerIntervalKm.set(markerIntervalKm);
  }

  private renderRoute(routePoints: RoutePoint[]): void {
    this.clearMapLayers();
    this.routePoints = routePoints;

    const routeLatLngs = routePoints.map(({ point }) => point);

    if (!this.map || routeLatLngs.length === 0) {
      return;
    }

    this.routeLayer = L.polyline(routeLatLngs, {
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
    this.routeBounds = this.routeLayer.getBounds();
    this.map.fitBounds(this.routeBounds, { padding: [24, 24] });
  }

  private clearRoute(): void {
    this.clearMapLayers();
    this.routePoints = [];
    this.elevationPath.set('');
    this.elevationAreaPath.set('');
  }

  private clearMapLayers(): void {
    this.routeLayer?.remove();
    this.routeLayer = undefined;
    this.startMarker?.remove();
    this.startMarker = undefined;

    for (const marker of this.distanceMarkerLayers) {
      marker.remove();
    }

    this.distanceMarkerLayers = [];
  }

  private getRouteName(xml: Document): string {
    const name =
      xml.querySelector('metadata > name')?.textContent?.trim() ||
      xml.querySelector('trk > name')?.textContent?.trim() ||
      this.getXmlElementText(xml, 'name')?.trim();

    return name?.replace(/^Wikiloc - /, '') || this.raceName();
  }

  private getXmlElements(parent: Document | Element, tagName: string): Element[] {
    const directMatches = Array.from(parent.getElementsByTagName(tagName));

    if (directMatches.length > 0) {
      return directMatches;
    }

    return Array.from(parent.getElementsByTagNameNS('*', tagName));
  }

  private getXmlElementText(parent: Document | Element, tagName: string): string | undefined {
    return this.getXmlElements(parent, tagName)[0]?.textContent?.trim();
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
    this.elevationGain.set(this.getElevationGain(routePoints) * this.raceLaps);
    this.elevationDistanceKm.set(totalDistanceM / 1000);
  }

  private getElevationGain(routePoints: RoutePoint[]): number {
    let gain = 0;

    for (let index = 1; index < routePoints.length; index += 1) {
      const previousElevation = routePoints[index - 1].elevation;
      const currentElevation = routePoints[index].elevation;

      if (previousElevation === undefined || currentElevation === undefined) {
        continue;
      }

      const elevationDelta = currentElevation - previousElevation;

      if (elevationDelta >= ELEVATION_GAIN_THRESHOLD_M) {
        gain += elevationDelta;
      }
    }

    return Math.round(gain);
  }

  private getRaceElevationPoints(routePoints: RoutePoint[]): ElevationProfilePoint[] {
    const routeDistanceM = routePoints[routePoints.length - 1]?.distanceM ?? 0;
    const hasElevation = routePoints.some((point) => point.elevation !== undefined);

    if (routeDistanceM === 0) {
      return [];
    }

    const elevationPoints: ElevationProfilePoint[] = [];

    for (let lap = 0; lap < this.raceLaps; lap += 1) {
      for (const point of routePoints) {
        if (point.elevation === undefined && hasElevation) {
          continue;
        }

        elevationPoints.push({
          distanceM: lap * routeDistanceM + point.distanceM,
          elevation: point.elevation ?? 0,
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
    const targetDistanceM = routeDistanceM * this.raceLaps;
    const markerCount = Math.floor(targetDistanceM / (this.markerIntervalKm * 1000));
    const markers: DistanceMarker[] = [];

    for (let markerIndex = 1; markerIndex <= markerCount; markerIndex += 1) {
      const kilometer = markerIndex * this.markerIntervalKm;
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
    return (routePoints[routePoints.length - 1]?.distanceM ?? 0) * this.raceLaps;
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

  private normalizeRaceLaps(value: number): number {
    if (!Number.isFinite(value)) {
      return DEFAULT_RACE_LAPS;
    }

    return Math.min(20, Math.max(1, Math.round(value)));
  }

  private normalizeMarkerInterval(value: number): number {
    if (!Number.isFinite(value)) {
      return DEFAULT_MARKER_INTERVAL_KM;
    }

    return Math.min(50, Math.max(1, Math.round(value)));
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

  private getRaceConfigSaveErrorMessage(error: unknown): string {
    if (error instanceof FirebaseError && error.code === 'permission-denied') {
      return 'Firestore rechazo el guardado de la carrera.';
    }

    return 'No se pudo guardar la carrera.';
  }
}
