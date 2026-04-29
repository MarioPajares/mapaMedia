import { Routes } from '@angular/router';

import { MapaComponent } from './components/mapa/mapa';
import { UbicacionComponent } from './components/ubicacion/ubicacion';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'mapa' },
  { path: 'mapa', component: MapaComponent },
  { path: 'ubicacion', component: UbicacionComponent },
];
