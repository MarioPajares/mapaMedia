import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  templateUrl: './login.html',
  styleUrl: './login.css',
})
export class LoginComponent {
  private readonly router = inject(Router);
  protected readonly auth = inject(AuthService);
  protected readonly error = signal('');
  protected readonly isSubmitting = signal(false);

  protected goBack(): void {
    if (window.history.length > 1) {
      window.history.back();
      return;
    }

    void this.router.navigateByUrl('/mapa');
  }

  protected async login(): Promise<void> {
    this.error.set('');
    this.isSubmitting.set(true);

    try {
      const shouldNavigate = await this.auth.loginAsGpsWriter();

      if (shouldNavigate) {
        await this.router.navigateByUrl('/mapa');
      } else {
        this.error.set('Esta cuenta no tiene permiso para emitir ubicacion.');
      }
    } catch {
      this.error.set('No se pudo iniciar sesion con Google.');
    } finally {
      this.isSubmitting.set(false);
    }
  }
}
