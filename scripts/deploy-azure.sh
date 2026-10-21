#!/usr/bin/env bash
# Publica una nueva versión del adaptador en la VM de Azure.
# Uso: ./scripts/deploy-azure.sh v2
#
# El adaptador corre en una VM (no en Container Apps Express) porque necesita un puerto TCP público para los
# dispositivos GT06. La VM ya tiene Docker, el login al registro y /etc/cmp-adaptador.env con las variables
# (ver README, "Despliegue en Azure"); aquí solo se publica la imagen y se reemplaza el contenedor.
set -euo pipefail

VERSION=${1:?Indica la versión, p. ej.: ./scripts/deploy-azure.sh v2}
REGISTRO=cmpcapstoneacr
IMAGEN=$REGISTRO.azurecr.io/cmp-adaptador
GRUPO=CMP_Capstone
VM=cmp-adaptador-vm

cd "$(dirname "$0")/.."

az acr login -n "$REGISTRO" >/dev/null
docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
  -t "$IMAGEN:$VERSION" -t "$IMAGEN:latest" --push .

# Se ejecuta dentro de la VM como root, sin SSH. Los dispositivos se reconectan solos al contenedor nuevo
az vm run-command invoke -g "$GRUPO" -n "$VM" --command-id RunShellScript --query "value[0].message" -o tsv --scripts "
set -e
docker pull $IMAGEN:$VERSION
docker rm -f adaptador 2>/dev/null || true
docker run -d --name adaptador --restart unless-stopped --env-file /etc/cmp-adaptador.env \
  -p 5023:5023 -p 127.0.0.1:3001:3001 $IMAGEN:$VERSION
sleep 3
curl -fsS http://127.0.0.1:3001/health
docker image prune -f >/dev/null
"

echo "Desplegado $VERSION"
