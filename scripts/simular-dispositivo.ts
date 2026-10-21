import net from 'node:net';
import { heartbeat, login, ubicacion } from '../src/gt06/codificador.js';

/*
 * Simula un dispositivo GT06 para probar el flujo completo sin teléfono ni LL301: se conecta al adaptador, hace
 * login con el IMEI y manda una posición cada INTERVALO segundos moviéndose en círculo por la faena.
 *   pnpm simular [idMaquina] [intervaloSegundos] [host] [puerto]
 * El IMEI es el GPS virtual de la máquina ('9' + id en 14 dígitos), igual que la app móvil.
 */
const [idMaquina = '1', intervalo = '10', host = 'localhost', puerto = process.env.TCP_PORT ?? '5023'] = process.argv.slice(2);
const imei = `9${idMaquina.padStart(14, '0')}`;
// Centro del rajo de Los Colorados
const CENTRO = { latitud: -28.2999, longitud: -70.8085 };
const RADIO_GRADOS = 0.004;

let serie = 1;
let paso = 0;
const socket = net.connect(Number(puerto), host, () => {
  console.log(`Conectado a ${host}:${puerto} como ${imei} (máquina ${idMaquina})`);
  socket.write(login(imei, serie++));
  enviar();
  setInterval(enviar, Number(intervalo) * 1000);
});

function enviar() {
  const angulo = (paso++ * Math.PI) / 18;
  const posicion = {
    fechaHora: new Date(),
    latitud: CENTRO.latitud + RADIO_GRADOS * Math.sin(angulo),
    longitud: CENTRO.longitud + RADIO_GRADOS * Math.cos(angulo),
    velocidad: 15,
    rumbo: ((angulo * 180) / Math.PI + 90) % 360,
  };
  // El heartbeat va antes: el adaptador asocia a cada posición la última batería informada
  socket.write(heartbeat(80, serie++));
  socket.write(ubicacion(posicion, serie++));
  console.log(`Enviada ${posicion.latitud.toFixed(5)}, ${posicion.longitud.toFixed(5)}`);
}

socket.on('data', (datos) => console.log(`ACK ${datos.toString('hex')}`));
socket.on('error', (error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
socket.on('close', () => {
  console.log('Conexión cerrada');
  process.exit(0);
});
