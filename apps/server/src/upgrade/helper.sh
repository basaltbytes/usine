set -eu
umask 077

record() {
  if [ "$1" = installing ] || [ "$1" = good ]; then
    printf '{"previous":"%s","target":"%s","status":"%s"}\n' \
      "$previous" "$target" "$1" > "$folder/result.tmp"
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
  local wanted=$1
  for ((i=0; i<36; i++)); do
    actual=$(curl --silent --fail --max-time 2 "http://127.0.0.1:$port/api/version") || actual=
    if [ "$actual" = "\"$wanted\"" ]; then return 0; fi
    state=$(systemctl show --property=ActiveState --value "$unit") || return 1
    if [ "$state" = failed ] || [ "$state" = inactive ]; then return 1; fi
    sleep 3
  done
  return 1
}

install_version() {
  timeout 5m npm install --global --prefix "$prefix" "@usine/server@$1"
}

# The lock is outside node_modules and survives replacement of the package.
exec 9> "$folder/helper.lock"
flock -n 9 || exit 0
record installing ''
if ! stop_server; then
  record failed 'Could not stop the server; no package was changed.'
  exit 1
fi
reason='The package could not be installed.'
if install_version "$target"; then
  reason='The new server did not answer the operator API within three minutes.'
  if timeout 30s systemctl start "$unit" && healthy "$target"; then
    record good ''
    exit 0
  fi
fi
printf 'upgrade rollback previous=%s target=%s reason=%s\n' "$previous" "$target" "$reason"
if stop_server && install_version "$previous" && timeout 30s systemctl start "$unit" && healthy "$previous"; then
  record rolled-back "$reason"
else
  record failed 'Rollback failed. Check the upgrade service journal and reinstall the previous version.'
  exit 1
fi
