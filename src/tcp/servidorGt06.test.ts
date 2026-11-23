import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PosicionGps } from '../backend/posicion.js';
import { login, trama } from '../gt06/codificador.js';
import { extraerTramas } from '../gt06/protocolo.js';
import { DispositivosVistos } from './dispositivosVistos.js';
import type { ModoLogTramas } from './registroTramas.js';
import { crearServidorGt06 } from './servidorGt06.js';

const hex = (texto: string) => Buffer.from(texto.replace(/\s/g, ''), 'hex');

// Ejemplos del documento del protocolo GT06
const LOGIN = hex('78 78 0D 01 01 23 45 67 89 01 23 45 00 01 8C DD 0D 0A');
const ACK_LOGIN = hex('78 78 05 01 00 01 D9 DC 0D 0A');
const UBICACION = hex('78 78 1F 12 0B 08 1D 11 2E 10 CF 02 7A C7 EB 0C 46 58 49 00 14 8F 01 CC 00 28 7D 00 1F B8 00 03 80 81 0D 0A');

const IMEI_REAL = '864032050668829';
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
// Alarma 0x16 en Los Colorados (sur y oeste, posicionada): GPS (18), celda (9) y estado con alarma SOS (0x01)
const ALARMA = (() => {
  const estado = 0x1000 | 0x0800 | 90;
  const gps = [26, 10, 21, 13, 5, 30, 0xc9, ...u32(50_939_820), ...u32(127_455_300), 15, estado >> 8, estado & 0xff];
  return trama(0x16, [...gps, 0x09, 0x02, 0xd6, 0x01, 0x00, 0x01, 0x00, 0x00, 0x01, 0x44, 0x05, 0x04, 0x01, 0x02], 8);
})();

const log = { info: vi.fn(), warn: vi.fn() };
let servidor: net.Server | null = null;

async function levantar(alRecibir: (p: PosicionGps) => void, dispositivos?: DispositivosVistos, logTramas?: ModoLogTramas) {
  servidor = crearServidorGt06({ alRecibir, log, dispositivos, logTramas });
  await new Promise<void>((resolve) => servidor!.listen(0, resolve));
  const { port } = servidor.address() as AddressInfo;
  const cliente = net.connect(port);
  await new Promise<void>((resolve) => cliente.once('connect', resolve));
  return cliente;
}

// Todo lo recibido hasta tener al menos `bytes`
async function leer(cliente: net.Socket, bytes: number): Promise<Buffer> {
  let recibido = Buffer.alloc(0);
  return new Promise((resolve) => {
    const alLlegar = (datos: Buffer) => {
      recibido = Buffer.concat([recibido, datos]);
      if (recibido.length < bytes) return;
      cliente.off('data', alLlegar);
      resolve(recibido);
    };
    cliente.on('data', alLlegar);
  });
}

const lineasInfo = () => log.info.mock.calls.map(([linea]) => String(linea));

afterEach(async () => {
  await new Promise((resolve) => servidor?.close(resolve));
  servidor = null;
  log.info.mockClear();
  log.warn.mockClear();
});

describe('servidor GT06', () => {
  it('confirma el login y reenvía la ubicación con el IMEI', async () => {
    const recibidas: PosicionGps[] = [];
    const cliente = await levantar((p) => recibidas.push(p));
    const respuesta = new Promise<Buffer>((resolve) => cliente.once('data', resolve));

    // El login llega partido en dos y la ubicación pegada a su segunda mitad
    cliente.write(LOGIN.subarray(0, 7));
    cliente.write(Buffer.concat([LOGIN.subarray(7), UBICACION]));

    expect(await respuesta).toEqual(ACK_LOGIN);
    await vi.waitFor(() => expect(recibidas).toHaveLength(1));
    expect(recibidas[0]).toMatchObject({ imei: '123456789012345', fechaHora: '2011-08-29T17:46:16.000Z', enTiempoReal: true });
    cliente.destroy();
  });

  it('registra el dispositivo para /health y lo marca desconectado al cerrar', async () => {
    const dispositivos = new DispositivosVistos();
    const recibidas: PosicionGps[] = [];
    const cliente = await levantar((p) => recibidas.push(p), dispositivos);
    cliente.write(Buffer.concat([LOGIN, UBICACION]));
    await vi.waitFor(() => expect(recibidas).toHaveLength(1));

    expect(dispositivos.lista()).toEqual([expect.objectContaining({ imei: '123456789012345', ubicaciones: 1, conectado: true })]);

    cliente.end();
    await vi.waitFor(() => expect(dispositivos.lista()[0].conectado).toBe(false));
  });

  it('ignora ubicaciones antes del login', async () => {
    const alRecibir = vi.fn();
    const cliente = await levantar(alRecibir);
    cliente.write(UBICACION);
    cliente.write(LOGIN);
    await new Promise((resolve) => cliente.once('data', resolve));

    expect(alRecibir).not.toHaveBeenCalled();
    cliente.destroy();
  });

  it('guarda la posición de una alarma y la confirma', async () => {
    const recibidas: PosicionGps[] = [];
    const cliente = await levantar((p) => recibidas.push(p));
    cliente.write(Buffer.concat([login(IMEI_REAL, 1), ALARMA]));

    const respuestas = extraerTramas(await leer(cliente, 20)).tramas;
    expect(respuestas.map((t) => [t.protocolo, t.serie])).toEqual([
      [0x01, 1],
      [0x16, 8],
    ]);
    await vi.waitFor(() => expect(recibidas).toHaveLength(1));
    expect(recibidas[0]).toMatchObject({ imei: IMEI_REAL, fechaHora: '2026-10-21T13:05:30.000Z', enTiempoReal: true });
    expect(recibidas[0].latitud).toBeCloseTo(-28.2999, 4);
    cliente.destroy();
  });

  it('responde la solicitud de hora (0x8A) con la hora UTC', async () => {
    const cliente = await levantar(vi.fn());
    const antes = Date.now();
    cliente.write(trama(0x8a, [], 6));

    const [respuesta] = extraerTramas(await leer(cliente, 16)).tramas;
    expect(respuesta).toMatchObject({ protocolo: 0x8a, serie: 6 });
    const [a, m, d, h, min, s] = respuesta.contenido;
    const hora = Date.UTC(2000 + a, m - 1, d, h, min, s);
    expect(Math.abs(hora - antes)).toBeLessThan(5000);
    cliente.destroy();
  });

  it('registra en hex lo recibido y lo enviado por un GPS real, y quién cerró la conexión', async () => {
    const cliente = await levantar(vi.fn(), undefined, 'reales');
    cliente.write(Buffer.concat([login(IMEI_REAL, 1), trama(0x94, [0x0a, 0x01], 2)]));
    await leer(cliente, 10);
    cliente.end();

    await vi.waitFor(() => expect(lineasInfo().some((l) => l.startsWith('Desconexión'))).toBe(true));
    const lineas = lineasInfo();
    expect(lineas).toContainEqual(expect.stringMatching(new RegExp(`^RX ${IMEI_REAL} 0x01 login #1 IMEI ${IMEI_REAL} \\| 7878`)));
    expect(lineas).toContainEqual(`TX ${IMEI_REAL} 0x01 login #1 | 787805010001d9dc0d0a`);
    expect(lineas).toContainEqual(expect.stringMatching(new RegExp(`^RX ${IMEI_REAL} 0x94 información del equipo #2 no se procesa`)));
    expect(lineas).toContainEqual(
      expect.stringMatching(new RegExp(`^Desconexión ${IMEI_REAL}: la cerró el equipo; duró \\d+ s, 2 tramas, última trama hace`)),
    );
  });

  it('no registra las tramas de la app móvil (IMEI virtual) en modo reales', async () => {
    const cliente = await levantar(vi.fn(), undefined, 'reales');
    cliente.write(login('900000000000027', 1));
    await leer(cliente, 10);
    cliente.end();

    await vi.waitFor(() => expect(lineasInfo()).toContainEqual(expect.stringMatching(/^Login 900000000000027/)));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lineasInfo().filter((l) => /^(RX|TX|Desconexión)/.test(l))).toEqual([]);
  });
});
