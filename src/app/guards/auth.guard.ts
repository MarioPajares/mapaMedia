import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';

import { AuthService } from '../services/auth.service';
import { environment } from '../../environments/environment';

export const authGuard: CanActivateFn = async (): Promise<boolean | UrlTree> => {
  const auth = inject(AuthService);
  const router = inject(Router);

  await auth.ready;

  return auth.isLoggedIn() ? true : router.createUrlTree(['/login']);
};

export const loginGuard: CanActivateFn = async (): Promise<boolean | UrlTree> => {
  const auth = inject(AuthService);
  const router = inject(Router);

  await auth.ready;

  return auth.user()?.uid === environment.gpsWriterUid ? router.createUrlTree(['/mapa']) : true;
};
