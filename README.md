<p align="center">
  <img src="public/banner.svg" alt="VAULT — Encrypted Document Vault" width="100%">
</p>

<h3 align="center">One password. One vault. Zero traces.</h3>
<p align="center">Your files encrypted at rest. Your notes are yours alone.<br>Even the server admin sees nothing.</p>

<br>

---

<br>

<table>
<tr>
<td width="55%" valign="top">

## Why this exists

You have documents you can't store in Google Drive. Notes you can't put in Notion. Bookmarks into books nobody should know you're reading.

Most "secure" apps encrypt your data but still expose **file names, folder structures, and access patterns** to the server.

Vault encrypts *everything* — the database, every file, every byte on disk — with a key derived solely from your passphrase.

**Different passphrase = different vault.**
**No master user list. No account table. No way to enumerate what exists.**

An attacker with root access to the server sees random directories full of random encrypted blobs. That's it.

</td>
<td width="45%" valign="top">

### What full server access reveals

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

No file names. No file types. No folder names.
No note titles. No reading history.

**Nothing.**

</td>
</tr>
</table>

<br>

---

<br>

## Get started

Three commands. No build step.

```bash
git clone <repo-url> vault && cd vault
npm install
```

```bash
# Generate a TLS certificate
openssl req -new -x509 -newkey rsa:2048 -nodes \
  -keyout data/.cert-key.pem -out data/.cert.pem \
  -days 3650 -subj "/CN=localhost"
```

```bash
node server.js
# Vault server running on https://localhost:3000
```

Open the URL. Enter any passphrase. That passphrase *is* the vault.

<br>

---

<br>

## How encryption works

```
                  +---------------------------------------------+
 Passphrase ----->|  scrypt(pass, salt)  -->  64 bytes           |
                  |    |-- first 32 --> SHA-256 --> vault ID     |
                  |    +-- last  32 --> AES-256-GCM key          |
                  +---------------------------------------------+
                                      |
                       +--------------+--------------+
                       v                             v
                data/<vault_id>/               Vault unlocked
                |-- meta.db.enc    <-- encrypted SQLite
                +-- files/
                    |-- a7f3c9...enc  <-- encrypted blob
                    +-- b2e8d1...enc  <-- encrypted blob
```

The vault ID is derived deterministically from the passphrase. There is no user database. You cannot list vaults. You cannot tell if a directory is a vault or random data. The encrypted SQLite database inside contains all file names, folder structures, notes, bookmarks, and reading progress — invisible without the key.

<br>

---

<br>

## What's inside

<table>
<tr>
<td width="50%" valign="top">

### Encrypted file vault

Upload anything. Organize with nested folders. **AES-256-GCM** encryption before anything touches disk. File names, metadata, folder structure — all live inside the encrypted database. Nothing leaks.

<br>

### Full PDF reader

Powered by PDF.js. Not a basic viewer — a full reading environment:

- Continuous scroll with lazy page rendering
- Text search across the entire document
- **Resume reading** — saves your page, picks up where you left off
- Named bookmarks — jump to any saved position
- Text highlighting in 5 colors, persisted as annotations
- Zoom, rotate, fit-width, fit-page, thumbnail sidebar
- Dark mode for extended reading sessions

</td>
<td width="50%" valign="top">

### Notion-style note editor

Block-based rich text, not a textarea:

- **Slash commands** — type `/` to pick block types
- **Markdown shortcuts** — `# `, `- `, `> `, `---`, ` ``` ` auto-convert
- Inline formatting: bold, italic, underline, strikethrough, code, links
- Todo checkboxes, code blocks, blockquotes, dividers
- Drag-and-drop block reordering
- Embed files from your vault into notes
- 2-second debounced auto-save
- Content stored as structured JSON

<br>

### Document viewer

- **DOCX** rendered via Mammoth
- **XLSX** spreadsheet view via SheetJS
- Images, text, and code files rendered inline
- Download decrypted files on demand

</td>
</tr>
</table>

<br>

<table>
<tr>
<td width="50%" valign="top">

### Secure browser

Built-in web proxy via <a href="https://github.com/nfriedly/node-unblocker">unblocker</a>. Your browser makes **zero direct external requests** — everything routes through the vault server.

- Address bar doubles as search (DuckDuckGo)
- Back, forward, refresh with history
- `target="_blank"` suppressed
- Works for static sites, news, wikis, forums, search

> JS-heavy sites (YouTube, Discord, Google login) won't fully work. This is inherent to server-side proxying.

</td>
<td width="50%" valign="top">

### Panic button

Press **Esc** twice. Or click the bolt icon.

1. Server session destroyed **instantly**
2. Entire screen replaced with a **working calculator**

The calculator does real math. No vault content remains visible, in DOM or in memory. Click outside or press Esc 3x to return to login.

<br>

### Auto-lock

15 minutes of inactivity. Session destroyed. Login screen. Zero residue.

</td>
</tr>
</table>

<br>

---

<br>

## Security model

> **Threat model:** An adversary has physical access to the server, can read all files on disk, inspect all database contents, and monitor network traffic. They should learn *nothing* about what's stored, how many users exist, or what anyone is reading.

<table>
<tr><td width="200"><strong>Encryption</strong></td><td>AES-256-GCM per file + encrypted SQLite database</td></tr>
<tr><td><strong>Key derivation</strong></td><td>scrypt (N=32768, r=8, p=1) with persistent random salt</td></tr>
<tr><td><strong>Disk storage</strong></td><td>Random hex filenames. Zero correlation to real names.</td></tr>
<tr><td><strong>Database</strong></td><td>Encrypted at rest. Decrypted only in memory during active session.</td></tr>
<tr><td><strong>CSRF</strong></td><td>Per-request tokens. Invalidated after single use.</td></tr>
<tr><td><strong>Brute force</strong></td><td>5 attempts / 60s per IP, then 5-minute lockout.</td></tr>
<tr><td><strong>IP allowlist</strong></td><td>Optional. Non-listed IPs get empty 403. No hint a vault exists.</td></tr>
<tr><td><strong>Sessions</strong></td><td>HttpOnly cookies. 15-minute auto-lock. Strict security headers.</td></tr>
<tr><td><strong>HTTPS</strong></td><td>Auto-generated self-signed cert, or bring your own.</td></tr>
<tr><td><strong>Deniability</strong></td><td>No user table. No account list. Impossible to enumerate vaults.</td></tr>
</table>

<br>

---

<br>

## Configuration

All via environment variables. Nothing to accidentally commit.

| Variable | Default | What it does |
|:--|:--|:--|
| `PORT` | `3000` | Server port |
| `ALLOWED_IPS` | *(all)* | Comma-separated IP allowlist. Everyone else gets empty 403. |
| `TRUST_PROXY` | `false` | Set `true` behind nginx/cloudflare to trust `X-Forwarded-For` |

```bash
# Production: locked to one IP
PORT=443 ALLOWED_IPS=203.0.113.50 TRUST_PROXY=true node server.js

# Local access only
ALLOWED_IPS="127.0.0.1,::1" node server.js
```

<br>

---

<br>

## Stack

No frameworks. No build step. No bundler. No React. Vanilla JavaScript.

```
server.js                776 lines    Express, CSRF, rate limiting, proxy
src/crypto.js            128 lines    scrypt + AES-256-GCM
src/vault.js             635 lines    Encrypted SQLite vault operations
src/auth.js               73 lines    Sessions + auto-lock

public/js/app.js        3433 lines    SPA: file manager, notes editor, browser
public/js/pdf-viewer.js 2005 lines    PDF.js: full reader with annotations
public/css/app.css       1552 lines   Light theme
public/index.html         269 lines   HTML shell
                         --------
                         ~8,800 total
```

<details>
<summary>Runtime dependencies (11 packages)</summary>
<br>

| Package | Purpose |
|:--|:--|
| `express` | HTTP server |
| `better-sqlite3` | Vault metadata database |
| `helmet` | Security headers |
| `express-session` | Session management |
| `multer` | File uploads (up to 500MB) |
| `unblocker` | Web proxy middleware |
| `mammoth` | DOCX to HTML |
| `xlsx` | Spreadsheet processing |
| `uuid` | Random ID generation |
| `mime-types` | Content type detection |
| `csrf-csrf` | CSRF token generation |

</details>

<details>
<summary>Keyboard shortcuts</summary>
<br>

| Key | Action |
|:--|:--|
| **Esc Esc** | Panic — destroy session, show calculator |
| **Esc** | Close viewer, dismiss menus |
| **Ctrl+U** | Upload files |
| **Ctrl+K** | Focus search |
| **Ctrl+N** | New note |
| **Delete** | Trash selected items |
| **/** | Slash command menu (in notes) |
| **Ctrl+B / I / U** | Bold / Italic / Underline (in notes) |

</details>

<br>

---

<br>

## Limitations

These are intentional or inherent.

- **No password recovery.** The passphrase *is* the encryption key. Forget it and the data is gone forever. This is a feature.
- **Single machine.** No sync, no replication, no cloud. The vault lives where you put it.
- **Proxy boundaries.** YouTube, Google OAuth, Discord, and other JS-heavy apps won't work through the built-in browser.
- **Not audited.** Standard crypto primitives (scrypt + AES-256-GCM) but the implementation has not been professionally reviewed.

<br>

---

<br>

> **If someone gains access to your server,** they see encrypted noise.
>
> **If someone watches your network,** they see HTTPS to localhost.
>
> **If someone walks up to your screen,** they see a calculator.

<br>

---

<p align="center"><sub>MIT License</sub></p>
