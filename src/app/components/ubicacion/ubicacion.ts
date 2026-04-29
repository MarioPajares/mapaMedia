import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, signal } from '@angular/core';
import * as L from 'leaflet';

@Component({
  selector: 'app-ubicacion',
  standalone: true,
  templateUrl: './ubicacion.html',
  styleUrl: './ubicacion.css',
})
export class UbicacionComponent implements AfterViewInit, OnDestroy {
  @ViewChild('mapContainer', { static: true }) private readonly mapContainer?: ElementRef<HTMLDivElement>;

  protected readonly status = signal('Pulsa el boton para permitir la ubicacion.');
  protected readonly isLoading = signal(false);

  private map?: L.Map;
  private userMarker?: L.CircleMarker;
  private accuracyCircle?: L.Circle;

  ngAfterViewInit(): void {
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
  }

  ngOnDestroy(): void {
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

  private showLocation(position: GeolocationPosition): void {
    const { latitude, longitude, accuracy } = position.coords;
    const currentPoint: L.LatLngTuple = [latitude, longitude];

    this.userMarker?.remove();
    this.accuracyCircle?.remove();

    this.userMarker = L.circleMarker(currentPoint, {
      radius: 10,
      color: '#0b4f9c',
      fillColor: '#1e88ff',
      fillOpacity: 0.95,
      weight: 3,
    }).addTo(this.map!);

    this.accuracyCircle = L.circle(currentPoint, {
      radius: accuracy,
      color: '#1e88ff',
      fillColor: '#7cc4ff',
      fillOpacity: 0.2,
      weight: 1,
    }).addTo(this.map!);

    this.map?.setView(currentPoint, 16);
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
