import { describe, expect, it } from 'vitest';
import { validarComando } from './comandosPermitidos.js';

describe('validarComando', () => {
  it('acepta la configuración de modo, sensibilidad y alarmas, normalizada', () => {
    expect(validarComando('MODE,1,30,1,1,1#')).toEqual({ ok: true, texto: 'MODE,1,30,1,1,1#' });
    expect(validarComando(' gpsdup,on# ')).toEqual({ ok: true, texto: 'GPSDUP,ON#' });
    expect(validarComando('LEVEL,1#')).toEqual({ ok: true, texto: 'LEVEL,1#' });
    expect(validarComando('REMALM,OFF#')).toEqual({ ok: true, texto: 'REMALM,OFF#' });
    expect(validarComando('MODE#')).toEqual({ ok: true, texto: 'MODE#' });
  });

  it('acepta las consultas sin parámetros y RESET', () => {
    expect(validarComando('PARAM#')).toMatchObject({ ok: true });
    expect(validarComando('STATUS#')).toMatchObject({ ok: true });
    expect(validarComando('RESET#')).toMatchObject({ ok: true });
  });

  it('rechaza lo que puede dejar al equipo sin hablar con el adaptador', () => {
    expect(validarComando('SERVER,1,otro.servidor.com,5023,0#')).toMatchObject({ ok: false });
    expect(validarComando('APN,internet#')).toMatchObject({ ok: false });
    expect(validarComando('FACTORY#')).toMatchObject({ ok: false });
    expect(validarComando('GMT,W,3,0#')).toMatchObject({ ok: false });
  });

  it('rechaza formatos inválidos, parámetros en consultas y lo que no es texto', () => {
    expect(validarComando('PARAM')).toMatchObject({ ok: false });
    expect(validarComando('MODE,1;RESET#')).toMatchObject({ ok: false });
    expect(validarComando('PARAM,1#')).toMatchObject({ ok: false });
    expect(validarComando('')).toMatchObject({ ok: false });
    expect(validarComando(42)).toMatchObject({ ok: false });
    expect(validarComando(`MODE,${'1'.repeat(250)}#`)).toMatchObject({ ok: false });
  });
});
