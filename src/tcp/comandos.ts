/*
 * Comandos en línea (0x80) para los GPS: el mismo texto que por SMS ('MODE,1,30,1,1,1#'), pero por la conexión TCP
 * que el equipo ya tiene con el adaptador, sin gastar SMS. Solo en memoria: un reinicio del adaptador pierde la
 * cola y el historial.
 *
 * Entrega: un equipo puede tener varias conexiones abiertas (abre una nueva sin cerrar la anterior, que muere a los
 * 10 min de inactividad), y escribir en una conexión muerta pierde el comando sin error. Por eso se envía por la
 * conexión que mandó la última trama, y solo si fue hace poco; si no, el comando espera la próxima trama del equipo
 * (el LL301 manda heartbeat cada ~5 min).
 */

export type EstadoComando = 'en cola' | 'enviado' | 'respondido' | 'sin respuesta' | 'expirado';

export interface Comando {
  // También es la "bandera del servidor" del 0x80, que el equipo devuelve en su respuesta
  id: number;
  imei: string;
  texto: string;
  estado: EstadoComando;
  creado: string; // ISO
  enviado: string | null;
  respondido: string | null;
  respuesta: string | null;
}

export type EnviarComando = (texto: string, bandera: number) => void;

// Una conexión que mandó una trama hace menos de esto se da por viva: el comando sale al tiro
const RECIENTE_MS = 60 * 1000;
// Enviado y sin respuesta en este tiempo: probablemente se perdió (se puede volver a mandar)
const SIN_RESPUESTA_MS = 5 * 60 * 1000;
// En cola sin que el equipo aparezca en este tiempo: ya no se envía
const EXPIRA_MS = 24 * 60 * 60 * 1000;
// Historial que se guarda (los más antiguos ya cerrados se olvidan)
const MAXIMO_HISTORIAL = 200;

export class Comandos {
  private readonly historial: Comando[] = [];
  private readonly conexiones = new Map<string, { enviar: EnviarComando; ultimaTrama: number }>();
  private readonly esperando = new Map<number, Array<(comando: Comando) => void>>();
  private siguienteId = 1;

  constructor(private readonly ahora: () => Date = () => new Date()) {}

  encolar(imei: string, texto: string): Comando {
    const comando: Comando = {
      id: this.siguienteId++,
      imei,
      texto,
      estado: 'en cola',
      creado: this.ahora().toISOString(),
      enviado: null,
      respondido: null,
      respuesta: null,
    };
    this.historial.push(comando);
    this.recortar();
    const conexion = this.conexiones.get(imei);
    if (conexion && this.ahora().getTime() - conexion.ultimaTrama < RECIENTE_MS) this.despachar(imei);
    return { ...comando };
  }

  // El equipo mandó una trama por esta conexión: está viva, se le entregan los comandos pendientes
  actividad(imei: string, enviar: EnviarComando) {
    this.conexiones.set(imei, { enviar, ultimaTrama: this.ahora().getTime() });
    this.despachar(imei);
  }

  // Se cerró una conexión: si era la que se usaba para ese equipo, se olvida
  cierre(imei: string, enviar: EnviarComando) {
    if (this.conexiones.get(imei)?.enviar === enviar) this.conexiones.delete(imei);
  }

  // Respuesta 0x21 del equipo. Devuelve el comando al que responde, o null si no se reconoce la bandera
  respuesta(imei: string, bandera: number, texto: string): Comando | null {
    const comando = this.historial.find(
      (c) => c.id === bandera && c.imei === imei && (c.estado === 'enviado' || c.estado === 'sin respuesta'),
    );
    if (!comando) return null;
    comando.estado = 'respondido';
    comando.respondido = this.ahora().toISOString();
    comando.respuesta = texto;
    for (const resolver of this.esperando.get(comando.id) ?? []) resolver({ ...comando });
    this.esperando.delete(comando.id);
    return { ...comando };
  }

  obtener(id: number): Comando | undefined {
    this.actualizarEstados();
    const comando = this.historial.find((c) => c.id === id);
    return comando ? { ...comando } : undefined;
  }

  // El más reciente primero
  lista(imei?: string): Comando[] {
    this.actualizarEstados();
    return this.historial
      .filter((c) => !imei || c.imei === imei)
      .map((c) => ({ ...c }))
      .reverse();
  }

  // Espera la respuesta hasta `ms`; devuelve el comando como esté en ese momento
  async esperarRespuesta(id: number, ms: number): Promise<Comando | undefined> {
    const actual = this.obtener(id);
    if (!actual || actual.estado === 'respondido' || ms <= 0) return actual;
    return new Promise((resolve) => {
      let listo = false;
      const resolver = (comando: Comando) => {
        if (listo) return;
        listo = true;
        clearTimeout(temporizador);
        resolve(comando);
      };
      const temporizador = setTimeout(() => {
        if (listo) return;
        listo = true;
        const pendientes = (this.esperando.get(id) ?? []).filter((r) => r !== resolver);
        if (pendientes.length > 0) this.esperando.set(id, pendientes);
        else this.esperando.delete(id);
        resolve(this.obtener(id));
      }, ms);
      this.esperando.set(id, [...(this.esperando.get(id) ?? []), resolver]);
    });
  }

  private despachar(imei: string) {
    const conexion = this.conexiones.get(imei);
    if (!conexion) return;
    this.actualizarEstados();
    for (const comando of this.historial) {
      if (comando.imei !== imei || comando.estado !== 'en cola') continue;
      conexion.enviar(comando.texto, comando.id);
      comando.estado = 'enviado';
      comando.enviado = this.ahora().toISOString();
    }
  }

  private actualizarEstados() {
    const ahora = this.ahora().getTime();
    for (const comando of this.historial) {
      if (comando.estado === 'en cola' && ahora - Date.parse(comando.creado) > EXPIRA_MS) comando.estado = 'expirado';
      if (comando.estado === 'enviado' && comando.enviado && ahora - Date.parse(comando.enviado) > SIN_RESPUESTA_MS) {
        comando.estado = 'sin respuesta';
      }
    }
  }

  // Sobre el máximo se olvidan los más antiguos que ya no están en cola
  private recortar() {
    while (this.historial.length > MAXIMO_HISTORIAL) {
      const indice = this.historial.findIndex((c) => c.estado !== 'en cola');
      if (indice === -1) return;
      this.historial.splice(indice, 1);
    }
  }
}
