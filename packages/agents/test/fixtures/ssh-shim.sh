#!/bin/sh
# Stands in for ssh: skips the client options and the destination, then runs
# the remote command line on this machine in a separate shell, as sshd does,
# so killing this process leaves that shell to finish on its own.
for argument in "$@"; do
  if [ "$argument" = "-L" ]; then
    while [ "$1" != "-L" ]; do shift; done
    shift
    exec node "$(dirname "$0")/ssh-forward-shim.mjs" "$1"
  fi
done
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
sh -c "$1"
