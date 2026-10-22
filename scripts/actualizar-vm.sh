#!/bin/sh
# Reemplaza el contenedor del adaptador dentro de la VM. No se ejecuta a mano: lo envían con az vm run-command
# el pipeline (.github/workflows/ci.yml) y scripts/deploy-azure.sh, anteponiendo la línea NUEVA=<imagen:tag>.
# La VM ya tiene Docker, el login al ACR y /etc/cmp-adaptador.env con las variables.
# Si el contenedor nuevo no responde /health vuelve a levantar la imagen anterior. run-command termina bien
# aunque el script falle, así que quien lo envía revisa que la salida traiga DESPLIEGUE_OK.
# POSIX sh y no bash: run-command lo ejecuta con sh (dash en Ubuntu) e ignora el shebang.
set -eu

: "${NUEVA:?Falta NUEVA (imagen a desplegar)}"
ANTERIOR=$(docker inspect -f '{{.Config.Image}}' adaptador 2>/dev/null || true)

levantar() {
  docker rm -f adaptador 2>/dev/null || true
  # Los dispositivos se reconectan solos al contenedor nuevo
  docker run -d --name adaptador --restart unless-stopped --env-file /etc/cmp-adaptador.env \
    -p 5023:5023 -p 127.0.0.1:3001:3001 "$1"
}

sano() {
  for _ in $(seq 1 10); do
    curl -fsS --max-time 3 http://127.0.0.1:3001/health && return 0
    sleep 3
  done
  return 1
}

docker pull "$NUEVA"
if levantar "$NUEVA" && sano; then
  docker image prune -f >/dev/null
  echo
  echo DESPLIEGUE_OK
else
  echo "El contenedor nuevo no responde /health. Últimos logs:"
  docker logs --tail 50 adaptador 2>&1 || true
  if [ -n "$ANTERIOR" ]; then
    echo "Volviendo a $ANTERIOR"
    levantar "$ANTERIOR"
  fi
  exit 1
fi
