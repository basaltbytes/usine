export const CONTAINER_LIMITS_SCRIPT = String.raw`
read quota period < /sys/fs/cgroup/cpu.max
awk -v q="$quota" -v p="$period" -v cpus="$1" 'BEGIN { exit !(q != "max" && p > 0 && q == int(cpus * p)) }'
[ "$(cat /sys/fs/cgroup/memory.max)" = "$2" ]
[ "$(cat /sys/fs/cgroup/memory.swap.max)" = 0 ]
[ "$(cat /sys/fs/cgroup/pids.max)" = "$3" ]
`;
