launchd_print() {
  local status
  if timeout 30s launchctl print "$unit" > "$folder/launchd-state.log" 2>&1; then return 0; else status=$?; fi
  if [ "$status" -eq 113 ]; then return 113; fi
  cat "$folder/launchd-state.log" >&2
  return 1
}

service_state() {
  local status
  if launchd_print; then
    if grep -q 'state = running' "$folder/launchd-state.log"; then
      echo active
    elif grep -Eq 'state = (waiting|not running)' "$folder/launchd-state.log"; then
      echo inactive
    elif grep -Eq 'last (exit code|terminating signal) = ' "$folder/launchd-state.log"; then
      echo failed
    else
      echo activating
    fi
  else
    status=$?
    if [ "$status" -eq 113 ]; then echo inactive; else return 1; fi
  fi
}

start_server() {
  timeout 30s launchctl bootstrap "${unit%/*}" "$plist" || return 1
  timeout 30s launchctl kickstart "$unit"
}

stop_server() {
  local status main_pid
  if launchd_print; then
    main_pid=$(awk '/^[[:space:]]*pid = [0-9]+$/ { print $3; exit }' "$folder/launchd-state.log")
  else
    status=$?
    if [ "$status" -eq 113 ]; then return 0; else return 1; fi
  fi
  timeout 30s launchctl bootout "$unit" || return 1
  if [ -z "$main_pid" ]; then return 0; fi
  sleep 1
  if ! kill -0 "$main_pid" 2>/dev/null; then return 0; fi
  kill -TERM "$main_pid" || return 1
  for ((i=0; i<60; i++)); do
    if ! kill -0 "$main_pid" 2>/dev/null; then return 0; fi
    sleep 1
  done
  kill -KILL "$main_pid" || return 1
  for ((i=0; i<5; i++)); do
    if ! kill -0 "$main_pid" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}
