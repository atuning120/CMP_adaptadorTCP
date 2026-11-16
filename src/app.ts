import express from 'express';
import type { EstadoCola } from './backend/colaPosiciones.js';
import type { DispositivoVisto } from './tcp/dispositivosVistos.js';

export interface DependenciasApp {
  cola?: { estado(): EstadoCola };
  dispositivos?: { lista(): DispositivoVisto[] };
  // Cuándo partió el proceso (para saber si se reinició)
  inicio?: Date;
}

// Crea la app HTTP sin levantar el servidor, para poder probarla con supertest
export function createApp({ cola, dispositivos, inicio }: DependenciasApp = {}) {
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

  return app;
}
