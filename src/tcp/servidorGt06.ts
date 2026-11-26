import net from 'node:net';
import type { PosicionGps } from '../backend/posicion.js';
import { ack, decodificar, extraerTramas, nombreProtocolo, requiereAck, respuestaHora } from '../gt06/protocolo.js';
import type { DispositivosVistos } from './dispositivosVistos.js';
import { DESFASE_SOSPECHOSO_MS, duracion, registraTramas, resumir } from './registroTramas.js';
import type { ModoLogTramas } from './registroTramas.js';

// Sin datos en este tiempo la conexión se cierra (el LL301 manda heartbeat cada pocos minutos)
const INACTIVIDAD_MS = 10 * 60 * 1000;
// Un dispositivo nunca acumula tanto sin una trama completa: es basura o un cliente que no habla GT06
const MAXIMO_BUFFER = 64 * 1024;

export interface OpcionesServidor {
  alRecibir: (posicion: PosicionGps) => void;
  log?: Pick<Console, 'info' | 'warn'>;
  // Para el diagnóstico de /health
  dispositivos?: DispositivosVistos;
  // Tramas en hex en el log (ver registroTramas.ts)
  logTramas?: ModoLogTramas;
  ahora?: () => Date;
}

/**
 * Servidor TCP que recibe a los dispositivos GT06 (LL301 o la app móvil haciéndose pasar por uno). Cada
 * conexión parte con un login que trae el IMEI; las ubicaciones posteriores se asocian a ese IMEI.
 */
export function crearServidorGt06({
  alRecibir,
  log = console,
  dispositivos,
  logTramas = 'no',
  ahora = () => new Date(),
}: OpcionesServidor): net.Server {
  return net.createServer((socket) => {
    // Puede no estar si la conexión se cortó apenas se aceptó
    const origen = socket.remoteAddress ? `${socket.remoteAddress}:${socket.remotePort}` : 'origen desconocido';
    const inicio = ahora();
    let imei: string | null = null;
    let bateria: number | null = null;
    let buffer: Buffer = Buffer.alloc(0);
    let tramasRecibidas = 0;
    let ultimaTrama: { protocolo: number; fecha: Date } | null = null;
    // Quién cerró la conexión, para saber si un equipo en reposo corta solo o lo corta el timeout de aquí
    let motivoCierre: string | null = null;

    const etiqueta = () => imei ?? `sin login (${origen})`;
    const conLog = () => registraTramas(logTramas, imei);
    const enviar = (datos: Buffer, protocolo: number, serie: number) => {
      socket.write(datos);
      if (conLog()) log.info(`TX ${etiqueta()} ${nombreProtocolo(protocolo)} #${serie} | ${datos.toString('hex')}`);
    };

    socket.setTimeout(INACTIVIDAD_MS);
    socket.on('timeout', () => {
      motivoCierre = `la cerró el servidor: ${duracion(INACTIVIDAD_MS)} sin datos`;
      socket.destroy();
    });
    socket.on('end', () => {
      motivoCierre ??= 'la cerró el equipo';
    });
    socket.on('error', (error) => {
      motivoCierre ??= `error: ${error.message}`;
      log.warn(`Conexión ${origen} (${imei ?? 'sin login'}): ${error.message}`);
    });
    socket.on('close', () => {
      if (imei) dispositivos?.desconexion(imei);
      // Las conexiones que nunca mandaron una trama válida son escáneres de internet: no se registran
      if (!conLog() || tramasRecibidas === 0) return;
      const fin = ahora();
      const ultima = ultimaTrama
        ? `última trama hace ${duracion(fin.getTime() - ultimaTrama.fecha.getTime())} (${nombreProtocolo(ultimaTrama.protocolo)})`
        : 'sin tramas';
      log.info(
        `Desconexión ${etiqueta()}: ${motivoCierre ?? 'cerrada'}; duró ${duracion(fin.getTime() - inicio.getTime())}, ` +
          `${tramasRecibidas} tramas, ${ultima}`,
      );
    });

    socket.on('data', (datos: Buffer) => {
      buffer = Buffer.concat([buffer, datos]);
      const { tramas, resto, descartadas } = extraerTramas(buffer);
      buffer = resto;
      if (descartadas > 0) log.warn(`Conexión ${origen}: ${descartadas} tramas inválidas descartadas`);
      if (buffer.length > MAXIMO_BUFFER) {
        motivoCierre = 'la cerró el servidor: datos sin formato GT06';
        log.warn(`Conexión ${origen}: datos sin formato GT06, se cierra`);
        socket.destroy();
        return;
      }

      for (const trama of tramas) {
        const recibida = ahora();
        const mensaje = decodificar(trama);
        tramasRecibidas += 1;
        ultimaTrama = { protocolo: trama.protocolo, fecha: recibida };

        if (mensaje.tipo === 'login') {
          // Un segundo login en la misma conexión (otro IMEI) cierra el registro del anterior
          if (imei && imei !== mensaje.imei) dispositivos?.desconexion(imei);
          if (imei !== mensaje.imei) dispositivos?.login(mensaje.imei);
          imei = mensaje.imei;
          log.info(`Login ${imei} desde ${origen}`);
        }
        // Después del login, para que su propia línea ya lleve el IMEI
        if (conLog()) {
          log.info(
            `RX ${etiqueta()} ${nombreProtocolo(trama.protocolo)} #${trama.serie} ${resumir(mensaje, recibida)} | ` +
              trama.cruda.toString('hex'),
          );
        }

        if (mensaje.tipo === 'heartbeat') {
          bateria = mensaje.bateria ?? bateria;
        } else if (mensaje.tipo === 'ubicacion') {
          const { ubicacion } = mensaje;
          const desfase = ubicacion.fechaHora.getTime() - recibida.getTime();
          if (conLog() && ubicacion.enTiempoReal && Math.abs(desfase) > DESFASE_SOSPECHOSO_MS) {
            log.warn(
              `${etiqueta()}: la hora GPS difiere ${duracion(Math.abs(desfase))} de la del servidor ` +
                '(las tramas deben venir en UTC: ¿zona horaria del equipo?)',
            );
          }
          // Sin login no se sabe de qué máquina es; sin fix GPS la posición no sirve
          if (imei && ubicacion.posicionada) {
            dispositivos?.ubicacion(imei, bateria);
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

        if (mensaje.tipo === 'hora') enviar(respuestaHora(trama.serie, recibida), trama.protocolo, trama.serie);
        else if (requiereAck(trama.protocolo)) enviar(ack(trama.protocolo, trama.serie), trama.protocolo, trama.serie);
      }
    });
  });
}
