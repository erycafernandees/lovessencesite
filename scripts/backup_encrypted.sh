#!/usr/bin/env bash
# Love Essences: backup PostgreSQL cifrado para destino externo.
# Os ficheiros Supabase Storage requerem backup separado.
set -euo pipefail
umask 077

: "${SUPABASE_DB_URL:?Configurar SUPABASE_DB_URL com uma ligacao segura}"
: "${BACKUP_AGE_RECIPIENT:?Configurar chave publica age}"
: "${BACKUP_DESTINATION:?Escolher destino privado fora do repositorio}"

for program in pg_dump age mktemp; do
  command -v "$program" >/dev/null 2>&1 || { echo "Falta: $program" >&2; exit 1; }
done
mkdir -p "$BACKUP_DESTINATION"
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT
filename="love-essences-db-$(date -u +%Y%m%d-%H%M%S).dump.age"
target="$BACKUP_DESTINATION/$filename"

pg_dump --dbname="$SUPABASE_DB_URL" --format=custom --no-owner --no-acl --file="$temp_dir/love-essences.dump"
age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$target" "$temp_dir/love-essences.dump"
test -s "$target"
echo "Copia cifrada criada: $target"
echo "Armazena-a fora do Supabase e testa a recuperacao numa base separada."
