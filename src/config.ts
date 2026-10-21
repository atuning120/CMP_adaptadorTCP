// Configuración leída de variables de entorno (en Azure viven en el Container App, nunca en la imagen)
const requerida = (nombre: string): string => {
  const valor = process.env[nombre]?.trim();
  if (!valor) throw new Error(`Falta la variable de entorno ${nombre}`);
  return valor;
};

export function leerConfig() {
  return {
    port: Number(process.env.PORT ?? 3001),
    // Puerto TCP de los dispositivos GT06 (el que usa Traccar para GT06)
    tcpPort: Number(process.env.TCP_PORT ?? 5023),
    backendUrl: requerida('BACKEND_URL').replace(/\/+$/, ''),
    // Misma clave que ADAPTADOR_API_KEY del Backend
    apiKey: requerida('ADAPTADOR_API_KEY'),
  };
}
