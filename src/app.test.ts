import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { EstadoCola } from './backend/colaPosiciones.js';

describe('GET /health', () => {
  it('responde ok', async () => {
    const res = await request(createApp()).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('incluye el diagnóstico de la cola y de los dispositivos, y sigue en 200 con el Backend caído', async () => {
    // Un Backend caído no debe hacer que actualizar-vm.sh vuelva a la imagen anterior
    const estado: EstadoCola = {
      posicionesEnCola: 40,
      enviadas: 120,
      descartadas: 0,
      ultimoEnvioOk: '2026-11-16T11:50:00.000Z',
      ultimoError: { fecha: '2026-11-16T12:00:00.000Z', detalle: 'El Backend respondió 503' },
      reintentando: true,
    };
    const dispositivo = {
      imei: '900000000000012',
      ultimaConexion: '2026-11-16T12:00:00.000Z',
      ultimaUbicacion: '2026-11-16T12:00:00.000Z',
      ubicaciones: 160,
      bateria: 80,
      conectado: false,
    };
    const app = createApp({
      cola: { estado: () => estado },
      dispositivos: { lista: () => [dispositivo] },
      inicio: new Date('2026-11-16T08:00:00.000Z'),
    });

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      desde: '2026-11-16T08:00:00.000Z',
      posicionesEnCola: 40,
      cola: estado,
      dispositivos: [dispositivo],
    });
  });
});
