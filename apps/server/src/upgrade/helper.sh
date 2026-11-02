set -eu
umask 077

record() {
  local message=$2
  message=${message//\\/\\\\}
  message=${message//\"/\\\"}
  message=${message//$'\n'/\\n}
  message=${message//$'\r'/\\r}
  message=${message//$'\t'/\\t}
  if [ "$1" = installing ] || [ "$1" = good ]; then
    printf '{"previous":"%s","target":"%s","status":"%s"}\n' \
      "$previous" "$target" "$1" > "$folder/result.tmp"
  elif [ "$1" = rolled-back ]; then
    printf '{"previous":"%s","target":"%s","status":"%s","reason":"%s","failureStage":"%s"}\n' \
      "$previous" "$target" "$1" "$message" "$failure_stage" > "$folder/result.tmp"
  else
    printf '{"previous":"%s","target":"%s","status":"%s","reason":"%s"}\n' \
      "$previous" "$target" "$1" "$message" > "$folder/result.tmp"
  fi
  mv "$folder/result.tmp" "$folder/result.json"
  printf 'upgrade previous=%s target=%s status=%s reason=%s\n' "$previous" "$target" "$1" "$message"
}

stop_server() {
  systemctl stop --no-block "$unit" || return 1
  sleep 1
  # A second signal uses the same recovery path as usine restart --force.
  main_pid=$(systemctl show --property=MainPID --value "$unit") || return 1
  if [ "$main_pid" -gt 0 ] && ! kill -TERM "$main_pid"; then
    printf 'upgrade shutdown unit=%s pid=%s signal=TERM failed; checking unit state\n' "$unit" "$main_pid"
  fi
  for ((i=0; i<60; i++)); do
    state=$(systemctl show --property=ActiveState --value "$unit") || return 1
    if [ "$state" = inactive ] || [ "$state" = failed ]; then return 0; fi
    sleep 1
  done
  main_pid=$(systemctl show --property=MainPID --value "$unit") || return 1
  if [ "$main_pid" -gt 0 ] && ! kill -KILL "$main_pid"; then
    printf 'upgrade shutdown unit=%s pid=%s signal=KILL failed; checking unit state\n' "$unit" "$main_pid"
  fi
  for ((i=0; i<5; i++)); do
    state=$(systemctl show --property=ActiveState --value "$unit") || return 1
    if [ "$state" = inactive ] || [ "$state" = failed ]; then return 0; fi
    sleep 1
  done
  return 1
}

healthy() {
  local wanted=$1 check=$2 token started=$SECONDS deadline=$((SECONDS+180)) remaining request_timeout readiness
  while [ "$SECONDS" -lt "$deadline" ]; do
    remaining=$((deadline-SECONDS))
    if [ "$remaining" -le 0 ]; then break; fi
    request_timeout=2
    if [ "$remaining" -lt "$request_timeout" ]; then request_timeout=$remaining; fi
    actual=
    if token=$(cat "$folder/../admin-token") && [[ "$token" =~ ^[A-Za-z0-9_-]{43}$ ]]; then
      actual=$(printf 'Authorization: Bearer %s\n' "$token" |
        curl --silent --fail --max-time "$request_timeout" --header @- "http://127.0.0.1:$port/api/version") || actual=
    else
      printf 'upgrade health-check version=%s elapsed_seconds=%s reason=admin-token-unavailable\n' "$wanted" "$((SECONDS-started))"
    fi
    if [ "$actual" = "\"$wanted\"" ]; then
      if [ "$check" = version ]; then return 0; fi
      remaining=$((deadline-SECONDS))
      if [ "$remaining" -le 0 ]; then break; fi
      if [ "$remaining" -lt "$request_timeout" ]; then request_timeout=$remaining; fi
      readiness=$(curl --silent --max-time "$request_timeout" --output /dev/null \
        --write-out '%{http_code}' "http://127.0.0.1:$port/api/ready") || readiness=unavailable
      printf 'upgrade health-check version=%s check=ready status=%s elapsed_seconds=%s\n' \
        "$wanted" "$readiness" "$((SECONDS-started))"
      if [ "$readiness" = 200 ] && [ "$SECONDS" -le "$deadline" ]; then return 0; fi
    fi
    state=$(systemctl show --property=ActiveState --value "$unit") || return 1
    if [ "$state" = failed ] || [ "$state" = inactive ]; then
      printf 'upgrade health-check version=%s reason=service-stopped state=%s\n' "$wanted" "$state"
      return 1
    fi
    remaining=$((deadline-SECONDS))
    if [ "$remaining" -le 0 ]; then break; fi
    if [ "$remaining" -gt 3 ]; then remaining=3; fi
    sleep "$remaining"
  done
  printf 'upgrade health-check version=%s reason=deadline-exceeded elapsed_seconds=%s\n' "$wanted" "$((SECONDS-started))"
  return 1
}

prepare_backup() {
  backup_root=${USINE_UPGRADE_BACKUP_DIR-$folder}
  backup_keep=${USINE_UPGRADE_BACKUP_KEEP-3}
  if [[ ! "$backup_keep" =~ ^[1-9][0-9]{0,8}$ ]]; then
    backup_reason='USINE_UPGRADE_BACKUP_KEEP must be an integer between 1 and 999999999; the server and packages were not changed.'
    return 1
  fi
  if [[ "$backup_root" != /* ]]; then
    backup_reason='USINE_UPGRADE_BACKUP_DIR must be an absolute path; the server and packages were not changed.'
    return 1
  fi
  mkdir -p -- "$backup_root" || return 1
  backup_root=$(cd -- "$backup_root" && pwd -P) || return 1
  local database size=0 bytes available required
  for database in runtime.sqlite durable.sqlite runtime.sqlite-wal durable.sqlite-wal; do
    if [ -f "$folder/../$database" ]; then
      bytes=$(stat -c %s -- "$folder/../$database") || return 1
      size=$((size+bytes))
    fi
  done
  required=$((size*2))
  available=$(df -B1 --output=avail -- "$backup_root") || return 1
  available=${available##*$'\n'}
  available=${available//[[:space:]]/}
  [[ "$available" =~ ^[0-9]+$ ]] || return 1
  printf 'upgrade backup-space folder=%s required_bytes=%s available_bytes=%s\n' "$backup_root" "$required" "$available"
  if [ "$available" -lt "$required" ]; then
    backup_reason="Insufficient free disk space in $backup_root. Clean this backup folder before retrying; the server and packages were not changed."
    return 1
  fi
}

prune_backups() {
  local backup retained=1 failed=0
  find "$backup_root" -mindepth 1 -maxdepth 1 -type d -name 'backup.????????' \
    -printf '%T@ %p\0' > "$folder/backups.list" || return 1
  sort -z -nr -o "$folder/backups.list" "$folder/backups.list" || return 1
  while IFS= read -r -d '' backup; do
    backup=${backup#* }
    if [ "$backup" = "$snapshot" ]; then continue; fi
    if [ "$retained" -lt "$backup_keep" ]; then
      retained=$((retained+1))
      continue
    fi
    if rm -rf -- "$backup"; then
      printf 'upgrade backup-prune snapshot=%s status=removed\n' "$backup"
    else
      failed=1
      printf 'upgrade backup-prune snapshot=%s status=failed\n' "$backup" >&2
    fi
  done < "$folder/backups.list"
  rm -f "$folder/backups.list" || return 1
  if [ "$failed" -ne 0 ]; then return 1; fi
  printf 'upgrade backup-prune folder=%s keep=%s current=%s status=complete\n' "$backup_root" "$backup_keep" "$snapshot"
}

backup_data() {
  snapshot=$(mktemp -d "${backup_root%/}/backup.XXXXXXXX") || return 1
  printf 'upgrade backup previous=%s target=%s snapshot=%s\n' "$previous" "$target" "$snapshot"
  (cd "$folder/../.." && timeout 5m node "$prefix/lib/node_modules/@usine/server/dist/main.js" backup "$snapshot/runtime.sqlite") || return 1
  durable_snapshot=
  if [ -f "$snapshot/runtime.durable.sqlite" ]; then durable_snapshot="$snapshot/runtime.durable.sqlite"; fi
}

restore_data() {
  local database restore
  recovery_reason="Rollback failed: could not restore the databases. The service is stopped. Check the upgrade service journal and restore the backup in $snapshot."
  printf 'upgrade restore previous=%s snapshot=%s\n' "$previous" "$snapshot"
  restore=$(mktemp -d "$folder/restore.XXXXXXXX") || return 1
  cp "$snapshot/runtime.sqlite" "$restore/runtime.sqlite" || return 1
  if [ -n "$durable_snapshot" ]; then
    cp "$durable_snapshot" "$restore/durable.sqlite" || return 1
  fi
  for database in runtime durable; do
    rm -f "$folder/../$database.sqlite-wal" "$folder/../$database.sqlite-shm" || return 1
    if [ -f "$restore/$database.sqlite" ]; then
      mv "$restore/$database.sqlite" "$folder/../$database.sqlite" || return 1
    else
      rm -f "$folder/../$database.sqlite" || return 1
    fi
  done
  rmdir "$restore" || return 1
  recovery_reason=
  printf 'upgrade restore previous=%s status=complete snapshot=%s\n' "$previous" "$snapshot"
}

install_version() {
  local version=$1 attempt output exit_code
  for ((attempt=1; attempt<=3; attempt++)); do
    printf 'upgrade install version=%s attempt=%s\n' "$version" "$attempt"
    if timeout 5m npm install --global --prefix "$prefix" "@usine/server@$version" > "$folder/install.log" 2>&1; then
      cat "$folder/install.log"
      return 0
    else
      exit_code=$?
    fi
    output=$(< "$folder/install.log")
    printf '%s\n' "$output"
    if [ "$exit_code" -eq 124 ] || [ "$attempt" -eq 3 ] || \
      [[ ! "$output" =~ npm[[:space:]]+(ERR!|error)[[:space:]]+code[[:space:]]+(ETARGET|E404)($|[[:space:]]) ]]; then
      printf 'upgrade install failed version=%s attempt=%s exit_code=%s\n' "$version" "$attempt" "$exit_code"
      return 1
    fi
    printf 'upgrade install retry version=%s attempt=%s delay_seconds=60\n' "$version" "$attempt"
    sleep 60
  done
}

installed_version() {
  node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version' \
    "$prefix/lib/node_modules/@usine/server/package.json"
}

restore_previous() {
  if [ "$failure_stage" = install ] && [ "$(installed_version)" = "$previous" ]; then
    recovery_status=failed
    printf 'upgrade recovery version=%s action=restart reason=previous-version-still-installed\n' "$previous"
    return 0
  fi
  if install_version "$previous"; then return 0; fi
  if [ "$(installed_version)" = "$previous" ]; then
    recovery_status=failed
    printf 'upgrade recovery version=%s action=restart reason=rollback-install-failed\n' "$previous"
    return 0
  fi
  return 1
}

# The lock is outside node_modules and survives replacement of the package.
exec 9> "$folder/helper.lock"
flock -n 9 || exit 0
record installing ''
backup_reason='Could not prepare database backups; the server and packages were not changed. Check the upgrade service journal.'
if ! prepare_backup; then
  record failed "$backup_reason"
  exit 1
fi
if ! backup_data; then
  record failed 'Could not back up the databases; the server and packages were not changed. Check the upgrade service journal.'
  exit 1
fi
if ! stop_server; then
  record failed 'Could not stop the server; no package was changed.'
  exit 1
fi
reason='The package could not be installed.'
failure_stage=install
if install_version "$target"; then
  reason='The new server did not become ready within three minutes.'
  failure_stage=health-check
  if timeout 30s systemctl start "$unit" && healthy "$target" ready; then
    if ! prune_backups; then
      printf 'upgrade backup-prune folder=%s status=failed; check the upgrade service journal and remove old backups manually\n' "$backup_root" >&2
    fi
    record good ''
    exit 0
  fi
fi
printf 'upgrade rollback previous=%s target=%s failure_stage=%s reason=%s\n' "$previous" "$target" "$failure_stage" "$reason"
recovery_status=rolled-back
recovery_reason=
if stop_server && restore_previous && restore_data && timeout 30s systemctl start "$unit" && healthy "$previous" version; then
  record "$recovery_status" "$reason"
  if [ "$recovery_status" = failed ]; then exit 1; fi
else
  if ! stop_server; then
    record failed 'Rollback failed and the service could not be stopped. Stop it manually and check the upgrade service journal.'
    exit 1
  fi
  if [ -n "$recovery_reason" ]; then
    record failed "$recovery_reason"
    exit 1
  fi
  installed=$(installed_version) || installed=
  case "$installed" in
    "$previous"|"$target") record failed 'Rollback failed. Check the upgrade service journal.';;
    *) record failed 'Rollback failed. Check the upgrade service journal and reinstall the previous version.';;
  esac
  exit 1
fi
