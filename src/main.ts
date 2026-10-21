import { createApp } from './app.js';
import { ColaPosiciones } from './backend/colaPosiciones.js';
import { leerConfig } from './config.js';
import { crearServidorGt06 } from './tcp/servidorGt06.js';

// Al detenerse (un despliegue nuevo) se espera este máximo a que la cola termine de enviarse al Backend
const ESPERA_CIERRE_MS = 8_000;

const config = leerConfig();
const cola = new ColaPosiciones({ backendUrl: config.backendUrl, apiKey: config.apiKey });

const http = createApp({ cola }).listen(config.port, () => {
  console.log(`Adaptador: HTTP en el puerto ${config.port}`);
});

const tcp = crearServidorGt06({ alRecibir: (posicion) => cola.encolar(posicion) }).listen(config.tcpPort, () => {
  console.log(`Adaptador: GT06 (TCP) en el puerto ${config.tcpPort}, reenviando a ${config.backendUrl}`);
});

// Docker manda SIGTERM al detener el contenedor: se dejan de aceptar conexiones y se intenta vaciar la cola,
// que vive en memoria. Los dispositivos se reconectan solos al contenedor nuevo
const cerrar = async (senal: string) => {
  console.log(`${senal}: cerrando (${cola.cantidad} posiciones en cola)`);
  tcp.close();
  http.close();
  cola.detener();
  await Promise.race([cola.enviar(), new Promise((resolve) => setTimeout(resolve, ESPERA_CIERRE_MS))]);
  process.exit(0);
};
process.once('SIGTERM', () => void cerrar('SIGTERM'));
process.once('SIGINT', () => void cerrar('SIGINT'));
