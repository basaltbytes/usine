# Bounded supervisor conversation storage

Supervisor conversations persist in preallocated ext4 images mounted with FUSE on the orchestrator host. Docker and Podman bind-mount the same filesystem, and Pi writes its session files through the host mount. This provides one capacity boundary for every writer. Container storage-driver quotas do not bound host-side writes to a bind mount, and periodically measuring a directory cannot stop a fast writer before it fills the instance disk.

Preallocation reserves the configured capacity before a turn starts. The image cannot grow when its filesystem fills, so writes fail with a no-space error. This requires Linux, FUSE access and filesystem tools on the host, and reserves capacity for each saved conversation. An unavailable mount refuses the turn. Changing an existing image's capacity requires offline migration; usine does not silently grow it after a configuration edit.

Container cleanup precedes unmounting. Turns, shutdown and startup remove containers by labels, and an earlier container prevents another turn from accessing the conversation. The relay heartbeat is best effort because a session can stop that process.
