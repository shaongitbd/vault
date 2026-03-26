'use strict';

/**
 * Session store for active vault sessions.
 * Maps sessionId to { vaultId, encryptionKey, vault, lastActivity }.
 * @type {Map<string, { vaultId: string, encryptionKey: Buffer, vault: import('./vault'), lastActivity: number }>}
 */
const sessions = new Map();

/**
 * Auto-lock timeout in milliseconds (15 minutes).
 */
const AUTO_LOCK_MS = 15 * 60 * 1000;

/**
 * Express middleware that ensures the request has an authenticated vault
 * session. Reads the session identifier from `req.session.vaultSession` and
 * looks it up in the in-memory sessions Map.
 *
 * On success, attaches `req.vault` for downstream handlers.
 * On failure, responds with 401.
 */
function requireAuth(req, res, next) {
  const sessionId = req.session && req.session.vaultSession;

  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const entry = sessions.get(sessionId);

  if (!entry.vault) {
    return res.status(401).json({ error: 'Vault not open' });
  }

  // Update last activity timestamp
  entry.lastActivity = Date.now();

  req.vault = entry.vault;
  next();
}

/**
 * Periodically check for idle sessions and close them.
 * Runs every 60 seconds.
 */
const _cleanupInterval = setInterval(() => {
  const now = Date.now();

  for (const [sessionId, entry] of sessions) {
    if (now - entry.lastActivity > AUTO_LOCK_MS) {
      try {
        if (entry.vault) {
          entry.vault.close();
        }
      } catch (_) {
        // Vault may already be closed; ignore errors during cleanup.
      }
      sessions.delete(sessionId);
    }
  }
}, 60 * 1000);

// Allow the Node.js process to exit even if the interval is still active.
if (_cleanupInterval.unref) {
  _cleanupInterval.unref();
}

module.exports = {
  sessions,
  requireAuth,
  AUTO_LOCK_MS,
};
