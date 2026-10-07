#!/usr/bin/env bash
# Funções de GPU comuns ao deploy.sh e ao gpu-e2e.sh (para `source`, não para executar): o contêiner
# de um serviço da produção e o sinal `eclume:gpu:health busy` do worker-gpu, que diz se há uma
# transcrição em curso. Falam com o docker do ambiente (no deploy, o contexto do host).

service_id() { docker ps -q --filter label=com.docker.compose.project=eclume --filter "label=com.docker.compose.service=$1" | head -n 1; }

gpu_busy() {
  local redis_id
  redis_id="$(service_id redis)"
  [[ -n "$redis_id" ]] || { echo 0; return; }
  # Com a ACL (holetz/eclume#94), o redis-cli autentica com a senha que o próprio contêiner tem; o
  # Redis anterior a ela não tem a variável e responde sem usuário.
  # shellcheck disable=SC2016 # expandida dentro do contêiner
  docker exec "$redis_id" sh -c 'redis-cli --no-auth-warning --raw \
    ${ECLUME_REDIS_SERVER_PASSWORD:+--user eclume-server --pass "$ECLUME_REDIS_SERVER_PASSWORD"} \
    hget eclume:gpu:health busy' 2>/dev/null | tr -dc 0-9 || echo 0
}
