// Configuración leída de variables de entorno (en Azure viven en el Container App, nunca en la imagen)
export const config = {
  port: Number(process.env.PORT ?? 3001),
};
