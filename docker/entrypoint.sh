#!/usr/bin/env sh
set -eu

if [ "${RUN_DB_MIGRATIONS:-true}" != "false" ]; then
  npx prisma migrate deploy --schema packages/db/prisma/schema.prisma
fi

exec "$@"
