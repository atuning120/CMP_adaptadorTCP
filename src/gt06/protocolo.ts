import { crcItu } from './crc.js';

/*
 * Protocolo binario GT06 (Concox/Jimi), el que usa el LL301. Cada trama es:
 *   corta: 78 78 | largo (1 byte) | protocolo | contenido | serie (2) | CRC (2) | 0D 0A
 *   larga: 79 79 | largo (2 bytes) | protocolo | contenido | serie (2) | CRC (2) | 0D 0A
 * El largo cuenta desde el protocolo hasta el CRC inclusive, y el CRC se calcula desde el largo hasta la serie.
 */

export const PROTOCOLO = {
  LOGIN: 0x01,
  UBICACION: 0x12,
  HEARTBEAT: 0x13,
  ALARMA: 0x16,
  UBICACION_LBS: 0x22,
  HEARTBEAT_4G: 0x23,
  ALARMA_4G: 0x26,
  ALARMA_4G_EXTENDIDA: 0x27,
  UBICACION_4G: 0xa0,
} as const;

// Paquetes que el dispositivo espera ver confirmados; si no recibe el ACK, reintenta o se desconecta
const CON_ACK = new Set<number>([
  PROTOCOLO.LOGIN,
  PROTOCOLO.HEARTBEAT,
  PROTOCOLO.HEARTBEAT_4G,
  PROTOCOLO.ALARMA,
  PROTOCOLO.ALARMA_4G,
  PROTOCOLO.ALARMA_4G_EXTENDIDA,
]);

const INICIO_CORTA = 0x78;
const INICIO_LARGA = 0x79;
const FIN = [0x0d, 0x0a];

export interface Trama {
  protocolo: number;
  contenido: Buffer;
  serie: number;
  cruda: Buffer;
}

export interface Ubicacion {
  fechaHora: Date;
  latitud: number;
  longitud: number;
  velocidad: number;
  rumbo: number;
  satelites: number;
  posicionada: boolean;
  // false si es una posición guardada sin señal y reenviada después
  enTiempoReal: boolean;
}

export type Mensaje =
  | { tipo: 'login'; imei: string }
  | { tipo: 'ubicacion'; ubicacion: Ubicacion }
  | { tipo: 'heartbeat'; bateria: number | null }
  | { tipo: 'otro' };

const esInicio = (b: Buffer, i: number) =>
  (b[i] === INICIO_CORTA && b[i + 1] === INICIO_CORTA) || (b[i] === INICIO_LARGA && b[i + 1] === INICIO_LARGA);

/**
 * Separa las tramas completas que vienen en el buffer (TCP puede juntarlas o cortarlas). Devuelve lo que sobra para
 * concatenarlo con los próximos bytes. Los bytes basura antes de un inicio válido o una trama con CRC inválido
 * se descartan.
 */
export function extraerTramas(buffer: Buffer): { tramas: Trama[]; resto: Buffer; descartadas: number } {
  const tramas: Trama[] = [];
  let descartadas = 0;
  let i = 0;
  while (i + 1 < buffer.length) {
    if (!esInicio(buffer, i)) {
      i++;
      continue;
    }
    const larga = buffer[i] === INICIO_LARGA;
    const bytesLargo = larga ? 2 : 1;
    if (i + 2 + bytesLargo > buffer.length) break;
    const largo = larga ? buffer.readUInt16BE(i + 2) : buffer[i + 2];
    const total = 2 + bytesLargo + largo + 2;
    if (largo < 5) {
      i += 2;
      descartadas++;
      continue;
    }
    if (i + total > buffer.length) break;

    const cruda = buffer.subarray(i, i + total);
    const finCrc = 2 + bytesLargo + largo - 2;
    const crcEsperado = cruda.readUInt16BE(finCrc);
    const valida =
      cruda[total - 2] === FIN[0] && cruda[total - 1] === FIN[1] && crcItu(cruda.subarray(2, finCrc)) === crcEsperado;
    if (!valida) {
      i += 2;
      descartadas++;
      continue;
    }

    const inicioProtocolo = 2 + bytesLargo;
    tramas.push({
      protocolo: cruda[inicioProtocolo],
      contenido: cruda.subarray(inicioProtocolo + 1, finCrc - 2),
      serie: cruda.readUInt16BE(finCrc - 2),
      cruda: Buffer.from(cruda),
    });
    i += total;
  }
  return { tramas, resto: Buffer.from(buffer.subarray(i)), descartadas };
}

// IMEI en BCD: 8 bytes, 16 dígitos con un 0 adelante
const leerImei = (contenido: Buffer) => contenido.subarray(0, 8).toString('hex').replace(/^0/, '');

/**
 * Bloque GPS común a 0x12, 0x22, 0x16 y 0xA0 (18 bytes): fecha UTC (6), largo GPS + satélites (1),
 * latitud (4), longitud (4), velocidad km/h (1) y rumbo con estado (2).
 */
function leerGps(c: Buffer): Omit<Ubicacion, 'enTiempoReal'> {
  const fechaHora = new Date(Date.UTC(2000 + c[0], c[1] - 1, c[2], c[3], c[4], c[5]));
  const estado = c.readUInt16BE(16);
  // Grados × 60 × 30000. El bit 10 indica latitud norte y el bit 11 longitud oeste
  let latitud = c.readUInt32BE(7) / 1_800_000;
  let longitud = c.readUInt32BE(11) / 1_800_000;
  if (!(estado & 0x0400)) latitud = -latitud;
  if (estado & 0x0800) longitud = -longitud;
  return {
    fechaHora,
    latitud,
    longitud,
    velocidad: c[15],
    rumbo: estado & 0x03ff,
    satelites: c[6] & 0x0f,
    posicionada: Boolean(estado & 0x1000),
  };
}

// Posición del byte "reenvío" (0 = en tiempo real, 1 = guardada y reenviada) después de los datos de la celda
function indiceReenvio(protocolo: number, c: Buffer): number | null {
  if (protocolo === PROTOCOLO.UBICACION_LBS) return 18 + 8 + 2;
  if (protocolo === PROTOCOLO.UBICACION_4G && c.length >= 20) {
    // En 4G el MNC ocupa 2 bytes si el bit alto del MCC está encendido; LAC 4 y Cell ID 8
    const bytesMnc = c.readUInt16BE(18) & 0x8000 ? 2 : 1;
    return 18 + 2 + bytesMnc + 4 + 8 + 2;
  }
  return null;
}

export function decodificar(trama: Trama): Mensaje {
  const { protocolo, contenido } = trama;
  switch (protocolo) {
    case PROTOCOLO.LOGIN:
      return contenido.length >= 8 ? { tipo: 'login', imei: leerImei(contenido) } : { tipo: 'otro' };
    case PROTOCOLO.UBICACION:
    case PROTOCOLO.UBICACION_LBS:
    case PROTOCOLO.UBICACION_4G: {
      if (contenido.length < 18) return { tipo: 'otro' };
      const indice = indiceReenvio(protocolo, contenido);
      const enTiempoReal = indice === null || indice >= contenido.length || contenido[indice] === 0;
      return { tipo: 'ubicacion', ubicacion: { ...leerGps(contenido), enTiempoReal } };
    }
    case PROTOCOLO.HEARTBEAT: {
      // Nivel de batería de 0 a 6
      const nivel = contenido[1];
      const bateria = contenido.length >= 2 && nivel <= 6 ? Math.round((nivel / 6) * 100) : null;
      return { tipo: 'heartbeat', bateria };
    }
    case PROTOCOLO.HEARTBEAT_4G:
      return { tipo: 'heartbeat', bateria: null };
    default:
      return { tipo: 'otro' };
  }
}

export const requiereAck = (protocolo: number) => CON_ACK.has(protocolo);

// ACK: 78 78 05 | protocolo | serie | CRC | 0D 0A
export function ack(protocolo: number, serie: number): Buffer {
  const cuerpo = Buffer.from([0x05, protocolo, (serie >> 8) & 0xff, serie & 0xff]);
  const crc = crcItu(cuerpo);
  return Buffer.concat([
    Buffer.from([INICIO_CORTA, INICIO_CORTA]),
    cuerpo,
    Buffer.from([(crc >> 8) & 0xff, crc & 0xff, ...FIN]),
  ]);
}
