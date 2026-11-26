#!/usr/bin/env bash
# Manda un comando en línea (0x80) a un GPS conectado al adaptador, sin gastar SMS. Es el mismo texto que por SMS.
# Uso:
#   ./scripts/comando-gps.sh 864032050668829 'PARAM#'            # lo envía y espera la respuesta hasta 60 s
#   ./scripts/comando-gps.sh 864032050668829 'MODE,1,30,1,1,1#'
#   ./scripts/comando-gps.sh 864032050668829                     # historial de comandos de ese equipo
#
# Si el equipo no habló en el último minuto, el comando queda en cola hasta su próxima trama (heartbeat cada ~5 min):
# vuelve a correr el script sin comando para ver si respondió. Comandos permitidos: src/gt06/comandosPermitidos.ts.
set -euo pipefail

IMEI=${1:?Indica el IMEI, p. ej.: ./scripts/comando-gps.sh 864032050668829 'PARAM#'}
COMANDO=${2:-}
GRUPO=CMP_Capstone
VM=cmp-adaptador-vm

[[ $IMEI =~ ^[0-9]{15}$ ]] || { echo "El IMEI debe tener 15 dígitos" >&2; exit 1; }
# Mismo formato que valida el adaptador; también evita que el texto rompa el JSON o el script remoto
[[ -z $COMANDO || $COMANDO =~ ^[A-Za-z]+(,[A-Za-z0-9:.-]*)*#$ ]] || {
  echo "Formato inválido: NOMBRE,param1,param2# (debe terminar en #)" >&2
  exit 1
}

# Se ejecuta dentro de la VM como root: la clave se lee de /etc/cmp-adaptador.env y nunca sale de ahí
REMOTO='CLAVE=$(grep "^ADAPTADOR_API_KEY=" /etc/cmp-adaptador.env | cut -d= -f2-)'
if [[ -n $COMANDO ]]; then
  REMOTO+="; curl -s -m 70 -H \"X-Api-Key: \$CLAVE\" -H 'Content-Type: application/json'"
  REMOTO+=" -d '{\"imei\":\"$IMEI\",\"comando\":\"$COMANDO\",\"esperarSegundos\":60}' http://127.0.0.1:3001/comandos"
else
  REMOTO+="; curl -s -m 10 -H \"X-Api-Key: \$CLAVE\" 'http://127.0.0.1:3001/comandos?imei=$IMEI'"
fi

SALIDA=$(az vm run-command invoke -g "$GRUPO" -n "$VM" --command-id RunShellScript \
  --scripts "$REMOTO" --query "value[0].message" -o tsv)
# run-command envuelve la salida con [stdout] / [stderr]: se deja solo el JSON
JSON=$(sed -n '/^\[stdout\]/,/^\[stderr\]/p' <<< "$SALIDA" | sed '1d;$d')
if command -v jq >/dev/null && [[ -n $JSON ]]; then jq . <<< "$JSON"; else echo "${JSON:-$SALIDA}"; fi
