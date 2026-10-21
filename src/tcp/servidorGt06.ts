import net from 'node:net';
import type { PosicionGps } from '../backend/posicion.js';
import { ack, decodificar, extraerTramas, requiereAck } from '../gt06/protocolo.js';

// Sin datos en este tiempo la conexión se cierra (el LL301 manda heartbeat cada pocos minutos)
const INACTIVIDAD_MS = 10 * 60 * 1000;
// Un dispositivo nunca acumula tanto sin una trama completa: es basura o un cliente que no habla GT06
const MAXIMO_BUFFER = 64 * 1024;

export interface OpcionesServidor {
  alRecibir: (posicion: PosicionGps) => void;
  log?: Pick<Console, 'info' | 'warn'>;
}

/**
 * Servidor TCP que recibe a los dispositivos GT06 (LL301 o la app móvil haciéndose pasar por uno). Cada
 * conexión parte con un login que trae el IMEI; las ubicaciones posteriores se asocian a ese IMEI.
 */
export function crearServidorGt06({ alRecibir, log = console }: OpcionesServidor): net.Server {
  return net.createServer((socket) => {
    const origen = `${socket.remoteAddress}:${socket.remotePort}`;
    let imei: string | null = null;
    let bateria: number | null = null;
    let buffer: Buffer = Buffer.alloc(0);

    socket.setTimeout(INACTIVIDAD_MS);
    socket.on('timeout', () => socket.destroy());
    socket.on('error', (error) => log.warn(`Conexión ${origen} (${imei ?? 'sin login'}): ${error.message}`));

    socket.on('data', (datos: Buffer) => {
      buffer = Buffer.concat([buffer, datos]);
      const { tramas, resto, descartadas } = extraerTramas(buffer);
      buffer = resto;
      if (descartadas > 0) log.warn(`Conexión ${origen}: ${descartadas} tramas inválidas descartadas`);
      if (buffer.length > MAXIMO_BUFFER) {
        log.warn(`Conexión ${origen}: datos sin formato GT06, se cierra`);
        socket.destroy();
        return;
      }

      for (const trama of tramas) {
        const mensaje = decodificar(trama);
        if (mensaje.tipo === 'login') {
          imei = mensaje.imei;
          log.info(`Login ${imei} desde ${origen}`);
        } else if (mensaje.tipo === 'heartbeat') {
          bateria = mensaje.bateria ?? bateria;
        } else if (mensaje.tipo === 'ubicacion') {
          const { ubicacion } = mensaje;
          // Sin login no se sabe de qué máquina es; sin fix GPS la posición no sirve
          if (imei && ubicacion.posicionada) {
            alRecibir({
              imei,
              fechaHora: ubicacion.fechaHora.toISOString(),
              latitud: ubicacion.latitud,
              longitud: ubicacion.longitud,
              velocidad: ubicacion.velocidad,
              rumbo: ubicacion.rumbo,
              bateria,
              satelites: ubicacion.satelites,
              enTiempoReal: ubicacion.enTiempoReal,
              tramaHex: trama.cruda.toString('hex'),
            });
          }
        }
        if (requiereAck(trama.protocolo)) socket.write(ack(trama.protocolo, trama.serie));
      }
    });
  });
}
