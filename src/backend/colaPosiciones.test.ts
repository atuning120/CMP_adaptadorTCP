import { afterEach, describe, expect, it, vi } from 'vitest';
import { ColaPosiciones } from './colaPosiciones.js';
import type { PosicionGps } from './posicion.js';

const posicion = (imei: string): PosicionGps => ({
  imei,
  fechaHora: '2026-10-21T13:00:00.000Z',
  latitud: -28.3,
  longitud: -70.8,
  velocidad: 10,
  rumbo: 90,
  bateria: 80,
  satelites: 9,
  enTiempoReal: true,
  tramaHex: '7878',
});

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const crearCola = (fetch: typeof globalThis.fetch) =>
  new ColaPosiciones({ backendUrl: 'http://backend', apiKey: 'clave', fetch, tamanoLote: 2, log });

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('ColaPosiciones', () => {
  it('envía en lotes con la API key y vacía la cola', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const cola = crearCola(fetch);
    cola.encolar(posicion('1'));
    cola.encolar(posicion('2'));
    cola.encolar(posicion('3'));
    await cola.enviar();

    expect(cola.cantidad).toBe(0);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://backend/tracking/posiciones');
    expect((init.headers as Record<string, string>)['X-Api-Key']).toBe('clave');
    const enviados = fetch.mock.calls.flatMap((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string).posiciones);
    expect(enviados.map((p: PosicionGps) => p.imei)).toEqual(['1', '2', '3']);
  });

  it('conserva las posiciones y reintenta si el Backend no responde', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(new Response(null, { status: 200 }));
    const cola = crearCola(fetch);
    cola.encolar(posicion('1'));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(cola.cantidad).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(cola.cantidad).toBe(0);
    cola.detener();
  });

  it('descarta el lote si el Backend lo rechaza con 4xx', async () => {
    const fetch = vi.fn(async () => new Response('IMEI inválido', { status: 400 }));
    const cola = crearCola(fetch);
    cola.encolar(posicion('x'));
    await cola.enviar();

    expect(cola.cantidad).toBe(0);
    expect(log.error).toHaveBeenCalled();
  });
});
