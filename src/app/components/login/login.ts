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

  protected async login(): Promise<void> {
    this.error.set('');
    this.isSubmitting.set(true);

    try {
      await this.auth.loginWithGoogle();
      await this.router.navigateByUrl('/mapa');
    } catch {
      this.error.set('No se pudo iniciar sesion con Google.');
    } finally {
      this.isSubmitting.set(false);
    }
  }
}
