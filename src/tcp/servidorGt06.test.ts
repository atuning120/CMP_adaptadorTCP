import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PosicionGps } from '../backend/posicion.js';
import { crearServidorGt06 } from './servidorGt06.js';

const hex = (texto: string) => Buffer.from(texto.replace(/\s/g, ''), 'hex');

// Ejemplos del documento del protocolo GT06
const LOGIN = hex('78 78 0D 01 01 23 45 67 89 01 23 45 00 01 8C DD 0D 0A');
const ACK_LOGIN = hex('78 78 05 01 00 01 D9 DC 0D 0A');
const UBICACION = hex('78 78 1F 12 0B 08 1D 11 2E 10 CF 02 7A C7 EB 0C 46 58 49 00 14 8F 01 CC 00 28 7D 00 1F B8 00 03 80 81 0D 0A');

const log = { info: vi.fn(), warn: vi.fn() };
let servidor: net.Server | null = null;

async function levantar(alRecibir: (p: PosicionGps) => void) {
  servidor = crearServidorGt06({ alRecibir, log });
  await new Promise<void>((resolve) => servidor!.listen(0, resolve));
  const { port } = servidor.address() as AddressInfo;
  const cliente = net.connect(port);
  await new Promise<void>((resolve) => cliente.once('connect', resolve));
  return cliente;
}

afterEach(async () => {
  await new Promise((resolve) => servidor?.close(resolve));
  servidor = null;
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

  it('ignora ubicaciones antes del login', async () => {
    const alRecibir = vi.fn();
    const cliente = await levantar(alRecibir);
    cliente.write(UBICACION);
    cliente.write(LOGIN);
    await new Promise((resolve) => cliente.once('data', resolve));

    expect(alRecibir).not.toHaveBeenCalled();
    cliente.destroy();
  });
});
