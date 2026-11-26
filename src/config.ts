import { MODOS_LOG_TRAMAS } from './tcp/registroTramas.js';
import type { ModoLogTramas } from './tcp/registroTramas.js';

// Configuración leída de variables de entorno (en Azure viven en /etc/cmp-adaptador.env de la VM, nunca en la imagen)
const requerida = (nombre: string): string => {
  const valor = process.env[nombre]?.trim();
  if (!valor) throw new Error(`Falta la variable de entorno ${nombre}`);
  return valor;
};

const modoLogTramas = (valor: string): ModoLogTramas => {
  const modo = valor.trim().toLowerCase();
  if (!(MODOS_LOG_TRAMAS as readonly string[]).includes(modo)) {
    throw new Error(`LOG_TRAMAS debe ser ${MODOS_LOG_TRAMAS.join(', ')} (llegó "${valor}")`);
  }
  return modo as ModoLogTramas;
};

export function leerConfig() {
  return {
    port: Number(process.env.PORT ?? 3001),
    // Puerto TCP de los dispositivos GT06 (el que usa Traccar para GT06)
    tcpPort: Number(process.env.TCP_PORT ?? 5023),
    backendUrl: requerida('BACKEND_URL').replace(/\/+$/, ''),
    // Misma clave que ADAPTADOR_API_KEY del Backend
    apiKey: requerida('ADAPTADOR_API_KEY'),
    // Tramas GT06 en hex en el log: reales (GPS reales, por defecto), todas (también la app móvil) o no
    logTramas: modoLogTramas(process.env.LOG_TRAMAS?.trim() || 'reales'),
  };
}
