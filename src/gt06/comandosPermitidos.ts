import { LARGO_MAXIMO_COMANDO } from './protocolo.js';

/*
 * Comandos del LL301 que se pueden mandar por el adaptador (lista de comandos oficial del LL301, la misma sintaxis
 * que por SMS). Quedan fuera los que pueden dejar al equipo sin hablar con el adaptador (SERVER, APN, FACTORY) o
 * cambiar la hora de las tramas (GMT): esos solo por SMS, a conciencia.
 */

// Configuración: se aceptan con parámetros (p. ej. 'MODE,1,30,1,1,1#') o solos para consultarlos ('MODE#')
const CONFIGURABLES = new Set([
  'MODE', // modo de trabajo: 1 temporizado, 2 inteligente, 3 ahorro de batería
  'GPSDUP', // en modo inteligente, posiciones también estando detenido (cada T2 de MODE)
  'LEVEL', // sensibilidad del sensor de movimiento, 1 (más sensible) a 5
  'REMALM', // alarma de manipulación (botón anti-manipulación, 0x13)
  'REMALMF', // alarma de tapa abierta (0x18)
  'SENALM', // alarma de vibración
  'BATALM', // alarma de batería baja
]);

// Solo consulta, sin parámetros. RESET# reinicia el equipo (vuelve a conectarse solo)
const SIN_PARAMETROS = new Set([
  'VERSION',
  'PARAM',
  'GPRSSET',
  'STATUS',
  'WHERE',
  'POSITION',
  'URL',
  'GMT',
  'PWRLIMIT',
  'AUTOSTART',
  'TEMPTIMER',
  'TEMPALM',
  'RESET',
]);

// Nombre, parámetros opcionales separados por coma (letras, números, ':', '.', '-') y el '#' final
const FORMATO = /^([A-Z]+)((?:,[A-Z0-9:.-]*)*)#$/;

export type ResultadoComando = { ok: true; texto: string } | { ok: false; error: string };

// Normaliza el comando (mayúsculas, sin espacios) y lo rechaza si no está permitido o no tiene el formato
export function validarComando(entrada: unknown): ResultadoComando {
  if (typeof entrada !== 'string') return { ok: false, error: 'El comando debe ser un texto, p. ej. "PARAM#"' };
  const texto = entrada.replace(/\s+/g, '').toUpperCase();
  if (texto.length === 0 || texto.length > LARGO_MAXIMO_COMANDO) {
    return { ok: false, error: `El comando debe tener entre 1 y ${LARGO_MAXIMO_COMANDO} caracteres` };
  }
  const partes = FORMATO.exec(texto);
  if (!partes) return { ok: false, error: 'Formato inválido: NOMBRE,param1,param2# (debe terminar en #)' };
  const [, nombre, parametros] = partes;
  if (CONFIGURABLES.has(nombre)) return { ok: true, texto };
  if (SIN_PARAMETROS.has(nombre)) {
    return parametros ? { ok: false, error: `${nombre} no acepta parámetros: se envía como ${nombre}#` } : { ok: true, texto };
  }
  return {
    ok: false,
    error: `${nombre} no está permitido. Permitidos: ${[...CONFIGURABLES, ...SIN_PARAMETROS].join(', ')}`,
  };
}
