import { crcItu } from './crc.js';
import { PROTOCOLO } from './protocolo.js';

// Arma las tramas que manda un dispositivo GT06. Lo usan el simulador y los tests (la app móvil tiene su propia copia)

export function trama(protocolo: number, contenido: number[], serie: number): Buffer {
  const cuerpo = [contenido.length + 5, protocolo, ...contenido, (serie >> 8) & 0xff, serie & 0xff];
  const crc = crcItu(Uint8Array.from(cuerpo));
  return Buffer.from([0x78, 0x78, ...cuerpo, (crc >> 8) & 0xff, crc & 0xff, 0x0d, 0x0a]);
}

const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

// IMEI de 15 dígitos en BCD: 8 bytes con un 0 adelante
export const login = (imei: string, serie: number) =>
  trama(PROTOCOLO.LOGIN, [...Buffer.from(`0${imei}`, 'hex')], serie);

export interface DatosUbicacion {
  fechaHora: Date;
  latitud: number;
  longitud: number;
  velocidad?: number;
  rumbo?: number;
  satelites?: number;
  enTiempoReal?: boolean;
}

// Ubicación 0x22: bloque GPS + celda (vacía) + ACC, modo de envío y reenvío
export function ubicacion(datos: DatosUbicacion, serie: number): Buffer {
  const f = datos.fechaHora;
  const estado =
    0x1000 | // posicionado
    (datos.latitud >= 0 ? 0x0400 : 0) | // norte
    (datos.longitud < 0 ? 0x0800 : 0) | // oeste
    (Math.round(datos.rumbo ?? 0) % 360);
  const gps = [
    f.getUTCFullYear() - 2000, f.getUTCMonth() + 1, f.getUTCDate(), f.getUTCHours(), f.getUTCMinutes(), f.getUTCSeconds(),
    0xc0 | Math.min(datos.satelites ?? 8, 15),
    ...u32(Math.round(Math.abs(datos.latitud) * 1_800_000)),
    ...u32(Math.round(Math.abs(datos.longitud) * 1_800_000)),
    Math.min(Math.round(datos.velocidad ?? 0), 255),
    estado >> 8, estado & 0xff,
  ];
  const celda = [0, 0, 0, 0, 0, 0, 0, 0];
  return trama(PROTOCOLO.UBICACION_LBS, [...gps, ...celda, 0x01, 0x00, datos.enTiempoReal === false ? 1 : 0], serie);
}

// Heartbeat 0x13 con la batería (porcentaje) convertida al nivel 0 a 6 de GT06
export const heartbeat = (bateria: number, serie: number) =>
  trama(PROTOCOLO.HEARTBEAT, [0x40, Math.round((bateria / 100) * 6), 0x04, 0x00, 0x02], serie);
