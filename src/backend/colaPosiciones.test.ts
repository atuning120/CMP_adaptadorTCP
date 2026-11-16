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

describe('ColaPosiciones: estado para /health', () => {
  const T0 = new Date('2026-11-16T12:00:00.000Z');
  const conReloj = (fetch: typeof globalThis.fetch, opciones: { maximoEnCola?: number } = {}) =>
    new ColaPosiciones({ backendUrl: 'http://backend', apiKey: 'clave', fetch, tamanoLote: 2, log, ahora: () => T0, ...opciones });

  it('parte en cero', () => {
    expect(conReloj(vi.fn()).estado()).toEqual({
      posicionesEnCola: 0,
      enviadas: 0,
      descartadas: 0,
      ultimoEnvioOk: null,
      ultimoError: null,
      reintentando: false,
    });
  });

  it('cuenta las enviadas y la hora del último envío exitoso', async () => {
    const cola = conReloj(vi.fn(async () => new Response(null, { status: 200 })));
    for (const imei of ['1', '2', '3']) cola.encolar(posicion(imei));
    await cola.enviar();

    expect(cola.estado()).toMatchObject({ posicionesEnCola: 0, enviadas: 3, descartadas: 0, ultimoEnvioOk: T0.toISOString() });
  });

  it('con el Backend caído muestra la cola, el error y que está reintentando', async () => {
    vi.useFakeTimers();
    const cola = conReloj(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 503 })));
    cola.encolar(posicion('1'));
    await vi.waitFor(() => expect(cola.estado().reintentando).toBe(true));

    expect(cola.estado()).toMatchObject({
      posicionesEnCola: 1,
      enviadas: 0,
      ultimoEnvioOk: null,
      ultimoError: { fecha: T0.toISOString(), detalle: 'El Backend respondió 503' },
    });
    cola.detener();
  });

  it('cuenta como descartadas las rechazadas con 4xx (p. ej. API key incorrecta) con el motivo', async () => {
    const cola = conReloj(vi.fn(async () => new Response('API key inválida', { status: 401 })));
    cola.encolar(posicion('1'));
    cola.encolar(posicion('2'));
    await cola.enviar();

    // encolar envía de inmediato: van en dos lotes de 1 y el último error es del segundo
    expect(cola.estado()).toMatchObject({
      descartadas: 2,
      enviadas: 0,
      ultimoError: { detalle: 'El Backend rechazó 1 posiciones (401): API key inválida' },
    });
  });

  it('cuenta como descartadas las que saca la cola llena', () => {
    vi.useFakeTimers();
    // El primer envío queda colgado: las siguientes se acumulan
    const cola = conReloj(vi.fn(() => new Promise<Response>(() => undefined)), { maximoEnCola: 2 });
    for (const imei of ['1', '2', '3', '4']) cola.encolar(posicion(imei));

    expect(cola.estado()).toMatchObject({ posicionesEnCola: 2, descartadas: 2 });
  });
});
