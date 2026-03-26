
<div align="center">

<br>

```
 ___  ___  ________  ___  ___  ___   _________
|\  \|\  \|\   __  \|\  \|\  \|\  \ |\___   ___\
\ \  \\\  \ \  \|\  \ \  \\\  \ \  \\|___ \  \_|
 \ \  \\\  \ \   __  \ \  \\\  \ \  \    \ \  \
  \ \  \\\  \ \  \ \  \ \  \\\  \ \  \____\ \  \
   \ \_______\ \__\ \__\ \_______\ \_______\ \__\
    \|_______|\|__|\|__|\|_______|\|_______|\|__|
```

**One password. One vault. Zero traces.**

Your files encrypted at rest. Your reading position remembered.<br>
Your notes are yours alone. Even the server admin sees nothing.

---

[Get Started](#get-started) &middot; [How It Works](#how-it-works) &middot; [Features](#features) &middot; [Security](#security) &middot; [Configuration](#configuration)

<br>
</div>

## The Problem

You have documents you can't store in Google Drive. Notes you can't put in Notion. Bookmarks into books nobody should know you're reading. You need a place that doesn't just *promise* privacy &mdash; it *enforces* it structurally.

Most "secure" apps encrypt your data but still expose file names, folder structures, and access patterns to the server. Vault encrypts **everything** &mdash; the database, every file, every byte &mdash; with a key derived from your passphrase that never touches disk.

Different passphrase? Different vault. No one can even tell how many vaults exist.

---

## Get Started

```bash
git clone <repo-url> vault && cd vault
npm install
```

Generate an HTTPS certificate (required for secure cookies):

```bash
openssl req -new -x509 -newkey rsa:2048 -nodes \
  -keyout data/.cert-key.pem -out data/.cert.pem \
  -days 3650 -subj "/CN=localhost"
```

Run it:

```bash
node server.js
```

Open `https://localhost:3000`. Enter any passphrase. That's it &mdash; your vault exists now.

---

## How It Works

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
                  |-- meta.db.enc    <-- encrypted SQLite database
                  +-- files/
                      |-- a7f3c9...enc  <-- encrypted file
                      |-- b2e8d1...enc  <-- encrypted file
                      +-- ...

   Every file name on disk is a random hex string.
   The database mapping names to files is itself encrypted.
   Without the passphrase, it's all noise.
```

**Multi-identity by design.** The vault ID is derived deterministically from the passphrase. Different passphrase = different vault directory. There's no master user table, no account list, no way to enumerate what exists. An attacker with full disk access sees random directories full of random encrypted blobs.

---

## Features

### Document Vault
Upload anything. Organize with folders. Everything encrypted with AES-256-GCM before it touches disk. File names, metadata, folder structure &mdash; all inside the encrypted database.

### PDF Reader
Full-featured viewer powered by PDF.js.

- Continuous scroll with lazy rendering (handles 1000+ page documents)
- Text selection and in-document search
- Bookmarks with labels &mdash; jump to any saved position
- **Resume reading** &mdash; auto-saves your last page, picks up where you left off
- Highlight text in 5 colors, saved as persistent annotations
- Zoom, rotate, fit-width, fit-page
- Thumbnail sidebar
- Dark mode for night reading
- Keyboard shortcuts throughout

### Notion-Style Notes
Block-based rich text editor.

- Headings, paragraphs, bullet lists, numbered lists, checkboxes
- Code blocks, blockquotes, dividers
- **Slash commands** &mdash; type `/` to insert any block type
- **Markdown shortcuts** &mdash; `# `, `- `, `1. `, `> `, `---`, `` ``` `` auto-convert as you type
- Inline formatting: **bold**, *italic*, <u>underline</u>, ~~strikethrough~~, `code`, links
- Drag-and-drop block reordering
- Embed files from your vault directly into notes
- 2-second debounced auto-save
- Stored as structured JSON &mdash; not fragile HTML

### Document Viewer
- **DOCX** rendered to clean HTML via Mammoth
- **XLSX/XLS** spreadsheet viewer with sheet tabs via SheetJS
- Images displayed inline with zoom
- Text and code files with proper rendering
- Download anything back to your machine, decrypted on the fly

### Secure Browser
Built-in web proxy powered by [unblocker](https://github.com/nfriedly/node-unblocker). Browse without your machine making direct external requests.

- All traffic routes through the vault server
- URL bar doubles as search &mdash; non-URLs go to DuckDuckGo
- Back / forward / refresh with history
- `target="_blank"` suppressed &mdash; navigation stays inside the vault
- Works well for static sites, news, wikis, forums, search engines

> **Note:** Sites with heavy client-side JS (YouTube, Discord, Google login) won't fully work. This is a fundamental limitation of server-side proxying.

### Panic Button
Press **Esc twice** or click the bolt icon. The vault instantly:

1. Destroys the server session
2. Replaces the entire screen with a **working calculator**

Click outside the calculator or press Esc three times to return to login. No vault content remains visible. The calculator actually does math &mdash; it's not a screenshot.

---

## Security

| Layer | Implementation |
|---|---|
| **Encryption** | AES-256-GCM per file + encrypted SQLite database |
| **Key Derivation** | scrypt (N=32768, r=8, p=1) with persistent random salt |
| **File Names on Disk** | Random hex &mdash; zero correlation to actual names |
| **Database** | Encrypted at rest, decrypted only in memory during session |
| **CSRF Protection** | Per-request tokens, invalidated after single use |
| **Brute Force** | 5 attempts / 60s per IP, then 5-minute lockout |
| **IP Allowlist** | Optional &mdash; restrict access to specific IPs via env var |
| **Session** | HttpOnly cookies, auto-lock after 15 min inactivity |
| **Headers** | Helmet with strict CSP, no-referrer, no-store cache |
| **Temp Files** | Session database cleaned up on close and on crash recovery |
| **HTTPS** | Auto-generated self-signed cert, or bring your own |
| **Deniability** | No master user list. No way to tell how many vaults exist. |

### What the server admin sees

```
data/
  .salt
  a3f8b2c19e4d.../
    meta.db.enc              <- ???
    files/
      7cfe1d2f261f...enc     <- ???
      9a3b4e8c0d12...enc     <- ???
  f7d2918a5c0b.../
    meta.db.enc              <- ???
    files/
      2e8f4a1b9c7d...enc    <- ???
```

No file names. No file types. No folder names. No note titles. No reading history. Nothing.

---

## Configuration

All configuration through environment variables. Nothing to accidentally commit.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Server port |
| `ALLOWED_IPS` | *(all)* | Comma-separated IP allowlist. Everyone else gets empty 403. |
| `TRUST_PROXY` | `false` | Set `true` behind nginx/cloudflare to read `X-Forwarded-For` |

```bash
# Lock to one IP, production port
PORT=443 ALLOWED_IPS=203.0.113.50 TRUST_PROXY=true node server.js

# Local access only
ALLOWED_IPS="127.0.0.1,::1" node server.js
```

---

## Stack

No frameworks. No build step. No webpack. No React. Just files that do what they're supposed to do.

```
server.js              776 lines    Express, routing, CSRF, rate limiting, proxy
src/crypto.js          128 lines    scrypt KDF, AES-256-GCM encrypt/decrypt
src/vault.js           635 lines    Encrypted SQLite vault management
src/auth.js             73 lines    Session middleware, auto-lock

public/js/app.js      3433 lines    Vanilla JS SPA — file manager, rich notes editor, browser
public/js/pdf-viewer.js 2005 lines  PDF.js — full reader with annotations & highlights
public/css/app.css     1552 lines   Light theme, zero preprocessors
public/index.html       269 lines   Semantic HTML shell
```

**~8,800 lines total.** Zero client-side build dependencies. PDF.js and Font Awesome loaded from CDN.

### Runtime Dependencies

| Package | Why |
|---|---|
| `express` | Server |
| `better-sqlite3` | Vault metadata (encrypted at rest) |
| `helmet` | Security headers |
| `express-session` | Session management |
| `multer` | File uploads |
| `unblocker` | Web proxy |
| `mammoth` | DOCX to HTML |
| `xlsx` | Spreadsheet processing |
| `uuid` | Random IDs |
| `mime-types` | Content type detection |
| `csrf-csrf` | CSRF token generation |

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Esc` `Esc` | Panic &mdash; kill session, show calculator |
| `Esc` | Close viewer, dismiss menus |
| `Ctrl+U` | Upload files |
| `Ctrl+K` | Focus search |
| `Ctrl+N` | New note |
| `Delete` | Trash selected items |
| `/` | *(in notes)* Open slash command menu |
| `Ctrl+B` / `I` / `U` | *(in notes)* Bold / Italic / Underline |

---

## Limitations

These are intentional or inherent. Not bugs.

- **No password recovery.** The passphrase *is* the encryption key. Forget it and the data is gone forever. This is the point.
- **Single server.** No sync, no replication, no cloud. The vault lives on one machine you control.
- **Proxy can't do everything.** YouTube, Google OAuth, Discord, and other heavy JS apps won't work through the built-in browser. Use it for reading, searching, and browsing static content.
- **Not audited.** This is a working tool, not a certified security product. The crypto is standard (scrypt + AES-256-GCM) but the implementation has not been professionally reviewed.

---

<div align="center">
<br>

*If someone gains access to your server, they see encrypted noise.*<br>
*If someone watches your network, they see HTTPS to localhost.*<br>
*If someone walks up to your screen, they see a calculator.*

<br>
</div>

## License

MIT
