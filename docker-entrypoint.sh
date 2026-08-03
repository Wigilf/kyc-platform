#!/bin/sh
set -e

# Apply migrations before serving.
#
# Render's preDeployCommand is a paid-plan feature — the API accepts the field
# on a free service and silently drops it, so a free deployment would come up
# against an empty database and only fail once something touched a table.
# Doing it here means the image migrates itself wherever it runs.
#
# `migrate deploy` is a no-op when the database is current, and it takes a
# Postgres advisory lock, so concurrent instances starting together are safe.
if [ "${RUN_MIGRATIONS_ON_BOOT:-true}" = "true" ]; then
  echo "[entrypoint] applying migrations"
  node_modules/.bin/prisma migrate deploy --schema packages/db/prisma/schema.prisma
fi

exec "$@"
