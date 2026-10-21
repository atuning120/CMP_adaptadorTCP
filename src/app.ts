import express from 'express';

// Crea la app HTTP sin levantar el servidor, para poder probarla con supertest
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  return app;
}
