#!/usr/bin/env bash
set -euo pipefail

# Runs on the GitHub-hosted Linux runner; secrets are supplied through step env.
: "${ECS_HOST:?}" "${ECS_USER:?}" "${ECS_SSH_KEY:?}"
ECS_PORT="${ECS_PORT:-22}"
IMAGE_FILE="${1:?Usage: wms-upload-image.sh IMAGE_FILE}"
IMAGE_NAME="$(basename "$IMAGE_FILE")"
[[ "$ECS_HOST" =~ ^[A-Za-z0-9.:-]+$ && "$ECS_USER" =~ ^[A-Za-z0-9_.-]+$ && "$ECS_PORT" =~ ^[0-9]+$ ]] || { echo 'Invalid SSH connection settings'; exit 1; }
[[ "$IMAGE_NAME" =~ ^wms-api-[0-9a-f]{40}\.tar\.gz$ && -s "$IMAGE_FILE" ]] || { echo 'Missing or invalid image archive'; exit 1; }

TASK_SSH_DIR="$(mktemp -d)"
PROGRESS_PID=''
cleanup() {
  if [[ -n "$PROGRESS_PID" ]]; then
    pkill -P "$PROGRESS_PID" 2>/dev/null || true
    kill "$PROGRESS_PID" 2>/dev/null || true
    wait "$PROGRESS_PID" 2>/dev/null || true
  fi
  rm -rf -- "$TASK_SSH_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
umask 077
printf '%s\n' "$ECS_SSH_KEY" > "$TASK_SSH_DIR/key"
unset ECS_SSH_KEY
ssh-keyscan -T 30 -p "$ECS_PORT" "$ECS_HOST" > "$TASK_SSH_DIR/known_hosts" 2>/dev/null
[[ -s "$TASK_SSH_DIR/known_hosts" ]] || { echo 'Unable to read server SSH host key'; exit 1; }
SSH_OPTIONS=(-i "$TASK_SSH_DIR/key" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$TASK_SSH_DIR/known_hosts" -o ConnectTimeout=30
  -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
DESTINATION="${ECS_USER}@${ECS_HOST}"
remote() { ssh "${SSH_OPTIONS[@]}" -p "$ECS_PORT" "$DESTINATION" "$@"; }

IMAGE_SHA="$(sha256sum "$IMAGE_FILE" | cut -d ' ' -f 1)"
IMAGE_BYTES="$(stat -c %s "$IMAGE_FILE")"
# A rebuild of the same commit may produce different bytes; only resume identical archives.
REMOTE_PARTIAL="/tmp/${IMAGE_NAME}.${IMAGE_SHA:0:16}.partial"
REMOTE_FINAL="/tmp/${IMAGE_NAME}"
echo "Image archive: ${IMAGE_BYTES} bytes"
echo 'Checking server resources before upload'
remote "df -h /tmp; free -m; docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}'" </dev/null

(
  while sleep 60; do
    BYTES="$(remote "stat -c %s '${REMOTE_PARTIAL}' 2>/dev/null || printf 0" </dev/null)" || continue
    echo "Upload progress: ${BYTES}/${IMAGE_BYTES} bytes"
  done
) &
PROGRESS_PID=$!

for attempt in 1 2 3; do
  echo "Upload attempt ${attempt}/3 (resuming any matching partial archive)"
  if printf 'reput "%s" "%s"\n' "$IMAGE_FILE" "$REMOTE_PARTIAL" |
    timeout --kill-after=15s 8m sftp "${SSH_OPTIONS[@]}" -P "$ECS_PORT" -b - "$DESTINATION"; then
    if remote "printf '%s  %s\\n' '${IMAGE_SHA}' '${REMOTE_PARTIAL}' | sha256sum -c - && mv -- '${REMOTE_PARTIAL}' '${REMOTE_FINAL}'" </dev/null; then
      echo 'Image upload complete; SHA-256 verified'
      exit 0
    fi
    echo 'Archive verification failed; discarding only this partial archive before retry'
    remote "rm -f -- '${REMOTE_PARTIAL}'" </dev/null
  fi
  if [[ "$attempt" != 3 ]]; then sleep 5; fi
done
echo 'Image upload failed after three resumable attempts; service was not updated'
exit 1
