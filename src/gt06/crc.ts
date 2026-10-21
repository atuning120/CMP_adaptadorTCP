// CRC-ITU (CRC-16/X-25) que usa GT06 para validar cada trama: polinomio 0x1021 reflejado, inicio y XOR final 0xFFFF
export function crcItu(datos: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of datos) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
    }
  }
  return ~crc & 0xffff;
}
