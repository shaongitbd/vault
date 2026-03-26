<p align="center">
  <img src="public/banner.svg" alt="VAULT — Encrypted Document Vault" width="100%">
</p>

<br>

<h1 align="center">One password. One vault. Zero traces.</h1>

<p align="center">
  <img src="https://img.shields.io/badge/AES--256--GCM-Encrypted-0d7377?style=for-the-badge&labelColor=080f10" alt="AES-256-GCM">
  <img src="https://img.shields.io/badge/scrypt-Key_Derivation-0d7377?style=for-the-badge&labelColor=080f10" alt="scrypt">
  <img src="https://img.shields.io/badge/Zero-Frameworks-1c1c1a?style=for-the-badge&labelColor=080f10" alt="No frameworks">
  <img src="https://img.shields.io/badge/8,800-Lines_of_Code-1c1c1a?style=for-the-badge&labelColor=080f10" alt="8.8k lines">
</p>

<br>

<p align="center"><i>
Every file encrypted at rest. Every filename hidden. Every note locked.<br>
Even the server admin sees nothing but random noise on disk.<br>
Forget the passphrase and the vault is gone forever. That's the point.
</i></p>

<br>

<img src="public/divider.svg" width="100%">

<br>

## Why this exists

<table>
<tr>
<td width="55%" valign="top">

<br>

You have documents you can't store in Google Drive.

Notes you can't put in Notion.

Bookmarks into books nobody should know you're reading.

Most "secure" apps encrypt your data but still expose **file names, folder structures, and access patterns** to the server. Vault encrypts *everything* — the database, every file, every byte — with a key derived from your passphrase that **never touches disk**.

> **Different passphrase = different vault.**
> No master user list. No account table. No way to know how many vaults exist.
> An attacker with root access sees random directories full of random encrypted blobs.

<br>

</td>
<td width="45%" valign="top">

<br>

#### What root access to the server reveals:

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

**No file names.** No file types. No folder names.
No note titles. No reading history.

Nothing.

<br>

</td>
</tr>
</table>

<br>

<img src="public/divider.svg" width="100%">

<br>

## 3 commands to start

```bash
git clone <repo-url> vault && cd vault
npm install
openssl req -new -x509 -newkey rsa:2048 -nodes -keyout data/.cert-key.pem -out data/.cert.pem -days 3650 -subj "/CN=localhost"
```

```bash
node server.js
# -> Vault server running on https://localhost:3000
```

**Open the URL. Enter any passphrase. That passphrase *is* the vault.**

<br>

<img src="public/divider.svg" width="100%">

<br>

## How encryption works

```
                   +----------------------------------------------+
  Passphrase ----->|  scrypt(pass, salt)  --->  64 bytes           |
                   |    |--- first 32 ---> SHA-256 ---> vault ID  |
                   |    +--- last  32 ---> AES-256-GCM key        |
                   +----------------------------------------------+
                                       |
                        +--------------+--------------+
                        v                             v
                 data/<vault_id>/               Vault unlocked
                 |-- meta.db.enc    <-- encrypted SQLite database
                 +-- files/
                     |-- a7f3c9...enc  <-- encrypted blob
                     +-- b2e8d1...enc  <-- encrypted blob
```

> The vault ID is derived deterministically from the passphrase. There is no user database. You cannot list vaults. You cannot tell if a directory is a vault or random data. The encrypted SQLite database inside holds all filenames, folder structures, notes, bookmarks, reading progress — **invisible without the key.**

<br>

<img src="public/divider.svg" width="100%">

<br>

## What's inside

<br>

<table>
<tr>
<td valign="top" width="50%">

### Encrypted file vault

Upload anything. Organize with nested folders. **AES-256-GCM** encryption before anything touches disk. Filenames, metadata, folder structure — all inside the encrypted database.

<br>

### Full PDF reader

Not a basic viewer. A full reading environment powered by PDF.js:

- Continuous scroll with lazy page rendering
- Full-text search across the entire document
- **Resume reading** — saves your page, picks up where you left off
- Named bookmarks — jump to any saved position
- Text highlighting in **5 colors**, persisted as annotations
- Zoom, rotate, fit-width, fit-page, thumbnail sidebar
- Dark mode for extended reading
- Keyboard shortcuts throughout

</td>
<td valign="top" width="50%">

### Notion-style note editor

Block-based rich text. Not a textarea.

- **Slash commands** — type `/` to pick any block type
- **Markdown shortcuts** — `# `, `- `, `> `, `---`, ` ``` ` auto-convert
- Bold, italic, underline, strikethrough, inline code, links
- Todo checkboxes, code blocks, blockquotes, dividers
- **Drag-and-drop** block reordering
- **Embed vault files** directly into notes
- 2-second debounced auto-save
- Stored as structured JSON

<br>

### Document viewer

- **DOCX** rendered to clean HTML via Mammoth
- **XLSX** spreadsheet viewer via SheetJS
- Images, text, code files rendered inline
- Download decrypted files on demand

</td>
</tr>
</table>

<br>

<table>
<tr>
<td valign="top" width="50%">

### Secure browser

Built-in web proxy via <a href="https://github.com/nfriedly/node-unblocker">unblocker</a>. Your browser makes **zero direct external requests**.

- Address bar doubles as search (DuckDuckGo)
- Back, forward, refresh with full history
- All `target="_blank"` suppressed
- Works for static sites, news, wikis, forums, search

> JS-heavy sites (YouTube, Discord, Google) won't fully work. Inherent to server-side proxying.

</td>
<td valign="top" width="50%">

### Panic button

Press **Esc** twice. Or click the bolt icon.

> **1.** Server session destroyed instantly
> **2.** Entire screen replaced with a **working calculator**

No vault content remains visible — not in the DOM, not in memory. The calculator does real math. Press Esc 3x to return to login.

### Auto-lock

15 minutes of inactivity. Session destroyed. Zero residue.

</td>
</tr>
</table>

<br>

<img src="public/divider.svg" width="100%">

<br>

## Security model

> **Threat scenario:** An adversary has root access to the server, can read every file on disk, inspect every database, and monitor all network traffic. They should learn **nothing** — not what's stored, not how many users exist, not what anyone is reading.

<br>

| | |
|:--|:--|
| **Encryption** | AES-256-GCM per file + encrypted SQLite database |
| **Key derivation** | scrypt (N=32768, r=8, p=1) with persistent random salt |
| **Disk storage** | Random hex filenames. Zero correlation to actual names. |
| **Database** | Encrypted at rest. Decrypted only in memory during session. |
| **CSRF** | Per-request tokens. Invalidated after single use. |
| **Brute force** | 5 attempts / 60s per IP, then 5-minute lockout. |
| **IP allowlist** | Optional. Non-listed IPs get empty 403. No hint a vault exists. |
| **Sessions** | HttpOnly cookies. 15-min auto-lock. Strict security headers. |
| **HTTPS** | Auto-generated self-signed cert, or bring your own. |
| **Deniability** | No user table. No account list. Impossible to enumerate vaults. |

<br>

<img src="public/divider.svg" width="100%">

<br>

## Configuration

Environment variables only. Nothing to accidentally commit.

| Variable | Default | What it does |
|:--|:--|:--|
| `PORT` | `3000` | Server port |
| `ALLOWED_IPS` | *(all)* | Comma-separated IP allowlist. Everyone else gets empty 403. |
| `TRUST_PROXY` | `false` | Set `true` behind nginx/cloudflare |

```bash
# Production: locked to one IP
PORT=443 ALLOWED_IPS=203.0.113.50 TRUST_PROXY=true node server.js

# Local only
ALLOWED_IPS="127.0.0.1,::1" node server.js
```

<br>

<img src="public/divider.svg" width="100%">

<br>

## Stack

**No frameworks. No build step. No bundler. No React. Vanilla JavaScript.**

```
server.js                776 lines    Express, CSRF, rate limiting, proxy
src/crypto.js            128 lines    scrypt + AES-256-GCM
src/vault.js             635 lines    Encrypted SQLite vault
src/auth.js               73 lines    Sessions + auto-lock

public/js/app.js        3433 lines    SPA: files, notes editor, browser
public/js/pdf-viewer.js 2005 lines    PDF.js: reader with annotations
public/css/app.css       1552 lines   Light theme
public/index.html         269 lines   HTML shell
                         --------
                         ~8,800 total
```

<details>
<summary><strong>11 runtime dependencies</strong></summary>
<br>

| Package | Purpose |
|:--|:--|
| express | HTTP server |
| better-sqlite3 | Vault metadata database |
| helmet | Security headers |
| express-session | Session management |
| multer | File uploads (up to 500MB) |
| unblocker | Web proxy middleware |
| mammoth | DOCX to HTML |
| xlsx | Spreadsheet processing |
| uuid | Random ID generation |
| mime-types | Content type detection |
| csrf-csrf | CSRF token generation |

</details>

<details>
<summary><strong>Keyboard shortcuts</strong></summary>
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
| **Ctrl+B/I/U** | Bold / Italic / Underline (in notes) |

</details>

<br>

<img src="public/divider.svg" width="100%">

<br>

## Limitations

- **No password recovery.** The passphrase *is* the encryption key. Forget it and the data is gone forever. This is a feature.
- **Single machine.** No sync, no replication, no cloud. The vault lives where you put it.
- **Proxy boundaries.** YouTube, Google OAuth, Discord won't work through the built-in browser.
- **Not audited.** Standard crypto (scrypt + AES-256-GCM) but the implementation has not been professionally reviewed.

<br>

<img src="public/divider.svg" width="100%">

<br>

<br>

> **If someone gains access to your server,** they see encrypted noise.
>
> **If someone watches your network,** they see HTTPS to localhost.
>
> **If someone walks up to your screen,** they see a calculator.

<br>

<br>

---

<p align="center"><sub>MIT License</sub></p>
