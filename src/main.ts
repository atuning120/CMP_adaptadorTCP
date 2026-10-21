import { createApp } from './app.js';
import { ColaPosiciones } from './backend/colaPosiciones.js';
import { leerConfig } from './config.js';
import { crearServidorGt06 } from './tcp/servidorGt06.js';

const config = leerConfig();
const cola = new ColaPosiciones({ backendUrl: config.backendUrl, apiKey: config.apiKey });

createApp({ cola }).listen(config.port, () => {
  console.log(`Adaptador: HTTP en el puerto ${config.port}`);
});

crearServidorGt06({ alRecibir: (posicion) => cola.encolar(posicion) }).listen(config.tcpPort, () => {
  console.log(`Adaptador: GT06 (TCP) en el puerto ${config.tcpPort}, reenviando a ${config.backendUrl}`);
});
