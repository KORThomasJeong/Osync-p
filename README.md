# Osync

**[한국어](README.ko.md)** | English

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

### Installing via BRAT

If you install Osync through [BRAT](https://github.com/TfTHacker/obsidian42-brat), sign in normally after installation. If you previously installed Osync via BRAT and are reinstalling, **delete the existing Osync entry from BRAT before adding it again** — stale authentication stored by BRAT can cause a 403 error on the first sign-in attempt.

## Setup

1. Open **Settings** → **Osync**
2. Enter your server URL (self-hosted or Osync Cloud)
3. Sign in or create an account
4. Create a new vault or connect to an existing one
5. Set a strong vault password — this is the key to your encryption

> **Important:** Your vault password is not recoverable from the server. Keep it safe.

## Self-Hosting

Osync is fully self-hostable. The server is distributed as a Docker image — no source code needed.

**Requirements:** Docker, Docker Compose, `openssl`

### Quick Start

```bash
# 1. Download the config files
curl -O https://raw.githubusercontent.com/KORThomasJeong/Osync-p/master/docker-compose.yml
curl -O https://raw.githubusercontent.com/KORThomasJeong/Osync-p/master/.env.example
cp .env.example .env
```

```bash
# 2. Fill in your secrets (replace every CHANGE_ME value)
# Required secrets to generate:
echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)"
echo "SYNC_TOKEN_SECRET=$(openssl rand -hex 32)"
echo "MINIO_KMS_SECRET_KEY=osync-key:$(openssl rand -base64 32)"
```

```bash
# 3. Start
docker compose up -d

# 4. Check health
curl http://localhost:3000/health
```

The admin account is created automatically on first start using `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`. Remove those variables after the first successful login.

### Docker Image

```
docker pull thomasjeong/osync:latest
```

Supports `linux/amd64` and `linux/arm64`.

### Ports

| Port | Service |
|------|---------|
| `3000` | Osync API (configurable via `PORT=`) |
| `127.0.0.1:9001` | MinIO admin console (localhost only) |

PostgreSQL (5432) and MinIO S3 (9000) are not exposed externally.

### Reverse Proxy (HTTPS)

**Caddy:**
```
your-domain.com {
    reverse_proxy localhost:3000
}
```

**Nginx:**
```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
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
