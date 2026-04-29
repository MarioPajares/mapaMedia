import { Routes } from '@angular/router';

import { authGuard, loginGuard } from './guards/auth.guard';
import { LoginComponent } from './components/login/login';
import { MapaComponent } from './components/mapa/mapa';
import { UbicacionComponent } from './components/ubicacion/ubicacion';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'mapa' },
  { path: 'login', component: LoginComponent, canActivate: [loginGuard] },
  { path: 'mapa', component: MapaComponent, canActivate: [authGuard] },
  { path: 'ubicacion', component: UbicacionComponent, canActivate: [authGuard] },
  { path: '**', redirectTo: 'mapa' },
];
