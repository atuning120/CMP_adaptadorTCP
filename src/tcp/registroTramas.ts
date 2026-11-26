import type { Mensaje } from '../gt06/protocolo.js';

/*
 * Log de tramas en hex para depurar los GPS (sobre todo su primera conexión). Modos (variable LOG_TRAMAS):
 * - 'reales' (por defecto): solo los equipos reales y las tramas antes del login. La app móvil (IMEI virtual
 *   '9' + id_maquina en 14 dígitos) abre una conexión por lote y llenaría el log.
 * - 'todas': también la app móvil.
 * - 'no': nada.
 * Un equipo que reporta cada 20 s deja del orden de 1 MB de log al día (Docker rota en 3 × 10 MB).
 */
export const MODOS_LOG_TRAMAS = ['reales', 'todas', 'no'] as const;
export type ModoLogTramas = (typeof MODOS_LOG_TRAMAS)[number];

// IMEI virtual de la app: '9' + id_maquina con ceros a la izquierda. Un IMEI real nunca empieza con 9000
export const esImeiVirtual = (imei: string) => imei.startsWith('9000');

// imei null = la conexión aún no hace login (no se sabe quién es: se registra para ver qué manda)
export function registraTramas(modo: ModoLogTramas, imei: string | null): boolean {
  if (modo === 'no') return false;
  if (modo === 'todas' || imei === null) return true;
  return !esImeiVirtual(imei);
}

// Más que esto entre la hora GPS de una posición en tiempo real y la llegada: la hora del equipo está mal
// (p. ej. el comando GMT cambió la hora de las tramas, que deben venir en UTC)
export const DESFASE_SOSPECHOSO_MS = 10 * 60 * 1000;

export function duracion(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min ${s % 60} s`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

// Resumen legible de lo que trae la trama, para la misma línea del hex
export function resumir(mensaje: Mensaje, ahora: Date): string {
  switch (mensaje.tipo) {
    case 'login':
      return `IMEI ${mensaje.imei}${mensaje.zonaHoraria ? `, zona horaria ${mensaje.zonaHoraria}` : ''}`;
    case 'ubicacion': {
      const u = mensaje.ubicacion;
      const desfase = Math.round((u.fechaHora.getTime() - ahora.getTime()) / 1000);
      return [
        `${u.fechaHora.toISOString()} (desfase ${desfase} s)`,
        `${u.latitud.toFixed(6)},${u.longitud.toFixed(6)}`,
        `${u.velocidad} km/h`,
        `${u.rumbo}°`,
        `${u.satelites} sat`,
        u.posicionada ? 'con fix' : 'SIN FIX',
        ...(u.enTiempoReal ? [] : ['reenviada']),
        ...(mensaje.alarma !== undefined ? [`alarma 0x${mensaje.alarma.toString(16).padStart(2, '0')}`] : []),
      ].join(', ');
    }
    case 'heartbeat':
      return [
        `batería ${mensaje.bateria ?? '?'}%`,
        ...(mensaje.voltaje !== undefined ? [`${mensaje.voltaje.toFixed(2)} V`] : []),
        ...(mensaje.senalGsm !== undefined ? [`GSM ${mensaje.senalGsm}/4`] : []),
        ...(mensaje.cargando ? ['cargando'] : []),
      ].join(', ');
    case 'hora':
      return 'pide la hora';
    case 'respuestaComando':
      return `respuesta al comando ${mensaje.bandera}: "${mensaje.texto}"`;
    case 'otro':
      return 'no se procesa';
  }
}
