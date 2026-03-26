'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const { encrypt, decrypt, generateId } = require('./crypto');

const DATA_DIR = path.join(process.cwd(), 'data');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime_type TEXT,
  size INTEGER,
  folder_id TEXT,
  storage_name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  is_trashed INTEGER DEFAULT 0,
  trashed_at TEXT
);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  is_trashed INTEGER DEFAULT 0,
  trashed_at TEXT
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  page INTEGER,
  label TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reading_progress (
  file_id TEXT PRIMARY KEY,
  last_page INTEGER,
  scroll_position REAL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  page INTEGER,
  type TEXT,
  data TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT,
  folder_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  is_trashed INTEGER DEFAULT 0,
  trashed_at TEXT
);
`;

class Vault {
  /**
   * @param {string} vaultId
   * @param {Buffer} encryptionKey - 32-byte key
   */
  constructor(vaultId, encryptionKey) {
    this.vaultId = vaultId;
    this.encryptionKey = encryptionKey;
    this.db = null;
    this.isNew = false;
  }

  /** @returns {string} */
  get vaultDir() {
    return path.join(DATA_DIR, this.vaultId);
  }

  /** @returns {string} */
  get filesDir() {
    return path.join(this.vaultDir, 'files');
  }

  /** @returns {string} */
  get encPath() {
    return path.join(this.vaultDir, 'meta.db.enc');
  }

  /** @returns {string} */
  get tmpDbPath() {
    return path.join(this.vaultDir, '.session.db');
  }

  // ---------------------------------------------------------------------------
  // Core lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Open the vault. Decrypts the metadata database into a temporary file for
   * use with better-sqlite3. If the vault does not exist yet, creates a fresh
   * database with the full schema.
   */
  open() {
    const vaultDir = this.vaultDir;
    const encPath = this.encPath;
    const tmpPath = this.tmpDbPath;

    // Clean up stale temp files from crashed sessions
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpPath + suffix); } catch (_) {}
    }

    if (fs.existsSync(encPath)) {
      const encryptedBuf = fs.readFileSync(encPath);
      const decryptedBuf = decrypt(encryptedBuf, this.encryptionKey);
      fs.writeFileSync(tmpPath, decryptedBuf);
      this.db = new Database(tmpPath);
    } else {
      this.isNew = true;
      fs.mkdirSync(vaultDir, { recursive: true });
      fs.mkdirSync(this.filesDir, { recursive: true });
      this.db = new Database(tmpPath);
      this.db.exec(SCHEMA_SQL);
    }

    this.db.pragma('journal_mode = WAL');
  }

  /**
   * Persist the current in-session database to the encrypted meta.db.enc file.
   */
  save() {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    const raw = fs.readFileSync(this.tmpDbPath);
    const encryptedBuf = encrypt(raw, this.encryptionKey);
    fs.writeFileSync(this.encPath, encryptedBuf);
  }

  /**
   * Save, close the database handle, and clean up temporary files.
   */
  close() {
    if (!this.db) return;
    this.save();
    this.db.close();
    this.db = null;

    const tmpPath = this.tmpDbPath;
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(tmpPath + suffix);
      } catch (_) {
        // file may not exist; that is fine
      }
    }
  }

  // ---------------------------------------------------------------------------
  // File operations
  // ---------------------------------------------------------------------------

  /**
   * Add a file to the vault.
   *
   * @param {string} name
   * @param {string} mimeType
   * @param {number} size
   * @param {string|null} folderId
   * @param {Buffer} fileBuffer
   * @returns {object} the inserted file record
   */
  addFile(name, mimeType, size, folderId, fileBuffer) {
    const id = generateId();
    const storageName = generateId() + '.enc';
    const encryptedFile = encrypt(fileBuffer, this.encryptionKey);

    fs.mkdirSync(this.filesDir, { recursive: true });
    fs.writeFileSync(path.join(this.filesDir, storageName), encryptedFile);

    const stmt = this.db.prepare(`
      INSERT INTO files (id, name, mime_type, size, folder_id, storage_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, name, mimeType, size, folderId || null, storageName);
    this.save();

    return this.db.prepare('SELECT * FROM files WHERE id = ?').get(id);
  }

  /**
   * Get file metadata by ID (non-trashed only).
   */
  getFile(id) {
    return this.db
      .prepare('SELECT * FROM files WHERE id = ? AND is_trashed = 0')
      .get(id);
  }

  /**
   * Read and decrypt a file's content from disk.
   *
   * @param {string} id
   * @returns {Buffer}
   */
  getFileContent(id) {
    const file = this.getFile(id);
    if (!file) throw new Error(`File not found: ${id}`);
    const encryptedBuf = fs.readFileSync(
      path.join(this.filesDir, file.storage_name),
    );
    return decrypt(encryptedBuf, this.encryptionKey);
  }

  /**
   * List non-trashed files in a folder (or root when folderId is null).
   */
  listFiles(folderId) {
    if (folderId == null) {
      return this.db
        .prepare(
          'SELECT * FROM files WHERE folder_id IS NULL AND is_trashed = 0 ORDER BY name',
        )
        .all();
    }
    return this.db
      .prepare(
        'SELECT * FROM files WHERE folder_id = ? AND is_trashed = 0 ORDER BY name',
      )
      .all(folderId);
  }

  renameFile(id, newName) {
    this.db
      .prepare(
        "UPDATE files SET name = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(newName, id);
    this.save();
  }

  moveFile(id, newFolderId) {
    this.db
      .prepare(
        "UPDATE files SET folder_id = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(newFolderId || null, id);
    this.save();
  }

  trashFile(id) {
    this.db
      .prepare(
        "UPDATE files SET is_trashed = 1, trashed_at = datetime('now') WHERE id = ?",
      )
      .run(id);
    this.save();
  }

  deleteFilePermanently(id) {
    const file = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id);
    if (file) {
      const filePath = path.join(this.filesDir, file.storage_name);
      try {
        fs.unlinkSync(filePath);
      } catch (_) {
        // file may already be gone
      }
      this.db.prepare('DELETE FROM files WHERE id = ?').run(id);
      this.save();
    }
  }

  // ---------------------------------------------------------------------------
  // Folder operations
  // ---------------------------------------------------------------------------

  createFolder(name, parentId) {
    const id = generateId();
    this.db
      .prepare('INSERT INTO folders (id, name, parent_id) VALUES (?, ?, ?)')
      .run(id, name, parentId || null);
    this.save();
    return this.db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
  }

  listFolders(parentId) {
    if (parentId == null) {
      return this.db
        .prepare(
          'SELECT * FROM folders WHERE parent_id IS NULL AND is_trashed = 0 ORDER BY name',
        )
        .all();
    }
    return this.db
      .prepare(
        'SELECT * FROM folders WHERE parent_id = ? AND is_trashed = 0 ORDER BY name',
      )
      .all(parentId);
  }

  renameFolder(id, name) {
    this.db
      .prepare('UPDATE folders SET name = ? WHERE id = ?')
      .run(name, id);
    this.save();
  }

  moveFolder(id, newParentId) {
    this.db
      .prepare('UPDATE folders SET parent_id = ? WHERE id = ?')
      .run(newParentId || null, id);
    this.save();
  }

  trashFolder(id) {
    this.db
      .prepare(
        "UPDATE folders SET is_trashed = 1, trashed_at = datetime('now') WHERE id = ?",
      )
      .run(id);
    this.save();
  }

  /**
   * Return the full folder path from root down to the given folder.
   *
   * @param {string} id
   * @returns {Array<{id: string, name: string}>}
   */
  getFolderPath(id) {
    const segments = [];
    let currentId = id;

    while (currentId) {
      const folder = this.db
        .prepare('SELECT id, name, parent_id FROM folders WHERE id = ?')
        .get(currentId);
      if (!folder) break;
      segments.unshift({ id: folder.id, name: folder.name });
      currentId = folder.parent_id;
    }

    return segments;
  }

  // ---------------------------------------------------------------------------
  // Bookmarks
  // ---------------------------------------------------------------------------

  addBookmark(fileId, page, label) {
    const id = generateId();
    this.db
      .prepare(
        'INSERT INTO bookmarks (id, file_id, page, label) VALUES (?, ?, ?, ?)',
      )
      .run(id, fileId, page, label || null);
    this.save();
    return this.db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id);
  }

  /**
   * Get bookmarks, optionally filtered by file ID. Includes the file name via
   * a join on the files table.
   */
  getBookmarks(fileId) {
    if (fileId) {
      return this.db
        .prepare(
          `SELECT b.*, f.name AS file_name
             FROM bookmarks b
             LEFT JOIN files f ON f.id = b.file_id
            WHERE b.file_id = ?
            ORDER BY b.page`,
        )
        .all(fileId);
    }
    return this.db
      .prepare(
        `SELECT b.*, f.name AS file_name
           FROM bookmarks b
           LEFT JOIN files f ON f.id = b.file_id
          ORDER BY b.created_at DESC`,
      )
      .all();
  }

  deleteBookmark(id) {
    this.db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
    this.save();
  }

  // ---------------------------------------------------------------------------
  // Reading progress
  // ---------------------------------------------------------------------------

  getProgress(fileId) {
    return (
      this.db
        .prepare('SELECT * FROM reading_progress WHERE file_id = ?')
        .get(fileId) || null
    );
  }

  setProgress(fileId, lastPage, scrollPosition) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO reading_progress (file_id, last_page, scroll_position, updated_at)
         VALUES (?, ?, ?, datetime('now'))`,
      )
      .run(fileId, lastPage, scrollPosition);
    this.save();
  }

  // ---------------------------------------------------------------------------
  // Annotations
  // ---------------------------------------------------------------------------

  getAnnotations(fileId) {
    return this.db
      .prepare('SELECT * FROM annotations WHERE file_id = ? ORDER BY page')
      .all(fileId);
  }

  addAnnotation(fileId, page, type, data) {
    const id = generateId();
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
    this.db
      .prepare(
        'INSERT INTO annotations (id, file_id, page, type, data) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, fileId, page, type, dataStr);
    this.save();
    return this.db.prepare('SELECT * FROM annotations WHERE id = ?').get(id);
  }

  deleteAnnotation(id) {
    this.db.prepare('DELETE FROM annotations WHERE id = ?').run(id);
    this.save();
  }

  // ---------------------------------------------------------------------------
  // Notes
  // ---------------------------------------------------------------------------

  createNote(title, content, folderId) {
    const id = generateId();
    this.db
      .prepare(
        'INSERT INTO notes (id, title, content, folder_id) VALUES (?, ?, ?, ?)',
      )
      .run(id, title, content || null, folderId || null);
    this.save();
    return this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
  }

  listNotes(folderId) {
    if (folderId == null) {
      return this.db
        .prepare(
          'SELECT * FROM notes WHERE folder_id IS NULL AND is_trashed = 0 ORDER BY updated_at DESC',
        )
        .all();
    }
    return this.db
      .prepare(
        'SELECT * FROM notes WHERE folder_id = ? AND is_trashed = 0 ORDER BY updated_at DESC',
      )
      .all(folderId);
  }

  getNote(id) {
    return this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
  }

  updateNote(id, title, content) {
    this.db
      .prepare(
        "UPDATE notes SET title = ?, content = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(title, content, id);
    this.save();
  }

  trashNote(id) {
    this.db
      .prepare(
        "UPDATE notes SET is_trashed = 1, trashed_at = datetime('now') WHERE id = ?",
      )
      .run(id);
    this.save();
  }

  // ---------------------------------------------------------------------------
  // Trash
  // ---------------------------------------------------------------------------

  /**
   * List all trashed files, folders, and notes.
   */
  listTrash() {
    const files = this.db
      .prepare('SELECT *, \'file\' AS item_type FROM files WHERE is_trashed = 1')
      .all();
    const folders = this.db
      .prepare(
        'SELECT *, \'folder\' AS item_type FROM folders WHERE is_trashed = 1',
      )
      .all();
    const notes = this.db
      .prepare('SELECT *, \'note\' AS item_type FROM notes WHERE is_trashed = 1')
      .all();

    return [...files, ...folders, ...notes];
  }

  /**
   * Restore a trashed item by ID and type.
   *
   * @param {string} id
   * @param {'file'|'folder'|'note'} itemType
   */
  restoreItem(id, itemType) {
    const table = this._tableForType(itemType);
    this.db
      .prepare(
        `UPDATE ${table} SET is_trashed = 0, trashed_at = NULL WHERE id = ?`,
      )
      .run(id);
    this.save();
  }

  /**
   * Permanently delete all trashed items.
   */
  emptyTrash() {
    // Delete trashed files from disk first
    const trashedFiles = this.db
      .prepare('SELECT * FROM files WHERE is_trashed = 1')
      .all();
    for (const file of trashedFiles) {
      try {
        fs.unlinkSync(path.join(this.filesDir, file.storage_name));
      } catch (_) {
        // already removed
      }
    }

    this.db.prepare('DELETE FROM files WHERE is_trashed = 1').run();
    this.db.prepare('DELETE FROM folders WHERE is_trashed = 1').run();
    this.db.prepare('DELETE FROM notes WHERE is_trashed = 1').run();
    this.save();
  }

  /**
   * Permanently delete a single item by ID and type.
   *
   * @param {string} id
   * @param {'file'|'folder'|'note'} itemType
   */
  deletePermanently(id, itemType) {
    if (itemType === 'file') {
      const file = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id);
      if (file) {
        try {
          fs.unlinkSync(path.join(this.filesDir, file.storage_name));
        } catch (_) {
          // already removed
        }
      }
    }

    const table = this._tableForType(itemType);
    this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    this.save();
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  /**
   * Search files by name and notes by title/content. Returns combined results.
   *
   * @param {string} query
   * @returns {Array<object>}
   */
  search(query) {
    const pattern = `%${query}%`;

    const files = this.db
      .prepare(
        `SELECT *, 'file' AS item_type FROM files
          WHERE is_trashed = 0 AND name LIKE ?
          ORDER BY name`,
      )
      .all(pattern);

    const notes = this.db
      .prepare(
        `SELECT *, 'note' AS item_type FROM notes
          WHERE is_trashed = 0 AND (title LIKE ? OR content LIKE ?)
          ORDER BY updated_at DESC`,
      )
      .all(pattern, pattern);

    return [...files, ...notes];
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Map an item type string to its database table name.
   * @private
   */
  _tableForType(itemType) {
    const map = { file: 'files', folder: 'folders', note: 'notes' };
    const table = map[itemType];
    if (!table) {
      throw new Error(`Unknown item type: ${itemType}`);
    }
    return table;
  }
}

module.exports = Vault;
