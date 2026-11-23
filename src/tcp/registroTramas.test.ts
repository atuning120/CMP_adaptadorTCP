import { describe, expect, it } from 'vitest';
import { duracion, esImeiVirtual, registraTramas, resumir } from './registroTramas.js';

describe('registraTramas', () => {
  it('en modo reales deja fuera solo a la app móvil', () => {
    expect(registraTramas('reales', '864032050668829')).toBe(true);
    expect(registraTramas('reales', null)).toBe(true);
    expect(registraTramas('reales', '900000000000027')).toBe(false);
    expect(registraTramas('todas', '900000000000027')).toBe(true);
    expect(registraTramas('no', '864032050668829')).toBe(false);
  });

  it('reconoce el IMEI virtual de la app', () => {
    expect(esImeiVirtual('900000000000012')).toBe(true);
    expect(esImeiVirtual('864032050668829')).toBe(false);
  });
});

describe('duracion', () => {
  it('usa la unidad que se lee mejor', () => {
    expect(duracion(45_000)).toBe('45 s');
    expect(duracion(125_000)).toBe('2 min 5 s');
    expect(duracion(3_720_000)).toBe('1 h 2 min');
  });
});

describe('resumir', () => {
  const ahora = new Date('2026-11-23T19:00:10.000Z');

  it('muestra la hora GPS y su desfase con la del servidor', () => {
    const resumen = resumir(
      {
        tipo: 'ubicacion',
        ubicacion: {
          fechaHora: new Date('2026-11-23T19:00:00.000Z'),
          latitud: -28.2999,
          longitud: -70.8085,
          velocidad: 15,
          rumbo: 90,
          satelites: 9,
          posicionada: true,
          enTiempoReal: true,
        },
        alarma: 1,
      },
      ahora,
    );
    expect(resumen).toBe('2026-11-23T19:00:00.000Z (desfase -10 s), -28.299900,-70.808500, 15 km/h, 90°, 9 sat, con fix, alarma 0x01');
  });

  it('muestra batería, voltaje, señal y carga del heartbeat', () => {
    expect(resumir({ tipo: 'heartbeat', bateria: 70, voltaje: 4.02, senalGsm: 4, cargando: true }, ahora)).toBe(
      'batería 70%, 4.02 V, GSM 4/4, cargando',
    );
    expect(resumir({ tipo: 'login', imei: '864032050668829', zonaHoraria: 'GMT-3:00' }, ahora)).toBe(
      'IMEI 864032050668829, zona horaria GMT-3:00',
    );
  });
});
