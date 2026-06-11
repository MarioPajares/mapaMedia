# MapaMedia

MapaMedia es una aplicacion web y Android para visualizar el recorrido de una media maraton, consultar marcas de distancia y compartir la ubicacion GPS en tiempo real durante la carrera.

La aplicacion esta pensada para mostrar el circuito sobre un mapa, cargar recorridos GPX, gestionar carreras guardadas en un backend configurable y permitir que un usuario autenticado emita su posicion para que se vea en el mapa.

## Funcionamiento

La pantalla principal es `/mapa`. Desde ahi se carga el mapa con Leaflet, se dibuja el recorrido de la carrera y se muestran puntos de referencia como la salida, las marcas por kilometros y el perfil de elevacion cuando el GPX contiene altitud.

Los usuarios pueden iniciar sesion con Google mediante un proveedor de autenticacion configurable. Una vez autenticados, pueden acceder a las funciones protegidas, como compartir ubicacion GPS o gestionar configuraciones de carrera. La ubicacion se guarda en el backend en dos sitios: la ultima posicion activa del usuario y el historico de muestras GPS.

En navegador, la ubicacion se obtiene con la API `navigator.geolocation`. En Android, la app usa Capacitor y el plugin de geolocalizacion en segundo plano para poder seguir compartiendo ubicacion aunque el movil este bloqueado. Tambien solicita permisos de notificaciones locales para mantener el servicio activo correctamente.

La ruta `/ubicacion` permite probar la deteccion de ubicacion del dispositivo y mostrarla sobre un mapa con un circulo de precision.

## Tecnologias usadas

- Angular 21 para la interfaz, rutas, componentes standalone y signals.
- TypeScript 5.9 para el codigo de la aplicacion.
- Leaflet 1.9 para renderizar mapas, recorridos GPX, marcadores y capas.
- Backend externo configurable para autenticacion con Google y persistencia de datos.
- Capacitor 8 para empaquetar la aplicacion web como app Android.
- `@capacitor-community/background-geolocation` para GPS en segundo plano en Android.
- `@capacitor/local-notifications` para permisos y avisos necesarios mientras el GPS esta activo.
- Vitest 4 y Angular CLI para pruebas y tooling de desarrollo.

## Versiones compatibles

El proyecto esta configurado para funcionar con estas versiones:

- Node.js `>=20.19.0` o `>=22.12.0`.
- Version recomendada del proyecto: Node.js `22.19.0`, indicada en `.nvmrc`.
- npm `>=10.0.0`. El `packageManager` del proyecto indica npm `11.11.0`.
- Angular CLI `21.2.8`.
- Angular `21.2.x`.
- Capacitor `8.3.x`.
- Android `minSdkVersion 24`.
- Android `compileSdkVersion 36`.
- Android `targetSdkVersion 36`.

Para usar la version recomendada de Node:

```bash
nvm use
```

## Configuracion local

Este repositorio no incluye credenciales, secretos ni configuraciones personales de despliegue.

Antes de ejecutar la aplicacion, crea tus archivos locales de configuracion a partir de los ejemplos:

```bash
cp src/environments/environment.example.ts src/environments/environment.ts
cp android/app/google-services.example.json android/app/google-services.json
cp firebase.example.json firebase.json
cp firestore.rules.example firestore.rules
cp netlify.toml.example netlify.toml
```

Despues, rellena tus variables de backend web en `src/environments/environment.ts`, tu configuracion Android en `android/app/google-services.json` y, si vas a desplegar, ajusta `firebase.json`, `firestore.rules` y `netlify.toml` segun tu proyecto.

Los archivos reales de configuracion estan ignorados por Git para que cada persona use sus propias variables sin subirlas al repositorio. Si no se rellenan, la aplicacion puede abrir el mapa, pero las funciones de login, carreras guardadas y GPS compartido quedan desactivadas hasta configurar el backend.

## Backend con Firebase

La app usa Firebase como backend configurable para:

- Login con Google.
- Guardar carreras en Firestore.
- Marcar una carrera activa.
- Guardar la ultima ubicacion GPS compartida.
- Guardar muestras historicas de posicion GPS del usuario.

Para configurarlo en un proyecto nuevo:

1. Crea un proyecto en Firebase Console.
2. Activa Authentication con el proveedor Google.
3. Activa Cloud Firestore.
4. Crea una app web y copia sus datos en `src/environments/environment.ts`.
5. Autoriza los dominios desde Authentication: al menos `localhost` para desarrollo y el dominio real si despliegas la web.
6. Si vas a usar Android, crea una app Android con el package name `com.mapamedia.app`, descarga `google-services.json` y guardalo en `android/app/google-services.json`.
7. Copia `firestore.rules.example` a `firestore.rules` y revisa las reglas antes de desplegarlas.

El archivo `src/environments/environment.ts` debe quedar con este formato:

```ts
export const environment = {
  firebase: {
    apiKey: 'TU_API_KEY',
    authDomain: 'TU_PROYECTO.firebaseapp.com',
    projectId: 'TU_PROJECT_ID',
    storageBucket: 'TU_PROYECTO.appspot.com',
    messagingSenderId: 'TU_MESSAGING_SENDER_ID',
    appId: 'TU_APP_ID',
    measurementId: 'TU_MEASUREMENT_ID',
  },
};
```

Para desplegar las reglas de Firestore, instala y configura Firebase CLI con tu proyecto y ejecuta:

```bash
firebase login
firebase use TU_PROJECT_ID
firebase deploy --only firestore:rules
```

## Instalacion

Instala las dependencias con:

```bash
npm install
```

## Desarrollo web

Para arrancar el servidor local:

```bash
npm start
```

Cuando el servidor este activo, abre:

```text
http://localhost:4200/
```

La aplicacion se recargara automaticamente al modificar los archivos fuente.

## Compilacion

Para generar la version de produccion:

```bash
npm run build
```

Los archivos compilados se guardan en `dist/mapa-media/browser`, que es tambien el directorio usado por Capacitor segun `capacitor.config.ts`.

## Despliegue web en Netlify

El repositorio incluye `netlify.toml.example` como plantilla. Para usar Netlify, crea tu archivo local:

```bash
cp netlify.toml.example netlify.toml
```

La plantilla usa:

- Comando de build: `npm run build`.
- Carpeta publicada: `dist/mapa-media/browser`.
- Node.js `22.19.0`.
- Redireccion SPA a `/index.html` para que funcionen rutas como `/mapa`, `/login` o `/ubicacion` al recargar.

Como `src/environments/environment.ts` no se sube al repositorio, el despliegue tambien debe disponer de esas variables. Puedes hacerlo generando ese archivo durante el build de Netlify o manteniendo una configuracion equivalente en tu propio flujo de despliegue.

Tras publicar, anade el dominio de Netlify a los dominios autorizados del proveedor de autenticacion de Firebase.

## Android

Para sincronizar los cambios web con el proyecto Android:

```bash
npm run cap:sync
```

Para abrir el proyecto nativo en Android Studio:

```bash
npm run cap:open
```

Para compilar e instalar la aplicacion directamente en un dispositivo Android conectado o emulador, usa el comando definido en `package.json`:

```bash
npm run android:install
```

Ese script cambia a Node.js `22.19.0`, compila la aplicacion web, sincroniza Capacitor con Android, genera el APK debug con Gradle e instala la app con `installDebug`.

## Pruebas

Para ejecutar las pruebas:

```bash
npm test
```

## Scripts principales

- `npm start`: arranca Angular en modo desarrollo.
- `npm run build`: compila la aplicacion.
- `npm run cap:sync`: compila y sincroniza el proyecto Android con Capacitor.
- `npm run cap:copy`: compila y copia los assets web a Android.
- `npm run cap:open`: abre Android Studio.
- `npm run android:install`: compila e instala la app Android en un dispositivo o emulador.
- `npm test`: ejecuta las pruebas.
