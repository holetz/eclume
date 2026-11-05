#!/usr/bin/env bash
# GPU functions shared by deploy.sh and gpu-e2e.sh (to `source`, not to run): the container of a
# production service and the worker-gpu's `eclume:gpu:health busy` signal, which tells whether a
# transcription is in progress. They talk to the environment's docker (in the deploy, the host's context).

service_id() { docker ps -q --filter label=com.docker.compose.project=eclume --filter "label=com.docker.compose.service=$1" | head -n 1; }

gpu_busy() {
  local redis_id
  redis_id="$(service_id redis)"
  [[ -n "$redis_id" ]] || { echo 0; return; }
  # With the ACL (holetz/eclume#94), the CLI authenticates with the password the container itself has;
  # a Redis before it does not have the variable and answers without a user. `valkey-cli` since
  # holetz/eclume#324, `redis-cli` while the container being replaced is still the old Redis image.
  # shellcheck disable=SC2016 # expanded inside the container
  docker exec "$redis_id" sh -c '"$(command -v valkey-cli || echo redis-cli)" --no-auth-warning --raw \
    ${ECLUME_REDIS_SERVER_PASSWORD:+--user eclume-server --pass "$ECLUME_REDIS_SERVER_PASSWORD"} \
    hget eclume:gpu:health busy' 2>/dev/null | tr -dc 0-9 || echo 0
}
