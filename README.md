# Adaptador GeoPlanta

Servicio intermedio entre las **fuentes de ubicación** de las máquinas y el **Backend** de GeoPlanta.

Recibe las posiciones de los dispositivos GPS por TCP (protocolo binario GT06, el del Jimi LL301), las traduce a JSON y las reenvía al Backend por HTTPS. El adaptador no escribe en la base de datos. El Backend asocia cada dispositivo a su máquina, guarda el historial y publica las posiciones en tiempo real al panel web por WebSocket.

## Arquitectura

```
App móvil (hoy)  ─┐                       ┌───────────────────┐  HTTPS + API key   ┌─────────┐  WebSocket  ┌───────────┐
                  ├── TCP GT06 :5023 ───▶ │ Adaptador         │ ─────────────────▶ │ Backend │ ──────────▶ │ Panel web │
GPS LL301 (luego) ┘                       │ (cola + reintento)│ POST /tracking/... └────┬────┘  /tracking  │  /mapa    │
                                          └───────────────────┘                         ▼             └───────────┘
                                                                              PostgreSQL + PostGIS
```

| Etapa | Fuente | Protocolo | Frecuencia |
|---|---|---|---|
| Actual (provisoria) | App móvil GeoPlanta, durante un turno activo | TCP, GT06 (se hace pasar por un LL301) | Cada ~30 segundos |
| Futura | GPS Jimi IoT LL301 instalado en cada máquina | TCP, GT06 | Cada 20–30 segundos |

Mientras no lleguen los GPS, el teléfono del operador actúa como un **GPS virtual** de la máquina de su turno: habla GT06 igual que un LL301, con el IMEI `9` + id de la máquina en 14 dígitos (la máquina 12 es `900000000000012`). Cuando lleguen los LL301 se configuran apuntando a este mismo puerto y se quita el envío de la app: el adaptador y el Backend no cambian.

### Protocolo GT06

| Paquete | Código | Qué hace el adaptador |
|---|---|---|
| Login | `0x01` | Guarda el IMEI de la conexión y responde ACK |
| Heartbeat | `0x13`, `0x23` | Guarda la batería (se asocia a las posiciones siguientes) y responde ACK |
| Ubicación | `0x12`, `0x22`, `0xA0` | Si hay login y fix GPS, encola la posición para el Backend |
| Alarma | `0x16`, `0x26`, `0x27` | Responde ACK |

Las tramas con CRC inválido se descartan. Si el Backend no responde, las posiciones quedan en una cola en memoria y se reintenta con espera creciente (hasta 60 s).

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

## Variables de entorno

Para desarrollo local van en el archivo `.env` (`pnpm dev` lo carga). En producción viven en la configuración del contenedor, nunca en la imagen.

| Variable | Obligatoria | Descripción | Por defecto |
|---|---|---|---|
| `BACKEND_URL` | Sí | URL del Backend, por ejemplo `http://localhost:3000` | — |
| `ADAPTADOR_API_KEY` | Sí | Clave compartida con el Backend (su variable `ADAPTADOR_API_KEY`) | — |
| `PORT` | No | Puerto HTTP (`/health`) | `3001` |
| `TCP_PORT` | No | Puerto TCP de los dispositivos GT06 | `5023` |

## Ejecución

### Modo desarrollo

```bash
pnpm dev
```

Levanta el servidor HTTP en `http://localhost:3001` y el TCP de los dispositivos en el puerto `5023`, y se reinicia solo cada vez que guardas un archivo de `src/`. Para detenerlo, presiona `Ctrl + C`.

### Modo producción

Primero compila y luego ejecuta la versión compilada:

```bash
pnpm build
pnpm start
```

`pnpm start` no lee el archivo `.env`: las variables se pasan en el entorno:

```bash
BACKEND_URL=https://mi-backend ADAPTADOR_API_KEY=... pnpm start
```

### Verificar que está funcionando

Con el servidor corriendo, en otra terminal:

```bash
curl http://localhost:3001/health
```

Debe responder (`posicionesEnCola` son las que esperan al Backend; si crece y no baja, el Backend no está recibiendo):

```json
{ "status": "ok", "posicionesEnCola": 0 }
```

### Simular un dispositivo

Para probar el flujo completo sin teléfono ni LL301, con el adaptador y el Backend corriendo:

```bash
pnpm simular [idMaquina] [intervaloSegundos] [host] [puerto]
pnpm simular 3 10            # máquina 3, una posición cada 10 s, a localhost:5023
```

Hace login con el IMEI virtual de la máquina y la mueve en círculo por Mina Los Colorados. La máquina aparece moviéndose en el mapa del panel web. Requiere que la máquina tenga su GPS virtual en la base de datos (migración `010_tracking_gps.sql` del Backend).

### Antes de hacer commit

```bash
pnpm lint && pnpm typecheck && pnpm test
```

## Despliegue en Azure

El adaptador corre en una **máquina virtual** y no en Container Apps como el Backend: los dispositivos necesitan un puerto TCP público fijo, y el entorno Express de Container Apps solo acepta HTTP.

| Recurso | Valor |
|---|---|
| VM | `cmp-adaptador-vm` (grupo `CMP_Capstone`, Chile Central), Ubuntu 24.04, tamaño `Standard_B2ats_v2` |
| Dirección | `cmp-adaptador.chilecentral.cloudapp.azure.com` (IP pública estática) |
| Puertos abiertos | `5023/TCP` (dispositivos GT06) y `22` (SSH, solo desde tu IP). `/health` (3001) queda solo dentro de la VM |
| Imagen | `cmpcapstoneacr.azurecr.io/cmp-adaptador:<versión>` |
| Variables | `/etc/cmp-adaptador.env` en la VM (permisos 600) |
| Contenedor | `adaptador`, con `--restart unless-stopped` (vuelve solo si la VM se reinicia) |

### Despliegue automático (CI/CD)

Al mergear un PR a `main`, el job **Desplegar en Azure** de `.github/workflows/ci.yml` vuelve a pasar calidad y seguridad, construye la imagen (`cmp-adaptador:<sha del commit>` y `latest`), la sube al ACR y reemplaza el contenedor en la VM con `az vm run-command` (sin SSH), usando `scripts/actualizar-vm.sh`. Si el contenedor nuevo no responde `/health`, ese script vuelve a levantar la imagen anterior y el job falla.

Se autentica en Azure por OIDC, sin contraseñas guardadas:

| Dónde | Qué |
|---|---|
| Entra ID | App registration con federated credential, subject `repo:atuning120@90119017/CMP_adaptadorTCP@1428338524:environment:produccion`, rol Contributor sobre `CMP_Capstone` |
| GitHub | Environment `produccion` (solo `main`) y variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` |

### Despliegue manual (respaldo)

Si el pipeline no está disponible, desde tu PC con `az login` hecho:

```bash
./scripts/deploy-azure.sh v2
```

Hace lo mismo que el pipeline, con la versión que le indiques como tag.

Ver los logs en la VM:

```bash
ssh -i <clave.pem> azureuser@cmp-adaptador.chilecentral.cloudapp.azure.com
sudo docker logs -f adaptador
```

Probar desde tu PC sin teléfono:

```bash
pnpm simular 3 10 cmp-adaptador.chilecentral.cloudapp.azure.com 5023
```

El puerto 5023 no tiene autenticación, igual que con un GPS real: cualquiera que conozca un IMEI registrado podría enviar posiciones falsas. Para el piloto se acepta. Si llega a ser un problema, se puede limitar el puerto a las IP del operador móvil.

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
| `pnpm simular` | Simula un dispositivo GT06 (ver arriba) |
| `./scripts/deploy-azure.sh vN` | Publica la versión en la VM de Azure a mano (el camino normal es el merge a `main`) |

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/health` | Estado del servicio y posiciones en cola |
| TCP | `:5023` | Dispositivos GT06 (LL301 o la app móvil) |

## Estructura

```
src/
├── app.ts                    # App Express (/health) sin levantar el servidor (la usan los tests)
├── config.ts                 # Lee las variables de entorno
├── main.ts                   # Punto de entrada: levanta el servidor HTTP y el TCP
├── gt06/
│   ├── crc.ts                # CRC-ITU de las tramas
│   ├── protocolo.ts          # Separa y decodifica tramas, arma los ACK
│   └── codificador.ts        # Arma tramas como un dispositivo (simulador y tests)
├── tcp/
│   └── servidorGt06.ts       # Servidor TCP: login, heartbeat y ubicaciones por conexión
└── backend/
    ├── posicion.ts           # Contrato con el Backend (POST /tracking/posiciones)
    └── colaPosiciones.ts     # Cola en memoria, envío en lotes y reintentos
scripts/
└── simular-dispositivo.ts    # pnpm simular
```

Los tests van junto al código, con el sufijo `*.test.ts`.

## Proyectos relacionados

- **Backend**: API NestJS. Recibe las posiciones en `POST /tracking/posiciones` (cabecera `X-Api-Key`), las guarda en `TRACKING_HISTORY` y las publica por WebSocket (Socket.IO, namespace `/tracking`).
- **Front-mobile**: App Expo que, en la etapa actual, envía la ubicación del teléfono por GT06 cada 30 segundos durante el turno.
- **Frontend**: Panel web que muestra la flota en el mapa (`/mapa`) y la mueve en tiempo real.
