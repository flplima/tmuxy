# The public read-only demo

A tmuxy viewer anyone can open, showing a real tmux session nobody can touch.

## Why it is shaped this way

A read-only server refuses every command that is not a read, and it refuses the
two arbitrary-file-read routes outright (`/api/file`, `/api/browse` — see
[docs/SECURITY.md](../../docs/SECURITY.md)). That is the lock on the door.

It is not the whole answer, because a public demo is the one deployment where
somebody will try the door. So the demo does not run on a machine that has
anything on it. It runs in a container with no source tree, no credentials, no
host mounts, no capabilities and a read-only root filesystem — and the session it
shows is three scripted loops, not a shell anyone works in. A visitor who defeats
every layer lands in an empty room, and `docker compose restart` empties it again.

This is also why `--no-auth` on `0.0.0.0` appears here and nowhere else. That
pair is normally how you hand a stranger a shell as yourself; behind this
container there is no "yourself" to be.

## Running it

```bash
# 1. Build and start. The port is published to loopback only.
docker compose -f deploy/public-demo/compose.yml up -d --build

# 2. Point a tunnel at it, and tell the server the public name it will forward.
#    Without TMUXY_ALLOWED_HOSTS every API call answers 403 and the app says so.
TMUXY_ALLOWED_HOSTS=tmuxy-demo.example.com \
  docker compose -f deploy/public-demo/compose.yml up -d

cloudflared tunnel --url http://127.0.0.1:9100   # or: ngrok http 9100
```

Check it locally first — `curl -s localhost:9100 | head -1` should return the
app's HTML, and a write must be refused:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:9100/commands \
  -H 'Content-Type: application/json' \
  -H 'Host: localhost:9100' -H 'Sec-Fetch-Site: same-origin' \
  -d '{"cmd":"run_tmux_command","args":{"command":"kill-server"}}'
# 403

curl -s -o /dev/null -w '%{http_code}\n' 'localhost:9100/api/file?path=/etc/hosts' \
  -H 'Host: localhost:9100' -H 'Sec-Fetch-Site: same-origin'
# 403
```

## What it deliberately does not do

- **No persistence.** `/home/demo` and `/tmp` are tmpfs. A restart is a reset,
  and that is the intended way to clean up after a visitor.
- **No shared socket.** The container's tmux lives on its own `tmuxy-public`
  socket inside the container; it cannot see a session on the host at all.
- **No trace file.** `TMUXY_NO_TRACE=1`, because a public box has no use for a
  local record of who did what.
- **No outbound story.** Nothing in the image can fetch, build or sign anything.
  If the demo ever needs network access, add it deliberately rather than
  discovering it works.
