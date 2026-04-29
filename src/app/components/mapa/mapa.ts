import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, inject, signal } from '@angular/core';
import * as L from 'leaflet';

import { GpsRecorderService } from '../../services/gps-recorder.service';

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
  protected readonly gpsRecorder = inject(GpsRecorderService);

  private map?: L.Map;
  private routeBounds?: L.LatLngBounds;
  private userMarker?: L.CircleMarker;
  private accuracyCircle?: L.Circle;
  private startMarker?: L.CircleMarker;

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
      this.requestLocation();
      this.gpsRecorder.start();
      return;
    }

    this.map.setView([39.4762, -6.3722], 13);
    this.requestLocation();
    this.gpsRecorder.start();
  }

  ngOnDestroy(): void {
    this.gpsRecorder.stop();
    this.map?.remove();
  }

  protected requestLocation(): void {
    if (!navigator.geolocation) {
      this.status.set('Tu navegador no soporta geolocalizacion.');
      return;
    }

    this.isLoading.set(true);
    this.status.set('Solicitando permiso de ubicacion...');

    navigator.geolocation.getCurrentPosition(
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
        timeout: 10000,
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
    this.accuracyCircle?.remove();

    this.userMarker = L.circleMarker(currentPoint, {
      radius: 5,
      color: '#0b4f9c',
      fillColor: '#1e88ff',
      fillOpacity: 0.95,
      weight: 2,
    }).addTo(this.map!);

    this.accuracyCircle = L.circle(currentPoint, {
      radius: accuracy,
      color: '#1e88ff',
      fillColor: '#7cc4ff',
      fillOpacity: 0.2,
      weight: 1,
    }).addTo(this.map!);

    const focusBounds = this.routeBounds
      ? this.routeBounds.extend(currentPoint)
      : L.latLngBounds([currentPoint]);

    this.map?.fitBounds(focusBounds, { padding: [24, 24] });
    this.status.set(
      `Ubicacion detectada. Latitud ${latitude.toFixed(5)}, longitud ${longitude.toFixed(5)}.`
    );
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
}
