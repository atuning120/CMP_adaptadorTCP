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
  // Alarma de los 4G (la que manda el LL301)
  ALARMA_4G_MULTICERCO: 0xa4,
  SOLICITUD_HORA: 0x8a,
  // Comando en línea (servidor → equipo, el mismo texto de un SMS) y sus respuestas: 0x21 los 4G, 0x15 los GT06
  COMANDO: 0x80,
  RESPUESTA_COMANDO: 0x21,
  RESPUESTA_COMANDO_GT06: 0x15,
} as const;

// Nombres para el log (incluye paquetes que el adaptador recibe pero no procesa)
const NOMBRES: Record<number, string> = {
  0x01: 'login',
  0x12: 'ubicación',
  0x13: 'heartbeat',
  0x15: 'respuesta a comando',
  0x16: 'alarma',
  0x21: 'respuesta a comando',
  0x22: 'ubicación',
  0x23: 'heartbeat 4G',
  0x26: 'alarma',
  0x27: 'alarma 4G',
  0x80: 'comando',
  0x8a: 'solicitud de hora',
  0x94: 'información del equipo',
  0xa0: 'ubicación 4G',
  0xa2: 'antenas y WiFi (sin GPS)',
  0xa4: 'alarma 4G',
};

export const nombreProtocolo = (protocolo: number) =>
  `0x${protocolo.toString(16).padStart(2, '0')} ${NOMBRES[protocolo] ?? 'desconocido'}`;

// Paquetes que el dispositivo espera ver confirmados; si no recibe el ACK, reintenta o se desconecta
const CON_ACK = new Set<number>([
  PROTOCOLO.LOGIN,
  PROTOCOLO.HEARTBEAT,
  PROTOCOLO.HEARTBEAT_4G,
  PROTOCOLO.ALARMA,
  PROTOCOLO.ALARMA_4G,
  PROTOCOLO.ALARMA_4G_EXTENDIDA,
  PROTOCOLO.ALARMA_4G_MULTICERCO,
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

export interface Heartbeat {
  tipo: 'heartbeat';
  bateria: number | null; // porcentaje
  voltaje?: number; // V, solo 0x23
  senalGsm?: number; // 0 (sin señal) a 4
  cargando?: boolean;
}

export type Mensaje =
  // zonaHoraria: la que tiene configurada el equipo (comando GMT), p. ej. 'GMT-3:00'; los 4G la mandan en el login
  | { tipo: 'login'; imei: string; zonaHoraria?: string }
  // alarma: código de alarma de 0x16, 0x26 y 0xA4 (su posición se guarda igual que una ubicación)
  | { tipo: 'ubicacion'; ubicacion: Ubicacion; alarma?: number }
  | Heartbeat
  | { tipo: 'hora' }
  // bandera: la que puso el servidor en el comando 0x80 (el equipo la devuelve tal cual), para saber a cuál responde
  | { tipo: 'respuestaComando'; bandera: number; texto: string }
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
 * Login de los equipos 4G: IMEI (8), tipo de equipo (2) y zona horaria con idioma (2). La zona viene en los bits
 * 15 a 4 como horas × 100 + minutos, y el bit 3 indica oeste.
 */
function leerZonaHoraria(contenido: Buffer): string | undefined {
  if (contenido.length < 12) return undefined;
  const bits = contenido.readUInt16BE(10);
  const valor = bits >> 4;
  const minutos = String(valor % 100).padStart(2, '0');
  return `GMT${bits & 0x08 ? '-' : '+'}${Math.floor(valor / 100)}:${minutos}`;
}

// Batería de litio: 3,6 V se toma como vacía y 4,2 V como llena (aproximado, para seguir la descarga)
const VOLTAJE_VACIA = 3.6;
const VOLTAJE_LLENA = 4.2;
const porcentajeDeVoltaje = (voltaje: number) =>
  Math.round(Math.min(Math.max((voltaje - VOLTAJE_VACIA) / (VOLTAJE_LLENA - VOLTAJE_VACIA), 0), 1) * 100);

/**
 * Heartbeat 0x13: información del terminal (1), nivel de batería 0 a 6 (1), señal GSM (1), alarma e idioma (2).
 * Heartbeat 0x23 (4G): información del terminal (1), voltaje en centésimas de V (2), señal GSM (1), idioma (2).
 * En la información del terminal, el bit 2 indica que está cargando.
 */
function leerHeartbeat(protocolo: number, c: Buffer): Heartbeat {
  const cargando = c.length >= 1 ? Boolean(c[0] & 0x04) : undefined;
  if (protocolo === PROTOCOLO.HEARTBEAT_4G) {
    if (c.length < 4) return { tipo: 'heartbeat', bateria: null };
    const voltaje = c.readUInt16BE(1) / 100;
    return { tipo: 'heartbeat', bateria: porcentajeDeVoltaje(voltaje), voltaje, senalGsm: c[3], cargando };
  }
  const nivel = c[1];
  const bateria = c.length >= 2 && nivel <= 6 ? Math.round((nivel / 6) * 100) : null;
  return { tipo: 'heartbeat', bateria, ...(c.length >= 3 ? { senalGsm: c[2] } : {}), ...(cargando !== undefined ? { cargando } : {}) };
}

// Alarma 0x16 y 0x26: GPS (18), celda (9: largo, MCC, MNC, LAC, Cell ID), información del terminal, voltaje, señal GSM,
// código de alarma e idioma
const INDICE_CODIGO_ALARMA = 18 + 9 + 3;

// Alarma 0xA4: GPS (18), celda 4G (el primer byte es su largo, contándose), información del terminal, voltaje, señal
// GSM, código de alarma, idioma y N° de geocerca
const indiceCodigoAlarma4g = (c: Buffer) => 18 + c[18] + 3;

/**
 * Bloque GPS común a 0x12, 0x22, 0xA0 y las alarmas 0x16, 0x26, 0x27 y 0xA4 (18 bytes): fecha UTC (6), largo GPS + satélites (1),
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

/**
 * Respuesta a un comando 0x80:
 * - 0x21 (4G, trama larga): bandera del servidor (4), codificación (1: 0x01 ASCII, 0x02 UTF-16 BE) y el texto.
 * - 0x15 (GT06, trama corta): largo (1: bandera + texto), bandera (4), texto e idioma (2).
 */
function leerRespuestaComando(protocolo: number, c: Buffer): Mensaje | null {
  if (protocolo === PROTOCOLO.RESPUESTA_COMANDO) {
    if (c.length < 5) return null;
    const crudo = c.subarray(5);
    let texto: string;
    if (c[4] === 0x02 && crudo.length % 2 === 0) {
      const copia = Buffer.from(crudo);
      texto = copia.swap16().toString('utf16le');
    } else {
      texto = crudo.toString('latin1');
    }
    return { tipo: 'respuestaComando', bandera: c.readUInt32BE(0), texto: limpiarTexto(texto) };
  }
  if (c.length < 5) return null;
  const fin = Math.min(1 + c[0], c.length);
  return { tipo: 'respuestaComando', bandera: c.readUInt32BE(1), texto: limpiarTexto(c.subarray(5, fin).toString('latin1')) };
}

// Sin los NUL de relleno ni espacios en los extremos
const limpiarTexto = (texto: string) => texto.replace(/\0+/g, '').trim();

export function decodificar(trama: Trama): Mensaje {
  const { protocolo, contenido } = trama;
  switch (protocolo) {
    case PROTOCOLO.LOGIN: {
      if (contenido.length < 8) return { tipo: 'otro' };
      const zonaHoraria = leerZonaHoraria(contenido);
      return { tipo: 'login', imei: leerImei(contenido), ...(zonaHoraria ? { zonaHoraria } : {}) };
    }
    case PROTOCOLO.UBICACION:
    case PROTOCOLO.UBICACION_LBS:
    case PROTOCOLO.UBICACION_4G: {
      if (contenido.length < 18) return { tipo: 'otro' };
      const indice = indiceReenvio(protocolo, contenido);
      const enTiempoReal = indice === null || indice >= contenido.length || contenido[indice] === 0;
      return { tipo: 'ubicacion', ubicacion: { ...leerGps(contenido), enTiempoReal } };
    }
    // Las alarmas traen la posición del momento: se guarda como una ubicación más (en tiempo real)
    case PROTOCOLO.ALARMA:
    case PROTOCOLO.ALARMA_4G:
    case PROTOCOLO.ALARMA_4G_EXTENDIDA:
    case PROTOCOLO.ALARMA_4G_MULTICERCO: {
      if (contenido.length < 18) return { tipo: 'otro' };
      const indiceCodigo =
        protocolo === PROTOCOLO.ALARMA_4G_MULTICERCO && contenido.length > 18 ? indiceCodigoAlarma4g(contenido) : INDICE_CODIGO_ALARMA;
      const conCodigo = protocolo !== PROTOCOLO.ALARMA_4G_EXTENDIDA && contenido.length > indiceCodigo;
      return {
        tipo: 'ubicacion',
        ubicacion: { ...leerGps(contenido), enTiempoReal: true },
        ...(conCodigo ? { alarma: contenido[indiceCodigo] } : {}),
      };
    }
    case PROTOCOLO.HEARTBEAT:
    case PROTOCOLO.HEARTBEAT_4G:
      return leerHeartbeat(protocolo, contenido);
    case PROTOCOLO.SOLICITUD_HORA:
      return { tipo: 'hora' };
    case PROTOCOLO.RESPUESTA_COMANDO:
    case PROTOCOLO.RESPUESTA_COMANDO_GT06:
      return leerRespuestaComando(protocolo, contenido) ?? { tipo: 'otro' };
    default:
      return { tipo: 'otro' };
  }
}

export const requiereAck = (protocolo: number) => CON_ACK.has(protocolo);

// Respuesta del servidor: 78 78 | largo | protocolo | contenido | serie | CRC | 0D 0A
function respuesta(protocolo: number, contenido: number[], serie: number): Buffer {
  const cuerpo = Buffer.from([contenido.length + 5, protocolo, ...contenido, (serie >> 8) & 0xff, serie & 0xff]);
  const crc = crcItu(cuerpo);
  return Buffer.concat([
    Buffer.from([INICIO_CORTA, INICIO_CORTA]),
    cuerpo,
    Buffer.from([(crc >> 8) & 0xff, crc & 0xff, ...FIN]),
  ]);
}

// ACK: 78 78 05 | protocolo | serie | CRC | 0D 0A
export const ack = (protocolo: number, serie: number) => respuesta(protocolo, [], serie);

// Respuesta a 0x8A: la hora UTC del servidor (AA MM DD HH MM SS), para el equipo que aún no tiene hora del GPS
export const respuestaHora = (serie: number, ahora: Date) =>
  respuesta(
    PROTOCOLO.SOLICITUD_HORA,
    [
      ahora.getUTCFullYear() - 2000,
      ahora.getUTCMonth() + 1,
      ahora.getUTCDate(),
      ahora.getUTCHours(),
      ahora.getUTCMinutes(),
      ahora.getUTCSeconds(),
    ],
    serie,
  );

// Largo máximo del texto de un comando: la trama corta tiene un solo byte de largo
export const LARGO_MAXIMO_COMANDO = 200;

/**
 * Comando en línea 0x80 (servidor → equipo): largo (1: bandera + texto), bandera del servidor (4) y el texto ASCII,
 * igual al de un SMS (p. ej. 'PARAM#'). El equipo responde con 0x21 devolviendo la misma bandera. Sin los 2 bytes de
 * idioma, como en el ejemplo del documento del LL301 (es opcional y así lo manda Traccar por defecto).
 */
export function comandoEnLinea(texto: string, bandera: number, serie: number): Buffer {
  const ascii = Buffer.from(texto, 'latin1');
  if (ascii.length === 0 || ascii.length > LARGO_MAXIMO_COMANDO) {
    throw new Error(`El comando debe tener entre 1 y ${LARGO_MAXIMO_COMANDO} caracteres`);
  }
  const banderaBytes = [(bandera >>> 24) & 0xff, (bandera >>> 16) & 0xff, (bandera >>> 8) & 0xff, bandera & 0xff];
  return respuesta(PROTOCOLO.COMANDO, [ascii.length + 4, ...banderaBytes, ...ascii], serie);
}
