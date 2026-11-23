import { describe, expect, it } from 'vitest';
import { heartbeat, login, trama, ubicacion } from './codificador.js';
import { crcItu } from './crc.js';
import { ack, decodificar, extraerTramas, nombreProtocolo, requiereAck, respuestaHora } from './protocolo.js';

const hex = (texto: string) => Buffer.from(texto.replace(/\s/g, ''), 'hex');

// Ejemplos del documento del protocolo GT06
const LOGIN = hex('78 78 0D 01 01 23 45 67 89 01 23 45 00 01 8C DD 0D 0A');
const ACK_LOGIN = hex('78 78 05 01 00 01 D9 DC 0D 0A');
const UBICACION = hex('78 78 1F 12 0B 08 1D 11 2E 10 CF 02 7A C7 EB 0C 46 58 49 00 14 8F 01 CC 00 28 7D 00 1F B8 00 03 80 81 0D 0A');

const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

// Bloque GPS en Los Colorados (sur y oeste), posicionado, 15 km/h, rumbo 90°, 9 satélites
const GPS_LOS_COLORADOS = (() => {
  const estado = 0x1000 | 0x0800 | 90;
  return [
    26, 10, 21, 13, 5, 30, 0xc9,
    ...u32(Math.round(28.2999 * 1_800_000)), ...u32(Math.round(70.8085 * 1_800_000)),
    15, estado >> 8, estado & 0xff,
  ];
})();
// Celda de las alarmas: largo, MCC (2), MNC (1), LAC (2), Cell ID (3)
const CELDA_ALARMA = [0x09, 0x02, 0xd6, 0x01, 0x00, 0x01, 0x00, 0x00, 0x01];

// Trama larga (79 79, largo de 2 bytes), como la 0x94 de los equipos 4G
function tramaLarga(protocolo: number, contenido: number[], serie: number): Buffer {
  const largo = contenido.length + 5;
  const cuerpo = [largo >> 8, largo & 0xff, protocolo, ...contenido, serie >> 8, serie & 0xff];
  const crc = crcItu(Uint8Array.from(cuerpo));
  return Buffer.from([0x79, 0x79, ...cuerpo, crc >> 8, crc & 0xff, 0x0d, 0x0a]);
}

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

  it('separa tramas largas (79 79) entre tramas cortas', () => {
    const info = tramaLarga(0x94, [0x0a, ...Buffer.from('LL301 V1.0')], 3);
    const { tramas, resto } = extraerTramas(Buffer.concat([LOGIN, info, UBICACION]));

    expect(tramas.map((t) => t.protocolo)).toEqual([0x01, 0x94, 0x12]);
    expect(tramas[1].serie).toBe(3);
    expect(tramas[1].contenido.subarray(1).toString()).toBe('LL301 V1.0');
    expect(decodificar(tramas[1])).toEqual({ tipo: 'otro' });
    expect(resto).toHaveLength(0);
  });
});

describe('decodificar', () => {
  it('lee el IMEI del login', () => {
    const [login] = extraerTramas(LOGIN).tramas;
    expect(decodificar(login)).toEqual({ tipo: 'login', imei: '123456789012345' });
    expect(login.serie).toBe(1);
  });

  it('lee la zona horaria del login de los equipos 4G', () => {
    const imei = [...Buffer.from('0864032050668829', 'hex')];
    // Tipo de equipo (2) y zona: horas × 100 en los bits 15 a 4, bit 3 = oeste
    const oeste3 = (300 << 4) | 0x08;
    const [t] = extraerTramas(trama(0x01, [...imei, 0x36, 0x08, oeste3 >> 8, oeste3 & 0xff], 1)).tramas;
    expect(decodificar(t)).toEqual({ tipo: 'login', imei: '864032050668829', zonaHoraria: 'GMT-3:00' });

    const [este] = extraerTramas(trama(0x01, [...imei, 0x36, 0x08, 0x32, 0x00], 1)).tramas;
    expect(decodificar(este)).toMatchObject({ zonaHoraria: 'GMT+8:00' });
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
    expect(decodificar(t)).toEqual({ tipo: 'heartbeat', bateria: 50, senalGsm: 4, cargando: false });
  });

  it('lee el voltaje del heartbeat 4G (0x23) y lo estima en porcentaje', () => {
    // Cargando (bit 2), 4,02 V, señal GSM 4
    const [t] = extraerTramas(trama(0x23, [0x44, 0x01, 0x92, 0x04, 0x00, 0x02], 9)).tramas;
    expect(decodificar(t)).toEqual({ tipo: 'heartbeat', bateria: 70, voltaje: 4.02, senalGsm: 4, cargando: true });

    // Fuera del rango 3,6 a 4,2 V queda en 0 o 100
    const [baja] = extraerTramas(trama(0x23, [0x00, 0x01, 0x5e, 0x02, 0x00, 0x02], 9)).tramas;
    expect(decodificar(baja)).toMatchObject({ bateria: 0, voltaje: 3.5, cargando: false });
  });

  it.each([
    ['0x16', 0x16],
    ['0x26', 0x26],
  ])('guarda la posición de la alarma %s con su código', (_nombre, protocolo) => {
    const estado = [0x44, 0x05, 0x04, 0x01, 0x02]; // terminal, voltaje, GSM, alarma SOS (0x01), idioma
    const [t] = extraerTramas(trama(protocolo, [...GPS_LOS_COLORADOS, ...CELDA_ALARMA, ...estado], 4)).tramas;
    const mensaje = decodificar(t);

    expect(mensaje).toMatchObject({ tipo: 'ubicacion', alarma: 0x01 });
    if (mensaje.tipo !== 'ubicacion') return;
    expect(mensaje.ubicacion.fechaHora.toISOString()).toBe('2026-10-21T13:05:30.000Z');
    expect(mensaje.ubicacion.latitud).toBeCloseTo(-28.2999, 5);
    expect(mensaje.ubicacion.longitud).toBeCloseTo(-70.8085, 5);
    expect(mensaje.ubicacion.enTiempoReal).toBe(true);
    expect(requiereAck(protocolo)).toBe(true);
  });

  it('reconoce la solicitud de hora (0x8A)', () => {
    const [t] = extraerTramas(trama(0x8a, [], 5)).tramas;
    expect(decodificar(t)).toEqual({ tipo: 'hora' });
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
    // La 0x8A tiene su propia respuesta (respuestaHora)
    expect(requiereAck(0x8a)).toBe(false);
  });
});

describe('respuestaHora', () => {
  it('responde la hora UTC con la serie de la solicitud y un CRC válido', () => {
    const respuesta = respuestaHora(5, new Date('2026-11-23T19:04:05.000Z'));
    const { tramas, descartadas } = extraerTramas(respuesta);

    expect(respuesta.subarray(0, 4)).toEqual(hex('78 78 0B 8A'));
    expect(descartadas).toBe(0);
    expect(tramas[0]).toMatchObject({ protocolo: 0x8a, serie: 5 });
    expect([...tramas[0].contenido]).toEqual([26, 11, 23, 19, 4, 5]);
  });
});

describe('nombreProtocolo', () => {
  it('nombra los paquetes conocidos y los desconocidos', () => {
    expect(nombreProtocolo(0x94)).toBe('0x94 información del equipo');
    expect(nombreProtocolo(0x05)).toBe('0x05 desconocido');
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
    expect(decodificar(t)).toMatchObject({ tipo: 'heartbeat', bateria: 100 });
  });
});
