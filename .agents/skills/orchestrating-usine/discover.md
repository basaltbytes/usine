# Discover the instance

Produce `.scratchpad/orchestrating-usine/env.sh` with these variables. Every script in `scripts/` sources it.

```sh
USINE_URL=        # operator API base, no trailing slash
USINE_TOKEN=      # bearer token, empty while the API has no auth
USINE_SSH=        # ssh destination of the orchestrator host, empty when local
USINE_DIR=        # instance folder on that host
USINE_BIN=        # absolute path of the usine executable on that host
USINE_REPOS=      # space-separated owner/name of the managed repositories
USINE_APP=        # GitHub login of the instance's App, as `app/<slug>`, for `gh pr list --author`
```

Work down this list and stop at the first hit for each variable.

## Operator-specific notes

Before probing, read what the operator already recorded: the memory index in `~/.claude/projects/<project>/memory/MEMORY.md` (an entry about the dogfood or factory instance names the host, the folder, and the gotchas), a handoff file the human pointed at, and the repository's `infra/` folder, whose README describes how the operator's servers were built. These beat probing, and they carry the gotchas probing cannot see.

## Local instance

An instance folder has `usine.yaml` or a `.usine/` folder. Candidates: the current directory, a sibling of the repository checkout named after the factory, and `~/Code/*/.usine`.

```sh
cd <folder> && usine status          # prints address, version, pid, open runs; exit 3 when stopped
cat .usine/instance.json             # pid, version, launch.port, systemdUnit
```

`USINE_URL` is `http://127.0.0.1:<launch.port>`. `USINE_BIN` is `command -v usine`, or `node <checkout>/apps/server/dist/main.js` for an instance that runs from a checkout.

## Remote instance

```sh
grep -E '^Host ' ~/.ssh/config | grep -i usine        # candidate destinations
ssh <dest> 'systemctl show usine.service -p WorkingDirectory -p ExecStart -p ActiveState'
ssh <dest> 'cat <WorkingDirectory>/.usine/instance.json'
ssh <dest> 'command -v usine || ls ~/.local/bin/usine /usr/local/bin/usine 2>/dev/null'
```

The API is on loopback on the host. Reach it one of three ways, in order of preference:

1. A reverse proxy the operator set up: `tailscale status` on your machine lists tailnet names; `ssh <dest> tailscale serve status` shows what the host publishes. `USINE_URL` is then `https://<name>`.
2. An SSH tunnel: `ssh -N -L 7331:127.0.0.1:7331 <dest>` in the background, then `USINE_URL=http://127.0.0.1:7331`.
3. `curl` over SSH for one-off calls when neither is available.

## Token

While `GET /api/version` answers without a header, leave `USINE_TOKEN` empty. Once it returns 401, the admin token is a mode 0600 file in the instance folder on the host; read it with `ssh <dest> cat <path>` into the variable, never onto a command line.

## Repositories, workers, labels

```sh
scripts/usine-api.sh GET /api/configuration | python3 -I -c '
import json,sys; c=json.load(sys.stdin)
print("repos:", [r["name"] for r in c["repositories"]])
print("workers:", [(w["name"], w.get("kind"), w.get("destination")) for w in c["workers"]])
print("loops:", [(l["name"], l["agent"], l.get("paused")) for l in c["loops"]])
print("agents:", [(a["name"], a.get("brain")) for a in c["agents"]])
print("labels:", [l["name"] for l in c["labels"]])'
```

The App login for `USINE_APP` is the author of the agent PRs: `gh pr list --state all --limit 5 --json author --jq '.[].author.login'` in a managed repository shows it.

Workers with a `destination` are SSH hosts you can reach with the same key; `.usine/ssh-workers/` on the orchestrator host records how. Provisioned workers come and go; the provider CLI the `infra/` README names lists them.

## Write env.sh

```sh
mkdir -p .scratchpad/orchestrating-usine/actions
cat > .scratchpad/orchestrating-usine/env.sh <<'EOF'
USINE_URL=...
USINE_TOKEN=...
USINE_SSH=...
USINE_DIR=...
USINE_BIN=...
USINE_REPOS="owner/name"
USINE_APP="app/slug"
EOF
chmod 600 .scratchpad/orchestrating-usine/env.sh
```

Verify with `scripts/usine-api.sh GET /api/version`.
