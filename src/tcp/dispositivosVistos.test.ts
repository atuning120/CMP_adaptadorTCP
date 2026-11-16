import { describe, expect, it } from 'vitest';
import { DispositivosVistos } from './dispositivosVistos.js';

const reloj = () => {
  let actual = new Date('2026-11-16T12:00:00.000Z');
  return {
    ahora: () => actual,
    avanzar: (ms: number) => {
      actual = new Date(actual.getTime() + ms);
    },
  };
};

describe('DispositivosVistos', () => {
  it('recuerda el último login, la última ubicación, cuántas mandó y su batería', () => {
    const { ahora, avanzar } = reloj();
    const vistos = new DispositivosVistos(ahora);

    vistos.login('900000000000012');
    avanzar(1_000);
    vistos.ubicacion('900000000000012', 80);
    vistos.ubicacion('900000000000012', null);

    expect(vistos.lista()).toEqual([
      {
        imei: '900000000000012',
        ultimaConexion: '2026-11-16T12:00:00.000Z',
        ultimaUbicacion: '2026-11-16T12:00:01.000Z',
        ubicaciones: 2,
        bateria: 80,
        conectado: true,
      },
    ]);
  });

  it('sigue en la lista al desconectarse (la app abre una conexión por lote) y acumula entre conexiones', () => {
    const vistos = new DispositivosVistos(reloj().ahora);
    vistos.login('900000000000012');
    vistos.ubicacion('900000000000012', 80);
    vistos.desconexion('900000000000012');

    expect(vistos.lista()[0]).toMatchObject({ conectado: false, ubicaciones: 1, bateria: 80 });

    vistos.login('900000000000012');
    vistos.ubicacion('900000000000012', null);
    expect(vistos.lista()[0]).toMatchObject({ conectado: true, ubicaciones: 2, bateria: 80 });
  });

  it('sigue conectado mientras le quede otra conexión abierta (p. ej. una que aún no expira)', () => {
    const vistos = new DispositivosVistos(reloj().ahora);
    vistos.login('900000000000012');
    vistos.login('900000000000012');
    vistos.desconexion('900000000000012');

    expect(vistos.lista()[0].conectado).toBe(true);
    vistos.desconexion('900000000000012');
    expect(vistos.lista()[0].conectado).toBe(false);
  });

  it('ignora ubicaciones de un IMEI sin login', () => {
    const vistos = new DispositivosVistos(reloj().ahora);
    vistos.ubicacion('900000000000099', 50);
    expect(vistos.lista()).toEqual([]);
  });

  it('ordena por la conexión más reciente', () => {
    const { ahora, avanzar } = reloj();
    const vistos = new DispositivosVistos(ahora);
    vistos.login('900000000000001');
    avanzar(60_000);
    vistos.login('900000000000002');

    expect(vistos.lista().map((d) => d.imei)).toEqual(['900000000000002', '900000000000001']);
  });

  it('con demasiados IMEI olvida el que lleva más tiempo sin conectarse', () => {
    const { ahora, avanzar } = reloj();
    const vistos = new DispositivosVistos(ahora);
    for (let i = 0; i < 1001; i++) {
      vistos.login(String(i).padStart(15, '0'));
      avanzar(1_000);
    }

    const imeis = vistos.lista().map((d) => d.imei);
    expect(imeis).toHaveLength(1000);
    expect(imeis).not.toContain('000000000000000');
    expect(imeis).toContain('000000000001000');
  });
});
