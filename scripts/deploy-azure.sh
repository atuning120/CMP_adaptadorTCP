#!/usr/bin/env bash
# Publica una nueva versión del adaptador en la VM de Azure desde tu PC. El camino normal es el pipeline
# (merge a main); esto queda como respaldo manual.
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

# Se ejecuta dentro de la VM como root, sin SSH. run-command termina bien aunque el script falle
SCRIPT=$(mktemp)
trap 'rm -f "$SCRIPT"' EXIT
{ echo "NUEVA=$IMAGEN:$VERSION"; cat scripts/actualizar-vm.sh; } > "$SCRIPT"
SALIDA=$(az vm run-command invoke -g "$GRUPO" -n "$VM" --command-id RunShellScript \
  --scripts "@$SCRIPT" --query "value[0].message" -o tsv)
echo "$SALIDA"
grep -q DESPLIEGUE_OK <<< "$SALIDA" || { echo "El despliegue falló" >&2; exit 1; }

echo "Desplegado $VERSION"
