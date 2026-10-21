import express from 'express';

export interface DependenciasApp {
  cola?: { cantidad: number };
}

// Crea la app HTTP sin levantar el servidor, para poder probarla con supertest
export function createApp({ cola }: DependenciasApp = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  // Posiciones esperando al Backend: si crece y no baja, el Backend no está recibiendo
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', ...(cola ? { posicionesEnCola: cola.cantidad } : {}) });
  });

  return app;
}
