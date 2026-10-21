import { describe, expect, it } from 'vitest';
import { heartbeat, login, trama, ubicacion } from './codificador.js';
import { crcItu } from './crc.js';
import { ack, decodificar, extraerTramas, requiereAck } from './protocolo.js';

const hex = (texto: string) => Buffer.from(texto.replace(/\s/g, ''), 'hex');

// Ejemplos del documento del protocolo GT06
const LOGIN = hex('78 78 0D 01 01 23 45 67 89 01 23 45 00 01 8C DD 0D 0A');
const ACK_LOGIN = hex('78 78 05 01 00 01 D9 DC 0D 0A');
const UBICACION = hex('78 78 1F 12 0B 08 1D 11 2E 10 CF 02 7A C7 EB 0C 46 58 49 00 14 8F 01 CC 00 28 7D 00 1F B8 00 03 80 81 0D 0A');

const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

describe('crcItu', () => {
  it('coincide con los ejemplos del protocolo', () => {
    expect(crcItu(hex('0D 01 01 23 45 67 89 01 23 45 00 01'))).toBe(0x8cdd);
    expect(crcItu(hex('05 01 00 01'))).toBe(0xd9dc);
  });
});

describe('extraerTramas', () => {
  it('separa tramas pegadas y guarda el resto incompleto', () => {
    const datos = Buffer.concat([LOGIN, UBICACION, UBICACION.subarray(0, 10)]);
    const { tramas, resto } = extraerTramas(datos);

    expect(tramas.map((t) => t.protocolo)).toEqual([0x01, 0x12]);
    expect(resto).toEqual(UBICACION.subarray(0, 10));
  });

  it('descarta basura y tramas con CRC inválido', () => {
    const corrupta = Buffer.from(LOGIN);
    corrupta[5] ^= 0xff;
    const { tramas, descartadas } = extraerTramas(Buffer.concat([hex('AABB'), corrupta, UBICACION]));

    expect(tramas.map((t) => t.protocolo)).toEqual([0x12]);
    expect(descartadas).toBe(1);
  });
});

describe('decodificar', () => {
  it('lee el IMEI del login', () => {
    const [login] = extraerTramas(LOGIN).tramas;
    expect(decodificar(login)).toEqual({ tipo: 'login', imei: '123456789012345' });
    expect(login.serie).toBe(1);
  });

  it('lee la ubicación del ejemplo (hemisferio norte y este)', () => {
    const [t] = extraerTramas(UBICACION).tramas;
    const mensaje = decodificar(t);

    expect(mensaje.tipo).toBe('ubicacion');
    if (mensaje.tipo !== 'ubicacion') return;
    expect(mensaje.ubicacion.fechaHora.toISOString()).toBe('2011-08-29T17:46:16.000Z');
    expect(mensaje.ubicacion.latitud).toBeCloseTo(23.111668, 5);
    expect(mensaje.ubicacion.longitud).toBeCloseTo(114.409285, 5);
    expect(mensaje.ubicacion.satelites).toBe(15);
    expect(mensaje.ubicacion.posicionada).toBe(true);
    expect(mensaje.ubicacion.rumbo).toBe(0x08f);
  });

  it('lee latitud sur y longitud oeste (Los Colorados) y el reenvío de 0x22', () => {
    const lat = Math.round(28.2999 * 1_800_000);
    const lon = Math.round(70.8085 * 1_800_000);
    // Posicionado (bit 12) y oeste (bit 11), sin el bit de norte; rumbo 90°
    const estado = 0x1000 | 0x0800 | 90;
    const gps = [26, 10, 21, 13, 5, 30, 0xc9, ...u32(lat), ...u32(lon), 15, estado >> 8, estado & 0xff];
    const celda = [0x02, 0xd6, 0x01, 0x00, 0x01, 0x00, 0x00, 0x01];
    const [t] = extraerTramas(trama(0x22, [...gps, ...celda, 0x01, 0x00, 0x01], 7)).tramas;
    const mensaje = decodificar(t);

    expect(mensaje.tipo).toBe('ubicacion');
    if (mensaje.tipo !== 'ubicacion') return;
    expect(mensaje.ubicacion.fechaHora.toISOString()).toBe('2026-10-21T13:05:30.000Z');
    expect(mensaje.ubicacion.latitud).toBeCloseTo(-28.2999, 5);
    expect(mensaje.ubicacion.longitud).toBeCloseTo(-70.8085, 5);
    expect(mensaje.ubicacion.velocidad).toBe(15);
    expect(mensaje.ubicacion.rumbo).toBe(90);
    expect(mensaje.ubicacion.enTiempoReal).toBe(false);
  });

  it('convierte el nivel de batería del heartbeat a porcentaje', () => {
    const [t] = extraerTramas(trama(0x13, [0x40, 0x03, 0x04, 0x00, 0x02], 9)).tramas;
    expect(decodificar(t)).toEqual({ tipo: 'heartbeat', bateria: 50 });
  });
});

describe('ack', () => {
  it('responde el login igual que el ejemplo del protocolo', () => {
    expect(ack(0x01, 1)).toEqual(ACK_LOGIN);
  });

  it('solo confirma login, heartbeat y alarmas', () => {
    expect(requiereAck(0x01)).toBe(true);
    expect(requiereAck(0x13)).toBe(true);
    expect(requiereAck(0x12)).toBe(false);
    expect(requiereAck(0x22)).toBe(false);
  });
});

describe('codificador', () => {
  it('arma el login igual que el ejemplo del protocolo', () => {
    expect(login('123456789012345', 1)).toEqual(LOGIN);
  });

  it('una ubicación codificada se decodifica igual', () => {
    const fechaHora = new Date('2026-10-21T13:05:30.000Z');
    const [t] = extraerTramas(ubicacion({ fechaHora, latitud: -28.2999, longitud: -70.8085, velocidad: 20, rumbo: 270 }, 3)).tramas;
    const mensaje = decodificar(t);
    expect(mensaje).toEqual({
      tipo: 'ubicacion',
      ubicacion: expect.objectContaining({ fechaHora, velocidad: 20, rumbo: 270, posicionada: true, enTiempoReal: true }),
    });
    if (mensaje.tipo === 'ubicacion') expect(mensaje.ubicacion.latitud).toBeCloseTo(-28.2999, 5);
  });

  it('el heartbeat lleva la batería en niveles de 0 a 6', () => {
    const [t] = extraerTramas(heartbeat(100, 4)).tramas;
    expect(decodificar(t)).toEqual({ tipo: 'heartbeat', bateria: 100 });
  });
});
