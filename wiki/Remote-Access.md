**The tmuxy server gives whoever reaches it a shell as you, so never put it on a routable address without authentication and encryption.**

This page shows four ways to reach tmuxy from another device, safest first. Pick the first one that fits.

## The default: this machine only

`tmuxy server` listens on `127.0.0.1:9000`. Only programs on the same machine reach it, and an SSH tunnel can bring the port to you. No password is needed there.

Any other `--host` puts a shell on the network. The server refuses to start on one unless you give it a password or pass `--no-auth`. A `--host` that is not an IP address is an error.

| Flag                    | What it does                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `--host <ip>`           | Address to listen on (default `127.0.0.1`)                                                                            |
| `--port <n>`            | Port to listen on (default `9000`)                                                                                    |
| `--password <pw>`       | HTTP Basic auth on every route. Any username works, only the password is checked                                      |
| `TMUXY_PASSWORD`        | Same as `--password`, but the secret stays out of `ps`                                                                |
| `--no-auth`             | Serve a routable address with no password. Only where everyone who can reach the port may already run commands as you |
| `--allowed-host <name>` | A hostname requests may use besides loopback ones. Repeatable. Also `TMUXY_ALLOWED_HOSTS`, comma-separated            |

The desktop app serves no HTTP at all. This page is about `tmuxy server`.

## 1. SSH tunnel (safest)

SSH gives you login, encryption and access control, and tmuxy stays on loopback.

1. On the remote machine, start the server. It listens on `127.0.0.1`.

   ```sh
   tmuxy server
   ```

2. On your own machine, open the tunnel.

   ```sh
   # -N: no remote shell, just the tunnel
   ssh -N -L 9000:localhost:9000 you@remote-host
   ```

3. Open `http://localhost:9000` in your browser.

If port 9000 is taken on your machine, pick another local one, like `-L 9001:localhost:9000`, and open `http://localhost:9001`.

## 2. A VPN (best for a phone)

WireGuard, Tailscale or similar. The VPN encrypts the traffic and decides who is on it. Bind tmuxy to the VPN address only.

1. Set up the VPN between your devices and the machine that runs tmuxy.
2. Find the machine's VPN address (with Tailscale, `tailscale ip -4`).
3. Start the server on that address, with a password.

   ```sh
   # <vpn address> is something like 100.x.y.z
   TMUXY_PASSWORD='pick-a-long-one' tmuxy server --host <vpn address>
   ```

4. On your phone or laptop, open `http://<vpn address>:9000`. The browser asks for a password: type anything as the username, then the password.

Reaching it by a VPN hostname instead of the address? Add `--allowed-host my-machine` (the name you type in the browser). Without it the page loads but every API route answers 403, and the app says the request Host is not this server.

Use `--no-auth` here only when nobody else is on that VPN. The server prints a warning at startup.

## 3. A reverse proxy with TLS

Use this when you want a real HTTPS name. The proxy ends TLS and checks who you are. tmuxy stays on `127.0.0.1:9000`.

1. Point a DNS name (say `tmux.example.com`) at the machine.
2. Start tmuxy and tell it the public name.

   ```sh
   tmuxy server --allowed-host tmux.example.com
   ```

3. Put a proxy in front, using one of the two configs below.
4. Open `https://tmux.example.com`.

What the proxy has to get right:

- **Pass the original `Host` header.** The server checks it against the `Origin` of every request. A changed `Host` makes every API call fail with 403.
- **Do not buffer responses.** The page gets its updates over a server-sent events stream at `/events`. A buffering proxy holds it back and the screen freezes.
- **Allow a long read.** The stream stays open. The server sends a ping every second, but a short read timeout still cuts idle links.
- **Do your own login and rate limiting.** The server sees only the proxy as the peer, so its wrong-password delay is shared by everyone behind it. It does not trust `X-Forwarded-For`.

### Caddy

Make a password hash first, then paste it into the file:

```sh
caddy hash-password
```

```caddyfile
tmux.example.com {
	# the username is "you"; the hash is from the command above
	basic_auth {
		you PASTE_THE_HASH_HERE
	}

	reverse_proxy 127.0.0.1:9000 {
		# send each event to the browser as it arrives
		flush_interval -1
	}
}
```

Caddy gets the certificate on its own and passes `Host` through unchanged.

### nginx

Make the password file first (it needs `htpasswd` from apache2-utils or httpd-tools):

```sh
sudo htpasswd -c /etc/nginx/tmuxy.htpasswd you
```

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name tmux.example.com;

    # certificate paths: use your own (certbot writes these by default)
    ssl_certificate     /etc/letsencrypt/live/tmux.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tmux.example.com/privkey.pem;

    auth_basic           "tmuxy";
    auth_basic_user_file /etc/nginx/tmuxy.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:9000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";

        # keep the name (and port) the browser used
        proxy_set_header Host $http_host;

        # server-sent events: no buffering, a long read timeout
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}

server {
    listen 80;
    server_name tmux.example.com;
    return 301 https://$host$request_uri;
}
```

`http2 on;` needs nginx 1.25.1 or newer. On an older nginx, write `listen 443 ssl http2;` instead.

## 4. A password on a trusted LAN

Plain HTTP on your home network. Fine for a quick look from the couch. Not fine on shared Wi-Fi.

```sh
# 0.0.0.0 listens on every interface of this machine
TMUXY_PASSWORD='pick-a-long-one' tmuxy server --host 0.0.0.0
```

Open `http://<this machine's LAN address>:9000` from the other device. To use a hostname there, add `--allowed-host <hostname>`.

Basic auth is not encryption. Over plain HTTP, the password travels as base64. Anyone on the same network can read it, and can read your terminal too. A wrong password also costs time: after a few tries the server delays each refusal, up to 30 seconds.

## What not to do

- Do not expose tmuxy on a public IP.
- Do not pass `--no-auth` on a network other people share. A container's published port counts: `-p 9000:9000` listens on every host interface.
- Do not run tmuxy as root.
- Do not run it on a shared or multi-tenant server without network isolation.
- Do not keep secrets (API keys, SSH passphrases) in sessions you reach over a network.
- Do not rely on Basic auth alone. Pair it with a tunnel, a VPN or TLS.

## Keep it running after logout and reboot

_On main, not in a release yet._

```sh
# prints every file and command, changes nothing
tmuxy server install --dry-run

# do it
tmuxy server install
```

On Linux this writes a systemd user unit at `~/.config/systemd/user/tmuxy.service` and starts it. It also runs `loginctl enable-linger`, so the server starts at boot and survives logout. `--no-linger` skips that. On macOS it writes a launchd agent that starts at login.

The install takes the same `--host`, `--port` and `--allowed-host` flags as `tmuxy server`. It never writes a password into the unit. A routable `--host` needs the password in a file, and the install refuses without it:

```sh
# the config directory is the one `tmuxy config paths` shows
echo 'TMUXY_PASSWORD=pick-a-long-one' > "<config dir>/server.env"
chmod 600 "<config dir>/server.env"

tmuxy server install --host <vpn address>
```

Run `tmuxy server install` again to update the service to the current binary and flags. `tmuxy server status` says whether it runs and whether the service is installed. `tmuxy server uninstall` stops it and removes only the file it wrote. Lingering stays on.

## Check what is listening

```sh
# Linux: expect 127.0.0.1:9000 unless you chose another address
ss -ltnp | grep 9000

# macOS
lsof -nP -iTCP:9000 -sTCP:LISTEN

# tmuxy's own view
tmuxy server status
```

A line with `0.0.0.0:9000` or `*:9000` means every interface can reach it. Make sure that is on purpose, and that a password or a firewall is in front.

## See also

- [[Security]]
- [[Phone and Tablet]]
- [[Installation]]
- [Network exposure, in the repo docs](https://github.com/flplima/tmuxy/blob/main/docs/SECURITY-NETWORK.md)
