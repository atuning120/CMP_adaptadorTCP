import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { Comandos } from './tcp/comandos.js';
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

describe('/comandos', () => {
  const CLAVE = 'clave-de-prueba';
  const IMEI = '864032050668829';

  function conComandos() {
    const comandos = new Comandos();
    return { comandos, app: createApp({ comandos, apiKey: CLAVE }) };
  }

  it('no existe sin comandos o sin clave', async () => {
    expect((await request(createApp()).post('/comandos')).status).toBe(404);
    expect((await request(createApp({ comandos: new Comandos() })).get('/comandos')).status).toBe(404);
  });

  it('exige la clave', async () => {
    const { app } = conComandos();
    expect((await request(app).get('/comandos')).status).toBe(401);
    expect((await request(app).get('/comandos').set('X-Api-Key', 'otra')).status).toBe(401);
    expect((await request(app).get('/comandos').set('X-Api-Key', CLAVE)).status).toBe(200);
  });

  it('rechaza un IMEI inválido o un comando no permitido', async () => {
    const { app } = conComandos();
    const enviar = (body: object) => request(app).post('/comandos').set('X-Api-Key', CLAVE).send(body);

    expect((await enviar({ imei: '123', comando: 'PARAM#' })).status).toBe(400);
    const rechazado = await enviar({ imei: IMEI, comando: 'SERVER,1,otro.com,5023,0#' });
    expect(rechazado.status).toBe(400);
    expect(rechazado.body.error).toMatch(/SERVER no está permitido/);
  });

  it('responde 202 con el comando en cola si el equipo no contesta a tiempo', async () => {
    const { app, comandos } = conComandos();
    const res = await request(app)
      .post('/comandos')
      .set('X-Api-Key', CLAVE)
      .send({ imei: IMEI, comando: 'mode,1,30,1,1,1#', esperarSegundos: 0 });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ id: 1, imei: IMEI, texto: 'MODE,1,30,1,1,1#', estado: 'en cola' });
    expect(comandos.lista(IMEI)).toHaveLength(1);
  });

  it('responde 200 con la respuesta del equipo si llega mientras espera', async () => {
    const { app, comandos } = conComandos();
    comandos.actividad(IMEI, (_texto, bandera) => {
      setTimeout(() => comandos.respuesta(IMEI, bandera, 'GPSDUP=ON'), 10);
    });

    const res = await request(app).post('/comandos').set('X-Api-Key', CLAVE).send({ imei: IMEI, comando: 'GPSDUP#' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ estado: 'respondido', respuesta: 'GPSDUP=ON' });
    const uno = await request(app).get(`/comandos/${res.body.id}`).set('X-Api-Key', CLAVE);
    expect(uno.body).toMatchObject({ estado: 'respondido' });
    expect((await request(app).get('/comandos/99').set('X-Api-Key', CLAVE)).status).toBe(404);
  });
});
