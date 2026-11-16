import type { PosicionGps } from './posicion.js';

export interface OpcionesCola {
  backendUrl: string;
  apiKey: string;
  // Inyectable para los tests
  fetch?: typeof fetch;
  tamanoLote?: number;
  maximoEnCola?: number;
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
  ahora?: () => Date;
}

// Para el diagnóstico de /health. Los contadores son desde que partió el proceso
export interface EstadoCola {
  posicionesEnCola: number;
  enviadas: number;
  // Rechazadas por el Backend (4xx: no se reintentan) o sacadas por cola llena
  descartadas: number;
  ultimoEnvioOk: string | null; // ISO
  ultimoError: { fecha: string; detalle: string } | null;
  // Esperando para reintentar: el Backend no responde
  reintentando: boolean;
}

const LARGO_MAXIMO_DETALLE = 300;

// Con mínimo 0 réplicas en Azure el primer request despierta al Backend y puede tardar varios segundos
const TIMEOUT_MS = 30_000;
const ESPERA_INICIAL_MS = 2_000;
const ESPERA_MAXIMA_MS = 60_000;

/**
 * Cola en memoria de posiciones hacia el Backend. Envía en lotes; si el Backend no responde o falla (5xx),
 * conserva las posiciones y reintenta con espera creciente. Un 4xx (lote inválido o API key incorrecta)
 * no se arregla reintentando: el lote se descarta y queda en el log.
 */
export class ColaPosiciones {
  private readonly pendientes: PosicionGps[] = [];
  private envioEnCurso: Promise<void> | null = null;
  private espera = ESPERA_INICIAL_MS;
  private temporizador: NodeJS.Timeout | null = null;
  private readonly fetch: typeof fetch;
  private readonly tamanoLote: number;
  private readonly maximoEnCola: number;
  private readonly log: Pick<Console, 'info' | 'warn' | 'error'>;
  private readonly ahora: () => Date;
  private enviadas = 0;
  private descartadas = 0;
  private ultimoEnvioOk: Date | null = null;
  private ultimoError: { fecha: Date; detalle: string } | null = null;

  constructor(private readonly opciones: OpcionesCola) {
    this.fetch = opciones.fetch ?? fetch;
    this.tamanoLote = opciones.tamanoLote ?? 100;
    this.maximoEnCola = opciones.maximoEnCola ?? 10_000;
    this.log = opciones.log ?? console;
    this.ahora = opciones.ahora ?? (() => new Date());
  }

  get cantidad() {
    return this.pendientes.length;
  }

  estado(): EstadoCola {
    return {
      posicionesEnCola: this.pendientes.length,
      enviadas: this.enviadas,
      descartadas: this.descartadas,
      ultimoEnvioOk: this.ultimoEnvioOk?.toISOString() ?? null,
      ultimoError: this.ultimoError ? { fecha: this.ultimoError.fecha.toISOString(), detalle: this.ultimoError.detalle } : null,
      reintentando: this.temporizador !== null,
    };
  }

  private registrarError(detalle: string) {
    this.ultimoError = { fecha: this.ahora(), detalle: detalle.slice(0, LARGO_MAXIMO_DETALLE) };
  }

  encolar(posicion: PosicionGps) {
    this.pendientes.push(posicion);
    if (this.pendientes.length > this.maximoEnCola) {
      this.pendientes.shift();
      this.descartadas += 1;
      this.log.warn('Cola llena: se descartó la posición más antigua');
    }
    if (!this.temporizador) void this.enviar();
  }

  // Envía todo lo pendiente; resuelve cuando la cola queda vacía o el Backend falla. Un solo envío a la vez:
  // quien llama mientras hay uno en curso espera ese mismo
  enviar(): Promise<void> {
    this.envioEnCurso ??= this.vaciar().finally(() => {
      this.envioEnCurso = null;
    });
    return this.envioEnCurso;
  }

  private async vaciar() {
    while (this.pendientes.length > 0) {
      const lote = this.pendientes.slice(0, this.tamanoLote);
      const resultado = await this.enviarLote(lote);
      if (resultado === 'reintentar') {
        this.programarReintento();
        return;
      }
      if (resultado === 'ok') {
        this.enviadas += lote.length;
        this.ultimoEnvioOk = this.ahora();
      } else {
        this.descartadas += lote.length;
      }
      // Por identidad y no por posición: si la cola se llenó mientras tanto, pudo descartar alguna del lote
      const enviadas = new Set(lote);
      const restantes = this.pendientes.filter((p) => !enviadas.has(p));
      this.pendientes.splice(0, this.pendientes.length, ...restantes);
      this.espera = ESPERA_INICIAL_MS;
    }
  }

  detener() {
    if (this.temporizador) clearTimeout(this.temporizador);
    this.temporizador = null;
  }

  private programarReintento() {
    this.log.warn(`Backend no disponible: ${this.pendientes.length} posiciones en cola, reintento en ${this.espera / 1000} s`);
    this.temporizador = setTimeout(() => {
      this.temporizador = null;
      void this.enviar();
    }, this.espera);
    this.espera = Math.min(this.espera * 2, ESPERA_MAXIMA_MS);
  }

  private async enviarLote(lote: PosicionGps[]): Promise<'ok' | 'descartar' | 'reintentar'> {
    let respuesta: Response;
    try {
      respuesta = await this.fetch(`${this.opciones.backendUrl}/tracking/posiciones`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': this.opciones.apiKey },
        body: JSON.stringify({ posiciones: lote }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      this.log.warn(`No se pudo conectar con el Backend: ${(error as Error).message}`);
      this.registrarError(`Sin conexión con el Backend: ${(error as Error).message}`);
      return 'reintentar';
    }
    if (respuesta.ok) return 'ok';
    if (respuesta.status >= 500 || respuesta.status === 408 || respuesta.status === 429) {
      this.registrarError(`El Backend respondió ${respuesta.status}`);
      return 'reintentar';
    }
    const detalle = await respuesta.text().catch(() => '');
    this.log.error(`El Backend rechazó ${lote.length} posiciones (${respuesta.status}): ${detalle}`);
    this.registrarError(`El Backend rechazó ${lote.length} posiciones (${respuesta.status}): ${detalle}`);
    return 'descartar';
  }
}
