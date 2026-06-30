# Osync

**[한국어](README.ko.md)** | English

<p align="center">
  <a href="https://ko-fi.com/thomasjeong" target="_blank">
    <img src="https://storage.ko-fi.com/cdn/kofi3.png?v=3" alt="Buy Me a Coffee at ko-fi.com" height="50">
  </a>
</p>

End-to-end encrypted vault sync plugin for Obsidian.

## Overview

Osync lets you sync your Obsidian vault across all your devices — including mobile — with zero-knowledge encryption. Your notes are encrypted on-device before leaving your vault, so the server never sees your content.

## Features

### End-to-End Encryption

- AES-256-GCM encryption applied locally before any data is transmitted
- Vault key derived from your password using Argon2id
- Password changes re-encrypt without exposing your data
- Server stores only encrypted blobs — even the server operator cannot read your notes

### Real-Time Sync

- Syncs automatically when you open Obsidian or regain focus
- Status bar indicator shows current sync state at a glance
- Progress bar in settings during active sync
- Pause and resume sync on demand

### Per-Device Granular Control

Each device has its own sync settings:

- Toggle sync for images, audio, videos, PDFs, and other attachments independently
- Toggle Obsidian config folder sync per device
- Exclude specific folders from sync on a per-device basis

### Vault Management

- Create a new remote vault or connect to an existing one
- Disconnect from a vault without deleting data
- View and restore deleted files
- Version history viewer for individual files
- Conflict resolution pane when the same file is edited on multiple devices simultaneously

### Commands (Command Palette)

| Command | Description |
|---------|-------------|
| Sign in / Sign out | Authenticate this device |
| Create remote vault | Initialize a new encrypted vault on the server |
| Connect to remote vault | Link this vault to an existing remote vault |
| Disconnect vault | Unlink from the remote vault |
| Change vault password | Re-encrypt vault key with a new password |
| View version history | Browse previous versions of a file |
| Toggle sync pause | Temporarily stop syncing |
| Reset local sync state | Force a full re-sync from the server |

## Installation

### Community Plugin (Recommended)

1. Open Obsidian → **Settings** → **Community plugins**
2. Search for **Osync**
3. Install and enable

### Manual Installation

Download the latest release assets and place them in your vault's `.obsidian/plugins/osync/` folder:

- `main.js`
- `manifest.json`
- `styles.css`

Then enable the plugin in **Settings** → **Community plugins**.

## Setup

1. Open **Settings** → **Osync**
2. Enter your server URL
3. Sign in or create an account
4. Create a new vault or connect to an existing one
5. Set a strong vault password — this is the key to your encryption

> **Important:** Your vault password is not recoverable from the server. Keep it safe.

## Self-Hosting

Osync is fully self-hostable. The server is distributed as a Docker image — no source code needed.

**Requirements:** Docker, Docker Compose, `openssl`

### Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/KORThomasJeong/Osync-p/main/install.sh | bash
```

The install script downloads `docker-compose.yml`, generates random secrets into a new `.env`, starts the stack, and prints the auto-generated admin email and password — **save them, the password is shown only once.**

To customize the admin email or public URL before installing:

```bash
ADMIN_EMAIL=me@example.com PUBLIC_URL=https://osync.example.com \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/KORThomasJeong/Osync-p/main/install.sh)"
```

Re-running the script is safe — an existing `.env` is never overwritten. After your first sign-in, remove `ADMIN_EMAIL` and `ADMIN_PASSWORD` from `.env`.

#### First-time deploy walkthrough (recommended)

The end-to-end procedure for a fresh 2.1.7 deployment:

1. **Pick subdomains.** Decide on two sibling subdomains under your existing domain, e.g.
   - `osync.your-domain.com` → API
   - `osync-s3.your-domain.com` → MinIO S3

   Both should sit at the same depth so Cloudflare's free Universal SSL (which covers `*.your-domain.com`) automatically issues their certificates. Avoid deeper names like `s3.osync.your-domain.com` unless you have a paid wildcard.

2. **Point DNS.** Add an A/AAAA record (or CNAME) for each subdomain pointing at your server's IP. If using Cloudflare, leave the proxy (orange cloud) on; the orange cloud also handles TLS at the edge.

3. **Provision the reverse proxy** (e.g., Nginx Proxy Manager):
   - Create proxy host 1: `osync.your-domain.com` → `osync-api:3000` (or `localhost:3000` depending on your network setup). In the Advanced tab, paste the API nginx snippet from the "Reverse Proxy (HTTPS)" section below. Enable SSL with Let's Encrypt or your existing cert.
   - Create proxy host 2: `osync-s3.your-domain.com` → `minio:9000` (or `localhost:9000`). In the Advanced tab, paste the MinIO nginx snippet. Enable SSL.
   - Both hosts MUST have buffering off and unlimited body size (see snippets in the next section).

4. **Configure `.env`.** After `curl`ing the example or running the install script, edit `.env`:
   ```
   PUBLIC_URL=https://osync.your-domain.com
   CORS_ORIGIN=https://osync.your-domain.com
   S3_PUBLIC_ENDPOINT=https://osync-s3.your-domain.com
   MINIO_PUBLIC_URL=https://osync-s3.your-domain.com
   ```
   `S3_PUBLIC_ENDPOINT` is what the API server uses when signing presigned URLs. `MINIO_PUBLIC_URL` is forwarded to MinIO as `MINIO_SERVER_URL` so MinIO's own redirects/console match. They should be identical.

5. **Bring up the stack:**
   ```bash
   docker compose pull
   docker compose up -d
   docker compose logs -f api
   ```
   Look for `[i18n] language=...` and `[osync] API running on http://localhost:3000`. Wait for postgres + MinIO health checks.

6. **Smoke-test:**
   ```bash
   # API reachable through your domain
   curl -fsSI https://osync.your-domain.com/health

   # MinIO reachable through its subdomain (will return XML 403 — that's expected; just confirms the proxy + TLS work)
   curl -fsSI https://osync-s3.your-domain.com/
   ```
   If either fails, fix the reverse proxy before going further.

7. **First sign-in.** The first-run admin email/password were printed by the install script (the password was shown only once — if you lost it, set `ADMIN_PASSWORD` in `.env` and restart once). Sign in at `https://osync.your-domain.com/admin/`, create an invite code, then sign up on `https://osync.your-domain.com/signup/`.

8. **Install the plugin.** Obsidian → Settings → Community plugins → search **Osync** → install + enable. In plugin settings, point the server URL at `https://osync.your-domain.com`, sign in, create or connect a vault.

#### Manual setup

If you'd rather not pipe through bash:

```bash
curl -O https://raw.githubusercontent.com/KORThomasJeong/Osync-p/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/KORThomasJeong/Osync-p/main/.env.example
cp .env.example .env
# Edit .env — replace every CHANGE_ME and generate secrets:
#   BETTER_AUTH_SECRET=$(openssl rand -hex 32)
#   SYNC_TOKEN_SECRET=$(openssl rand -hex 32)
#   MINIO_KMS_SECRET_KEY=osync-key:$(openssl rand -base64 32)
# Also set the public MinIO URL (used for presigned blob uploads/downloads):
#   MINIO_PUBLIC_URL=https://osync-s3.example.com
docker compose up -d
curl http://localhost:3000/health
```

> Since 2.1.7, the server hands out presigned URLs so the plugin uploads/downloads encrypted blobs **directly to MinIO**, bypassing the API. `.env` must therefore include `MINIO_PUBLIC_URL=https://osync-s3.example.com` — `docker-compose.yml` passes this through to the MinIO container as `MINIO_SERVER_URL`, which is what makes presigned signatures match the public hostname.

### Docker Image

```
docker pull thomasjeong/osync:latest
```

Supports `linux/amd64` and `linux/arm64`.

### Ports

| Port | Service | Public exposure |
|------|---------|-----------------|
| `3000` | Osync API (configurable via `PORT=`) | Reverse proxy on the API subdomain (e.g. `osync.example.com`) |
| `9000` | MinIO S3 API | Reverse proxy on its own subdomain (e.g. `osync-s3.example.com`) |
| `127.0.0.1:9001` | MinIO admin console | Localhost only (unchanged) |
| `5432` | PostgreSQL | Not exposed |

> Starting with 2.1.7, MinIO's S3 API (port `9000`) **must** be reachable from clients via its own public subdomain so the plugin can use presigned URLs. Still firewall the raw port — only the reverse proxy should be exposed.

### Reverse Proxy (HTTPS)

Osync 2.1.7+ uses **presigned URLs** for blob transfer: the API server signs short-lived URLs that point at MinIO, and the Obsidian plugin uploads/downloads the encrypted bytes **directly to MinIO**. The API never proxies blob bodies — this is the same architecture AWS S3 clients use, and it dramatically lowers API memory usage and raises throughput.

That means you need **two subdomains**, each terminated by your reverse proxy:

| Subdomain | Upstream | Purpose |
|-----------|----------|---------|
| `osync.example.com` | API container `:3000` | REST + WebSocket coordinator |
| `osync-s3.example.com` | MinIO `:9000` | Presigned blob uploads/downloads |

**TLS / wildcard certs.** Cloudflare's free Universal SSL covers depth-1 wildcards (`*.example.com`), so two **sibling** subdomains like `osync.example.com` and `osync-s3.example.com` work out of the box with the free cert. Deeper wildcards (e.g. `*.osync.example.com`) require Cloudflare Advanced Certificate Manager (paid) or a Let's Encrypt DNS-01 wildcard — easier to just use siblings.

**MinIO must know its public URL.** Set `MINIO_SERVER_URL` on the MinIO container (via `MINIO_PUBLIC_URL` in `.env`, see above) to exactly the public URL — e.g. `https://osync-s3.example.com`. If this doesn't match, presigned signatures break and uploads fail with `SignatureDoesNotMatch`.

**Proxy buffering must be off.** Encrypted blobs can be large; if the proxy buffers the whole body before forwarding, it eats memory and stalls uploads. Both vhosts need streaming mode and unlimited body size.

**Caddy (preferred — defaults are sane):**
```caddyfile
osync.example.com {
    reverse_proxy localhost:3000
    request_body {
        max_size 0
    }
}

osync-s3.example.com {
    reverse_proxy localhost:9000 {
        flush_interval -1
    }
    request_body {
        max_size 0
    }
}
```

**Nginx (or the Advanced tab in Nginx Proxy Manager):**
```nginx
# osync.example.com (API + WebSocket)
location / {
    proxy_pass http://osync-api:3000;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_read_timeout 86400;
    client_max_body_size 0;
}

# osync-s3.example.com (MinIO presigned blob transfer)
location / {
    proxy_pass http://minio:9000;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_connect_timeout 300;
    proxy_send_timeout 300;
    proxy_read_timeout 300;
    client_max_body_size 0;
}
```

### Troubleshooting

- **`SignatureDoesNotMatch` on upload/download** — `MINIO_PUBLIC_URL` or `S3_PUBLIC_ENDPOINT` doesn't exactly match the host clients hit, OR your reverse proxy isn't passing `Host $host` to MinIO. Verify both env vars equal the public URL of `osync-s3.your-domain.com`, and that the MinIO Nginx block has `proxy_set_header Host $host;`.

- **`RequestTimeTooSkewed`** — server clock drift greater than 15 minutes. Fix with `timedatectl set-ntp true` (or your OS equivalent).

- **502 Bad Gateway on `osync-s3.*`** — proxy can't resolve `minio:9000`. If Nginx is in a different Docker network than MinIO, either join the same network or use `localhost:9000` (if MinIO is bound to the host) instead of the service name.

- **Uploads hang or fail with `413 Request Entity Too Large`** — nginx is buffering and limiting. Confirm `proxy_request_buffering off`, `proxy_buffering off`, and `client_max_body_size 0` on **both** vhosts. Caddy: ensure `request_body { max_size 0 }`.

- **Sync stops when the mobile app goes background** — expected. Mobile OSes suspend WebViews; the WebSocket dies. Sync resumes when Obsidian becomes visible again. Not a bug.

- **Plugin shows "json parse error" right after upgrading** — usually means the API container failed mid-WebSocket. Check `docker compose logs api` for stack traces. If it mentions `meta/_journal.json`, your image is older than `2.1.6+drizzle-do-fix`; pull `thomasjeong/osync:latest` and restart.

- **Self-hosters running on a single machine without subdomains** — leave `S3_PUBLIC_ENDPOINT` and `MINIO_PUBLIC_URL` **empty**; the server falls back to `S3_ENDPOINT` (the internal MinIO URL) for presigning. Presigned URLs will then point at `http://minio:9000` which only the API container itself can reach, so blob transfers will only work from a client running on the same host. Use the subdomain setup for any real deployment.

### Admin UI

Sign in at `http://localhost:3000/admin/` (or `https://osync.your-domain.com/admin/`) with the admin account created on first run. The dashboard is organized into the following panels:

| Panel | What you can do |
|-------|-----------------|
| **Users** | List every account with its role, create new users (user or admin), reset a user's password, and delete a user. Password resets and deletions can fire Telegram notifications (see Settings). |
| **Invite codes** | Generate signup invite codes, track usage (`used / max`), and revoke, reset, or delete each code. Signup is invite-only, so this is how you let new people register. |
| **Vault stats** | At-a-glance totals (users, files, storage, average files per user) plus a per-user → per-vault storage breakdown measured **directly from MinIO** (the source of truth). From here you can also purge a vault's deleted-file tombstones to reclaim space. |
| **Groups** | Create groups, add or remove members, and share vaults across the members of a group. |
| **Settings** | Configure the Telegram notification integration (bot token + chat ID, with a test button), toggle which events send notifications, and set the default max-uses for new invite codes. |
| **Notifications** | Browse the recent history of sent notifications. |

> **Notifications are optional.** If you don't configure a Telegram bot under **Settings**, the server simply skips sending them — every other admin feature works without it.

The admin account is created automatically on first run from `ADMIN_EMAIL` / `ADMIN_PASSWORD` (the install script prints the generated password once). After your first sign-in, remove those variables from `.env`.

### Volumes

| Volume | Contents |
|--------|---------|
| `postgres_data` | User accounts, vault metadata |
| `minio_data` | Encrypted vault blobs |
| `coordinator_data` | Real-time sync state |

> Your vault password is never stored on the server. Only encrypted blobs are stored — the server operator cannot read your notes.

## Releases

Plugin releases are published here as GitHub Releases. Each release includes:

- `main.js` — compiled plugin
- `manifest.json` — plugin metadata
- `styles.css` — styles
- `versions.json` — Obsidian version compatibility map

## License

MIT
