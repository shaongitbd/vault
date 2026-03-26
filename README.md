<p align="center">
  <img src="public/banner.svg" alt="Vault" width="100%">
</p>

<p align="center">
  <strong>One password. One vault. Zero traces.</strong><br>
  <sub>Your files encrypted at rest. Your notes are yours alone. Even the server admin sees nothing.</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/encryption-AES--256--GCM-0d7377?style=flat-square" alt="AES-256-GCM">
  <img src="https://img.shields.io/badge/KDF-scrypt-0d7377?style=flat-square" alt="scrypt">
  <img src="https://img.shields.io/badge/framework-none-1c1c1a?style=flat-square" alt="No framework">
  <img src="https://img.shields.io/badge/build_step-none-1c1c1a?style=flat-square" alt="No build">
  <img src="https://img.shields.io/badge/lines-8.8k-1c1c1a?style=flat-square" alt="8.8k lines">
</p>

<br>

<table>
<tr>
<td width="50%">

### The Problem

You have documents you can't store in Google Drive. Notes you can't put in Notion. Bookmarks into books nobody should know you're reading.

Most "secure" apps encrypt your data but still expose **file names, folder structures, and access patterns** to the server.

Vault encrypts *everything* — the database, every file, every byte — with a key derived from your passphrase that never touches disk.

**Different passphrase? Different vault. No one can even tell how many vaults exist.**

</td>
<td width="50%">

### What the admin sees

```
data/
  .salt
  a3f8b2c19e4d.../
    meta.db.enc            <- ???
    files/
      7cfe1d2f261f...enc   <- ???
      9a3b4e8c0d12...enc   <- ???
  f7d2918a5c0b.../
    meta.db.enc            <- ???
    files/
      2e8f4a1b9c7d...enc   <- ???
```

No file names. No file types. No folder names. No note titles. No reading history. **Nothing.**

</td>
</tr>
</table>

---

## Get Started

```bash
git clone <repo-url> vault && cd vault
npm install
```

Generate a TLS certificate:

```bash
openssl req -new -x509 -newkey rsa:2048 -nodes \
  -keyout data/.cert-key.pem -out data/.cert.pem \
  -days 3650 -subj "/CN=localhost"
```

```bash
node server.js
# -> Vault server running on https://localhost:3000
```

Open `https://localhost:3000`. Enter any passphrase. Your vault exists.

---

## How It Works

```
                  ┌─────────────────────────────────────────────┐
 Passphrase ─────>│  scrypt(pass, salt)  ──>  64 bytes          │
                  │    ├── first 32  ──>  SHA-256  ──> vault ID │
                  │    └── last  32  ──>  AES-256-GCM key       │
                  └─────────────────────────────────────────────┘
                                      │
                       ┌──────────────┴──────────────┐
                       ▼                             ▼
                data/<vault_id>/               Vault unlocked
                ├── meta.db.enc    ◄── encrypted SQLite
                └── files/
                    ├── a7f3c9...enc  ◄── encrypted blob
                    └── b2e8d1...enc  ◄── encrypted blob
```

The vault ID is derived deterministically from the passphrase. No master user table, no account list, no way to enumerate what exists. Full disk access = random directories of random blobs.

---

## Features

<table>
<tr><td width="50%" valign="top">

### Encrypted File Vault
Upload anything. Organize with nested folders. **AES-256-GCM** encryption before anything touches disk — file names, metadata, folder structure all live inside the encrypted database.

### PDF Reader
Powered by PDF.js with everything you'd expect:
- Continuous scroll, lazy rendering (1000+ pages)
- Text search across all pages
- **Resume** — auto-saves last page, picks up where you left off
- Bookmarks with labels
- Text highlighting in 5 colors
- Zoom, rotate, fit-width, thumbnails
- Dark mode

</td><td width="50%" valign="top">

### Notion-Style Notes
Block-based rich editor:
- **Slash commands** — type `/` for block types
- **Markdown shortcuts** — `# `, `- `, `> `, `---` auto-convert
- Bold, italic, underline, code, links
- Checkboxes, code blocks, blockquotes
- Drag-and-drop block reordering
- Embed vault files into notes
- 2s debounced auto-save

### Document Viewer
- **DOCX** → HTML via Mammoth
- **XLSX** → spreadsheet view via SheetJS
- Images, text, code rendered inline

</td></tr>
<tr><td width="50%" valign="top">

### Secure Browser
Built-in proxy via [unblocker](https://github.com/nfriedly/node-unblocker). Your browser makes **zero external requests**.
- URL bar doubles as search (DuckDuckGo)
- Back / forward / refresh history
- `target="_blank"` suppressed
- Works for static sites, news, wikis, forums

> YouTube, Discord, Google login won't work. Fundamental limitation of server-side proxying.

</td><td width="50%" valign="top">

### Panic Button
**Esc Esc** or click the bolt icon:

1. Server session destroyed instantly
2. Screen replaced with a **working calculator**

No vault content remains visible. The calculator does real math. Press Esc 3x or click outside to return to login.

### Auto-Lock
15 minutes of inactivity → session destroyed, login screen. No residue.

</td></tr>
</table>

---

## Security

<table>
<tr>
<td><strong>Encryption</strong></td>
<td>AES-256-GCM per file + encrypted SQLite database</td>
</tr>
<tr>
<td><strong>Key Derivation</strong></td>
<td>scrypt (N=32768, r=8, p=1) with persistent random salt</td>
</tr>
<tr>
<td><strong>Disk Storage</strong></td>
<td>Random hex filenames — zero correlation to real names</td>
</tr>
<tr>
<td><strong>Database</strong></td>
<td>Encrypted at rest, decrypted only in memory during session</td>
</tr>
<tr>
<td><strong>CSRF</strong></td>
<td>Per-request tokens, invalidated after single use</td>
</tr>
<tr>
<td><strong>Brute Force</strong></td>
<td>5 attempts / 60s per IP → 5 minute lockout</td>
</tr>
<tr>
<td><strong>IP Allowlist</strong></td>
<td>Optional — non-listed IPs get empty 403, no hint a vault exists</td>
</tr>
<tr>
<td><strong>Sessions</strong></td>
<td>HttpOnly cookies, 15 min auto-lock, strict headers</td>
</tr>
<tr>
<td><strong>HTTPS</strong></td>
<td>Auto-generated self-signed cert or bring your own</td>
</tr>
<tr>
<td><strong>Deniability</strong></td>
<td>No master user list. Impossible to tell how many vaults exist.</td>
</tr>
</table>

---

## Configuration

All via environment variables. Nothing to accidentally commit.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Server port |
| `ALLOWED_IPS` | *(all)* | Comma-separated IP allowlist |
| `TRUST_PROXY` | `false` | `true` behind nginx/cloudflare |

```bash
# Production: locked to one IP
PORT=443 ALLOWED_IPS=203.0.113.50 TRUST_PROXY=true node server.js

# Local only
ALLOWED_IPS="127.0.0.1,::1" node server.js
```

---

## Stack

No frameworks. No build step. No webpack. No React.

```
server.js                776 lines   Express, CSRF, rate limiting, proxy
src/crypto.js            128 lines   scrypt + AES-256-GCM
src/vault.js             635 lines   Encrypted SQLite vault
src/auth.js               73 lines   Sessions + auto-lock
public/js/app.js        3433 lines   Vanilla JS SPA
public/js/pdf-viewer.js 2005 lines   PDF.js reader
public/css/app.css       1552 lines  Light theme
public/index.html         269 lines  HTML shell
                        ─────────
                        ~8,800 total
```

<details>
<summary><strong>Runtime dependencies</strong></summary>

| Package | Purpose |
|---|---|
| `express` | HTTP server |
| `better-sqlite3` | Vault metadata database |
| `helmet` | Security headers |
| `express-session` | Session management |
| `multer` | File uploads (up to 500MB) |
| `unblocker` | Web proxy middleware |
| `mammoth` | DOCX → HTML conversion |
| `xlsx` | Spreadsheet processing |
| `uuid` | Random ID generation |
| `mime-types` | Content type detection |
| `csrf-csrf` | CSRF tokens |

</details>

<details>
<summary><strong>Keyboard shortcuts</strong></summary>

| Key | Action |
|---|---|
| `Esc` `Esc` | Panic — kill session, show calculator |
| `Esc` | Close viewer / dismiss menus |
| `Ctrl+U` | Upload files |
| `Ctrl+K` | Focus search |
| `Ctrl+N` | New note |
| `Delete` | Trash selected items |
| `/` | *(in notes)* Slash command menu |
| `Ctrl+B/I/U` | *(in notes)* Bold / Italic / Underline |

</details>

---

## Limitations

- **No password recovery.** The passphrase *is* the encryption key. Forget it and the data is gone. This is the point.
- **Single server.** No sync, no replication. One machine you control.
- **Proxy limitations.** YouTube, Google OAuth, Discord won't work through the built-in browser.
- **Not audited.** Standard crypto (scrypt + AES-256-GCM) but the implementation has not been professionally reviewed.

---

<p align="center">
<sub>
If someone gains access to your server, they see encrypted noise.<br>
If someone watches your network, they see HTTPS to localhost.<br>
If someone walks up to your screen, they see a calculator.
</sub>
</p>

<p align="center">
  <sub>MIT License</sub>
</p>
