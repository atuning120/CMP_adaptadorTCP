# Adaptador

Express 5 · TypeScript (ESM, `nodenext`) · Vitest + supertest · oxlint · pnpm (never npm)

Gateway between location sources and the Backend: it receives positions, normalizes them to one contract and forwards them to the Backend over HTTPS. It never writes to the database; the Backend resolves IMEI → machine (`ASIGNACION_GPS`), geofences and alerts.

- Interim source: the mobile app (Front-mobile) posts its location every ~2 min during an active shift, as a virtual GPS `imei = 'APP-<id_maquina>'`.
- Future source: Jimi LL301 trackers over raw TCP, GT06 protocol (port 5023). Use Node's `net` module, not NestJS/Express transports; every login/heartbeat/position packet needs an ACK.
- When the LL301 arrive, only this project changes: add the TCP input and drop the app input. The contract towards the Backend stays the same.

## Code

- `src/app.ts`: `createApp()` builds the Express app without listening (tests use it with supertest); `src/main.ts` starts the server; `src/config.ts` reads env vars.
- ESM imports need the `.js` extension (`import { x } from './x.js'`).
- Tests live next to the code as `*.test.ts`.
- Before finishing: `pnpm lint`, `pnpm typecheck` and `pnpm test`.
- Local env vars go in `.env` (loaded by `pnpm dev`); in Azure they live in the Container App, never in the image.

## graphify

- Find code with `graphify query "<q>"`, `graphify explain "<X>"` or `graphify path "<A>" "<B>"`; read `graphify-out/GRAPH_REPORT.md` only for an architecture overview.
- After code changes: `graphify update .`

# Claude Code Configuration

Responde siempre en español. Mantén en inglés (sin traducir) todos los términos técnicos, nombres de herramientas, tecnologías y librerías: API, REST, database, backend, framework, Git, Docker, Linux, Node.js, Python, JavaScript, JSON, etc.
