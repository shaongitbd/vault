/* ============================================================
   Encrypted Document Vault — Main Application
   Pure vanilla JS SPA
   ============================================================ */

(function () {
  'use strict';

  // ===== API Client =====
  const api = {
    async request(method, url, body, isFormData = false) {
      const opts = {
        method,
        credentials: 'same-origin',
      };
      if (body) {
        if (isFormData) {
          opts.body = body;
        } else {
          opts.headers = { 'Content-Type': 'application/json' };
          opts.body = JSON.stringify(body);
        }
      }
      const res = await fetch(url, opts);
      if (res.status === 401) {
        showLoginScreen();
        throw new Error('Session expired');
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || errData.message || `Request failed (${res.status})`);
      }
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        return res.json();
      }
      return res;
    },
    get(url) { return this.request('GET', url); },
    post(url, body) { return this.request('POST', url, body); },
    put(url, body) { return this.request('PUT', url, body); },
    del(url, body) { return this.request('DELETE', url, body); },
    upload(url, formData) { return this.request('POST', url, formData, true); },
  };

  // ===== State =====
  const state = {
    currentView: 'files',
    currentFolder: null,
    viewMode: 'grid',
    files: [],
    folders: [],
    notes: [],
    breadcrumb: [{ id: null, name: 'Vault' }],
    selectedItems: new Set(),
    currentFile: null,
    sidebarOpen: true,
    autoLockTimer: null,
    escPressCount: 0,
    escPressTimer: null,
    searchTimeout: null,
    folderTreeCache: {},
    dragCounter: 0,
  };

  // ===== Utility Functions =====

  function formatFileSize(bytes) {
    if (bytes == null || isNaN(bytes)) return '';
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const val = bytes / Math.pow(1024, i);
    return (i === 0 ? val : val.toFixed(1)) + ' ' + units[i];
  }

  function formatDate(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    const now = new Date();
    const diff = now - d;
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + 'm ago';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h ago';
    const days = Math.floor(hr / 24);
    if (days < 7) return days + 'd ago';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
  }

  function getFileIcon(mimeType) {
    if (!mimeType) return { icon: 'fa-file', color: '#6b7280' };
    if (mimeType === 'application/pdf') return { icon: 'fa-file-pdf', color: '#ef4444' };
    if (mimeType.startsWith('image/')) return { icon: 'fa-file-image', color: '#22c55e' };
    if (mimeType.includes('word') || mimeType.includes('document') || mimeType === 'application/msword') return { icon: 'fa-file-word', color: '#3b82f6' };
    if (mimeType.includes('excel') || mimeType.includes('spreadsheet') || mimeType === 'application/vnd.ms-excel') return { icon: 'fa-file-excel', color: '#22c55e' };
    if (mimeType.includes('powerpoint') || mimeType.includes('presentation')) return { icon: 'fa-file-powerpoint', color: '#f97316' };
    if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') return { icon: 'fa-file-lines', color: '#6b7280' };
    if (mimeType.startsWith('audio/')) return { icon: 'fa-file-audio', color: '#8b5cf6' };
    if (mimeType.startsWith('video/')) return { icon: 'fa-file-video', color: '#ec4899' };
    if (mimeType.includes('zip') || mimeType.includes('archive') || mimeType.includes('compressed')) return { icon: 'fa-file-zipper', color: '#eab308' };
    return { icon: 'fa-file', color: '#6b7280' };
  }

  function debounce(fn, ms) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function escapeHtml(str) {
    if (!str) return '';
    const el = document.createElement('div');
    el.textContent = str;
    return el.innerHTML;
  }

  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '...' : str;
  }

  function $(id) { return document.getElementById(id); }

  // ===== Toast System =====

  function showToast(message, type = 'info', duration = 3000) {
    const container = $('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    const iconMap = { success: 'fa-check-circle', error: 'fa-exclamation-circle', info: 'fa-info-circle', warning: 'fa-exclamation-triangle' };
    toast.innerHTML = '<i class="fas ' + (iconMap[type] || iconMap.info) + '"></i><span>' + escapeHtml(message) + '</span>';
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      toast.addEventListener('transitionend', () => toast.remove(), { once: true });
      setTimeout(() => toast.remove(), 500);
    }, duration);
  }

  // ===== Modal System =====

  function showModal(title, bodyHtml, buttons) {
    return new Promise((resolve) => {
      const overlay = $('modal-overlay');
      const modal = $('modal');
      const mTitle = $('modal-title');
      const mBody = $('modal-body');
      const mFooter = $('modal-footer');

      mTitle.textContent = title;
      mBody.innerHTML = bodyHtml;
      mFooter.innerHTML = '';

      buttons.forEach((btn) => {
        const b = document.createElement('button');
        b.className = btn.className || 'btn';
        b.textContent = btn.label;
        b.addEventListener('click', () => {
          let val = btn.value;
          if (val === '__input__') {
            const inp = mBody.querySelector('input');
            val = inp ? inp.value.trim() : '';
          }
          hideModal();
          resolve(val);
        });
        mFooter.appendChild(b);
      });

      overlay.classList.remove('hidden');
      overlay.classList.add('active');

      const firstInput = mBody.querySelector('input, textarea');
      if (firstInput) {
        setTimeout(() => { firstInput.focus(); firstInput.select(); }, 50);
      }

      const handleOverlayClick = (e) => {
        if (e.target === overlay) {
          hideModal();
          resolve(null);
          overlay.removeEventListener('click', handleOverlayClick);
        }
      };
      overlay.addEventListener('click', handleOverlayClick);

      const handleKey = (e) => {
        if (e.key === 'Escape') {
          hideModal();
          resolve(null);
          document.removeEventListener('keydown', handleKey);
        } else if (e.key === 'Enter') {
          const primaryBtn = mFooter.querySelector('.btn-primary');
          if (primaryBtn) primaryBtn.click();
          document.removeEventListener('keydown', handleKey);
        }
      };
      document.addEventListener('keydown', handleKey);
    });
  }

  function hideModal() {
    const overlay = $('modal-overlay');
    overlay.classList.remove('active');
    overlay.classList.add('hidden');
  }

  function showConfirm(message) {
    return showModal('Confirm', '<p>' + escapeHtml(message) + '</p>', [
      { label: 'Cancel', value: false, className: 'btn btn-secondary' },
      { label: 'Confirm', value: true, className: 'btn btn-primary btn-danger' },
    ]);
  }

  function showPrompt(title, defaultValue = '') {
    return showModal(title, '<input type="text" class="modal-input" value="' + escapeHtml(defaultValue) + '" />', [
      { label: 'Cancel', value: null, className: 'btn btn-secondary' },
      { label: 'OK', value: '__input__', className: 'btn btn-primary' },
    ]);
  }

  // ===== Screen Management =====

  function showLoginScreen() {
    clearAutoLockTimer();
    $('login-screen').classList.remove('hidden');
    $('login-screen').classList.add('active');
    $('app-screen').classList.add('hidden');
    $('app-screen').classList.remove('active');
    $('panic-screen').classList.add('hidden');
    $('panic-screen').classList.remove('active');
    $('password-input').value = '';
    $('login-error').textContent = '';
    setTimeout(() => $('password-input').focus(), 100);
  }

  function showAppScreen() {
    $('login-screen').classList.add('hidden');
    $('login-screen').classList.remove('active');
    $('app-screen').classList.remove('hidden');
    $('app-screen').classList.add('active');
    $('panic-screen').classList.add('hidden');
    $('panic-screen').classList.remove('active');
    resetAutoLockTimer();
  }

  function showPanicScreen() {
    $('login-screen').classList.add('hidden');
    $('login-screen').classList.remove('active');
    $('app-screen').classList.add('hidden');
    $('app-screen').classList.remove('active');
    $('panic-screen').classList.remove('hidden');
    $('panic-screen').classList.add('active');
    clearAutoLockTimer();
    api.post('/api/auth/logout').catch(() => {});
    initCalculator();
  }

  // ===== Auto-Lock =====

  const AUTO_LOCK_MS = 15 * 60 * 1000;

  function resetAutoLockTimer() {
    clearTimeout(state.autoLockTimer);
    state.autoLockTimer = setTimeout(() => {
      lock();
    }, AUTO_LOCK_MS);
  }

  function clearAutoLockTimer() {
    clearTimeout(state.autoLockTimer);
    state.autoLockTimer = null;
  }

  async function lock() {
    clearAutoLockTimer();
    try { await api.post('/api/auth/logout'); } catch (e) { /* ignore */ }
    closeViewer();
    showLoginScreen();
  }

  // ===== Login =====

  function initLogin() {
    const form = $('login-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pw = $('password-input').value;
      const errEl = $('login-error');
      errEl.textContent = '';
      try {
        // Fetch CSRF token first
        const csrf = await api.get('/api/auth/csrf');
        const data = await api.post('/api/auth/login', {
          password: pw,
          _csrf: csrf.token,
        });
        if (data.success) {
          showAppScreen();
          loadCurrentFolder();
          loadFolderTree();
          if (data.isNew) {
            showToast('New vault created', 'success');
          }
        } else {
          throw new Error('Invalid password');
        }
      } catch (err) {
        errEl.textContent = err.message || 'Login failed';
        const input = $('password-input');
        input.classList.add('shake');
        setTimeout(() => input.classList.remove('shake'), 500);
      }
      $('password-input').value = '';
    });
  }

  // ===== Navigation & View Switching =====

  function switchView(viewName) {
    state.currentView = viewName;
    document.querySelectorAll('.nav-item, [data-view]').forEach((el) => {
      el.classList.toggle('active', el.dataset.view === viewName);
    });
    document.querySelectorAll('.view').forEach((el) => {
      el.classList.toggle('active', el.id === viewName + '-view');
      el.classList.toggle('hidden', el.id !== viewName + '-view');
    });
    closeViewer();
    state.selectedItems.clear();

    switch (viewName) {
      case 'files': loadCurrentFolder(); break;
      case 'notes': loadNotes(); break;
      case 'bookmarks': loadBookmarks(); break;
      case 'trash': loadTrash(); break;
      case 'browser': /* browser view is always ready */ break;
    }
  }

  function initNavigation() {
    document.querySelectorAll('[data-view]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        switchView(el.dataset.view);
      });
    });

    $('sidebar-toggle')?.addEventListener('click', () => {
      state.sidebarOpen = !state.sidebarOpen;
      $('sidebar').classList.toggle('hidden', !state.sidebarOpen);
      $('sidebar').classList.toggle('open', state.sidebarOpen);
    });
  }

  // ===== Breadcrumb =====

  async function updateBreadcrumb() {
    const container = $('breadcrumb');
    if (!container) return;

    if (state.currentFolder) {
      try {
        const data = await api.get('/api/folders/' + state.currentFolder + '/path');
        state.breadcrumb = [{ id: null, name: 'Vault' }, ...data.path];
      } catch (e) {
        state.breadcrumb = [{ id: null, name: 'Vault' }];
      }
    } else {
      state.breadcrumb = [{ id: null, name: 'Vault' }];
    }

    container.innerHTML = '';
    state.breadcrumb.forEach((item, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'breadcrumb-sep';
        sep.innerHTML = '<i class="fas fa-chevron-right"></i>';
        container.appendChild(sep);
      }
      const link = document.createElement('a');
      link.className = 'breadcrumb-item';
      link.href = '#';
      link.textContent = item.name;
      if (i === state.breadcrumb.length - 1) {
        link.classList.add('current');
      }
      link.addEventListener('click', (e) => {
        e.preventDefault();
        navigateToFolder(item.id);
      });
      container.appendChild(link);
    });
  }

  // ===== Folder Navigation =====

  function navigateToFolder(folderId) {
    state.currentFolder = folderId;
    state.selectedItems.clear();
    closeViewer();
    loadCurrentFolder();
  }

  // ===== File Manager =====

  async function loadCurrentFolder() {
    const fileList = $('file-list');
    const emptyState = $('empty-state');
    if (!fileList) return;

    fileList.innerHTML = '<div class="loading-spinner"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';
    if (emptyState) emptyState.classList.add('hidden');

    try {
      const folderParam = state.currentFolder ? '?parent=' + state.currentFolder : '';
      const fileParam = state.currentFolder ? '?folder=' + state.currentFolder : '';
      const [foldersData, filesData] = await Promise.all([
        api.get('/api/folders' + folderParam),
        api.get('/api/files' + fileParam),
      ]);

      state.folders = foldersData.folders || [];
      state.files = filesData.files || [];

      updateBreadcrumb();
      renderFileList();
    } catch (err) {
      fileList.innerHTML = '';
      showToast('Failed to load folder: ' + err.message, 'error');
    }
  }

  function renderFileList() {
    const fileList = $('file-list');
    const emptyState = $('empty-state');
    if (!fileList) return;

    fileList.innerHTML = '';
    fileList.className = 'file-list ' + (state.viewMode === 'grid' ? 'grid-view' : 'list-view');

    if (state.folders.length === 0 && state.files.length === 0) {
      if (emptyState) emptyState.classList.remove('hidden');
      return;
    }

    if (emptyState) emptyState.classList.add('hidden');

    state.folders.forEach((folder) => {
      const el = createFolderElement(folder);
      fileList.appendChild(el);
    });

    state.files.forEach((file) => {
      const el = createFileElement(file);
      fileList.appendChild(el);
    });
  }

  function createFolderElement(folder) {
    const el = document.createElement('div');
    el.className = 'file-item folder-item';
    el.dataset.id = folder.id;
    el.dataset.type = 'folder';

    if (state.viewMode === 'grid') {
      el.innerHTML =
        '<div class="file-icon folder-icon"><i class="fas fa-folder" style="color:#f59e0b"></i></div>' +
        '<div class="file-name" title="' + escapeHtml(folder.name) + '">' + escapeHtml(truncate(folder.name, 30)) + '</div>' +
        '<div class="file-meta">' + formatDate(folder.created_at) + '</div>';
    } else {
      el.innerHTML =
        '<div class="file-icon-sm"><i class="fas fa-folder" style="color:#f59e0b"></i></div>' +
        '<div class="file-name">' + escapeHtml(folder.name) + '</div>' +
        '<div class="file-type">Folder</div>' +
        '<div class="file-size">-</div>' +
        '<div class="file-date">' + formatDate(folder.created_at) + '</div>';
    }

    el.addEventListener('click', (e) => handleItemClick(e, folder.id, 'folder'));
    el.addEventListener('dblclick', () => navigateToFolder(folder.id));
    el.addEventListener('contextmenu', (e) => showContextMenu(e, folder, 'folder'));

    return el;
  }

  function createFileElement(file) {
    const el = document.createElement('div');
    el.className = 'file-item';
    el.dataset.id = file.id;
    el.dataset.type = 'file';

    const icon = getFileIcon(file.mime_type);
    const progressBadge = file.lastPage ? '<span class="progress-badge">p.' + file.lastPage + '</span>' : '';

    if (state.viewMode === 'grid') {
      el.innerHTML =
        '<div class="file-icon"><i class="fas ' + icon.icon + '" style="color:' + icon.color + '"></i></div>' +
        '<div class="file-name" title="' + escapeHtml(file.name) + '">' + escapeHtml(truncate(file.name, 30)) + '</div>' +
        '<div class="file-meta">' + formatFileSize(file.size) + progressBadge + '</div>';
    } else {
      el.innerHTML =
        '<div class="file-icon-sm"><i class="fas ' + icon.icon + '" style="color:' + icon.color + '"></i></div>' +
        '<div class="file-name">' + escapeHtml(file.name) + '</div>' +
        '<div class="file-type">' + escapeHtml(file.mime_type || 'File') + '</div>' +
        '<div class="file-size">' + formatFileSize(file.size) + '</div>' +
        '<div class="file-date">' + formatDate(file.updated_at || file.created_at) + '</div>' +
        (progressBadge ? '<div class="file-progress">' + progressBadge + '</div>' : '');
    }

    el.addEventListener('click', (e) => handleItemClick(e, file.id, 'file'));
    el.addEventListener('dblclick', () => openFile(file));
    el.addEventListener('contextmenu', (e) => showContextMenu(e, file, 'file'));

    return el;
  }

  function handleItemClick(e, id, type) {
    const key = type + ':' + id;
    if (e.ctrlKey || e.metaKey) {
      if (state.selectedItems.has(key)) {
        state.selectedItems.delete(key);
      } else {
        state.selectedItems.add(key);
      }
    } else {
      state.selectedItems.clear();
      state.selectedItems.add(key);

      // Single click on file opens it, on folder navigates into it
      if (!e.detail || e.detail === 1) {
        // Will be handled by dblclick if double-clicked
      }
    }
    updateSelectionUI();
  }

  function updateSelectionUI() {
    document.querySelectorAll('.file-item').forEach((el) => {
      const key = el.dataset.type + ':' + el.dataset.id;
      el.classList.toggle('selected', state.selectedItems.has(key));
    });
  }

  // ===== View Mode Toggle =====

  function initViewModeToggle() {
    $('view-grid')?.addEventListener('click', () => {
      state.viewMode = 'grid';
      $('view-grid').classList.add('active');
      $('view-list')?.classList.remove('active');
      renderFileList();
    });
    $('view-list')?.addEventListener('click', () => {
      state.viewMode = 'list';
      $('view-list').classList.add('active');
      $('view-grid')?.classList.remove('active');
      renderFileList();
    });
  }

  // ===== Context Menu =====

  function showContextMenu(e, item, type) {
    e.preventDefault();
    e.stopPropagation();

    const menu = $('context-menu');
    if (!menu) return;

    menu.innerHTML = '';
    menu.classList.remove('hidden');

    const actions = [];
    if (type === 'file') {
      actions.push({ label: 'Open', icon: 'fa-eye', action: () => openFile(item) });
      actions.push({ label: 'Rename', icon: 'fa-pen', action: () => renameFile(item) });
      actions.push({ label: 'Move to...', icon: 'fa-folder-open', action: () => moveFile(item) });
      actions.push({ label: 'Download', icon: 'fa-download', action: () => downloadFile(item) });
      actions.push({ divider: true });
      actions.push({ label: 'Delete', icon: 'fa-trash', action: () => deleteFile(item), danger: true });
    } else if (type === 'folder') {
      actions.push({ label: 'Open', icon: 'fa-folder-open', action: () => navigateToFolder(item.id) });
      actions.push({ label: 'Rename', icon: 'fa-pen', action: () => renameFolder(item) });
      actions.push({ divider: true });
      actions.push({ label: 'Delete', icon: 'fa-trash', action: () => deleteFolder(item), danger: true });
    }

    actions.forEach((a) => {
      if (a.divider) {
        const d = document.createElement('div');
        d.className = 'context-menu-divider';
        menu.appendChild(d);
        return;
      }
      const mi = document.createElement('div');
      mi.className = 'context-menu-item' + (a.danger ? ' danger' : '');
      mi.innerHTML = '<i class="fas ' + a.icon + '"></i><span>' + a.label + '</span>';
      mi.addEventListener('click', () => {
        hideContextMenu();
        a.action();
      });
      menu.appendChild(mi);
    });

    // Position
    const x = e.clientX;
    const y = e.clientY;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    // Adjust if off-screen
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        menu.style.left = (x - rect.width) + 'px';
      }
      if (rect.bottom > window.innerHeight) {
        menu.style.top = (y - rect.height) + 'px';
      }
    });
  }

  function hideContextMenu() {
    const menu = $('context-menu');
    if (menu) menu.classList.add('hidden');
  }

  // ===== File Operations =====

  async function openFile(file) {
    state.currentFile = file;
    const panel = $('viewer-panel');
    const title = $('viewer-title');
    const body = $('viewer-body');
    if (!panel || !body) return;

    panel.classList.remove('hidden');
    panel.classList.add('active');
    if (title) title.textContent = file.name;
    body.innerHTML = '<div class="loading-spinner"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';

    const mime = file.mime_type || '';

    try {
      if (mime === 'application/pdf') {
        body.innerHTML = '';
        if (window.PDFViewerApp) {
          window.PDFViewerApp.open(file.id, file.name);
        } else {
          body.innerHTML = '<iframe src="/api/files/' + file.id + '/view" class="viewer-iframe" style="width:100%;height:100%;border:none;"></iframe>';
        }
      } else if (mime.startsWith('image/')) {
        body.innerHTML = '<div class="image-viewer"><img src="/api/files/' + file.id + '/view" alt="' + escapeHtml(file.name) + '" class="viewer-image" /></div>';
      } else if (mime.includes('word') || mime.includes('document') || mime.includes('excel') || mime.includes('spreadsheet') || mime.includes('presentation') || mime.includes('powerpoint')) {
        const data = await api.get('/api/convert/' + file.id);
        body.innerHTML = '<div class="converted-content">' + data.html + '</div>';
      } else if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' || mime === 'application/javascript') {
        const res = await fetch('/api/files/' + file.id + '/view', { credentials: 'same-origin' });
        const text = await res.text();
        body.innerHTML = '<pre class="text-viewer"><code>' + escapeHtml(text) + '</code></pre>';
      } else {
        body.innerHTML =
          '<div class="unsupported-file">' +
          '<i class="fas fa-file fa-3x"></i>' +
          '<p>This file type cannot be previewed.</p>' +
          '<button class="btn btn-primary" onclick="window.__downloadCurrent()">Download File</button>' +
          '</div>';
      }
    } catch (err) {
      body.innerHTML = '<div class="viewer-error"><i class="fas fa-exclamation-triangle"></i><p>Error loading file: ' + escapeHtml(err.message) + '</p></div>';
    }
  }

  window.__downloadCurrent = function () {
    if (state.currentFile) downloadFile(state.currentFile);
  };

  function closeViewer() {
    const panel = $('viewer-panel');
    const body = $('viewer-body');
    if (state.currentFile && state.currentFile.__isNote) {
      RichEditor.destroy();
    }
    if (panel) {
      panel.classList.add('hidden');
      panel.classList.remove('active');
    }
    if (body) body.innerHTML = '';
    state.currentFile = null;
    if (window.PDFViewerApp && window.PDFViewerApp.close) {
      window.PDFViewerApp.close();
    }
  }

  function downloadFile(file) {
    const a = document.createElement('a');
    a.href = '/api/files/' + file.id + '/view';
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  async function renameFile(file) {
    const newName = await showPrompt('Rename File', file.name);
    if (!newName || newName === file.name) return;
    try {
      await api.put('/api/files/' + file.id + '/rename', { name: newName });
      showToast('File renamed', 'success');
      loadCurrentFolder();
    } catch (err) {
      showToast('Rename failed: ' + err.message, 'error');
    }
  }

  async function moveFile(file) {
    // Build folder selection modal
    let foldersHtml = '<div class="move-folder-list">';
    foldersHtml += '<div class="move-folder-item" data-folder-id="__root__"><i class="fas fa-home"></i> Vault (root)</div>';
    try {
      const data = await api.get('/api/folders');
      (data.folders || []).forEach((f) => {
        if (f.id !== state.currentFolder) {
          foldersHtml += '<div class="move-folder-item" data-folder-id="' + f.id + '"><i class="fas fa-folder"></i> ' + escapeHtml(f.name) + '</div>';
        }
      });
    } catch (e) { /* ignore */ }
    foldersHtml += '</div>';

    const result = await showModal('Move "' + file.name + '" to...', foldersHtml, [
      { label: 'Cancel', value: null, className: 'btn btn-secondary' },
    ]);

    // We need to handle click on folder items inside the modal
    // Since modal is already closed, let's redo this with a custom approach
    return new Promise((resolve) => {
      const overlay = $('modal-overlay');
      const mTitle = $('modal-title');
      const mBody = $('modal-body');
      const mFooter = $('modal-footer');

      mTitle.textContent = 'Move "' + file.name + '" to...';
      mBody.innerHTML = foldersHtml;
      mFooter.innerHTML = '<button class="btn btn-secondary" id="move-cancel">Cancel</button>';

      overlay.classList.remove('hidden');
      overlay.classList.add('active');

      $('move-cancel').addEventListener('click', () => {
        hideModal();
        resolve();
      });

      mBody.querySelectorAll('.move-folder-item').forEach((item) => {
        item.addEventListener('click', async () => {
          const folderId = item.dataset.folderId;
          const targetId = folderId === '__root__' ? null : folderId;
          hideModal();
          try {
            await api.put('/api/files/' + file.id + '/move', { folderId: targetId });
            showToast('File moved', 'success');
            loadCurrentFolder();
          } catch (err) {
            showToast('Move failed: ' + err.message, 'error');
          }
          resolve();
        });
      });
    });
  }

  async function deleteFile(file) {
    const confirmed = await showConfirm('Delete "' + file.name + '"? It will be moved to trash.');
    if (!confirmed) return;
    try {
      await api.del('/api/files/' + file.id);
      showToast('File deleted', 'success');
      loadCurrentFolder();
    } catch (err) {
      showToast('Delete failed: ' + err.message, 'error');
    }
  }

  // ===== Folder Operations =====

  async function createNewFolder() {
    const name = await showPrompt('New Folder Name', 'New Folder');
    if (!name) return;
    try {
      await api.post('/api/folders', { name, parentId: state.currentFolder });
      showToast('Folder created', 'success');
      loadCurrentFolder();
      loadFolderTree();
    } catch (err) {
      showToast('Failed to create folder: ' + err.message, 'error');
    }
  }

  async function renameFolder(folder) {
    const newName = await showPrompt('Rename Folder', folder.name);
    if (!newName || newName === folder.name) return;
    try {
      await api.put('/api/folders/' + folder.id, { name: newName });
      showToast('Folder renamed', 'success');
      loadCurrentFolder();
      loadFolderTree();
    } catch (err) {
      showToast('Rename failed: ' + err.message, 'error');
    }
  }

  async function deleteFolder(folder) {
    const confirmed = await showConfirm('Delete folder "' + folder.name + '" and all its contents?');
    if (!confirmed) return;
    try {
      await api.del('/api/folders/' + folder.id);
      showToast('Folder deleted', 'success');
      loadCurrentFolder();
      loadFolderTree();
    } catch (err) {
      showToast('Delete failed: ' + err.message, 'error');
    }
  }

  // ===== Upload =====

  function initUpload() {
    const uploadBtn = $('upload-btn');
    const fileInput = $('file-input');

    if (uploadBtn && fileInput) {
      uploadBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => {
        if (fileInput.files.length > 0) {
          uploadFiles(fileInput.files);
          fileInput.value = '';
        }
      });
    }

    // Drag and drop
    const appScreen = $('app-screen');
    const dropZone = $('drop-zone');
    if (appScreen && dropZone) {
      appScreen.addEventListener('dragenter', (e) => {
        e.preventDefault();
        state.dragCounter++;
        dropZone.classList.remove('hidden');
        dropZone.classList.add('active');
      });
      appScreen.addEventListener('dragleave', (e) => {
        e.preventDefault();
        state.dragCounter--;
        if (state.dragCounter <= 0) {
          state.dragCounter = 0;
          dropZone.classList.add('hidden');
          dropZone.classList.remove('active');
        }
      });
      appScreen.addEventListener('dragover', (e) => {
        e.preventDefault();
      });
      appScreen.addEventListener('drop', (e) => {
        e.preventDefault();
        state.dragCounter = 0;
        dropZone.classList.add('hidden');
        dropZone.classList.remove('active');
        if (e.dataTransfer.files.length > 0) {
          uploadFiles(e.dataTransfer.files);
        }
      });
    }
  }

  async function uploadFiles(files) {
    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
      formData.append('files', files[i]);
    }
    if (state.currentFolder) {
      formData.append('folderId', state.currentFolder);
    }

    const count = files.length;
    showToast('Uploading ' + count + ' file' + (count > 1 ? 's' : '') + '...', 'info', 5000);

    try {
      await api.upload('/api/files/upload', formData);
      showToast(count + ' file' + (count > 1 ? 's' : '') + ' uploaded', 'success');
      loadCurrentFolder();
    } catch (err) {
      showToast('Upload failed: ' + err.message, 'error');
    }
  }

  // ===== Notes View =====

  async function loadNotes() {
    const list = $('notes-list');
    if (!list) return;
    list.innerHTML = '<div class="loading-spinner"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';

    try {
      const folderParam = state.currentFolder ? '?folder=' + state.currentFolder : '';
      const data = await api.get('/api/notes' + folderParam);
      state.notes = data.notes || [];
      renderNotes();
    } catch (err) {
      list.innerHTML = '';
      showToast('Failed to load notes: ' + err.message, 'error');
    }
  }

  function renderNotes() {
    const list = $('notes-list');
    if (!list) return;
    list.innerHTML = '';

    if (state.notes.length === 0) {
      list.innerHTML = '<div class="empty-message"><i class="fas fa-sticky-note fa-2x"></i><p>No notes yet. Create one!</p></div>';
      return;
    }

    state.notes.forEach((note) => {
      const el = document.createElement('div');
      el.className = 'note-card';
      el.dataset.id = note.id;
      let preview = '';
      if (note.content) {
        try {
          const parsed = JSON.parse(note.content);
          if (parsed && parsed.blocks) {
            preview = truncate(parsed.blocks.filter(b => b.content).map(b => b.content.replace(/<[^>]*>/g, '')).join(' '), 100);
          } else {
            preview = truncate(note.content.replace(/<[^>]*>/g, ''), 100);
          }
        } catch (_) {
          preview = truncate(note.content.replace(/<[^>]*>/g, ''), 100);
        }
      }
      el.innerHTML =
        '<div class="note-title">' + escapeHtml(note.title || 'Untitled') + '</div>' +
        '<div class="note-preview">' + escapeHtml(preview) + '</div>' +
        '<div class="note-date">' + formatDate(note.updated_at || note.created_at) + '</div>';
      el.addEventListener('click', () => openNoteEditor(note));
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showNoteContextMenu(e, note);
      });
      list.appendChild(el);
    });
  }

  function showNoteContextMenu(e, note) {
    const menu = $('context-menu');
    if (!menu) return;
    menu.innerHTML = '';
    menu.classList.remove('hidden');

    const actions = [
      { label: 'Open', icon: 'fa-pen-to-square', action: () => openNoteEditor(note) },
      { label: 'Delete', icon: 'fa-trash', action: () => deleteNote(note), danger: true },
    ];

    actions.forEach((a) => {
      const mi = document.createElement('div');
      mi.className = 'context-menu-item' + (a.danger ? ' danger' : '');
      mi.innerHTML = '<i class="fas ' + a.icon + '"></i><span>' + a.label + '</span>';
      mi.addEventListener('click', () => { hideContextMenu(); a.action(); });
      menu.appendChild(mi);
    });

    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
  }

  let noteSaveTimer = null;

  // ===== Rich Note Editor (Notion-like block editor) =====

  const RichEditor = (function () {
    let _editorEl = null;
    let _titleInput = null;
    let _blocksContainer = null;
    let _slashMenu = null;
    let _slashMenuBlockId = null;
    let _slashMenuFilter = '';
    let _slashMenuSelectedIdx = 0;
    let _noteId = null;
    let _autoSaveFn = null;
    let _styleInjected = false;
    let _dragState = null;

    const BLOCK_TYPES = [
      { type: 'paragraph', label: 'Text', icon: 'fa-paragraph', description: 'Plain text block' },
      { type: 'heading1', label: 'Heading 1', icon: 'fa-heading', description: 'Large heading' },
      { type: 'heading2', label: 'Heading 2', icon: 'fa-heading', description: 'Medium heading' },
      { type: 'heading3', label: 'Heading 3', icon: 'fa-heading', description: 'Small heading' },
      { type: 'bullet', label: 'Bullet List', icon: 'fa-list-ul', description: 'Unordered list item' },
      { type: 'numbered', label: 'Numbered List', icon: 'fa-list-ol', description: 'Ordered list item' },
      { type: 'todo', label: 'To-do', icon: 'fa-square-check', description: 'Checkbox item' },
      { type: 'code', label: 'Code', icon: 'fa-code', description: 'Code block' },
      { type: 'quote', label: 'Quote', icon: 'fa-quote-left', description: 'Block quote' },
      { type: 'divider', label: 'Divider', icon: 'fa-minus', description: 'Horizontal line' },
      { type: 'embed', label: 'Embed File', icon: 'fa-file-import', description: 'Embed a vault file' },
    ];

    function uid() {
      return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    }

    function injectStyles() {
      if (_styleInjected) return;
      _styleInjected = true;
      const style = document.createElement('style');
      style.id = 'rich-editor-styles';
      style.textContent = `
        .re-editor {
          display: flex; flex-direction: column; height: 100%; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        .re-title-input {
          border: none; border-bottom: 2px solid transparent; font-size: 28px; font-weight: 700;
          padding: 24px 40px 12px; background: transparent; color: var(--text-primary, #1a1a1a);
          outline: none; width: 100%; transition: border-color 0.2s;
          line-height: 1.3;
        }
        .re-title-input:focus { border-bottom-color: #0d7377; }
        .re-title-input::placeholder { color: var(--text-tertiary, #9ca3af); }
        .re-blocks {
          flex: 1; overflow-y: auto; padding: 8px 0 120px; position: relative;
        }
        .re-block-wrapper {
          position: relative; display: flex; align-items: flex-start;
          padding: 2px 40px; margin: 1px 0;
          transition: background 0.15s;
        }
        .re-block-wrapper:hover { background: rgba(13, 115, 119, 0.03); }
        .re-block-wrapper:hover .re-block-handle,
        .re-block-wrapper:hover .re-block-add-btn { opacity: 1; }
        .re-block-controls {
          display: flex; align-items: center; gap: 2px;
          position: absolute; left: 4px; top: 50%; transform: translateY(-50%);
          opacity: 0; transition: opacity 0.15s;
        }
        .re-block-wrapper:hover .re-block-controls { opacity: 1; }
        .re-block-add-btn, .re-block-handle {
          width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
          border-radius: 4px; border: none; background: transparent; cursor: pointer;
          color: var(--text-tertiary, #9ca3af); font-size: 12px; padding: 0;
          opacity: 0; transition: opacity 0.15s, background 0.15s, color 0.15s;
        }
        .re-block-add-btn:hover, .re-block-handle:hover {
          background: var(--bg-tertiary, #e5e7eb); color: var(--text-secondary, #4b5563);
        }
        .re-block-handle { cursor: grab; }
        .re-block-handle:active { cursor: grabbing; }
        .re-block-content {
          flex: 1; min-height: 1.6em; outline: none; line-height: 1.6;
          font-size: 15px; color: var(--text-primary, #1a1a1a); word-break: break-word;
          padding: 3px 2px;
        }
        .re-block-content:empty::before {
          content: attr(data-placeholder); color: var(--text-tertiary, #9ca3af);
          pointer-events: none;
        }
        .re-block-content[contenteditable="true"]:focus { outline: none; }
        /* Block type styles */
        .re-block-wrapper[data-type="heading1"] .re-block-content {
          font-size: 26px; font-weight: 700; line-height: 1.3; padding: 8px 2px 4px;
        }
        .re-block-wrapper[data-type="heading2"] .re-block-content {
          font-size: 21px; font-weight: 600; line-height: 1.35; padding: 6px 2px 3px;
        }
        .re-block-wrapper[data-type="heading3"] .re-block-content {
          font-size: 17px; font-weight: 600; line-height: 1.4; padding: 4px 2px 2px;
        }
        .re-block-wrapper[data-type="bullet"] { padding-left: 56px; }
        .re-block-wrapper[data-type="bullet"]::after {
          content: ''; position: absolute; left: 44px; top: 14px;
          width: 6px; height: 6px; border-radius: 50%; background: var(--text-tertiary, #9ca3af);
        }
        .re-block-wrapper[data-type="numbered"] { padding-left: 56px; }
        .re-block-wrapper[data-type="numbered"]::after {
          content: attr(data-number) '.'; position: absolute; left: 40px; top: 5px;
          color: var(--text-tertiary, #9ca3af); font-size: 14px; font-weight: 500;
          min-width: 14px; text-align: right;
        }
        .re-block-wrapper[data-type="todo"] { padding-left: 56px; }
        .re-todo-checkbox {
          position: absolute; left: 40px; top: 7px;
          width: 18px; height: 18px; border-radius: 4px;
          border: 2px solid var(--border, #d1d5db); background: transparent;
          cursor: pointer; display: flex; align-items: center; justify-content: center;
          transition: all 0.15s; flex-shrink: 0; padding: 0;
        }
        .re-todo-checkbox:hover { border-color: #0d7377; }
        .re-todo-checkbox.checked {
          background: #0d7377; border-color: #0d7377;
        }
        .re-todo-checkbox.checked::after {
          content: '\\f00c'; font-family: 'Font Awesome 6 Free'; font-weight: 900;
          font-size: 10px; color: white;
        }
        .re-block-wrapper[data-checked="true"] .re-block-content {
          text-decoration: line-through; color: var(--text-tertiary, #9ca3af);
        }
        .re-block-wrapper[data-type="code"] .re-block-content {
          font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; font-size: 13px;
          background: var(--bg-tertiary, #f3f4f6); border-radius: 6px;
          padding: 12px 16px; line-height: 1.5; white-space: pre-wrap;
          border: 1px solid var(--border, #e5e7eb);
        }
        .re-block-wrapper[data-type="quote"] {
          padding-left: 56px;
        }
        .re-block-wrapper[data-type="quote"]::before {
          content: ''; position: absolute; left: 42px; top: 4px; bottom: 4px;
          width: 3px; border-radius: 3px; background: #0d7377;
        }
        .re-block-wrapper[data-type="quote"] .re-block-content {
          color: var(--text-secondary, #4b5563); font-style: italic;
        }
        .re-block-wrapper[data-type="divider"] {
          padding: 8px 40px; cursor: default;
        }
        .re-divider-line {
          width: 100%; height: 1px; background: var(--border, #e5e7eb);
        }
        .re-block-wrapper[data-type="embed"] {
          padding: 4px 40px;
        }
        .re-embed-card {
          display: flex; align-items: center; gap: 12px;
          padding: 12px 16px; border-radius: 8px;
          background: var(--bg-secondary, #f9fafb); border: 1px solid var(--border, #e5e7eb);
          cursor: pointer; transition: border-color 0.15s, box-shadow 0.15s;
          width: 100%;
        }
        .re-embed-card:hover {
          border-color: #0d7377; box-shadow: 0 2px 8px rgba(13, 115, 119, 0.08);
        }
        .re-embed-icon { font-size: 20px; color: #0d7377; flex-shrink: 0; }
        .re-embed-name {
          font-size: 14px; font-weight: 500; color: var(--text-primary, #1a1a1a); flex: 1;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .re-embed-badge {
          font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;
          color: var(--text-tertiary, #9ca3af);
        }
        .re-embed-remove {
          width: 24px; height: 24px; border-radius: 4px; border: none; background: transparent;
          cursor: pointer; color: var(--text-tertiary, #9ca3af); font-size: 12px;
          display: flex; align-items: center; justify-content: center;
          opacity: 0; transition: opacity 0.15s, background 0.15s;
        }
        .re-embed-card:hover .re-embed-remove { opacity: 1; }
        .re-embed-remove:hover { background: rgba(239, 68, 68, 0.1); color: #ef4444; }
        /* Slash menu */
        .re-slash-menu {
          position: fixed; z-index: 9999;
          background: var(--bg-primary, #fff); border: 1px solid var(--border, #e5e7eb);
          border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06);
          width: 260px; max-height: 340px; overflow-y: auto;
          padding: 6px; display: none;
        }
        .re-slash-menu.visible { display: block; }
        .re-slash-menu-label {
          font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
          color: var(--text-tertiary, #9ca3af); padding: 8px 10px 4px; user-select: none;
        }
        .re-slash-item {
          display: flex; align-items: center; gap: 10px; padding: 8px 10px;
          border-radius: 6px; cursor: pointer; transition: background 0.1s;
        }
        .re-slash-item:hover, .re-slash-item.selected { background: rgba(13, 115, 119, 0.08); }
        .re-slash-item-icon {
          width: 36px; height: 36px; border-radius: 6px;
          background: var(--bg-tertiary, #f3f4f6); display: flex; align-items: center; justify-content: center;
          font-size: 14px; color: #0d7377; flex-shrink: 0;
          border: 1px solid var(--border, #e5e7eb);
        }
        .re-slash-item-text { display: flex; flex-direction: column; }
        .re-slash-item-label { font-size: 14px; font-weight: 500; color: var(--text-primary, #1a1a1a); }
        .re-slash-item-desc { font-size: 12px; color: var(--text-tertiary, #9ca3af); }
        .re-slash-empty {
          padding: 16px; text-align: center; color: var(--text-tertiary, #9ca3af); font-size: 13px;
        }
        /* Inline formatting toolbar */
        .re-format-bar {
          position: fixed; z-index: 9998;
          background: #1a1a2e; border-radius: 8px;
          box-shadow: 0 4px 16px rgba(0,0,0,0.2);
          display: none; padding: 4px;
          gap: 2px; align-items: center;
        }
        .re-format-bar.visible { display: flex; }
        .re-format-btn {
          width: 32px; height: 32px; border: none; background: transparent;
          color: #e2e2e2; border-radius: 5px; cursor: pointer; font-size: 13px;
          display: flex; align-items: center; justify-content: center;
          transition: background 0.1s, color 0.1s;
        }
        .re-format-btn:hover { background: rgba(255,255,255,0.12); color: #fff; }
        .re-format-btn.active { background: rgba(13, 115, 119, 0.6); color: #fff; }
        .re-format-sep {
          width: 1px; height: 20px; background: rgba(255,255,255,0.15); margin: 0 2px;
        }
        /* Drag styles */
        .re-block-wrapper.dragging { opacity: 0.4; }
        .re-block-wrapper.drag-over-top { box-shadow: inset 0 2px 0 0 #0d7377; }
        .re-block-wrapper.drag-over-bottom { box-shadow: inset 0 -2px 0 0 #0d7377; }
        /* Footer bar */
        .re-footer {
          display: flex; align-items: center; justify-content: space-between;
          padding: 8px 24px; border-top: 1px solid var(--border, #e5e7eb);
          background: var(--bg-secondary, #f9fafb); flex-shrink: 0; min-height: 40px;
        }
        .re-footer-left { display: flex; align-items: center; gap: 12px; }
        .re-save-status {
          font-size: 12px; color: var(--text-tertiary, #9ca3af);
          display: flex; align-items: center; gap: 6px;
        }
        .re-save-status i { font-size: 10px; }
        .re-block-count { font-size: 12px; color: var(--text-tertiary, #9ca3af); }
        .re-footer-right { display: flex; align-items: center; gap: 8px; }
        .re-footer-btn {
          padding: 4px 12px; border-radius: 5px; border: 1px solid var(--border, #e5e7eb);
          background: transparent; cursor: pointer; font-size: 12px;
          color: var(--text-secondary, #6b7280); transition: all 0.15s;
        }
        .re-footer-btn:hover {
          border-color: #0d7377; color: #0d7377; background: rgba(13,115,119,0.04);
        }
        /* Link input popover */
        .re-link-popover {
          position: fixed; z-index: 10000;
          background: var(--bg-primary, #fff); border: 1px solid var(--border, #e5e7eb);
          border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.12);
          padding: 8px; display: none; gap: 6px; align-items: center;
        }
        .re-link-popover.visible { display: flex; }
        .re-link-popover input {
          border: 1px solid var(--border, #e5e7eb); border-radius: 5px;
          padding: 6px 10px; font-size: 13px; width: 220px; outline: none;
          background: var(--bg-secondary, #f9fafb);
        }
        .re-link-popover input:focus { border-color: #0d7377; }
        .re-link-popover button {
          padding: 6px 14px; border-radius: 5px; border: none;
          background: #0d7377; color: #fff; font-size: 13px; cursor: pointer;
          font-weight: 500;
        }
        .re-link-popover button:hover { background: #0b6164; }
        /* Scrollbar */
        .re-blocks::-webkit-scrollbar { width: 6px; }
        .re-blocks::-webkit-scrollbar-track { background: transparent; }
        .re-blocks::-webkit-scrollbar-thumb { background: var(--border, #d1d5db); border-radius: 3px; }
        .re-blocks::-webkit-scrollbar-thumb:hover { background: var(--text-tertiary, #9ca3af); }
        /* File picker for embed */
        .re-file-picker-list {
          max-height: 300px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px;
        }
        .re-file-picker-item {
          display: flex; align-items: center; gap: 10px; padding: 8px 12px;
          border-radius: 6px; cursor: pointer; transition: background 0.1s;
        }
        .re-file-picker-item:hover { background: rgba(13,115,119,0.06); }
        .re-file-picker-item i { font-size: 16px; width: 20px; text-align: center; }
        .re-file-picker-item span { font-size: 14px; color: var(--text-primary, #1a1a1a); }
        .re-file-picker-search {
          width: 100%; padding: 8px 12px; border: 1px solid var(--border, #e5e7eb);
          border-radius: 6px; font-size: 14px; margin-bottom: 8px; outline: none;
          background: var(--bg-secondary, #f9fafb);
        }
        .re-file-picker-search:focus { border-color: #0d7377; }
      `;
      document.head.appendChild(style);
    }

    function parseContent(raw) {
      if (!raw) return { blocks: [{ id: uid(), type: 'paragraph', content: '' }] };
      try {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.blocks) && parsed.blocks.length > 0) {
          // Ensure all blocks have ids
          parsed.blocks.forEach(b => { if (!b.id) b.id = uid(); });
          return parsed;
        }
      } catch (_) { /* not JSON */ }
      // Backward compat: plain string becomes a paragraph
      return { blocks: [{ id: uid(), type: 'paragraph', content: raw }] };
    }

    function serializeBlocks() {
      const wrappers = _blocksContainer.querySelectorAll('.re-block-wrapper');
      const blocks = [];
      wrappers.forEach(w => {
        const type = w.dataset.type;
        const id = w.dataset.blockId;
        if (type === 'divider') {
          blocks.push({ id: id, type: 'divider' });
        } else if (type === 'embed') {
          blocks.push({
            id: id, type: 'embed',
            fileId: w.dataset.fileId || '', fileName: w.dataset.fileName || '',
          });
        } else {
          const ce = w.querySelector('.re-block-content');
          const block = { id: id, type: type, content: ce ? ce.innerHTML : '' };
          if (type === 'todo') block.checked = w.dataset.checked === 'true';
          blocks.push(block);
        }
      });
      return JSON.stringify({ blocks: blocks });
    }

    function getPlaceholder(type) {
      const map = {
        paragraph: 'Type \'/\' for commands...',
        heading1: 'Heading 1',
        heading2: 'Heading 2',
        heading3: 'Heading 3',
        bullet: 'List item',
        numbered: 'List item',
        todo: 'To-do',
        code: 'Code',
        quote: 'Quote',
      };
      return map[type] || '';
    }

    function renumberBlocks() {
      let count = 0;
      _blocksContainer.querySelectorAll('.re-block-wrapper').forEach(w => {
        if (w.dataset.type === 'numbered') {
          count++;
          w.dataset.number = count;
        } else {
          count = 0;
        }
      });
    }

    function createBlockEl(block) {
      const wrapper = document.createElement('div');
      wrapper.className = 're-block-wrapper';
      wrapper.dataset.type = block.type;
      wrapper.dataset.blockId = block.id;
      wrapper.draggable = false; // handle via drag handle

      if (block.type === 'divider') {
        wrapper.innerHTML =
          '<div class="re-block-controls">' +
            '<button class="re-block-add-btn" title="Add block below"><i class="fas fa-plus"></i></button>' +
            '<button class="re-block-handle" title="Drag to reorder"><i class="fas fa-grip-vertical"></i></button>' +
          '</div>' +
          '<div class="re-divider-line"></div>';
        setupBlockControls(wrapper, block);
        return wrapper;
      }

      if (block.type === 'embed') {
        wrapper.dataset.fileId = block.fileId || '';
        wrapper.dataset.fileName = block.fileName || '';
        const iconInfo = getFileIcon('');
        wrapper.innerHTML =
          '<div class="re-block-controls">' +
            '<button class="re-block-add-btn" title="Add block below"><i class="fas fa-plus"></i></button>' +
            '<button class="re-block-handle" title="Drag to reorder"><i class="fas fa-grip-vertical"></i></button>' +
          '</div>' +
          '<div class="re-embed-card">' +
            '<div class="re-embed-icon"><i class="fas fa-file"></i></div>' +
            '<div class="re-embed-name">' + escapeHtml(block.fileName || 'Embedded file') + '</div>' +
            '<div class="re-embed-badge">Embed</div>' +
            '<button class="re-embed-remove" title="Remove embed"><i class="fas fa-xmark"></i></button>' +
          '</div>';
        const card = wrapper.querySelector('.re-embed-card');
        card.addEventListener('click', (e) => {
          if (e.target.closest('.re-embed-remove')) {
            removeBlock(block.id);
            return;
          }
          // Open the file if possible
          if (block.fileId) {
            try { api.get('/api/files/' + block.fileId + '/meta').then(data => { if (data) openFile(data); }); } catch (_) {}
          }
        });
        const removeBtn = wrapper.querySelector('.re-embed-remove');
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          removeBlock(block.id);
        });
        setupBlockControls(wrapper, block);
        return wrapper;
      }

      // Editable block
      if (block.type === 'todo') {
        wrapper.dataset.checked = block.checked ? 'true' : 'false';
      }

      const controlsHtml =
        '<div class="re-block-controls">' +
          '<button class="re-block-add-btn" title="Add block below"><i class="fas fa-plus"></i></button>' +
          '<button class="re-block-handle" title="Drag to reorder"><i class="fas fa-grip-vertical"></i></button>' +
        '</div>';

      let prefix = '';
      if (block.type === 'todo') {
        prefix = '<button class="re-todo-checkbox' + (block.checked ? ' checked' : '') + '"></button>';
      }

      const ce = document.createElement('div');
      ce.className = 're-block-content';
      ce.contentEditable = 'true';
      ce.setAttribute('data-placeholder', getPlaceholder(block.type));
      ce.spellcheck = true;
      if (block.type === 'code') ce.spellcheck = false;
      ce.innerHTML = block.content || '';

      wrapper.innerHTML = controlsHtml + prefix;
      wrapper.appendChild(ce);

      // Events
      ce.addEventListener('input', () => {
        handleMarkdownShortcuts(wrapper, ce);
        triggerAutoSave();
      });

      ce.addEventListener('keydown', (e) => {
        handleBlockKeydown(e, wrapper, ce, block.id);
      });

      ce.addEventListener('focus', () => {
        // Close slash menu on focus if targeting a different block
        if (_slashMenuBlockId && _slashMenuBlockId !== wrapper.dataset.blockId) {
          hideSlashMenu();
        }
      });

      if (block.type === 'todo') {
        const checkbox = wrapper.querySelector('.re-todo-checkbox');
        checkbox.addEventListener('click', () => {
          const isChecked = wrapper.dataset.checked === 'true';
          wrapper.dataset.checked = isChecked ? 'false' : 'true';
          checkbox.classList.toggle('checked', !isChecked);
          triggerAutoSave();
        });
      }

      setupBlockControls(wrapper, block);
      return wrapper;
    }

    function setupBlockControls(wrapper, block) {
      const addBtn = wrapper.querySelector('.re-block-add-btn');
      const handle = wrapper.querySelector('.re-block-handle');

      if (addBtn) {
        addBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const newBlock = { id: uid(), type: 'paragraph', content: '' };
          const el = createBlockEl(newBlock);
          wrapper.after(el);
          renumberBlocks();
          focusBlock(el);
          triggerAutoSave();
        });
      }

      if (handle) {
        handle.addEventListener('mousedown', (e) => {
          e.preventDefault();
          startDrag(wrapper, e);
        });
      }
    }

    // ===== Drag and Drop =====
    function startDrag(wrapper, startEvent) {
      _dragState = {
        el: wrapper,
        startY: startEvent.clientY,
      };
      wrapper.classList.add('dragging');
      document.addEventListener('mousemove', onDragMove);
      document.addEventListener('mouseup', onDragEnd);
    }

    function onDragMove(e) {
      if (!_dragState) return;
      const wrappers = Array.from(_blocksContainer.querySelectorAll('.re-block-wrapper'));
      wrappers.forEach(w => {
        w.classList.remove('drag-over-top', 'drag-over-bottom');
        if (w === _dragState.el) return;
        const rect = w.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
          if (e.clientY < midY) {
            w.classList.add('drag-over-top');
          } else {
            w.classList.add('drag-over-bottom');
          }
          _dragState.targetEl = w;
          _dragState.position = e.clientY < midY ? 'before' : 'after';
        }
      });
    }

    function onDragEnd() {
      if (!_dragState) return;
      document.removeEventListener('mousemove', onDragMove);
      document.removeEventListener('mouseup', onDragEnd);
      const { el, targetEl, position } = _dragState;
      el.classList.remove('dragging');
      _blocksContainer.querySelectorAll('.re-block-wrapper').forEach(w => {
        w.classList.remove('drag-over-top', 'drag-over-bottom');
      });
      if (targetEl && targetEl !== el) {
        if (position === 'before') {
          targetEl.before(el);
        } else {
          targetEl.after(el);
        }
        renumberBlocks();
        triggerAutoSave();
      }
      _dragState = null;
    }

    // ===== Keyboard handling =====
    function handleBlockKeydown(e, wrapper, ce, blockId) {
      // Slash menu navigation
      if (_slashMenu && _slashMenu.classList.contains('visible') && _slashMenuBlockId === wrapper.dataset.blockId) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab') {
          e.preventDefault();
          e.stopPropagation();
          handleSlashMenuKey(e.key);
          return;
        }
      }

      // Inline formatting shortcuts
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
        if (e.key === 'b') { e.preventDefault(); document.execCommand('bold'); triggerAutoSave(); return; }
        if (e.key === 'i') { e.preventDefault(); document.execCommand('italic'); triggerAutoSave(); return; }
        if (e.key === 'u') { e.preventDefault(); document.execCommand('underline'); triggerAutoSave(); return; }
        if (e.key === 'e') { e.preventDefault(); toggleInlineCode(); triggerAutoSave(); return; }
      }

      // Enter: create new block
      if (e.key === 'Enter' && !e.shiftKey) {
        if (wrapper.dataset.type === 'code') return; // allow newlines in code
        e.preventDefault();
        // If slash menu is open, it was handled above
        const sel = window.getSelection();
        let afterContent = '';
        if (sel.rangeCount) {
          const range = sel.getRangeAt(0);
          const afterRange = range.cloneRange();
          afterRange.selectNodeContents(ce);
          afterRange.setStart(range.endContainer, range.endOffset);
          const fragment = afterRange.cloneContents();
          const tmp = document.createElement('div');
          tmp.appendChild(fragment);
          afterContent = tmp.innerHTML;
          // Remove the "after" part from current block
          afterRange.deleteContents();
        }
        // Determine new block type: lists continue, others default to paragraph
        let newType = 'paragraph';
        if (['bullet', 'numbered', 'todo'].includes(wrapper.dataset.type)) {
          // If current block is empty, convert to paragraph (un-indent)
          if (!ce.textContent.trim()) {
            convertBlockType(wrapper, 'paragraph');
            renumberBlocks();
            triggerAutoSave();
            return;
          }
          newType = wrapper.dataset.type;
        }
        const newBlock = { id: uid(), type: newType, content: afterContent };
        if (newType === 'todo') newBlock.checked = false;
        const el = createBlockEl(newBlock);
        wrapper.after(el);
        renumberBlocks();
        focusBlock(el, 'start');
        triggerAutoSave();
        return;
      }

      // Backspace at start: merge with previous or convert type
      if (e.key === 'Backspace') {
        const sel = window.getSelection();
        if (sel.rangeCount) {
          const range = sel.getRangeAt(0);
          if (range.collapsed && isAtStart(ce, range)) {
            // If not a paragraph, convert to paragraph first
            if (wrapper.dataset.type !== 'paragraph') {
              e.preventDefault();
              convertBlockType(wrapper, 'paragraph');
              renumberBlocks();
              triggerAutoSave();
              return;
            }
            // Merge with previous
            const prev = wrapper.previousElementSibling;
            if (prev && prev.classList.contains('re-block-wrapper')) {
              e.preventDefault();
              const prevType = prev.dataset.type;
              if (prevType === 'divider' || prevType === 'embed') {
                removeBlock(prev.dataset.blockId);
                triggerAutoSave();
                return;
              }
              const prevCe = prev.querySelector('.re-block-content');
              if (prevCe) {
                const insertionOffset = prevCe.textContent.length;
                prevCe.innerHTML = prevCe.innerHTML + ce.innerHTML;
                wrapper.remove();
                renumberBlocks();
                focusBlock(prev, insertionOffset);
                triggerAutoSave();
              }
            }
          }
        }
        return;
      }

      // Delete at end: merge with next
      if (e.key === 'Delete') {
        const sel = window.getSelection();
        if (sel.rangeCount) {
          const range = sel.getRangeAt(0);
          if (range.collapsed && isAtEnd(ce, range)) {
            const next = wrapper.nextElementSibling;
            if (next && next.classList.contains('re-block-wrapper')) {
              e.preventDefault();
              const nextType = next.dataset.type;
              if (nextType === 'divider' || nextType === 'embed') {
                removeBlock(next.dataset.blockId);
                triggerAutoSave();
                return;
              }
              const nextCe = next.querySelector('.re-block-content');
              if (nextCe) {
                ce.innerHTML = ce.innerHTML + nextCe.innerHTML;
                next.remove();
                renumberBlocks();
                triggerAutoSave();
              }
            }
          }
        }
        return;
      }

      // Arrow Up at start: focus previous
      if (e.key === 'ArrowUp') {
        const sel = window.getSelection();
        if (sel.rangeCount && isAtStart(ce, sel.getRangeAt(0))) {
          const prev = wrapper.previousElementSibling;
          if (prev && prev.classList.contains('re-block-wrapper')) {
            e.preventDefault();
            focusBlock(prev, 'end');
          }
        }
        return;
      }

      // Arrow Down at end: focus next
      if (e.key === 'ArrowDown') {
        const sel = window.getSelection();
        if (sel.rangeCount && isAtEnd(ce, sel.getRangeAt(0))) {
          const next = wrapper.nextElementSibling;
          if (next && next.classList.contains('re-block-wrapper')) {
            e.preventDefault();
            focusBlock(next, 'start');
          }
        }
        return;
      }

      // Tab: indent (for lists, convert bullet/numbered)
      if (e.key === 'Tab') {
        if (wrapper.dataset.type === 'code') {
          e.preventDefault();
          document.execCommand('insertText', false, '  ');
          triggerAutoSave();
          return;
        }
        e.preventDefault();
        return;
      }
    }

    function isAtStart(ce, range) {
      if (!range.collapsed) return false;
      const testRange = document.createRange();
      testRange.selectNodeContents(ce);
      testRange.setEnd(range.startContainer, range.startOffset);
      return testRange.toString().length === 0;
    }

    function isAtEnd(ce, range) {
      if (!range.collapsed) return false;
      const testRange = document.createRange();
      testRange.selectNodeContents(ce);
      testRange.setStart(range.endContainer, range.endOffset);
      return testRange.toString().length === 0;
    }

    function toggleInlineCode() {
      const sel = window.getSelection();
      if (!sel.rangeCount || sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      const selectedText = range.toString();
      if (!selectedText) return;

      // Check if we're inside a <code> already
      let parentCode = null;
      let node = range.commonAncestorContainer;
      while (node && node !== _blocksContainer) {
        if (node.nodeName === 'CODE') { parentCode = node; break; }
        node = node.parentNode;
      }

      if (parentCode) {
        // Unwrap
        const text = document.createTextNode(parentCode.textContent);
        parentCode.parentNode.replaceChild(text, parentCode);
      } else {
        const code = document.createElement('code');
        code.style.cssText = 'background:rgba(13,115,119,0.08);padding:2px 5px;border-radius:3px;font-family:monospace;font-size:0.9em;';
        range.surroundContents(code);
      }
    }

    // ===== Markdown shortcuts =====
    function handleMarkdownShortcuts(wrapper, ce) {
      const text = ce.textContent;

      // Only check shortcuts when text starts with trigger patterns
      if (text.startsWith('# ')) {
        ce.textContent = text.slice(2);
        convertBlockType(wrapper, 'heading1');
        focusBlock(wrapper, 'end');
      } else if (text.startsWith('## ')) {
        ce.textContent = text.slice(3);
        convertBlockType(wrapper, 'heading2');
        focusBlock(wrapper, 'end');
      } else if (text.startsWith('### ')) {
        ce.textContent = text.slice(4);
        convertBlockType(wrapper, 'heading3');
        focusBlock(wrapper, 'end');
      } else if (text.startsWith('- ') || text.startsWith('* ')) {
        ce.textContent = text.slice(2);
        convertBlockType(wrapper, 'bullet');
        focusBlock(wrapper, 'end');
      } else if (/^\d+\.\s/.test(text)) {
        ce.textContent = text.replace(/^\d+\.\s/, '');
        convertBlockType(wrapper, 'numbered');
        renumberBlocks();
        focusBlock(wrapper, 'end');
      } else if (text.startsWith('> ')) {
        ce.textContent = text.slice(2);
        convertBlockType(wrapper, 'quote');
        focusBlock(wrapper, 'end');
      } else if (text.startsWith('[] ') || text.startsWith('[ ] ')) {
        ce.textContent = text.startsWith('[] ') ? text.slice(3) : text.slice(4);
        convertBlockType(wrapper, 'todo');
        focusBlock(wrapper, 'end');
      } else if (text === '---' || text === '***') {
        // Replace with divider and create new paragraph after
        const divBlock = { id: uid(), type: 'divider' };
        const divEl = createBlockEl(divBlock);
        wrapper.before(divEl);
        ce.textContent = '';
        convertBlockType(wrapper, 'paragraph');
        focusBlock(wrapper, 'start');
      } else if (text === '```') {
        ce.textContent = '';
        convertBlockType(wrapper, 'code');
        focusBlock(wrapper, 'start');
      } else {
        // Check for slash command trigger
        if (text === '/' || text.endsWith('\n/')) {
          showSlashMenu(wrapper);
        } else if (_slashMenu && _slashMenu.classList.contains('visible') && _slashMenuBlockId === wrapper.dataset.blockId) {
          // Update filter
          const slashIdx = ce.textContent.lastIndexOf('/');
          if (slashIdx >= 0) {
            _slashMenuFilter = ce.textContent.slice(slashIdx + 1).toLowerCase();
            renderSlashMenuItems();
          } else {
            hideSlashMenu();
          }
        }
        return;
      }
      // If a conversion happened, also auto-save
      triggerAutoSave();
    }

    function convertBlockType(wrapper, newType) {
      const oldType = wrapper.dataset.type;
      wrapper.dataset.type = newType;

      // Remove old todo checkbox if switching away from todo
      if (oldType === 'todo' && newType !== 'todo') {
        const cb = wrapper.querySelector('.re-todo-checkbox');
        if (cb) cb.remove();
        delete wrapper.dataset.checked;
      }

      // Add todo checkbox if switching to todo
      if (newType === 'todo' && oldType !== 'todo') {
        wrapper.dataset.checked = 'false';
        const checkbox = document.createElement('button');
        checkbox.className = 're-todo-checkbox';
        checkbox.addEventListener('click', () => {
          const isChecked = wrapper.dataset.checked === 'true';
          wrapper.dataset.checked = isChecked ? 'false' : 'true';
          checkbox.classList.toggle('checked', !isChecked);
          triggerAutoSave();
        });
        const ce = wrapper.querySelector('.re-block-content');
        wrapper.insertBefore(checkbox, ce);
      }

      // Update placeholder
      const ce = wrapper.querySelector('.re-block-content');
      if (ce) {
        ce.setAttribute('data-placeholder', getPlaceholder(newType));
        if (newType === 'code') {
          ce.spellcheck = false;
        } else {
          ce.spellcheck = true;
        }
      }
    }

    // ===== Slash Command Menu =====
    function showSlashMenu(wrapper) {
      _slashMenuBlockId = wrapper.dataset.blockId;
      _slashMenuFilter = '';
      _slashMenuSelectedIdx = 0;
      if (!_slashMenu) {
        _slashMenu = document.createElement('div');
        _slashMenu.className = 're-slash-menu';
        document.body.appendChild(_slashMenu);
        _slashMenu.addEventListener('mousedown', (e) => e.preventDefault()); // prevent blur
      }
      renderSlashMenuItems();
      positionSlashMenu(wrapper);
      _slashMenu.classList.add('visible');
    }

    function hideSlashMenu() {
      if (_slashMenu) _slashMenu.classList.remove('visible');
      _slashMenuBlockId = null;
      _slashMenuFilter = '';
    }

    function positionSlashMenu(wrapper) {
      const ce = wrapper.querySelector('.re-block-content');
      if (!ce) return;
      const sel = window.getSelection();
      let rect;
      if (sel.rangeCount) {
        rect = sel.getRangeAt(0).getBoundingClientRect();
        if (rect.x === 0 && rect.y === 0) rect = ce.getBoundingClientRect();
      } else {
        rect = ce.getBoundingClientRect();
      }
      const menuHeight = 340;
      const spaceBelow = window.innerHeight - rect.bottom;
      _slashMenu.style.left = rect.left + 'px';
      if (spaceBelow > menuHeight + 10) {
        _slashMenu.style.top = (rect.bottom + 4) + 'px';
        _slashMenu.style.bottom = 'auto';
      } else {
        _slashMenu.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
        _slashMenu.style.top = 'auto';
      }
    }

    function renderSlashMenuItems() {
      if (!_slashMenu) return;
      const filter = _slashMenuFilter.toLowerCase();
      const filtered = BLOCK_TYPES.filter(bt =>
        bt.label.toLowerCase().includes(filter) || bt.type.toLowerCase().includes(filter) || bt.description.toLowerCase().includes(filter)
      );
      if (_slashMenuSelectedIdx >= filtered.length) _slashMenuSelectedIdx = Math.max(0, filtered.length - 1);

      if (filtered.length === 0) {
        _slashMenu.innerHTML = '<div class="re-slash-empty">No matching blocks</div>';
        return;
      }

      let html = '<div class="re-slash-menu-label">Blocks</div>';
      filtered.forEach((bt, idx) => {
        html +=
          '<div class="re-slash-item' + (idx === _slashMenuSelectedIdx ? ' selected' : '') + '" data-type="' + bt.type + '">' +
            '<div class="re-slash-item-icon"><i class="fas ' + bt.icon + '"></i></div>' +
            '<div class="re-slash-item-text">' +
              '<div class="re-slash-item-label">' + bt.label + '</div>' +
              '<div class="re-slash-item-desc">' + bt.description + '</div>' +
            '</div>' +
          '</div>';
      });
      _slashMenu.innerHTML = html;

      // Click handlers
      _slashMenu.querySelectorAll('.re-slash-item').forEach(item => {
        item.addEventListener('click', () => {
          selectSlashItem(item.dataset.type);
        });
        item.addEventListener('mouseenter', () => {
          _slashMenu.querySelectorAll('.re-slash-item').forEach(i => i.classList.remove('selected'));
          item.classList.add('selected');
          _slashMenuSelectedIdx = Array.from(_slashMenu.querySelectorAll('.re-slash-item')).indexOf(item);
        });
      });

      // Scroll selected into view
      const selectedEl = _slashMenu.querySelector('.re-slash-item.selected');
      if (selectedEl) selectedEl.scrollIntoView({ block: 'nearest' });
    }

    function handleSlashMenuKey(key) {
      const items = _slashMenu.querySelectorAll('.re-slash-item');
      if (!items.length) { if (key === 'Escape') hideSlashMenu(); return; }

      if (key === 'ArrowDown') {
        _slashMenuSelectedIdx = (_slashMenuSelectedIdx + 1) % items.length;
        items.forEach((it, i) => it.classList.toggle('selected', i === _slashMenuSelectedIdx));
        items[_slashMenuSelectedIdx].scrollIntoView({ block: 'nearest' });
      } else if (key === 'ArrowUp') {
        _slashMenuSelectedIdx = (_slashMenuSelectedIdx - 1 + items.length) % items.length;
        items.forEach((it, i) => it.classList.toggle('selected', i === _slashMenuSelectedIdx));
        items[_slashMenuSelectedIdx].scrollIntoView({ block: 'nearest' });
      } else if (key === 'Enter' || key === 'Tab') {
        const selected = items[_slashMenuSelectedIdx];
        if (selected) selectSlashItem(selected.dataset.type);
      } else if (key === 'Escape') {
        hideSlashMenu();
      }
    }

    function selectSlashItem(type) {
      hideSlashMenu();
      // Find the block wrapper
      const wrapper = _blocksContainer.querySelector('.re-block-wrapper[data-block-id="' + _slashMenuBlockId + '"]');
      if (!wrapper) return;
      const ce = wrapper.querySelector('.re-block-content');

      if (type === 'embed') {
        // Clear slash text
        if (ce) {
          const t = ce.textContent;
          const slashIdx = t.lastIndexOf('/');
          if (slashIdx >= 0) ce.textContent = t.slice(0, slashIdx);
        }
        showFilePicker(wrapper);
        return;
      }

      if (type === 'divider') {
        // Clear slash text from current block, insert divider before
        if (ce) {
          const t = ce.textContent;
          const slashIdx = t.lastIndexOf('/');
          if (slashIdx >= 0) ce.textContent = t.slice(0, slashIdx);
        }
        const divBlock = { id: uid(), type: 'divider' };
        const divEl = createBlockEl(divBlock);
        wrapper.before(divEl);
        focusBlock(wrapper, 'start');
        triggerAutoSave();
        return;
      }

      // Clear the slash text
      if (ce) {
        const t = ce.textContent;
        const slashIdx = t.lastIndexOf('/');
        if (slashIdx >= 0) ce.textContent = t.slice(0, slashIdx);
      }

      convertBlockType(wrapper, type);
      renumberBlocks();
      focusBlock(wrapper, 'end');
      triggerAutoSave();
    }

    // ===== File Embed Picker =====
    async function showFilePicker(afterWrapper) {
      let files = [];
      try {
        const data = await api.get('/api/files' + (state.currentFolder ? '?folder=' + state.currentFolder : ''));
        files = (data.files || []).filter(f => f.type !== 'folder');
      } catch (_) {}

      // Also get root files if in a subfolder
      if (state.currentFolder) {
        try {
          const rootData = await api.get('/api/files');
          const rootFiles = (rootData.files || []).filter(f => f.type !== 'folder');
          // Merge, avoiding duplicates
          const existingIds = new Set(files.map(f => f.id));
          rootFiles.forEach(f => { if (!existingIds.has(f.id)) files.push(f); });
        } catch (_) {}
      }

      let html = '<input type="text" class="re-file-picker-search" placeholder="Search files..." /><div class="re-file-picker-list">';
      if (files.length === 0) {
        html += '<div style="padding:16px;text-align:center;color:var(--text-tertiary);">No files in vault</div>';
      } else {
        files.forEach(f => {
          const iconInfo = getFileIcon(f.mime_type);
          html += '<div class="re-file-picker-item" data-file-id="' + f.id + '" data-file-name="' + escapeHtml(f.name) + '">' +
            '<i class="fas ' + iconInfo.icon + '" style="color:' + iconInfo.color + '"></i>' +
            '<span>' + escapeHtml(f.name) + '</span></div>';
        });
      }
      html += '</div>';

      const result = await showModal('Embed a file', html, [
        { label: 'Cancel', className: 'btn', value: null },
      ]);

      // The modal will be dismissed by selecting a file or cancelling
      // Since showModal resolves on button click, we need to hook into file item clicks
      // We handle this inside the modal's body after it's shown:
      // Actually, showModal doesn't give us ongoing access to the DOM easily.
      // Let's use a workaround: attach click handlers to file items after modal opens.
      // But showModal is promise-based and blocks. Let's just directly insert embed after modal.
      // The showModal resolves when a button is clicked; for file selection we can use a different approach.

      // Since the showModal approach is limited, let's build a custom picker
      return; // The above showModal won't work well for this, let's use a custom overlay
    }

    // Replace showFilePicker with a working implementation using a custom overlay
    async function showFilePickerOverlay(afterWrapper) {
      let files = [];
      try {
        const data = await api.get('/api/files' + (state.currentFolder ? '?folder=' + state.currentFolder : ''));
        files = (data.files || []).filter(f => f.type !== 'folder');
      } catch (_) {}

      if (state.currentFolder) {
        try {
          const rootData = await api.get('/api/files');
          const rootFiles = (rootData.files || []).filter(f => f.type !== 'folder');
          const existingIds = new Set(files.map(f => f.id));
          rootFiles.forEach(f => { if (!existingIds.has(f.id)) files.push(f); });
        } catch (_) {}
      }

      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.3);z-index:10001;display:flex;align-items:center;justify-content:center;';

        const dialog = document.createElement('div');
        dialog.style.cssText = 'background:var(--bg-primary,#fff);border-radius:12px;padding:20px;width:400px;max-width:90vw;max-height:70vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.15);';

        const titleEl = document.createElement('div');
        titleEl.style.cssText = 'font-size:16px;font-weight:600;margin-bottom:12px;color:var(--text-primary,#1a1a1a);';
        titleEl.textContent = 'Embed a file';

        const searchInput = document.createElement('input');
        searchInput.className = 're-file-picker-search';
        searchInput.placeholder = 'Search files...';

        const listEl = document.createElement('div');
        listEl.className = 're-file-picker-list';

        function renderList(filter) {
          listEl.innerHTML = '';
          const filtered = filter ? files.filter(f => f.name.toLowerCase().includes(filter.toLowerCase())) : files;
          if (filtered.length === 0) {
            listEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-tertiary,#9ca3af);">No files found</div>';
            return;
          }
          filtered.forEach(f => {
            const item = document.createElement('div');
            item.className = 're-file-picker-item';
            const iconInfo = getFileIcon(f.mime_type);
            item.innerHTML = '<i class="fas ' + iconInfo.icon + '" style="color:' + iconInfo.color + '"></i><span>' + escapeHtml(f.name) + '</span>';
            item.addEventListener('click', () => {
              cleanup();
              resolve({ fileId: f.id, fileName: f.name });
            });
            listEl.appendChild(item);
          });
        }

        searchInput.addEventListener('input', () => renderList(searchInput.value));
        renderList('');

        dialog.appendChild(titleEl);
        dialog.appendChild(searchInput);
        dialog.appendChild(listEl);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        searchInput.focus();

        function cleanup() {
          overlay.remove();
        }

        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) { cleanup(); resolve(null); }
        });

        const handleKey = (e) => {
          if (e.key === 'Escape') { cleanup(); resolve(null); document.removeEventListener('keydown', handleKey); }
        };
        document.addEventListener('keydown', handleKey);
      });
    }

    // ===== Formatting Bar =====
    let _formatBar = null;
    let _linkPopover = null;

    function initFormatBar() {
      if (_formatBar) return;
      _formatBar = document.createElement('div');
      _formatBar.className = 're-format-bar';
      _formatBar.innerHTML =
        '<button class="re-format-btn" data-cmd="bold" title="Bold (Ctrl+B)"><i class="fas fa-bold"></i></button>' +
        '<button class="re-format-btn" data-cmd="italic" title="Italic (Ctrl+I)"><i class="fas fa-italic"></i></button>' +
        '<button class="re-format-btn" data-cmd="underline" title="Underline (Ctrl+U)"><i class="fas fa-underline"></i></button>' +
        '<button class="re-format-btn" data-cmd="strikethrough" title="Strikethrough"><i class="fas fa-strikethrough"></i></button>' +
        '<div class="re-format-sep"></div>' +
        '<button class="re-format-btn" data-cmd="code" title="Inline Code (Ctrl+E)"><i class="fas fa-code"></i></button>' +
        '<button class="re-format-btn" data-cmd="link" title="Link"><i class="fas fa-link"></i></button>';
      document.body.appendChild(_formatBar);

      _formatBar.addEventListener('mousedown', (e) => {
        e.preventDefault(); // Keep selection
        const btn = e.target.closest('.re-format-btn');
        if (!btn) return;
        const cmd = btn.dataset.cmd;
        if (cmd === 'code') {
          toggleInlineCode();
          triggerAutoSave();
          updateFormatBarState();
        } else if (cmd === 'link') {
          showLinkPopover();
        } else {
          document.execCommand(cmd);
          triggerAutoSave();
          updateFormatBarState();
        }
      });

      // Link popover
      _linkPopover = document.createElement('div');
      _linkPopover.className = 're-link-popover';
      _linkPopover.innerHTML = '<input type="text" placeholder="https://..." /><button>Apply</button>';
      document.body.appendChild(_linkPopover);

      const linkInput = _linkPopover.querySelector('input');
      const linkBtn = _linkPopover.querySelector('button');
      linkBtn.addEventListener('click', () => {
        const url = linkInput.value.trim();
        if (url) {
          document.execCommand('createLink', false, url);
          triggerAutoSave();
        }
        _linkPopover.classList.remove('visible');
      });
      linkInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { linkBtn.click(); }
        if (e.key === 'Escape') { _linkPopover.classList.remove('visible'); }
      });
    }

    function showLinkPopover() {
      if (!_linkPopover) return;
      const rect = _formatBar.getBoundingClientRect();
      _linkPopover.style.left = rect.left + 'px';
      _linkPopover.style.top = (rect.bottom + 6) + 'px';
      _linkPopover.classList.add('visible');
      const input = _linkPopover.querySelector('input');
      input.value = '';
      setTimeout(() => input.focus(), 10);
    }

    function updateFormatBarState() {
      if (!_formatBar) return;
      _formatBar.querySelectorAll('.re-format-btn').forEach(btn => {
        const cmd = btn.dataset.cmd;
        if (cmd === 'code' || cmd === 'link') return;
        btn.classList.toggle('active', document.queryCommandState(cmd));
      });
    }

    function onSelectionChange() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        if (_formatBar) _formatBar.classList.remove('visible');
        if (_linkPopover) _linkPopover.classList.remove('visible');
        return;
      }

      // Only show if selection is within our editor
      const range = sel.getRangeAt(0);
      if (!_blocksContainer || !_blocksContainer.contains(range.commonAncestorContainer)) {
        if (_formatBar) _formatBar.classList.remove('visible');
        return;
      }

      // Don't show in code blocks
      const wrapper = range.commonAncestorContainer.closest ? range.commonAncestorContainer.closest('.re-block-wrapper') :
        range.commonAncestorContainer.parentElement ? range.commonAncestorContainer.parentElement.closest('.re-block-wrapper') : null;
      if (wrapper && wrapper.dataset.type === 'code') {
        if (_formatBar) _formatBar.classList.remove('visible');
        return;
      }

      initFormatBar();
      const rect = range.getBoundingClientRect();
      if (rect.width === 0) return;

      _formatBar.style.left = Math.max(8, rect.left + rect.width / 2 - 120) + 'px';
      _formatBar.style.top = (rect.top - 44) + 'px';
      _formatBar.classList.add('visible');
      updateFormatBarState();
    }

    // ===== Block operations =====
    function focusBlock(wrapper, position) {
      const ce = wrapper.querySelector('.re-block-content');
      if (!ce) return;
      ce.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      if (position === 'start' || position === 0) {
        range.selectNodeContents(ce);
        range.collapse(true);
      } else if (position === 'end') {
        range.selectNodeContents(ce);
        range.collapse(false);
      } else if (typeof position === 'number') {
        // Position by text offset
        try {
          const walker = document.createTreeWalker(ce, NodeFilter.SHOW_TEXT, null, false);
          let charCount = 0;
          let node;
          while (node = walker.nextNode()) {
            if (charCount + node.length >= position) {
              range.setStart(node, position - charCount);
              range.collapse(true);
              break;
            }
            charCount += node.length;
          }
          if (!node) {
            range.selectNodeContents(ce);
            range.collapse(false);
          }
        } catch (_) {
          range.selectNodeContents(ce);
          range.collapse(false);
        }
      } else {
        range.selectNodeContents(ce);
        range.collapse(false);
      }
      sel.removeAllRanges();
      sel.addRange(range);
    }

    function removeBlock(blockId) {
      const wrapper = _blocksContainer.querySelector('.re-block-wrapper[data-block-id="' + blockId + '"]');
      if (!wrapper) return;
      const next = wrapper.nextElementSibling;
      const prev = wrapper.previousElementSibling;
      wrapper.remove();
      // Ensure at least one block
      if (!_blocksContainer.querySelector('.re-block-wrapper')) {
        const newBlock = { id: uid(), type: 'paragraph', content: '' };
        const el = createBlockEl(newBlock);
        _blocksContainer.appendChild(el);
        focusBlock(el, 'start');
      } else if (next && next.classList.contains('re-block-wrapper')) {
        focusBlock(next, 'start');
      } else if (prev && prev.classList.contains('re-block-wrapper')) {
        focusBlock(prev, 'end');
      }
      renumberBlocks();
      triggerAutoSave();
    }

    // ===== Auto-save =====
    let _saveDebounceTimer = null;
    let _saveStatusEl = null;
    let _blockCountEl = null;
    let _isSaving = false;

    function triggerAutoSave() {
      if (_saveStatusEl) {
        _saveStatusEl.innerHTML = '<i class="fas fa-circle" style="color:#f59e0b;"></i> Unsaved changes';
      }
      updateBlockCount();
      clearTimeout(_saveDebounceTimer);
      _saveDebounceTimer = setTimeout(doSave, 2000);
    }

    async function doSave() {
      if (!_noteId || _isSaving) return;
      _isSaving = true;
      if (_saveStatusEl) {
        _saveStatusEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
      }
      try {
        const titleVal = _titleInput ? _titleInput.value.trim() || 'Untitled' : 'Untitled';
        const contentJson = serializeBlocks();
        await api.put('/api/notes/' + _noteId, {
          title: titleVal,
          content: contentJson,
        });
        if (_saveStatusEl) {
          _saveStatusEl.innerHTML = '<i class="fas fa-check" style="color:#0d7377;"></i> Saved';
        }
        // Update viewer title
        const viewerTitle = $('viewer-title');
        if (viewerTitle) viewerTitle.textContent = titleVal;
      } catch (err) {
        if (_saveStatusEl) {
          _saveStatusEl.innerHTML = '<i class="fas fa-exclamation-triangle" style="color:#ef4444;"></i> Save failed';
        }
      }
      _isSaving = false;
    }

    function updateBlockCount() {
      if (!_blockCountEl || !_blocksContainer) return;
      const count = _blocksContainer.querySelectorAll('.re-block-wrapper').length;
      _blockCountEl.textContent = count + ' block' + (count !== 1 ? 's' : '');
    }

    // ===== Public: mount editor =====
    function mount(container, noteId, noteTitle, rawContent) {
      injectStyles();
      _noteId = noteId;

      // Parse content
      const data = parseContent(rawContent);

      container.innerHTML = '';

      // Build editor structure
      _editorEl = document.createElement('div');
      _editorEl.className = 're-editor';

      // Title input
      _titleInput = document.createElement('input');
      _titleInput.type = 'text';
      _titleInput.className = 're-title-input';
      _titleInput.value = noteTitle || '';
      _titleInput.placeholder = 'Untitled';
      _titleInput.addEventListener('input', triggerAutoSave);
      _titleInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          // Focus first block
          const first = _blocksContainer.querySelector('.re-block-wrapper');
          if (first) focusBlock(first, 'start');
        }
      });

      // Blocks container
      _blocksContainer = document.createElement('div');
      _blocksContainer.className = 're-blocks';

      // Render blocks
      data.blocks.forEach(block => {
        const el = createBlockEl(block);
        _blocksContainer.appendChild(el);
      });
      renumberBlocks();

      // Click on empty area at bottom creates new block
      _blocksContainer.addEventListener('click', (e) => {
        if (e.target === _blocksContainer) {
          const lastWrapper = _blocksContainer.querySelector('.re-block-wrapper:last-child');
          if (lastWrapper) {
            const ce = lastWrapper.querySelector('.re-block-content');
            if (ce && ce.textContent.trim() === '' && lastWrapper.dataset.type === 'paragraph') {
              focusBlock(lastWrapper, 'start');
            } else {
              const newBlock = { id: uid(), type: 'paragraph', content: '' };
              const el = createBlockEl(newBlock);
              _blocksContainer.appendChild(el);
              focusBlock(el, 'start');
            }
          }
        }
      });

      // Footer
      const footer = document.createElement('div');
      footer.className = 're-footer';

      const footerLeft = document.createElement('div');
      footerLeft.className = 're-footer-left';
      _saveStatusEl = document.createElement('span');
      _saveStatusEl.className = 're-save-status';
      _saveStatusEl.innerHTML = '<i class="fas fa-check" style="color:#0d7377;"></i> Saved';
      _blockCountEl = document.createElement('span');
      _blockCountEl.className = 're-block-count';
      footerLeft.appendChild(_saveStatusEl);
      footerLeft.appendChild(_blockCountEl);

      const footerRight = document.createElement('div');
      footerRight.className = 're-footer-right';
      const saveNowBtn = document.createElement('button');
      saveNowBtn.className = 're-footer-btn';
      saveNowBtn.innerHTML = '<i class="fas fa-floppy-disk"></i> Save now';
      saveNowBtn.addEventListener('click', () => {
        clearTimeout(_saveDebounceTimer);
        doSave();
      });
      footerRight.appendChild(saveNowBtn);

      footer.appendChild(footerLeft);
      footer.appendChild(footerRight);

      _editorEl.appendChild(_titleInput);
      _editorEl.appendChild(_blocksContainer);
      _editorEl.appendChild(footer);
      container.appendChild(_editorEl);

      updateBlockCount();

      // Selection change listener for formatting bar
      document.addEventListener('selectionchange', onSelectionChange);

      // Click outside to close slash menu
      document.addEventListener('click', (e) => {
        if (_slashMenu && _slashMenu.classList.contains('visible') && !_slashMenu.contains(e.target)) {
          const wrapper = e.target.closest('.re-block-wrapper');
          if (!wrapper || wrapper.dataset.blockId !== _slashMenuBlockId) {
            hideSlashMenu();
          }
        }
      });

      // Focus first block
      const firstBlock = _blocksContainer.querySelector('.re-block-wrapper');
      if (firstBlock) {
        const ce = firstBlock.querySelector('.re-block-content');
        if (ce && !ce.textContent.trim()) {
          setTimeout(() => focusBlock(firstBlock, 'start'), 100);
        }
      }
    }

    // Fix the showFilePicker to use the overlay version
    showFilePicker = async function(afterWrapper) {
      const result = await showFilePickerOverlay(afterWrapper);
      if (result) {
        const embedBlock = {
          id: uid(), type: 'embed',
          fileId: result.fileId, fileName: result.fileName,
        };
        const el = createBlockEl(embedBlock);
        afterWrapper.after(el);
        // If the current block is empty paragraph, remove it
        const ce = afterWrapper.querySelector('.re-block-content');
        if (ce && !ce.textContent.trim() && afterWrapper.dataset.type === 'paragraph') {
          afterWrapper.remove();
        }
        triggerAutoSave();
      }
    };

    function destroy() {
      document.removeEventListener('selectionchange', onSelectionChange);
      if (_slashMenu) { _slashMenu.remove(); _slashMenu = null; }
      if (_formatBar) { _formatBar.remove(); _formatBar = null; }
      if (_linkPopover) { _linkPopover.remove(); _linkPopover = null; }
      clearTimeout(_saveDebounceTimer);
      _editorEl = null;
      _titleInput = null;
      _blocksContainer = null;
      _noteId = null;
      _saveStatusEl = null;
      _blockCountEl = null;
      _slashMenuBlockId = null;
      _dragState = null;
    }

    return { mount: mount, destroy: destroy, save: doSave };
  })();

  async function openNoteEditor(note) {
    // Destroy any previous editor instance
    RichEditor.destroy();

    state.currentFile = { ...note, __isNote: true };
    const panel = $('viewer-panel');
    const title = $('viewer-title');
    const body = $('viewer-body');
    if (!panel || !body) return;

    panel.classList.remove('hidden');
    panel.classList.add('active');

    body.innerHTML = '<div class="loading-spinner" style="padding:40px;text-align:center;"><i class="fas fa-spinner fa-spin"></i> Loading note...</div>';

    // Fetch full note content
    let fullNote = note;
    try {
      const data = await api.get('/api/notes/' + note.id);
      fullNote = data.note || data;
    } catch (e) { /* use partial */ }

    if (title) title.textContent = fullNote.title || 'Untitled';

    body.innerHTML = '';
    RichEditor.mount(body, fullNote.id, fullNote.title || '', fullNote.content || '');
  }

  async function createNewNote() {
    const initialContent = JSON.stringify({
      blocks: [{ id: Math.random().toString(36).slice(2, 10), type: 'paragraph', content: '' }]
    });
    try {
      const data = await api.post('/api/notes', {
        title: 'Untitled Note',
        content: initialContent,
        folderId: state.currentFolder,
      });
      showToast('Note created', 'success');
      if (data.note) {
        openNoteEditor(data.note);
      }
      if (state.currentView === 'notes') loadNotes();
    } catch (err) {
      showToast('Failed to create note: ' + err.message, 'error');
    }
  }

  async function deleteNote(note) {
    const confirmed = await showConfirm('Delete note "' + (note.title || 'Untitled') + '"?');
    if (!confirmed) return;
    try {
      await api.del('/api/notes/' + note.id);
      showToast('Note deleted', 'success');
      if (state.currentFile && state.currentFile.__isNote && state.currentFile.id === note.id) {
        RichEditor.destroy();
        closeViewer();
      }
      loadNotes();
    } catch (err) {
      showToast('Delete failed: ' + err.message, 'error');
    }
  }

  // ===== Bookmarks View =====

  async function loadBookmarks() {
    const list = $('bookmarks-list');
    if (!list) return;
    list.innerHTML = '<div class="loading-spinner"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';

    try {
      const data = await api.get('/api/bookmarks');
      renderBookmarks(data.bookmarks || []);
    } catch (err) {
      list.innerHTML = '';
      showToast('Failed to load bookmarks: ' + err.message, 'error');
    }
  }

  function renderBookmarks(bookmarks) {
    const list = $('bookmarks-list');
    if (!list) return;
    list.innerHTML = '';

    if (bookmarks.length === 0) {
      list.innerHTML = '<div class="empty-message"><i class="fas fa-bookmark fa-2x"></i><p>No bookmarks yet.</p></div>';
      return;
    }

    bookmarks.forEach((bm) => {
      const el = document.createElement('div');
      el.className = 'bookmark-item';
      el.innerHTML =
        '<div class="bookmark-icon"><i class="fas fa-bookmark"></i></div>' +
        '<div class="bookmark-info">' +
        '<div class="bookmark-file">' + escapeHtml(bm.file_name || 'Unknown file') + '</div>' +
        '<div class="bookmark-label">' + escapeHtml(bm.label || '') + '</div>' +
        '</div>' +
        '<span class="bookmark-page">Page ' + (bm.page || '?') + '</span>' +
        '<button class="btn-icon bookmark-delete" title="Remove"><i class="fas fa-times"></i></button>';

      el.addEventListener('click', (e) => {
        if (e.target.closest('.bookmark-delete')) return;
        openFileAtPage(bm.file_id, bm.page, bm.file_name);
      });

      el.querySelector('.bookmark-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await api.del('/api/bookmarks/' + bm.id);
          showToast('Bookmark removed', 'success');
          loadBookmarks();
        } catch (err) {
          showToast('Failed to remove bookmark: ' + err.message, 'error');
        }
      });

      list.appendChild(el);
    });
  }

  function openFileAtPage(fileId, page, fileName) {
    const fakeFile = { id: fileId, name: fileName || 'Document', mime_type: 'application/pdf' };
    state.currentFile = fakeFile;
    const panel = $('viewer-panel');
    const titleEl = $('viewer-title');
    const body = $('viewer-body');
    if (!panel || !body) return;

    panel.classList.remove('hidden');
    panel.classList.add('active');
    if (titleEl) titleEl.textContent = fakeFile.name;
    body.innerHTML = '';

    if (window.PDFViewerApp) {
      window.PDFViewerApp.open(fileId, fakeFile.name, page);
    } else {
      body.innerHTML = '<iframe src="/api/files/' + fileId + '/view#page=' + page + '" class="viewer-iframe" style="width:100%;height:100%;border:none;"></iframe>';
    }
  }

  // ===== Trash View =====

  async function loadTrash() {
    const list = $('trash-list');
    if (!list) return;
    list.innerHTML = '<div class="loading-spinner"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';

    try {
      const data = await api.get('/api/trash');
      renderTrash(data.items || []);
    } catch (err) {
      list.innerHTML = '';
      showToast('Failed to load trash: ' + err.message, 'error');
    }
  }

  function renderTrash(items) {
    const list = $('trash-list');
    if (!list) return;
    list.innerHTML = '';

    if (items.length === 0) {
      list.innerHTML = '<div class="empty-message"><i class="fas fa-trash fa-2x"></i><p>Trash is empty.</p></div>';
      return;
    }

    items.forEach((item) => {
      const el = document.createElement('div');
      el.className = 'trash-item';

      let icon;
      if (item.type === 'folder' || item.itemType === 'folder') {
        icon = '<i class="fas fa-folder" style="color:#f59e0b"></i>';
      } else if (item.type === 'note' || item.itemType === 'note') {
        icon = '<i class="fas fa-sticky-note" style="color:#8b5cf6"></i>';
      } else {
        const fi = getFileIcon(item.mime_type);
        icon = '<i class="fas ' + fi.icon + '" style="color:' + fi.color + '"></i>';
      }

      const typeBadge = item.itemType || item.type || 'file';

      el.innerHTML =
        '<div class="trash-icon">' + icon + '</div>' +
        '<div class="trash-name">' + escapeHtml(item.name) + '</div>' +
        '<span class="trash-type-badge">' + escapeHtml(typeBadge) + '</span>' +
        '<div class="trash-date">' + formatDate(item.deletedAt) + '</div>' +
        '<div class="trash-actions">' +
        '<button class="btn btn-sm btn-secondary trash-restore" title="Restore"><i class="fas fa-undo"></i> Restore</button>' +
        '<button class="btn btn-sm btn-danger trash-perma-delete" title="Delete permanently"><i class="fas fa-times"></i></button>' +
        '</div>';

      el.querySelector('.trash-restore').addEventListener('click', async () => {
        try {
          await api.post('/api/trash/' + item.id + '/restore', { itemType: item.itemType || item.type });
          showToast('Item restored', 'success');
          loadTrash();
        } catch (err) {
          showToast('Restore failed: ' + err.message, 'error');
        }
      });

      el.querySelector('.trash-perma-delete').addEventListener('click', async () => {
        const confirmed = await showConfirm('Permanently delete "' + item.name + '"? This cannot be undone.');
        if (!confirmed) return;
        try {
          await api.del('/api/trash/' + item.id + '?itemType=' + encodeURIComponent(item.itemType || item.type));
          showToast('Permanently deleted', 'success');
          loadTrash();
        } catch (err) {
          showToast('Delete failed: ' + err.message, 'error');
        }
      });

      list.appendChild(el);
    });
  }

  async function emptyTrash() {
    const confirmed = await showConfirm('Permanently delete everything in trash? This cannot be undone.');
    if (!confirmed) return;
    try {
      await api.post('/api/trash/empty');
      showToast('Trash emptied', 'success');
      loadTrash();
    } catch (err) {
      showToast('Failed to empty trash: ' + err.message, 'error');
    }
  }

  // ===== Browser View =====
  // Uses /browse/<url> pattern — iframe loads pages through server proxy.
  // Relative URLs in the page naturally resolve through the proxy path.
  // Server injects fetch/XHR patches so JS requests also go through proxy.

  const browserState = {
    history: [],
    historyIndex: -1,
    currentUrl: '',
    loading: false,
    iframe: null,
  };

  function initBrowser() {
    const form = $('browser-url-form');
    const input = $('browser-url-input');
    const backBtn = $('browser-back');
    const fwdBtn = $('browser-forward');
    const refreshBtn = $('browser-refresh');

    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        let raw = input.value.trim();
        if (!raw) return;
        let url;
        if (raw.startsWith('http://') || raw.startsWith('https://')) {
          url = raw;
        } else if (/^[\w-]+(\.[\w-]+)+/.test(raw)) {
          // Looks like a domain (has dots) — treat as URL
          url = 'https://' + raw;
        } else {
          // Not a URL — search with DuckDuckGo (privacy-friendly)
          url = 'https://duckduckgo.com/?q=' + encodeURIComponent(raw);
        }
        browserNavigate(url);
      });
    }

    if (backBtn) backBtn.addEventListener('click', browserBack);
    if (fwdBtn) fwdBtn.addEventListener('click', browserForward);
    if (refreshBtn) refreshBtn.addEventListener('click', browserRefresh);
  }

  function browserNavigate(url, pushHistory = true) {
    const content = $('browser-content');
    const input = $('browser-url-input');
    if (!content) return;

    browserState.loading = true;
    browserState.currentUrl = url;
    if (input) input.value = url;

    if (pushHistory) {
      browserState.history = browserState.history.slice(0, browserState.historyIndex + 1);
      browserState.history.push(url);
      browserState.historyIndex = browserState.history.length - 1;
    }
    updateBrowserButtons();

    // Show loading bar + iframe
    content.innerHTML = '<div class="browser-loading"></div>';

    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:100%;height:100%;border:none;display:none;';
    iframe.src = '/browse/' + url;
    browserState.iframe = iframe;

    iframe.addEventListener('load', () => {
      // Remove loading bar, show iframe
      const loader = content.querySelector('.browser-loading');
      if (loader) loader.remove();
      iframe.style.display = 'block';
      browserState.loading = false;

      // Try to read the actual URL from iframe (may be redirected)
      try {
        const iframePath = iframe.contentWindow.location.pathname;
        if (iframePath.startsWith('/browse/')) {
          const realUrl = iframePath.slice(8) + (iframe.contentWindow.location.search || '');
          browserState.currentUrl = realUrl;
          if (input) input.value = realUrl;
        }
      } catch (e) { /* cross-origin, ignore */ }

      // Try to read title
      try {
        const title = iframe.contentDocument?.title;
        if (title) {
          // Could display somewhere
        }
      } catch (e) {}
    });

    iframe.addEventListener('error', () => {
      content.innerHTML =
        '<div class="browser-error">' +
        '<i class="fas fa-exclamation-circle"></i>' +
        '<p>Failed to load page</p>' +
        '</div>';
      browserState.loading = false;
    });

    content.appendChild(iframe);
  }

  function browserBack() {
    if (browserState.historyIndex > 0) {
      browserState.historyIndex--;
      browserNavigate(browserState.history[browserState.historyIndex], false);
    }
  }

  function browserForward() {
    if (browserState.historyIndex < browserState.history.length - 1) {
      browserState.historyIndex++;
      browserNavigate(browserState.history[browserState.historyIndex], false);
    }
  }

  function browserRefresh() {
    if (browserState.currentUrl) {
      browserNavigate(browserState.currentUrl, false);
    }
  }

  function updateBrowserButtons() {
    const backBtn = $('browser-back');
    const fwdBtn = $('browser-forward');
    if (backBtn) backBtn.disabled = browserState.historyIndex <= 0;
    if (fwdBtn) fwdBtn.disabled = browserState.historyIndex >= browserState.history.length - 1;
  }

  // ===== Search =====

  function initSearch() {
    const input = $('search-input');
    if (!input) return;

    let searchDropdown = document.createElement('div');
    searchDropdown.className = 'search-dropdown hidden';
    searchDropdown.id = 'search-dropdown';
    input.parentElement.style.position = 'relative';
    input.parentElement.appendChild(searchDropdown);

    const performSearch = debounce(async (query) => {
      if (!query || query.length < 2) {
        searchDropdown.classList.add('hidden');
        searchDropdown.innerHTML = '';
        return;
      }
      try {
        const data = await api.get('/api/search?q=' + encodeURIComponent(query));
        renderSearchResults(data.results || [], searchDropdown);
      } catch (err) {
        searchDropdown.innerHTML = '<div class="search-no-results">Search failed</div>';
        searchDropdown.classList.remove('hidden');
      }
    }, 300);

    input.addEventListener('input', () => {
      performSearch(input.value.trim());
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        searchDropdown.classList.add('hidden');
        input.blur();
      }
    });

    // Close dropdown on click outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#search-input') && !e.target.closest('#search-dropdown')) {
        searchDropdown.classList.add('hidden');
      }
    });
  }

  function renderSearchResults(results, dropdown) {
    dropdown.innerHTML = '';
    if (results.length === 0) {
      dropdown.innerHTML = '<div class="search-no-results">No results found</div>';
      dropdown.classList.remove('hidden');
      return;
    }

    results.forEach((r) => {
      const el = document.createElement('div');
      el.className = 'search-result-item';
      const icon = r.type === 'folder'
        ? '<i class="fas fa-folder" style="color:#f59e0b"></i>'
        : r.type === 'note'
          ? '<i class="fas fa-sticky-note" style="color:#8b5cf6"></i>'
          : '<i class="fas ' + getFileIcon(r.mime_type).icon + '" style="color:' + getFileIcon(r.mime_type).color + '"></i>';
      el.innerHTML = '<div class="search-result-icon">' + icon + '</div><div class="search-result-name">' + escapeHtml(r.name) + '</div><span class="search-result-type">' + escapeHtml(r.type || 'file') + '</span>';
      el.addEventListener('click', () => {
        dropdown.classList.add('hidden');
        $('search-input').value = '';
        if (r.type === 'folder') {
          switchView('files');
          navigateToFolder(r.id);
        } else if (r.type === 'note') {
          switchView('notes');
          openNoteEditor(r);
        } else {
          switchView('files');
          openFile(r);
        }
      });
      dropdown.appendChild(el);
    });

    dropdown.classList.remove('hidden');
  }

  // ===== Sidebar Folder Tree =====

  async function loadFolderTree() {
    const tree = $('folder-tree');
    if (!tree) return;

    try {
      const data = await api.get('/api/folders');
      const allFolders = data.folders || [];
      tree.innerHTML = '';
      const rootItem = document.createElement('div');
      rootItem.className = 'tree-item' + (state.currentFolder === null ? ' active' : '');
      rootItem.innerHTML = '<i class="fas fa-home"></i><span>Vault</span>';
      rootItem.addEventListener('click', () => {
        switchView('files');
        navigateToFolder(null);
        highlightTreeItem(null);
      });
      tree.appendChild(rootItem);

      // Build tree structure
      const byParent = {};
      allFolders.forEach((f) => {
        const pid = f.parent_id || '__root__';
        if (!byParent[pid]) byParent[pid] = [];
        byParent[pid].push(f);
      });

      function renderLevel(parentId, indent) {
        const children = byParent[parentId] || [];
        children.forEach((folder) => {
          const item = document.createElement('div');
          item.className = 'tree-item' + (state.currentFolder === folder.id ? ' active' : '');
          item.dataset.folderId = folder.id;
          item.style.paddingLeft = (indent * 16 + 8) + 'px';

          const hasChildren = byParent[folder.id] && byParent[folder.id].length > 0;
          const expandIcon = hasChildren ? '<i class="fas fa-chevron-right tree-expand"></i>' : '<span class="tree-expand-spacer"></span>';

          item.innerHTML = expandIcon + '<i class="fas fa-folder"></i><span>' + escapeHtml(folder.name) + '</span>';

          const childContainer = document.createElement('div');
          childContainer.className = 'tree-children hidden';

          item.addEventListener('click', (e) => {
            if (e.target.closest('.tree-expand')) {
              childContainer.classList.toggle('hidden');
              const arrow = item.querySelector('.tree-expand');
              if (arrow) arrow.classList.toggle('fa-chevron-down');
              if (arrow) arrow.classList.toggle('fa-chevron-right');
              return;
            }
            switchView('files');
            navigateToFolder(folder.id);
            highlightTreeItem(folder.id);
          });

          tree.appendChild(item);
          tree.appendChild(childContainer);

          if (hasChildren) {
            // Render children inside childContainer
            const subItems = document.createDocumentFragment();
            renderSubLevel(folder.id, indent + 1, subItems, byParent);
            childContainer.appendChild(subItems);
          }
        });
      }

      function renderSubLevel(parentId, indent, container, map) {
        const children = map[parentId] || [];
        children.forEach((folder) => {
          const item = document.createElement('div');
          item.className = 'tree-item' + (state.currentFolder === folder.id ? ' active' : '');
          item.dataset.folderId = folder.id;
          item.style.paddingLeft = (indent * 16 + 8) + 'px';

          const hasChildren = map[folder.id] && map[folder.id].length > 0;
          const expandIcon = hasChildren ? '<i class="fas fa-chevron-right tree-expand"></i>' : '<span class="tree-expand-spacer"></span>';

          item.innerHTML = expandIcon + '<i class="fas fa-folder"></i><span>' + escapeHtml(folder.name) + '</span>';

          const childContainer = document.createElement('div');
          childContainer.className = 'tree-children hidden';

          item.addEventListener('click', (e) => {
            if (e.target.closest('.tree-expand')) {
              childContainer.classList.toggle('hidden');
              const arrow = item.querySelector('.tree-expand');
              if (arrow) arrow.classList.toggle('fa-chevron-down');
              if (arrow) arrow.classList.toggle('fa-chevron-right');
              return;
            }
            switchView('files');
            navigateToFolder(folder.id);
            highlightTreeItem(folder.id);
          });

          container.appendChild(item);
          if (hasChildren) {
            container.appendChild(childContainer);
            renderSubLevel(folder.id, indent + 1, childContainer, map);
          }
        });
      }

      renderLevel('__root__', 1);

    } catch (err) {
      // Silently fail — tree is non-critical
    }
  }

  function highlightTreeItem(folderId) {
    document.querySelectorAll('.tree-item').forEach((el) => {
      el.classList.toggle('active', folderId === null ? !el.dataset.folderId : el.dataset.folderId === folderId);
    });
  }

  // ===== Viewer Toolbar =====

  function initViewerControls() {
    $('viewer-back')?.addEventListener('click', () => {
      closeViewer();
      if (state.currentView === 'notes') loadNotes();
    });
    $('viewer-close')?.addEventListener('click', () => {
      closeViewer();
      if (state.currentView === 'notes') loadNotes();
    });

    $('viewer-bookmark')?.addEventListener('click', async () => {
      if (!state.currentFile || state.currentFile.__isNote) return;
      const label = await showPrompt('Bookmark Label', 'Bookmark');
      if (!label && label !== '') return;
      let page = 1;
      if (window.PDFViewerApp && window.PDFViewerApp.getCurrentPage) {
        page = window.PDFViewerApp.getCurrentPage();
      }
      try {
        await api.post('/api/bookmarks', {
          fileId: state.currentFile.id,
          page,
          label: label || 'Page ' + page,
        });
        showToast('Bookmark added', 'success');
      } catch (err) {
        showToast('Failed to add bookmark: ' + err.message, 'error');
      }
    });

    $('viewer-download')?.addEventListener('click', () => {
      if (state.currentFile && !state.currentFile.__isNote) {
        downloadFile(state.currentFile);
      }
    });

    $('viewer-fullscreen')?.addEventListener('click', () => {
      const panel = $('viewer-panel');
      if (!panel) return;
      if (!document.fullscreenElement) {
        panel.requestFullscreen?.().catch(() => {});
      } else {
        document.exitFullscreen?.();
      }
    });
  }

  // ===== Panic Mode & Calculator =====

  function initPanic() {
    $('panic-btn')?.addEventListener('click', () => showPanicScreen());
  }

  let panicEscCount = 0;
  let panicEscTimer = null;

  function initCalculator() {
    const screen = $('panic-screen');
    if (!screen) return;

    panicEscCount = 0;

    // Build calculator if not already there
    if (!screen.querySelector('.calculator')) {
      const calc = document.createElement('div');
      calc.className = 'calculator';
      calc.innerHTML =
        '<div class="calc-display"><input type="text" id="calc-display" value="0" readonly /></div>' +
        '<div class="calc-buttons">' +
        '<button class="calc-btn calc-fn" data-action="clear">C</button>' +
        '<button class="calc-btn calc-fn" data-action="sign">+/-</button>' +
        '<button class="calc-btn calc-fn" data-action="percent">%</button>' +
        '<button class="calc-btn calc-op" data-action="/">/</button>' +
        '<button class="calc-btn" data-action="7">7</button>' +
        '<button class="calc-btn" data-action="8">8</button>' +
        '<button class="calc-btn" data-action="9">9</button>' +
        '<button class="calc-btn calc-op" data-action="*">x</button>' +
        '<button class="calc-btn" data-action="4">4</button>' +
        '<button class="calc-btn" data-action="5">5</button>' +
        '<button class="calc-btn" data-action="6">6</button>' +
        '<button class="calc-btn calc-op" data-action="-">-</button>' +
        '<button class="calc-btn" data-action="1">1</button>' +
        '<button class="calc-btn" data-action="2">2</button>' +
        '<button class="calc-btn" data-action="3">3</button>' +
        '<button class="calc-btn calc-op" data-action="+">+</button>' +
        '<button class="calc-btn calc-zero" data-action="0">0</button>' +
        '<button class="calc-btn" data-action=".">.</button>' +
        '<button class="calc-btn calc-eq" data-action="=">=</button>' +
        '</div>';
      screen.innerHTML = '';
      screen.appendChild(calc);
    }

    // Calculator state
    let current = '0';
    let previous = '';
    let operator = '';
    let resetNext = false;

    const display = screen.querySelector('#calc-display');

    function updateDisplay() {
      if (display) display.value = current;
    }

    function calculate(a, b, op) {
      a = parseFloat(a);
      b = parseFloat(b);
      switch (op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return b !== 0 ? a / b : 'Error';
        default: return b;
      }
    }

    // Remove old listeners by replacing the buttons container
    const oldBtns = screen.querySelector('.calc-buttons');
    const newBtns = oldBtns.cloneNode(true);
    oldBtns.parentNode.replaceChild(newBtns, oldBtns);

    newBtns.addEventListener('click', (e) => {
      const btn = e.target.closest('.calc-btn');
      if (!btn) return;
      e.stopPropagation();
      const action = btn.dataset.action;

      if (action >= '0' && action <= '9') {
        if (current === '0' || resetNext) {
          current = action;
          resetNext = false;
        } else {
          current += action;
        }
      } else if (action === '.') {
        if (resetNext) { current = '0'; resetNext = false; }
        if (!current.includes('.')) current += '.';
      } else if (action === 'clear') {
        current = '0';
        previous = '';
        operator = '';
        resetNext = false;
      } else if (action === 'sign') {
        current = String(-parseFloat(current));
      } else if (action === 'percent') {
        current = String(parseFloat(current) / 100);
      } else if (['+', '-', '*', '/'].includes(action)) {
        if (previous && operator && !resetNext) {
          current = String(calculate(previous, current, operator));
        }
        previous = current;
        operator = action;
        resetNext = true;
      } else if (action === '=') {
        if (previous && operator) {
          current = String(calculate(previous, current, operator));
          previous = '';
          operator = '';
          resetNext = true;
        }
      }
      updateDisplay();
    });

    // Clicking outside calculator goes back to login
    screen.addEventListener('click', (e) => {
      if (!e.target.closest('.calculator')) {
        showLoginScreen();
      }
    });
  }

  // ===== Keyboard Shortcuts =====

  function initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Panic screen escape handling
      if ($('panic-screen')?.classList.contains('active')) {
        if (e.key === 'Escape') {
          panicEscCount++;
          clearTimeout(panicEscTimer);
          panicEscTimer = setTimeout(() => { panicEscCount = 0; }, 1000);
          if (panicEscCount >= 3) {
            panicEscCount = 0;
            showLoginScreen();
          }
        }
        return;
      }

      // Double-escape panic (from app screen)
      if (e.key === 'Escape' && $('app-screen')?.classList.contains('active')) {
        state.escPressCount++;
        clearTimeout(state.escPressTimer);
        state.escPressTimer = setTimeout(() => { state.escPressCount = 0; }, 500);

        if (state.escPressCount >= 2) {
          state.escPressCount = 0;
          showPanicScreen();
          return;
        }

        // Single escape: close viewer or context menu
        setTimeout(() => {
          if (state.escPressCount === 1) {
            state.escPressCount = 0;
            hideContextMenu();
            const dd = document.getElementById('search-dropdown');
            if (dd) dd.classList.add('hidden');
            if ($('viewer-panel')?.classList.contains('active')) {
              closeViewer();
              if (state.currentView === 'notes') loadNotes();
            }
          }
        }, 500);
        return;
      }

      // Only handle shortcuts on app screen
      if (!$('app-screen')?.classList.contains('active')) return;

      // Ctrl+U: upload
      if (e.ctrlKey && e.key === 'u') {
        e.preventDefault();
        $('file-input')?.click();
      }

      // Ctrl+K: focus search
      if (e.ctrlKey && e.key === 'k') {
        e.preventDefault();
        $('search-input')?.focus();
      }

      // Ctrl+N: new note
      if (e.ctrlKey && e.key === 'n') {
        e.preventDefault();
        createNewNote();
      }

      // Delete: delete selected items
      if (e.key === 'Delete' && state.selectedItems.size > 0 && !e.target.matches('input, textarea, [contenteditable]')) {
        e.preventDefault();
        deleteSelectedItems();
      }
    });
  }

  async function deleteSelectedItems() {
    const items = Array.from(state.selectedItems);
    if (items.length === 0) return;
    const confirmed = await showConfirm('Delete ' + items.length + ' selected item(s)?');
    if (!confirmed) return;

    for (const key of items) {
      const [type, id] = key.split(':');
      try {
        if (type === 'folder') {
          await api.del('/api/folders/' + id);
        } else {
          await api.del('/api/files/' + id);
        }
      } catch (err) {
        showToast('Failed to delete item: ' + err.message, 'error');
      }
    }
    state.selectedItems.clear();
    showToast('Items deleted', 'success');
    loadCurrentFolder();
    loadFolderTree();
  }

  // ===== Activity Listeners (auto-lock reset) =====

  function initActivityListeners() {
    ['click', 'keypress', 'mousemove', 'touchstart'].forEach((evt) => {
      document.addEventListener(evt, () => {
        if ($('app-screen')?.classList.contains('active')) {
          resetAutoLockTimer();
        }
      }, { passive: true });
    });
  }

  // ===== Global Click Handlers =====

  function initGlobalClickHandlers() {
    // Hide context menu on click outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#context-menu')) {
        hideContextMenu();
      }
    });

    // New folder button
    $('new-folder-btn')?.addEventListener('click', createNewFolder);

    // New note buttons
    $('new-note-btn')?.addEventListener('click', createNewNote);
    $('new-note-btn-2')?.addEventListener('click', createNewNote);

    // Lock button
    $('lock-btn')?.addEventListener('click', lock);

    // Empty trash button
    $('empty-trash-btn')?.addEventListener('click', emptyTrash);
  }

  // ===== Initialization =====

  async function init() {
    // Check auth status
    try {
      const data = await api.get('/api/auth/status');
      if (data.authenticated) {
        showAppScreen();
        loadCurrentFolder();
        loadFolderTree();
      } else {
        showLoginScreen();
      }
    } catch (e) {
      showLoginScreen();
    }

    // Set up all subsystems
    initLogin();
    initNavigation();
    initViewModeToggle();
    initUpload();
    initSearch();
    initViewerControls();
    initPanic();
    initKeyboardShortcuts();
    initActivityListeners();
    initGlobalClickHandlers();
    initBrowser();
  }

  // ===== Expose globals for PDF viewer =====
  window.VaultAPI = api;
  window.showToast = showToast;
  window.showModal = showModal;

  // Start the app when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
