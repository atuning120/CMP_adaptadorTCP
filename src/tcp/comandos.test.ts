import { describe, expect, it, vi } from 'vitest';
import { Comandos } from './comandos.js';

const IMEI = '864032050668829';
const OTRO = '864032050668795';

function conReloj(inicio = '2026-11-26T12:00:00.000Z') {
  let ahora = new Date(inicio).getTime();
  const comandos = new Comandos(() => new Date(ahora));
  return { comandos, avanzar: (ms: number) => (ahora += ms) };
}

describe('Comandos', () => {
  it('deja en cola el comando de un equipo sin conexión y lo envía en su próxima trama', () => {
    const { comandos } = conReloj();
    const enviar = vi.fn();

    const comando = comandos.encolar(IMEI, 'PARAM#');
    expect(comando).toMatchObject({ id: 1, estado: 'en cola', enviado: null });

    comandos.actividad(IMEI, enviar);
    expect(enviar).toHaveBeenCalledWith('PARAM#', 1);
    expect(comandos.obtener(1)).toMatchObject({ estado: 'enviado', enviado: '2026-11-26T12:00:00.000Z' });

    // No se reenvía en la trama siguiente
    comandos.actividad(IMEI, enviar);
    expect(enviar).toHaveBeenCalledTimes(1);
  });

  it('envía al tiro si el equipo habló hace menos de un minuto, y espera si fue antes', () => {
    const { comandos, avanzar } = conReloj();
    const enviar = vi.fn();
    comandos.actividad(IMEI, enviar);

    avanzar(30_000);
    comandos.encolar(IMEI, 'PARAM#');
    expect(enviar).toHaveBeenCalledTimes(1);

    avanzar(2 * 60_000);
    comandos.encolar(IMEI, 'STATUS#');
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(comandos.obtener(2)?.estado).toBe('en cola');
  });

  it('solo envía los comandos de ese equipo', () => {
    const { comandos } = conReloj();
    const enviar = vi.fn();
    comandos.encolar(OTRO, 'PARAM#');
    comandos.actividad(IMEI, enviar);
    expect(enviar).not.toHaveBeenCalled();
  });

  it('olvida la conexión cerrada, pero no si el equipo ya usa otra', () => {
    const { comandos } = conReloj();
    const vieja = vi.fn();
    const nueva = vi.fn();
    comandos.actividad(IMEI, vieja);
    comandos.actividad(IMEI, nueva);

    comandos.cierre(IMEI, vieja);
    comandos.encolar(IMEI, 'PARAM#');
    expect(nueva).toHaveBeenCalledWith('PARAM#', 1);

    comandos.cierre(IMEI, nueva);
    comandos.encolar(IMEI, 'STATUS#');
    expect(nueva).toHaveBeenCalledTimes(1);
  });

  it('guarda la respuesta y la entrega a quien la espera', async () => {
    const { comandos } = conReloj();
    comandos.actividad(IMEI, vi.fn());
    const { id } = comandos.encolar(IMEI, 'MODE#');

    const espera = comandos.esperarRespuesta(id, 5_000);
    expect(comandos.respuesta(IMEI, id, 'MODE=2,20,180,1,1,1,1')).toMatchObject({ estado: 'respondido' });

    expect(await espera).toMatchObject({ estado: 'respondido', respuesta: 'MODE=2,20,180,1,1,1,1' });
  });

  it('no acepta la respuesta con la bandera de otro equipo o de un comando que no se envió', () => {
    const { comandos } = conReloj();
    const { id } = comandos.encolar(IMEI, 'PARAM#');
    expect(comandos.respuesta(IMEI, id, 'OK')).toBeNull();
    comandos.actividad(IMEI, vi.fn());
    expect(comandos.respuesta(OTRO, id, 'OK')).toBeNull();
    expect(comandos.respuesta(IMEI, 99, 'OK')).toBeNull();
  });

  it('esperarRespuesta devuelve el estado actual si el equipo no responde a tiempo', async () => {
    const { comandos } = conReloj();
    const { id } = comandos.encolar(IMEI, 'PARAM#');
    expect(await comandos.esperarRespuesta(id, 10)).toMatchObject({ estado: 'en cola' });
  });

  it('marca sin respuesta a los 5 min, acepta una respuesta tardía y expira lo que nunca se pudo enviar', () => {
    const { comandos, avanzar } = conReloj();
    comandos.actividad(IMEI, vi.fn());
    const enviado = comandos.encolar(IMEI, 'PARAM#');
    const enCola = comandos.encolar(OTRO, 'PARAM#');

    avanzar(6 * 60_000);
    expect(comandos.obtener(enviado.id)?.estado).toBe('sin respuesta');
    expect(comandos.respuesta(IMEI, enviado.id, 'tarde')).toMatchObject({ estado: 'respondido' });

    avanzar(25 * 60 * 60_000);
    expect(comandos.obtener(enCola.id)?.estado).toBe('expirado');
    const enviar = vi.fn();
    comandos.actividad(OTRO, enviar);
    expect(enviar).not.toHaveBeenCalled();
  });

  it('lista el más reciente primero, filtrando por equipo', () => {
    const { comandos } = conReloj();
    comandos.encolar(IMEI, 'PARAM#');
    comandos.encolar(OTRO, 'STATUS#');
    comandos.encolar(IMEI, 'MODE#');
    expect(comandos.lista(IMEI).map((c) => c.texto)).toEqual(['MODE#', 'PARAM#']);
    expect(comandos.lista()).toHaveLength(3);
  });
});
