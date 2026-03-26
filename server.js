const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const { execSync } = require('child_process');
const mime = require('mime-types');
const { deriveKeys, generateId } = require('./src/crypto');
const Vault = require('./src/vault');
const { sessions, requireAuth } = require('./src/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const ALLOWED_IPS = process.env.ALLOWED_IPS
  ? process.env.ALLOWED_IPS.split(',').map(ip => ip.trim())
  : null; // null = allow all

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// IP allowlist — blocks everything if ALLOWED_IPS is set
if (ALLOWED_IPS) {
  app.set('trust proxy', process.env.TRUST_PROXY === 'true');
  app.use((req, res, next) => {
    const clientIp = req.ip || req.connection.remoteAddress;
    // Normalize IPv6-mapped IPv4 (::ffff:127.0.0.1 → 127.0.0.1)
    const normalized = clientIp.replace(/^::ffff:/, '');
    if (ALLOWED_IPS.includes(normalized) || ALLOWED_IPS.includes(clientIp)) {
      return next();
    }
    // Return nothing useful — don't even reveal it's a vault
    res.status(403).end();
  });
}

app.disable('x-powered-by');

app.use(helmet({
  hsts: false, // Disable HSTS — we run on HTTP in dev
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "blob:", "data:"],
      connectSrc: ["'self'", "https://cdnjs.cloudflare.com"],
      workerSrc: ["'self'", "blob:", "https://cdnjs.cloudflare.com"],
      frameSrc: ["'self'", "blob:", "http:", "https:"]
    }
  }
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

app.use(session({
  secret: crypto.randomBytes(64).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.TRUST_PROXY === 'true' || false,
    maxAge: 30 * 60 * 1000
  }
}));

app.use(express.json());
app.use(express.static('public'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }
});

// ---------------------------------------------------------------------------
// CSRF + Rate Limiting for login
// ---------------------------------------------------------------------------

// CSRF: server generates a token per session, client must send it back
app.get('/api/auth/csrf', (req, res) => {
  const token = crypto.randomBytes(32).toString('hex');
  req.session.csrfToken = token;
  res.json({ token });
});

// Rate limiter: per-IP, max 5 attempts per 60 seconds
const loginAttempts = new Map(); // ip → { count, resetAt }
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW = 60 * 1000; // 60 seconds
const LOCKOUT_DURATION = 5 * 60 * 1000; // 5 min lockout after exceeding

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW, lockedUntil: 0 });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 };
  }
  if (entry.lockedUntil && now < entry.lockedUntil) {
    const waitSec = Math.ceil((entry.lockedUntil - now) / 1000);
    return { allowed: false, remaining: 0, waitSec };
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    entry.lockedUntil = now + LOCKOUT_DURATION;
    const waitSec = Math.ceil(LOCKOUT_DURATION / 1000);
    return { allowed: false, remaining: 0, waitSec };
  }
  return { allowed: true, remaining: RATE_LIMIT_MAX - entry.count };
}

// Clean up stale rate limit entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt && (!entry.lockedUntil || now > entry.lockedUntil)) {
      loginAttempts.delete(ip);
    }
  }
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

app.post('/api/auth/login', async (req, res) => {
  try {
    // Rate limit check
    const ip = req.ip || req.connection.remoteAddress;
    const rateCheck = checkRateLimit(ip);
    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: `Too many attempts. Try again in ${rateCheck.waitSec} seconds.`
      });
    }

    // CSRF check
    const clientToken = req.body._csrf || req.headers['x-csrf-token'];
    const sessionToken = req.session && req.session.csrfToken;
    if (!clientToken || !sessionToken || clientToken !== sessionToken) {
      return res.status(403).json({ error: 'Invalid or missing CSRF token' });
    }
    // Invalidate used token
    delete req.session.csrfToken;

    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    const { vaultId, encryptionKey } = deriveKeys(password);
    const vault = new Vault(vaultId, encryptionKey);
    await vault.open();

    const sessionKey = generateId();
    sessions.set(sessionKey, {
      vaultId,
      encryptionKey,
      vault,
      lastActivity: Date.now()
    });

    req.session.vaultSession = sessionKey;

    // Reset rate limit on success
    loginAttempts.delete(ip);

    res.json({ success: true, isNew: vault.isNew || false });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Failed to open vault' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  try {
    const sessionKey = req.session && req.session.vaultSession;
    if (sessionKey && sessions.has(sessionKey)) {
      const sess = sessions.get(sessionKey);
      try { sess.vault.close(); } catch (e) { /* ignore */ }
      sessions.delete(sessionKey);
    }

    req.session.destroy(() => {
      res.json({ success: true });
    });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Failed to logout' });
  }
});

app.get('/api/auth/status', (req, res) => {
  const sessionKey = req.session && req.session.vaultSession;
  const authenticated = !!(sessionKey && sessions.has(sessionKey));
  res.json({ authenticated });
});

// ---------------------------------------------------------------------------
// All remaining routes require authentication
// ---------------------------------------------------------------------------

app.use('/api', requireAuth);

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

app.get('/api/files', async (req, res) => {
  try {
    const folder = req.query.folder || null;
    const files = await req.vault.listFiles(folder);

    const filesWithProgress = await Promise.all(
      files.map(async (file) => {
        try {
          const progress = await req.vault.getProgress(file.id);
          return { ...file, lastPage: progress ? progress.lastPage : null };
        } catch (e) {
          return { ...file, lastPage: null };
        }
      })
    );

    res.json({ files: filesWithProgress });
  } catch (err) {
    console.error('List files error:', err);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

app.post('/api/files/upload', upload.array('files', 20), async (req, res) => {
  try {
    const createdFiles = [];
    for (const file of req.files) {
      const created = await req.vault.addFile(
        file.originalname,
        file.mimetype,
        file.size,
        req.body.folderId || null,
        file.buffer
      );
      createdFiles.push(created);
    }
    res.json({ success: true, files: createdFiles });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Failed to upload files' });
  }
});

app.get('/api/files/:id/view', async (req, res) => {
  try {
    const file = await req.vault.getFile(req.params.id);
    const content = await req.vault.getFileContent(req.params.id);

    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'no-store');
    res.send(content);
  } catch (err) {
    console.error('View file error:', err);
    res.status(404).json({ error: 'File not found' });
  }
});

app.put('/api/files/:id/rename', async (req, res) => {
  try {
    const { name } = req.body;
    await req.vault.renameFile(req.params.id, name);
    res.json({ success: true });
  } catch (err) {
    console.error('Rename file error:', err);
    res.status(500).json({ error: 'Failed to rename file' });
  }
});

app.put('/api/files/:id/move', async (req, res) => {
  try {
    const { folderId } = req.body;
    await req.vault.moveFile(req.params.id, folderId);
    res.json({ success: true });
  } catch (err) {
    console.error('Move file error:', err);
    res.status(500).json({ error: 'Failed to move file' });
  }
});

app.delete('/api/files/:id', async (req, res) => {
  try {
    await req.vault.trashFile(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Trash file error:', err);
    res.status(500).json({ error: 'Failed to trash file' });
  }
});

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

app.get('/api/folders', async (req, res) => {
  try {
    const parent = req.query.parent || null;
    const folders = await req.vault.listFolders(parent);
    res.json({ folders });
  } catch (err) {
    console.error('List folders error:', err);
    res.status(500).json({ error: 'Failed to list folders' });
  }
});

app.post('/api/folders', async (req, res) => {
  try {
    const { name, parentId } = req.body;
    const folder = await req.vault.createFolder(name, parentId || null);
    res.json({ success: true, folder });
  } catch (err) {
    console.error('Create folder error:', err);
    res.status(500).json({ error: 'Failed to create folder' });
  }
});

app.put('/api/folders/:id', async (req, res) => {
  try {
    const { name, parentId } = req.body;
    if (name !== undefined) {
      await req.vault.renameFolder(req.params.id, name);
    }
    if (parentId !== undefined) {
      await req.vault.moveFolder(req.params.id, parentId);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Update folder error:', err);
    res.status(500).json({ error: 'Failed to update folder' });
  }
});

app.delete('/api/folders/:id', async (req, res) => {
  try {
    await req.vault.trashFolder(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Trash folder error:', err);
    res.status(500).json({ error: 'Failed to trash folder' });
  }
});

app.get('/api/folders/:id/path', async (req, res) => {
  try {
    const folderPath = await req.vault.getFolderPath(req.params.id);
    res.json({ path: folderPath });
  } catch (err) {
    console.error('Get folder path error:', err);
    res.status(500).json({ error: 'Failed to get folder path' });
  }
});

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------

app.get('/api/bookmarks', async (req, res) => {
  try {
    const file = req.query.file || null;
    const bookmarks = await req.vault.getBookmarks(file);
    res.json({ bookmarks });
  } catch (err) {
    console.error('Get bookmarks error:', err);
    res.status(500).json({ error: 'Failed to get bookmarks' });
  }
});

app.post('/api/bookmarks', async (req, res) => {
  try {
    const { fileId, page, label } = req.body;
    const bookmark = await req.vault.addBookmark(fileId, page, label);
    res.json({ success: true, bookmark });
  } catch (err) {
    console.error('Add bookmark error:', err);
    res.status(500).json({ error: 'Failed to add bookmark' });
  }
});

app.delete('/api/bookmarks/:id', async (req, res) => {
  try {
    await req.vault.deleteBookmark(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete bookmark error:', err);
    res.status(500).json({ error: 'Failed to delete bookmark' });
  }
});

// ---------------------------------------------------------------------------
// Reading Progress
// ---------------------------------------------------------------------------

app.get('/api/progress/:fileId', async (req, res) => {
  try {
    const progress = await req.vault.getProgress(req.params.fileId);
    if (progress) {
      res.json(progress);
    } else {
      res.json({ lastPage: null });
    }
  } catch (err) {
    console.error('Get progress error:', err);
    res.status(500).json({ error: 'Failed to get progress' });
  }
});

app.put('/api/progress/:fileId', async (req, res) => {
  try {
    const { lastPage, scrollPosition } = req.body;
    await req.vault.setProgress(req.params.fileId, lastPage, scrollPosition);
    res.json({ success: true });
  } catch (err) {
    console.error('Set progress error:', err);
    res.status(500).json({ error: 'Failed to set progress' });
  }
});

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

app.get('/api/annotations/:fileId', async (req, res) => {
  try {
    const annotations = await req.vault.getAnnotations(req.params.fileId);
    res.json({ annotations });
  } catch (err) {
    console.error('Get annotations error:', err);
    res.status(500).json({ error: 'Failed to get annotations' });
  }
});

app.post('/api/annotations', async (req, res) => {
  try {
    const { fileId, page, type, data } = req.body;
    const annotation = await req.vault.addAnnotation(fileId, page, type, data);
    res.json({ success: true, annotation });
  } catch (err) {
    console.error('Add annotation error:', err);
    res.status(500).json({ error: 'Failed to add annotation' });
  }
});

app.delete('/api/annotations/:id', async (req, res) => {
  try {
    await req.vault.deleteAnnotation(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete annotation error:', err);
    res.status(500).json({ error: 'Failed to delete annotation' });
  }
});

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

app.get('/api/notes', async (req, res) => {
  try {
    const folder = req.query.folder || null;
    const notes = await req.vault.listNotes(folder);
    res.json({ notes });
  } catch (err) {
    console.error('List notes error:', err);
    res.status(500).json({ error: 'Failed to list notes' });
  }
});

app.post('/api/notes', async (req, res) => {
  try {
    const { title, content, folderId } = req.body;
    const note = await req.vault.createNote(title, content, folderId || null);
    res.json({ success: true, note });
  } catch (err) {
    console.error('Create note error:', err);
    res.status(500).json({ error: 'Failed to create note' });
  }
});

app.get('/api/notes/:id', async (req, res) => {
  try {
    const note = await req.vault.getNote(req.params.id);
    res.json({ note });
  } catch (err) {
    console.error('Get note error:', err);
    res.status(500).json({ error: 'Failed to get note' });
  }
});

app.put('/api/notes/:id', async (req, res) => {
  try {
    const { title, content } = req.body;
    await req.vault.updateNote(req.params.id, title, content);
    res.json({ success: true });
  } catch (err) {
    console.error('Update note error:', err);
    res.status(500).json({ error: 'Failed to update note' });
  }
});

app.delete('/api/notes/:id', async (req, res) => {
  try {
    await req.vault.trashNote(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Trash note error:', err);
    res.status(500).json({ error: 'Failed to trash note' });
  }
});

// ---------------------------------------------------------------------------
// Trash
// ---------------------------------------------------------------------------

app.get('/api/trash', async (req, res) => {
  try {
    const items = await req.vault.listTrash();
    res.json({ items });
  } catch (err) {
    console.error('List trash error:', err);
    res.status(500).json({ error: 'Failed to list trash' });
  }
});

app.post('/api/trash/empty', async (req, res) => {
  try {
    await req.vault.emptyTrash();
    res.json({ success: true });
  } catch (err) {
    console.error('Empty trash error:', err);
    res.status(500).json({ error: 'Failed to empty trash' });
  }
});

app.post('/api/trash/:id/restore', async (req, res) => {
  try {
    const { itemType } = req.body;
    await req.vault.restoreItem(req.params.id, itemType);
    res.json({ success: true });
  } catch (err) {
    console.error('Restore item error:', err);
    res.status(500).json({ error: 'Failed to restore item' });
  }
});

app.delete('/api/trash/:id', async (req, res) => {
  try {
    const itemType = (req.body && req.body.itemType) || req.query.itemType;
    await req.vault.deletePermanently(req.params.id, itemType);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete permanently error:', err);
    res.status(500).json({ error: 'Failed to delete permanently' });
  }
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    const results = await req.vault.search(q);
    res.json({ results });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Failed to search' });
  }
});

// ---------------------------------------------------------------------------
// Web Proxy — powered by unblocker
// Handles URL rewriting, cookies, streaming, WebSocket automatically.
// Mounted at /browse/ — usage: /browse/https://example.com
// ---------------------------------------------------------------------------

const Unblocker = require('unblocker');

// Allow proxying sites with cert issues (corporate proxies, self-signed, etc.)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Script injected into proxied HTML pages to fix navigation behavior
const PROXY_INJECT_SCRIPT = Buffer.from(`<script>
(function(){
  // Remove all target="_blank" so links don't open new tabs
  new MutationObserver(function(muts){
    document.querySelectorAll('[target="_blank"],[target="_new"]').forEach(function(el){
      el.removeAttribute('target');
    });
  }).observe(document.documentElement,{childList:true,subtree:true});
  // Also fix existing ones on load
  document.addEventListener('DOMContentLoaded',function(){
    document.querySelectorAll('[target="_blank"],[target="_new"]').forEach(function(el){
      el.removeAttribute('target');
    });
  });
  // Prevent window.open from opening new tabs — navigate in same frame
  var _open=window.open;
  window.open=function(url){
    if(url)location.href=url;
    return window;
  };
})();
</script>`);

const unblocker = new Unblocker({
  prefix: '/browse/',
  responseMiddleware: [
    // Strip security headers from proxied responses
    function stripSecurityHeaders(data) {
      if (data.headers) {
        delete data.headers['content-security-policy'];
        delete data.headers['content-security-policy-report-only'];
        delete data.headers['x-frame-options'];
        delete data.headers['strict-transport-security'];
        delete data.headers['cross-origin-opener-policy'];
        delete data.headers['cross-origin-resource-policy'];
        delete data.headers['cross-origin-embedder-policy'];
      }
    },
    // Inject script into HTML to prevent new-tab behavior
    function injectScript(data) {
      if (data.contentType && data.contentType.includes('text/html')) {
        data.stream.write(PROXY_INJECT_SCRIPT);
      }
    }
  ]
});

// Auth gate + strip all security headers for proxied content
app.use('/browse/', (req, res, next) => {
  const sessionKey = req.session && req.session.vaultSession;
  if (!sessionKey || !sessions.has(sessionKey)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  sessions.get(sessionKey).lastActivity = Date.now();
  // Strip everything that could block proxied content or force HTTPS
  res.removeHeader('Content-Security-Policy');
  res.removeHeader('Content-Security-Policy-Report-Only');
  res.removeHeader('X-Frame-Options');
  res.removeHeader('Strict-Transport-Security');
  res.removeHeader('Cross-Origin-Opener-Policy');
  res.removeHeader('Cross-Origin-Resource-Policy');
  res.removeHeader('Cross-Origin-Embedder-Policy');
  next();
});

app.use(unblocker);

// ---------------------------------------------------------------------------
// File Conversion (DOCX, XLSX)
// ---------------------------------------------------------------------------

app.get('/api/convert/:fileId', async (req, res) => {
  try {
    const file = await req.vault.getFile(req.params.fileId);
    const fileContent = await req.vault.getFileContent(req.params.fileId);

    const mimeType = file.mime_type;
    let html = '';

    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        file.name.endsWith('.docx')) {
      const mammoth = require('mammoth');
      const result = await mammoth.convertToHtml({ buffer: fileContent });
      html = result.value;
    } else if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
               file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
      const XLSX = require('xlsx');
      const workbook = XLSX.read(fileContent);
      const htmlParts = [];
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const sheetHtml = XLSX.utils.sheet_to_html(sheet);
        htmlParts.push(`<h2>${sheetName}</h2>${sheetHtml}`);
      }
      html = htmlParts.join('\n');
    } else {
      return res.status(400).json({ error: 'Unsupported file type for conversion' });
    }

    res.json({ html });
  } catch (err) {
    console.error('Convert error:', err);
    res.status(500).json({ error: 'Failed to convert file' });
  }
});

// ---------------------------------------------------------------------------
// SPA catch-all
// ---------------------------------------------------------------------------

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start server (HTTPS with auto-generated self-signed cert)
// ---------------------------------------------------------------------------

function getOrCreateCert() {
  const certDir = path.join(__dirname, 'data');
  const keyPath = path.join(certDir, '.cert-key.pem');
  const certPath = path.join(certDir, '.cert.pem');

  fs.mkdirSync(certDir, { recursive: true });

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }

  try {
    execSync(
      `openssl req -new -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${certPath}" -days 3650 -subj "/CN=localhost"`,
      { stdio: 'pipe' }
    );
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  } catch (e) {
    console.log('openssl not available, cannot create TLS cert');
    return null;
  }
}

let server;
const forceHttp = process.env.FORCE_HTTP === 'true' || process.env.TRUST_PROXY === 'true';

if (!forceHttp) {
  const tlsCert = getOrCreateCert();
  if (tlsCert) {
    server = https.createServer(tlsCert, app).listen(PORT, () => {
      console.log(`Vault server running on https://localhost:${PORT}`);
    });
  } else {
    server = app.listen(PORT, () => {
      console.log(`Vault server running on http://localhost:${PORT}`);
    });
  }
} else {
  // Behind reverse proxy (Coolify, nginx, etc.) — proxy handles SSL
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Vault server running on http://0.0.0.0:${PORT} (behind proxy)`);
  });
}

// WebSocket upgrade handler for unblocker proxy
server.on('upgrade', unblocker.onUpgrade);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

process.on('SIGINT', () => {
  for (const [key, sess] of sessions) {
    try { sess.vault.close(); } catch (e) { /* ignore */ }
  }
  process.exit(0);
});
