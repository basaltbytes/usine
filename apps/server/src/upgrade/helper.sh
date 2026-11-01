set -eu
umask 077

record() {
  if [ "$1" = installing ] || [ "$1" = good ]; then
    printf '{"previous":"%s","target":"%s","status":"%s"}\n' \
      "$previous" "$target" "$1" > "$folder/result.tmp"
  elif [ "$1" = rolled-back ]; then
    printf '{"previous":"%s","target":"%s","status":"%s","reason":"%s","failureStage":"%s"}\n' \
      "$previous" "$target" "$1" "$2" "$failure_stage" > "$folder/result.tmp"
  else
    printf '{"previous":"%s","target":"%s","status":"%s","reason":"%s"}\n' \
      "$previous" "$target" "$1" "$2" > "$folder/result.tmp"
  fi
  mv "$folder/result.tmp" "$folder/result.json"
  printf 'upgrade previous=%s target=%s status=%s reason=%s\n' "$previous" "$target" "$1" "$2"
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

backup_data() {
  snapshot=$(mktemp -d "$folder/backup.XXXXXXXX") || return 1
  printf 'upgrade backup previous=%s target=%s snapshot=%s\n' "$previous" "$target" "$snapshot"
  (cd "$folder/../.." && timeout 5m node "$prefix/lib/node_modules/@usine/server/dist/main.js" backup "$snapshot/runtime.sqlite") || return 1
  durable_snapshot=
  if [ -f "$snapshot/runtime.durable.sqlite" ]; then durable_snapshot="$snapshot/runtime.durable.sqlite"; fi
}

restore_data() {
  local database
  recovery_reason='Rollback failed: could not restore the databases. The service is stopped. Check the upgrade service journal and restore the backup in .usine/upgrade/backup.*.'
  printf 'upgrade restore previous=%s snapshot=%s\n' "$previous" "$snapshot"
  cp "$snapshot/runtime.sqlite" "$snapshot/runtime.restore" || return 1
  if [ -n "$durable_snapshot" ]; then
    cp "$durable_snapshot" "$snapshot/durable.restore" || return 1
  fi
  for database in runtime durable; do
    rm -f "$folder/../$database.sqlite-wal" "$folder/../$database.sqlite-shm" || return 1
    if [ -f "$snapshot/$database.restore" ]; then
      mv "$snapshot/$database.restore" "$folder/../$database.sqlite" || return 1
    else
      rm -f "$folder/../$database.sqlite" || return 1
    fi
  done
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
