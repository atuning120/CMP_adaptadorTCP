import { describe, expect, it } from 'vitest';
import { heartbeat, login, trama, ubicacion } from './codificador.js';
import { crcItu } from './crc.js';
import {
  ack,
  comandoEnLinea,
  decodificar,
  extraerTramas,
  nombreProtocolo,
  requiereAck,
  respuestaHora,
} from './protocolo.js';

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

  it('guarda la posición de la alarma 4G 0xA4 (trama real del LL301)', () => {
    const real = hex(
      '78782da41a0b180b2908ce0308db980798f45804195f1002da0100000c8200000000002c1b084205041802ff006477c60d0a',
    );
    const { tramas, descartadas } = extraerTramas(real);
    const mensaje = decodificar(tramas[0]);

    expect(descartadas).toBe(0);
    expect(tramas[0].serie).toBe(100);
    expect(mensaje).toMatchObject({ tipo: 'ubicacion', alarma: 0x18 });
    if (mensaje.tipo !== 'ubicacion') return;
    expect(mensaje.ubicacion.fechaHora.toISOString()).toBe('2026-11-24T11:41:08.000Z');
    expect(mensaje.ubicacion.latitud).toBeCloseTo(-28.284529, 5);
    expect(mensaje.ubicacion.longitud).toBeCloseTo(-70.813631, 5);
    expect(mensaje.ubicacion).toMatchObject({ velocidad: 4, satelites: 14, posicionada: true });
    expect(requiereAck(0xa4)).toBe(true);
  });

  it('una 0xA4 sin celda se lee igual, sin código de alarma', () => {
    const [t] = extraerTramas(trama(0xa4, GPS_LOS_COLORADOS, 4)).tramas;
    const mensaje = decodificar(t);
    expect(mensaje.tipo).toBe('ubicacion');
    expect(mensaje).not.toHaveProperty('alarma');
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

describe('comandos en línea', () => {
  it('arma el comando 0x80 igual que el ejemplo del documento del LL301', () => {
    expect(comandoEnLinea('sos#', 0, 1)).toEqual(hex('78 78 0E 80 08 00 00 00 00 73 6F 73 23 00 01 6D 6A 0D 0A'));
  });

  it('pone la bandera del servidor para reconocer la respuesta', () => {
    const [t] = extraerTramas(comandoEnLinea('PARAM#', 0x01020304, 7)).tramas;
    expect(t.protocolo).toBe(0x80);
    expect([...t.contenido]).toEqual([10, 1, 2, 3, 4, ...Buffer.from('PARAM#')]);
  });

  it('rechaza un comando vacío o demasiado largo', () => {
    expect(() => comandoEnLinea('', 1, 1)).toThrow();
    expect(() => comandoEnLinea(`${'A'.repeat(200)}#`, 1, 1)).toThrow();
  });

  it('lee la respuesta 0x21 del ejemplo del documento', () => {
    const respuesta = hex(`79 79 00 9D 21 00 00 00 00 01 42 61 74 74 65 72 79 3A 34 2E 31 36 56 2C 4E 4F 52 4D 41 4C 3B
      20 47 50 52 53 3A 4C 69 6E 6B 20 55 70 3B 20 47 53 4D 20 53 69 67 6E 61 6C 20 4C 65 76 65 6C 3A 53 74 72 6F 6E 67
      3B 20 47 50 53 3A 53 65 61 72 63 68 69 6E 67 20 73 61 74 65 6C 6C 69 74 65 2C 20 53 56 53 20 55 73 65 64 20 69 6E
      20 66 69 78 3A 30 28 30 29 2C 20 47 50 53 20 53 69 67 6E 61 6C 20 4C 65 76 65 6C 3A 3B 20 41 43 43 3A 4F 46 46 3B
      20 44 65 66 65 6E 73 65 3A 4F 46 46 00 2E 26 DF 0D 0A`);
    const { tramas, descartadas } = extraerTramas(respuesta);

    expect(descartadas).toBe(0);
    expect(decodificar(tramas[0])).toEqual({
      tipo: 'respuestaComando',
      bandera: 0,
      texto:
        'Battery:4.16V,NORMAL; GPRS:Link Up; GSM Signal Level:Strong; GPS:Searching satellite, SVS Used in fix:0(0), ' +
        'GPS Signal Level:; ACC:OFF; Defense:OFF',
    });
    expect(nombreProtocolo(0x21)).toBe('0x21 respuesta a comando');
    expect(requiereAck(0x21)).toBe(false);
  });

  it('lee una respuesta 0x21 en UTF-16 y una 0x15 de los GT06', () => {
    const utf16 = Buffer.from('MODE OK', 'utf16le').swap16();
    const [t21] = extraerTramas(trama(0x21, [0, 0, 0, 9, 0x02, ...utf16], 3)).tramas;
    expect(decodificar(t21)).toEqual({ tipo: 'respuestaComando', bandera: 9, texto: 'MODE OK' });

    const texto = Buffer.from('OK!');
    const [t15] = extraerTramas(trama(0x15, [texto.length + 4, 0, 0, 0, 5, ...texto, 0x00, 0x02], 4)).tramas;
    expect(decodificar(t15)).toEqual({ tipo: 'respuestaComando', bandera: 5, texto: 'OK!' });
  });
});
