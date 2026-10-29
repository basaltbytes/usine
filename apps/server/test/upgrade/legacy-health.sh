# Health check from 7bf348a4, before member authentication.
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
