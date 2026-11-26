import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { RequestHandler } from 'express';
import type { EstadoCola } from './backend/colaPosiciones.js';
import { validarComando } from './gt06/comandosPermitidos.js';
import type { Comandos } from './tcp/comandos.js';
import type { DispositivoVisto } from './tcp/dispositivosVistos.js';

// Lo que espera POST /comandos a la respuesta del equipo antes de contestar (el comando sigue igual después)
const ESPERA_POR_DEFECTO_S = 30;
const ESPERA_MAXIMA_S = 120;

export interface DependenciasApp {
  cola?: { estado(): EstadoCola };
  dispositivos?: { lista(): DispositivoVisto[] };
  // Cuándo partió el proceso (para saber si se reinició)
  inicio?: Date;
  // Comandos en línea para los GPS; /comandos existe solo si vienen junto con la clave
  comandos?: Comandos;
  apiKey?: string;
}

const mismaClave = (recibida: unknown, esperada: string) => {
  if (typeof recibida !== 'string') return false;
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
};

// Crea la app HTTP sin levantar el servidor, para poder probarla con supertest
export function createApp({ cola, dispositivos, inicio, comandos, apiKey }: DependenciasApp = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  /*
   * Responde 200 mientras el proceso viva: actualizar-vm.sh lo usa para decidir el rollback de un despliegue, y un
   * Backend caído no es motivo para volver a la imagen anterior. El resto es diagnóstico. El puerto HTTP solo escucha
   * en 127.0.0.1 de la VM (se consulta con az vm run-command), así que esto no queda expuesto a internet.
   * - cola: si posicionesEnCola crece, reintentando sigue en true y ultimoEnvioOk queda atrás, el Backend no recibe.
   * - dispositivos: cuándo se supo por última vez de cada IMEI ('9' + id_maquina para la app móvil).
   */
  app.get('/health', (_req, res) => {
    const estadoCola = cola?.estado();
    res.json({
      status: 'ok',
      ...(inicio ? { desde: inicio.toISOString() } : {}),
      // También suelta, como antes de que existiera el detalle de la cola
      ...(estadoCola ? { posicionesEnCola: estadoCola.posicionesEnCola, cola: estadoCola } : {}),
      ...(dispositivos ? { dispositivos: dispositivos.lista() } : {}),
    });
  });

  if (comandos && apiKey) montarComandos(app, comandos, apiKey);

  return app;
}

/*
 * Comandos en línea para los GPS (el mismo texto que por SMS, ver gt06/comandosPermitidos.ts), con la misma clave que
 * usa el Backend (X-Api-Key). Como /health, solo se llega desde la VM: az vm run-command o scripts/comando-gps.sh.
 * - POST /comandos { imei, comando, esperarSegundos? }: lo encola y espera la respuesta del equipo hasta
 *   esperarSegundos (30 por defecto, máximo 120). 200 si respondió; 202 si sigue pendiente (consultar después).
 * - GET /comandos?imei=…: historial, el más reciente primero. GET /comandos/:id: uno.
 */
function montarComandos(app: express.Express, comandos: Comandos, apiKey: string) {
  const conClave: RequestHandler = (req, res, next) => {
    if (mismaClave(req.get('x-api-key'), apiKey)) return next();
    res.status(401).json({ error: 'Falta X-Api-Key o no es válida' });
  };

  app.post('/comandos', conClave, async (req, res) => {
    const { imei, comando, esperarSegundos } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof imei !== 'string' || !/^\d{15}$/.test(imei)) {
      res.status(400).json({ error: 'imei debe tener 15 dígitos' });
      return;
    }
    const validado = validarComando(comando);
    if (!validado.ok) {
      res.status(400).json({ error: validado.error });
      return;
    }
    const espera = typeof esperarSegundos === 'number' && Number.isFinite(esperarSegundos) ? esperarSegundos : ESPERA_POR_DEFECTO_S;
    const segundos = Math.min(Math.max(espera, 0), ESPERA_MAXIMA_S);

    const encolado = comandos.encolar(imei, validado.texto);
    const resultado = (await comandos.esperarRespuesta(encolado.id, segundos * 1000)) ?? encolado;
    res.status(resultado.estado === 'respondido' ? 200 : 202).json(resultado);
  });

  app.get('/comandos', conClave, (req, res) => {
    const imei = typeof req.query.imei === 'string' ? req.query.imei : undefined;
    res.json(comandos.lista(imei));
  });

  app.get('/comandos/:id', conClave, (req, res) => {
    const comando = comandos.obtener(Number(req.params.id));
    if (!comando) {
      res.status(404).json({ error: 'No existe ese comando (el historial se pierde al reiniciar el adaptador)' });
      return;
    }
    res.json(comando);
  });
}
