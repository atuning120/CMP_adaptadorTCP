// Contrato con el Backend (POST /tracking/posiciones): igual para la app móvil y para los LL301
export interface PosicionGps {
  imei: string;
  fechaHora: string; // ISO 8601 en UTC
  latitud: number;
  longitud: number;
  velocidad: number | null; // km/h
  rumbo: number | null; // grados desde el norte
  bateria: number | null; // porcentaje
  satelites: number | null;
  enTiempoReal: boolean;
  tramaHex: string; // trama GT06 original, para depurar
}
