#!/usr/bin/env bash
# Deploy de Ley Clara a Cloudflare (cuenta de wrangler.jsonc).
#
#   bash scripts/deploy.sh            # todo: D1 remota, datos, verificación del secreto, deploy, prueba
#   bash scripts/deploy.sh --solo-datos   # solo recargar D1 remota (p. ej. tras una nueva versión de la ley)
#
# Requisitos: `npx wrangler login`, el índice Vectorize `leyclara-chunks` ya poblado
# (ver README) y data/build/seed.sql generado con `python -m leyclara.build`.
# ANTHROPIC_API_KEY: si no está en Cloudflare, se sube la de .dev.vars con el deploy
# (o se carga después con scripts/set-api-key.ps1).
set -euo pipefail
cd "$(dirname "$0")/.."

# En algunas redes IPv6 no llega a api.cloudflare.com y wrangler se cuelga.
export NODE_OPTIONS="${NODE_OPTIONS:-} --dns-result-order=ipv4first"
W="npx wrangler"
PLACEHOLDER="00000000-0000-0000-0000-000000000000"

paso() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

[ -f data/build/seed.sql ] || { echo "Falta data/build/seed.sql: cd ingest && uv run python -m leyclara.build"; exit 1; }

paso "1. Base D1 remota"
if grep -q "\"database_id\": \"$PLACEHOLDER\"" <(sed -n '/"env"/q;p' wrangler.jsonc); then
  existente=$($W d1 list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const l=JSON.parse(s);const d=l.find(x=>x.name==="leyclara");console.log(d?d.uuid:"")})')
  if [ -z "$existente" ]; then
    $W d1 create leyclara >/dev/null
    existente=$($W d1 list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.parse(s).find(x=>x.name==="leyclara").uuid)})')
  fi
  # Reemplaza solo el primer placeholder (el entorno principal); --env offline sigue local.
  node -e '
    const fs=require("fs");const p="wrangler.jsonc";let s=fs.readFileSync(p,"utf8");
    s=s.replace(process.argv[1], process.argv[2]);fs.writeFileSync(p,s);' "\"database_id\": \"$PLACEHOLDER\"" "\"database_id\": \"$existente\""
  echo "database_id = $existente (actualizado en wrangler.jsonc)"
else
  echo "wrangler.jsonc ya tiene database_id de producción"
fi

paso "2. Migraciones y datos en D1 remota"
$W d1 migrations apply leyclara --remote --env=""
$W d1 execute leyclara --remote --env="" --file data/build/seed.sql --yes
$W d1 execute leyclara --remote --env="" --json --command "SELECT (SELECT count(*) FROM articulos) AS articulos, (SELECT count(*) FROM chunks_fts) AS fts" | grep -E '"(articulos|fts)"'
[ "${1:-}" = "--solo-datos" ] && exit 0

paso "3. Secreto ANTHROPIC_API_KEY"
secretos=()
if $W secret list --env="" 2>/dev/null | grep -q ANTHROPIC_API_KEY; then
  echo "ya está en Cloudflare"
elif grep -q '^ANTHROPIC_API_KEY=.' .dev.vars 2>/dev/null; then
  # Sube solo la key de .dev.vars (no ADMIN_TOKEN: /admin/index queda cerrado en producción).
  tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
  grep '^ANTHROPIC_API_KEY=' .dev.vars | tr -d '\r' > "$tmp"
  secretos=(--secrets-file "$tmp")
  echo "se subirá desde .dev.vars junto con el deploy"
else
  echo "Falta la key: ejecuta  powershell -ExecutionPolicy Bypass -File scripts\set-api-key.ps1  después del deploy"
fi

paso "4. Deploy del Worker + página"
salida=$($W deploy --env="" "${secretos[@]}" 2>&1 | tee /dev/stderr)
url=$(echo "$salida" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1 || true)

paso "5. Prueba"
if [ -n "$url" ]; then
  curl -fsS "$url/api/meta" && echo
  curl -fsS "$url/api/search?q=vacaciones&k=3" | head -c 300 && echo
  echo "Listo: $url"
else
  echo "No encontré la URL de workers.dev en la salida; revisa el dashboard."
fi
