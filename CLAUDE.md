# Adaptador

Express 5 · TypeScript (ESM, `nodenext`) · Vitest + supertest · oxlint · pnpm (never npm)

Gateway between GPS devices and the Backend: a raw TCP server (Node `net`, port 5023) speaks the binary GT06 protocol, and a queue forwards positions in batches to the Backend (`POST /tracking/posiciones`, header `X-Api-Key`). It never writes to the database; the Backend resolves IMEI → machine (`ASIGNACION_GPS`) and pushes positions to the web panel over Socket.IO.

- Sources: today the mobile app (Front-mobile `src/services/gt06.ts`) impersonates an LL301 every ~30 s during a shift with virtual IMEI `'9' + id_maquina` padded to 15 digits; later the real Jimi LL301 trackers connect to the same port. Nothing here changes when they arrive.
- GT06 ACKs: login, heartbeat and alarms get one (`ack()`); locations don't; `0x8A` gets the UTC time (`respuestaHora()`). Alarm packets (`0x16`, `0x26`, `0x27`, `0xA4`) are forwarded as positions; the LL301 uses `0xA0` + `0xA4`, and its alarms jump ahead of queued positions (arrive out of order). Battery comes from the last heartbeat of the connection (`0x23` estimates it from the voltage).
- Frame log (`src/tcp/registroTramas.ts`, env `LOG_TRAMAS`: `reales` default, `todas`, `no`): RX/TX lines in hex with the IMEI, plus a `Desconexión` line saying who closed the socket (device, 10 min idle timeout, error). Virtual app IMEIs (`9000…`) are skipped in `reales`.
- `src/gt06/codificador.ts` must stay in sync with Front-mobile's `src/services/gt06.ts`. `pnpm simular` drives a fake device for end-to-end tests.
- Env vars: `BACKEND_URL`, `ADAPTADOR_API_KEY` (required), `PORT`, `TCP_PORT`, `LOG_TRAMAS`.

## Code

- `/health` always answers 200 while the process lives (`actualizar-vm.sh` rolls back on failure, and a down Backend must not trigger that); its body is the diagnosis: `cola` (`ColaPosiciones.estado()`: queued, sent, discarded, last OK send, last error, retrying) and `dispositivos` (`DispositivosVistos`: last seen per IMEI; the app opens one connection per batch, so "connected now" is useless). HTTP listens only on the VM's 127.0.0.1: read it with `az vm run-command invoke ... --scripts 'curl -s http://127.0.0.1:3001/health'`. No source IPs stored.
- `src/app.ts`: `createApp()` builds the Express app (`/health`) without listening; `src/main.ts` starts HTTP + TCP; `src/config.ts` reads env vars (`leerConfig()`, only called from main).
- `src/gt06/` protocol (framing, CRC, decode, ACK), `src/tcp/` connection handling, `src/backend/` contract + queue.
- ESM imports need the `.js` extension (`import { x } from './x.js'`).
- Tests live next to the code as `*.test.ts`.
- Before finishing: `pnpm lint`, `pnpm typecheck` and `pnpm test`.
- Local env vars go in `.env` (loaded by `pnpm dev`); in Azure they live in `/etc/cmp-adaptador.env` on the VM, never in the image.
- Deploy: merging to `main` runs the `desplegar` job in `.github/workflows/ci.yml` (OIDC → ACR → `az vm run-command` with `scripts/actualizar-vm.sh`, which rolls back if `/health` fails). `scripts/deploy-azure.sh vN` is only a manual fallback.

## graphify

- Find code with `graphify query "<q>"`, `graphify explain "<X>"` or `graphify path "<A>" "<B>"`; read `graphify-out/GRAPH_REPORT.md` only for an architecture overview.
- After code changes: `graphify update .`

# Claude Code Configuration

Responde siempre en español. Mantén en inglés (sin traducir) todos los términos técnicos, nombres de herramientas, tecnologías y librerías: API, REST, database, backend, framework, Git, Docker, Linux, Node.js, Python, JavaScript, JSON, etc.
