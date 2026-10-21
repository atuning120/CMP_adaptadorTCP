# Adaptador GeoPlanta

Servicio intermedio entre las **fuentes de ubicación** de las máquinas y el **Backend** de GeoPlanta.

Recibe posiciones en el formato de cada fuente, las traduce a un formato único y las reenvía al Backend por HTTPS. El adaptador no escribe en la base de datos. El Backend se encarga de asociar cada dispositivo a su máquina, guardar el historial, revisar geocercas y generar alertas.

## Arquitectura

```
Etapa actual:  App móvil ──HTTPS JSON──▶ ┌────────────┐
                                        │ Adaptador  │ ──HTTPS──▶ Backend ──▶ PostgreSQL + PostGIS
Etapa futura:  GPS LL301 ──TCP GT06────▶ └────────────┘
```

| Etapa | Fuente | Protocolo | Frecuencia |
|---|---|---|---|
| Actual (provisoria) | App móvil GeoPlanta, durante un turno activo | HTTPS + JSON | Cada ~2 minutos |
| Futura | GPS Jimi IoT LL301 instalado en cada máquina | TCP, protocolo binario GT06 (puerto 5023) | Cada 20–30 segundos |

Mientras no lleguen los GPS, el teléfono del operador actúa como un **GPS virtual** de la máquina que tiene en su turno, con el identificador `APP-<id_maquina>`. Cuando lleguen los LL301 solo cambia este proyecto: se agrega la entrada TCP y se retira la entrada de la app. El contrato con el Backend sigue igual.

## Stack

- [Node.js](https://nodejs.org/) 24 o superior
- [Express](https://expressjs.com/) 5
- [TypeScript](https://www.typescriptlang.org/) (ESM)
- [Vitest](https://vitest.dev/) + [supertest](https://github.com/ladjs/supertest) para tests
- [oxlint](https://oxc.rs/docs/guide/usage/linter) para lint
- [pnpm](https://pnpm.io/) como gestor de paquetes (no usar npm)

## Requisitos

- Node.js 24 o superior
- pnpm 11 o superior

## Instalación

```bash
pnpm install
```

## Ejecución

### Modo desarrollo

```bash
pnpm dev
```

El servidor queda en `http://localhost:3001` (o en el puerto definido en `PORT`) y se reinicia solo cada vez que guardas un archivo de `src/`. Para detenerlo, presiona `Ctrl + C`.

### Modo producción

Primero compila y luego ejecuta la versión compilada:

```bash
pnpm build
pnpm start
```

`pnpm start` no lee el archivo `.env`. Si necesitas otro puerto, pásalo como variable de entorno:

```bash
PORT=8080 pnpm start
```

### Verificar que está funcionando

Con el servidor corriendo, en otra terminal:

```bash
curl http://localhost:3001/health
```

Debe responder:

```json
{ "status": "ok" }
```

También puedes abrir `http://localhost:3001/health` en el navegador.

### Antes de hacer commit

```bash
pnpm lint && pnpm typecheck && pnpm test
```

## Scripts

| Comando | Descripción |
|---|---|
| `pnpm dev` | Inicia el servidor en modo desarrollo y lo reinicia al guardar cambios |
| `pnpm build` | Compila TypeScript a `dist/` |
| `pnpm start` | Ejecuta la versión compilada (`dist/main.js`) |
| `pnpm lint` | Revisa el código con oxlint |
| `pnpm typecheck` | Verifica los tipos sin compilar |
| `pnpm test` | Ejecuta los tests una vez |
| `pnpm test:watch` | Ejecuta los tests en modo watch |

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/health` | Estado del servicio. Responde `{ "status": "ok" }` |

## Estructura

```
src/
├── app.ts        # Crea la app Express sin levantar el servidor (la usan los tests)
├── app.test.ts   # Tests del endpoint /health
├── config.ts     # Lee las variables de entorno
└── main.ts       # Punto de entrada: levanta el servidor HTTP
```

Los tests van junto al código, con el sufijo `*.test.ts`.

## Proyectos relacionados

- **Backend**: API NestJS que recibe las posiciones del adaptador y las guarda en `TRACKING_HISTORY`.
- **Front-mobile**: App Expo que, en la etapa actual, envía la ubicación del operador durante su turno.
- **Frontend**: Panel web que muestra la ubicación de la flota en el mapa.
