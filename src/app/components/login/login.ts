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
      await this.auth.loginWithGoogle();
      await this.router.navigateByUrl('/mapa');
    } catch (error) {
      console.error('Google login error', error);
      this.error.set(this.getLoginErrorMessage(error));
    } finally {
      this.isSubmitting.set(false);
    }
  }

  private getLoginErrorMessage(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = String(error.code);

      if (code.includes('popup-closed-by-user') || code.includes('canceled')) {
        return 'Inicio de sesion cancelado.';
      }

      if (code.includes('unauthorized-domain')) {
        return 'Este dominio no esta autorizado en Firebase Authentication.';
      }

      if (code.includes('invalid-credential') || code.includes('credential-already-in-use')) {
        return `Google rechazo la credencial (${code}). Revisa la configuracion de Android en Firebase.`;
      }

      return `No se pudo iniciar sesion con Google (${code}).`;
    }

    return 'No se pudo iniciar sesion con Google.';
  }
}
