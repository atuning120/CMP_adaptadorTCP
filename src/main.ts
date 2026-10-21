import { createApp } from './app.js';
import { config } from './config.js';

createApp().listen(config.port, () => {
  console.log(`Adaptador escuchando en el puerto ${config.port}`);
});
