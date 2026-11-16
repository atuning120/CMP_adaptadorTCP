/*
 * Últimos dispositivos vistos por el adaptador, por IMEI, para el diagnóstico de /health (solo en memoria, se pierde
 * al reiniciar). La app móvil abre una conexión por cada lote y la cierra, así que "conectados ahora" casi siempre
 * estaría vacío: lo útil es cuándo se supo por última vez de cada máquina. IMEI virtual de la app = '9' + id_maquina.
 * No guarda la IP de origen.
 */

export interface DispositivoVisto {
  imei: string;
  ultimaConexion: string; // ISO: último login
  ultimaUbicacion: string | null; // ISO: cuándo llegó (no la hora GPS de la posición)
  ubicaciones: number; // recibidas desde que partió el adaptador
  bateria: number | null; // % del último heartbeat
  conectado: boolean;
}

// Un LL301 por máquina: nunca deberían ser tantos. Es un tope contra clientes que inventen IMEI
const MAXIMO_DISPOSITIVOS = 1000;

export class DispositivosVistos {
  private readonly porImei = new Map<string, DispositivoVisto>();
  private readonly conexionesAbiertas = new Map<string, number>();

  constructor(private readonly ahora: () => Date = () => new Date()) {}

  login(imei: string) {
    const visto = this.porImei.get(imei);
    if (!visto && this.porImei.size >= MAXIMO_DISPOSITIVOS) {
      // Se olvida el que lleva más tiempo sin conectarse
      const masAntiguo = [...this.porImei.values()].sort((a, b) => a.ultimaConexion.localeCompare(b.ultimaConexion))[0];
      this.porImei.delete(masAntiguo.imei);
    }
    this.porImei.set(imei, {
      imei,
      ultimaConexion: this.ahora().toISOString(),
      ultimaUbicacion: visto?.ultimaUbicacion ?? null,
      ubicaciones: visto?.ubicaciones ?? 0,
      bateria: visto?.bateria ?? null,
      conectado: true,
    });
    this.conexionesAbiertas.set(imei, (this.conexionesAbiertas.get(imei) ?? 0) + 1);
  }

  ubicacion(imei: string, bateria: number | null) {
    const visto = this.porImei.get(imei);
    if (!visto) return;
    visto.ultimaUbicacion = this.ahora().toISOString();
    visto.ubicaciones += 1;
    if (bateria !== null) visto.bateria = bateria;
  }

  desconexion(imei: string) {
    const abiertas = (this.conexionesAbiertas.get(imei) ?? 1) - 1;
    if (abiertas > 0) {
      this.conexionesAbiertas.set(imei, abiertas);
      return;
    }
    this.conexionesAbiertas.delete(imei);
    const visto = this.porImei.get(imei);
    if (visto) visto.conectado = false;
  }

  // El que se vio más recientemente primero
  lista(): DispositivoVisto[] {
    return [...this.porImei.values()].map((d) => ({ ...d })).sort((a, b) => b.ultimaConexion.localeCompare(a.ultimaConexion));
  }
}
