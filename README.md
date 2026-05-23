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

Osync is fully self-hostable. The server source code is available for users who want to run their own instance. See the server repository for setup instructions.

## Releases

Plugin releases are published here as GitHub Releases. Each release includes:

- `main.js` — compiled plugin
- `manifest.json` — plugin metadata
- `styles.css` — styles
- `versions.json` — Obsidian version compatibility map

## License

MIT
