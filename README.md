# Osync

**[한국어](README.ko.md)** | English

<p align="center">
  <a href="https://www.buymeacoffee.com/thomasjeong" target="_blank">
    <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="50">
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

### Admin UI

Access at `http://localhost:3000/admin/` to manage users, invite codes, and vault stats.

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
