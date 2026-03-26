/**
 * PDF Viewer Application
 * Full-featured PDF viewer for the encrypted document vault.
 * Uses PDF.js 4.x (ESM) for rendering.
 */
const PDFViewerApp = (() => {
  // ── State ──────────────────────────────────────────────────────────
  let pdfDoc = null;
  let currentPage = 1;
  let totalPages = 0;
  let currentScale = 1.0;
  let rotation = 0;
  let darkMode = false;
  let highlightMode = false;
  let fileId = null;
  let fileName = null;
  let container = null;

  let pageCanvases = new Map();
  let pageTextLayers = new Map();
  let renderTasks = new Map();
  let thumbnailCanvases = new Map();
  let thumbnailRenderTasks = new Map();
  let pageTextContents = new Map();
  let pageDimensions = new Map();

  let bookmarks = [];
  let annotations = [];
  let searchResults = [];
  let currentSearchIndex = -1;
  let searchQuery = '';

  let observer = null;
  let thumbnailObserver = null;
  let progressSaveTimer = null;
  let searchDebounceTimer = null;
  let sidebarVisible = true;
  let pdfjsLib = null;

  const ZOOM_LEVELS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0];
  const THUMBNAIL_WIDTH = 150;
  const RENDER_BUFFER = 3; // pages above/below viewport to pre-render
  const PROGRESS_SAVE_DELAY = 2000;
  const SEARCH_DEBOUNCE = 300;
  const HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'pink', 'red'];
  const HIGHLIGHT_COLOR_MAP = {
    yellow: 'rgba(255, 235, 59, 0.35)',
    green: 'rgba(76, 175, 80, 0.35)',
    blue: 'rgba(33, 150, 243, 0.35)',
    pink: 'rgba(233, 30, 99, 0.35)',
    red: 'rgba(244, 67, 54, 0.35)',
  };

  let selectedHighlightColor = 'yellow';
  let isSelecting = false;
  let selectionStartPage = null;

  // ── Public API ─────────────────────────────────────────────────────

  async function open(fId, fName) {
    fileId = fId;
    fileName = fName;
    container = document.getElementById('viewer-body');
    if (!container) {
      window.showToast('Viewer container not found', 'error');
      return;
    }

    buildUI();
    setupEvents();

    try {
      await loadPdfJs();
      await loadDocument();
      createPageContainers();
      setupIntersectionObserver();
      setupThumbnailObserver();

      await Promise.all([
        loadBookmarks(),
        loadAnnotations(),
        loadProgress(),
      ]);
    } catch (err) {
      console.error('Failed to open PDF:', err);
      window.showToast('Failed to open PDF: ' + err.message, 'error');
    }
  }

  function close() {
    saveProgressImmediate();

    clearTimeout(progressSaveTimer);
    clearTimeout(searchDebounceTimer);

    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (thumbnailObserver) {
      thumbnailObserver.disconnect();
      thumbnailObserver = null;
    }

    for (const [, task] of renderTasks) {
      if (task && typeof task.cancel === 'function') {
        task.cancel();
      }
    }
    renderTasks.clear();

    for (const [, task] of thumbnailRenderTasks) {
      if (task && typeof task.cancel === 'function') {
        task.cancel();
      }
    }
    thumbnailRenderTasks.clear();

    pageCanvases.clear();
    pageTextLayers.clear();
    thumbnailCanvases.clear();
    pageTextContents.clear();
    pageDimensions.clear();

    if (pdfDoc) {
      pdfDoc.destroy();
      pdfDoc = null;
    }

    if (container) {
      container.innerHTML = '';
    }

    document.removeEventListener('keydown', handleKeyDown);

    currentPage = 1;
    totalPages = 0;
    currentScale = 1.0;
    rotation = 0;
    darkMode = false;
    highlightMode = false;
    fileId = null;
    fileName = null;
    container = null;
    bookmarks = [];
    annotations = [];
    searchResults = [];
    currentSearchIndex = -1;
    searchQuery = '';
    sidebarVisible = true;
    isSelecting = false;
    selectionStartPage = null;
    selectedHighlightColor = 'yellow';
  }

  // ── PDF.js Loading ─────────────────────────────────────────────────

  async function loadPdfJs() {
    if (pdfjsLib) return;
    pdfjsLib = await import(
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs'
    );
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';
  }

  async function loadDocument() {
    const url = `/api/files/${fileId}/view`;
    const loadingTask = pdfjsLib.getDocument({ url, withCredentials: false });
    pdfDoc = await loadingTask.promise;
    totalPages = pdfDoc.numPages;

    const totalSpan = container.querySelector('.pdf-page-total');
    if (totalSpan) totalSpan.textContent = totalPages;
  }

  // ── UI Construction ────────────────────────────────────────────────

  function buildUI() {
    injectStyles();

    container.innerHTML = `
      <div class="pdf-container">
        <div class="pdf-toolbar">
          <div class="pdf-toolbar-left">
            <button class="pdf-btn" title="Toggle sidebar" data-action="toggle-sidebar"><i class="fas fa-columns"></i></button>
            <span class="pdf-separator"></span>
            <button class="pdf-btn" title="Previous page" data-action="prev-page"><i class="fas fa-chevron-up"></i></button>
            <input type="text" class="pdf-page-input" value="1"> / <span class="pdf-page-total">0</span>
            <button class="pdf-btn" title="Next page" data-action="next-page"><i class="fas fa-chevron-down"></i></button>
          </div>
          <div class="pdf-toolbar-center">
            <button class="pdf-btn" title="Zoom out" data-action="zoom-out"><i class="fas fa-minus"></i></button>
            <span class="pdf-zoom-level">100%</span>
            <button class="pdf-btn" title="Zoom in" data-action="zoom-in"><i class="fas fa-plus"></i></button>
            <button class="pdf-btn" title="Fit width" data-action="fit-width"><i class="fas fa-arrows-alt-h"></i></button>
            <button class="pdf-btn" title="Fit page" data-action="fit-page"><i class="fas fa-expand"></i></button>
            <span class="pdf-separator"></span>
            <button class="pdf-btn" title="Rotate clockwise" data-action="rotate"><i class="fas fa-redo"></i></button>
          </div>
          <div class="pdf-toolbar-right">
            <button class="pdf-btn pdf-search-toggle" title="Search" data-action="toggle-search"><i class="fas fa-search"></i></button>
            <button class="pdf-btn pdf-dark-toggle" title="Dark mode" data-action="toggle-dark"><i class="fas fa-moon"></i></button>
            <button class="pdf-btn pdf-bookmark-btn" title="Bookmark this page" data-action="bookmark"><i class="far fa-bookmark"></i></button>
            <button class="pdf-btn pdf-highlight-toggle" title="Highlight mode" data-action="toggle-highlight"><i class="fas fa-highlighter"></i></button>
          </div>
        </div>

        <div class="pdf-search-bar hidden">
          <input type="text" class="pdf-search-input" placeholder="Search in document...">
          <span class="pdf-search-count">0 / 0</span>
          <button class="pdf-btn" title="Previous match" data-action="search-prev"><i class="fas fa-chevron-up"></i></button>
          <button class="pdf-btn" title="Next match" data-action="search-next"><i class="fas fa-chevron-down"></i></button>
          <button class="pdf-btn" title="Close search" data-action="search-close"><i class="fas fa-times"></i></button>
        </div>

        <div class="pdf-body">
          <div class="pdf-sidebar">
            <div class="pdf-sidebar-tabs">
              <button class="pdf-sidebar-tab active" data-tab="thumbnails"><i class="fas fa-th-list"></i></button>
              <button class="pdf-sidebar-tab" data-tab="bookmarks"><i class="fas fa-bookmark"></i></button>
              <button class="pdf-sidebar-tab" data-tab="annotations"><i class="fas fa-sticky-note"></i></button>
            </div>
            <div class="pdf-sidebar-content">
              <div class="pdf-thumbnails-panel pdf-sidebar-panel active"></div>
              <div class="pdf-bookmarks-panel pdf-sidebar-panel"></div>
              <div class="pdf-annotations-panel pdf-sidebar-panel"></div>
            </div>
          </div>

          <div class="pdf-main">
            <div class="pdf-pages"></div>
          </div>
        </div>
      </div>
    `;
  }

  function injectStyles() {
    if (document.getElementById('pdf-viewer-dynamic-styles')) return;

    const style = document.createElement('style');
    style.id = 'pdf-viewer-dynamic-styles';
    style.textContent = `
      /* Page containers */
      .pdf-page-container {
        position: relative;
        margin: 10px auto;
        background: #fff;
        box-shadow: 0 2px 8px rgba(0,0,0,0.15);
        overflow: hidden;
      }
      .pdf-page-container canvas {
        display: block;
      }
      .pdf-page-container.dark-mode canvas {
        filter: invert(0.85) hue-rotate(180deg);
      }

      /* Text layer */
      .pdf-text-layer {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        overflow: hidden;
        opacity: 0.25;
        line-height: 1.0;
        pointer-events: all;
      }
      .pdf-text-layer span {
        color: transparent;
        position: absolute;
        white-space: pre;
        transform-origin: 0% 0%;
        pointer-events: all;
      }
      .pdf-text-layer span::selection {
        background: rgba(0, 100, 200, 0.35);
      }
      .pdf-text-layer .highlight {
        background-color: rgba(180, 0, 170, 0.2);
      }

      /* Annotation layer (highlight overlays) */
      .pdf-annotation-layer {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        pointer-events: none;
      }
      .pdf-highlight-overlay {
        position: absolute;
        pointer-events: auto;
        cursor: pointer;
        mix-blend-mode: multiply;
        border-radius: 2px;
        transition: opacity 0.15s;
      }
      .pdf-highlight-overlay:hover {
        opacity: 0.7;
        outline: 2px solid rgba(0,0,0,0.3);
      }

      /* Search highlights */
      .pdf-search-highlight {
        position: absolute;
        background: rgba(255, 200, 0, 0.45);
        mix-blend-mode: multiply;
        border-radius: 1px;
        pointer-events: none;
      }
      .pdf-search-highlight.current {
        background: rgba(255, 120, 0, 0.6);
        outline: 2px solid #f57c00;
      }

      /* Thumbnails */
      .pdf-thumbnail-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 8px 4px;
        cursor: pointer;
        border-radius: 4px;
        transition: background 0.15s;
      }
      .pdf-thumbnail-container:hover {
        background: rgba(0,0,0,0.06);
      }
      .pdf-thumbnail-container.active {
        background: rgba(33, 150, 243, 0.12);
      }
      .pdf-thumbnail-container.active .pdf-thumbnail-canvas-wrap {
        outline: 2px solid #2196f3;
      }
      .pdf-thumbnail-canvas-wrap {
        background: #fff;
        box-shadow: 0 1px 4px rgba(0,0,0,0.15);
        border-radius: 2px;
        overflow: hidden;
      }
      .pdf-thumbnail-canvas-wrap canvas {
        display: block;
      }
      .pdf-thumbnail-label {
        font-size: 11px;
        color: #666;
        margin-top: 4px;
      }

      /* Bookmarks list */
      .pdf-bookmark-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        cursor: pointer;
        border-bottom: 1px solid rgba(0,0,0,0.06);
        transition: background 0.15s;
      }
      .pdf-bookmark-item:hover {
        background: rgba(0,0,0,0.04);
      }
      .pdf-bookmark-item .bookmark-label {
        flex: 1;
        font-size: 13px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pdf-bookmark-item .bookmark-page {
        font-size: 11px;
        color: #888;
        margin-left: 8px;
        flex-shrink: 0;
      }
      .pdf-bookmark-item .bookmark-delete {
        opacity: 0;
        margin-left: 6px;
        cursor: pointer;
        color: #d32f2f;
        font-size: 12px;
        flex-shrink: 0;
        transition: opacity 0.15s;
      }
      .pdf-bookmark-item:hover .bookmark-delete {
        opacity: 1;
      }

      /* Annotations list */
      .pdf-annotation-item {
        display: flex;
        align-items: flex-start;
        padding: 8px 12px;
        cursor: pointer;
        border-bottom: 1px solid rgba(0,0,0,0.06);
        transition: background 0.15s;
      }
      .pdf-annotation-item:hover {
        background: rgba(0,0,0,0.04);
      }
      .pdf-annotation-color-dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        margin-right: 8px;
        margin-top: 2px;
        flex-shrink: 0;
      }
      .pdf-annotation-item .annotation-text {
        flex: 1;
        font-size: 12px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pdf-annotation-item .annotation-page {
        font-size: 11px;
        color: #888;
        margin-left: 8px;
        flex-shrink: 0;
      }
      .pdf-annotation-item .annotation-delete {
        opacity: 0;
        margin-left: 6px;
        cursor: pointer;
        color: #d32f2f;
        font-size: 12px;
        flex-shrink: 0;
        transition: opacity 0.15s;
      }
      .pdf-annotation-item:hover .annotation-delete {
        opacity: 1;
      }

      /* Sidebar empty state */
      .pdf-sidebar-empty {
        text-align: center;
        color: #999;
        padding: 24px 12px;
        font-size: 13px;
      }

      /* Highlight mode indicator */
      .pdf-highlight-toggle.active {
        background: rgba(255, 235, 59, 0.3);
        border-color: #fbc02d;
      }

      /* Highlight color picker */
      .pdf-highlight-color-picker {
        display: none;
        position: absolute;
        top: 100%;
        right: 0;
        background: #fff;
        border: 1px solid #ddd;
        border-radius: 6px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        padding: 6px;
        gap: 4px;
        z-index: 100;
        flex-direction: row;
      }
      .pdf-highlight-color-picker.visible {
        display: flex;
      }
      .pdf-highlight-color-swatch {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        cursor: pointer;
        border: 2px solid transparent;
        transition: border-color 0.15s, transform 0.1s;
      }
      .pdf-highlight-color-swatch:hover {
        transform: scale(1.15);
      }
      .pdf-highlight-color-swatch.active {
        border-color: #333;
      }

      /* Loading spinner for pages */
      .pdf-page-loading {
        display: flex;
        align-items: center;
        justify-content: center;
        color: #aaa;
        font-size: 14px;
        position: absolute;
        inset: 0;
      }

      /* Highlight selection cursor */
      .pdf-main.highlight-mode {
        cursor: crosshair;
      }
      .pdf-main.highlight-mode .pdf-text-layer {
        cursor: crosshair;
      }

      /* Print styles */
      @media print {
        .pdf-toolbar,
        .pdf-search-bar,
        .pdf-sidebar {
          display: none !important;
        }
        .pdf-main {
          margin: 0 !important;
          width: 100% !important;
        }
        .pdf-page-container {
          box-shadow: none !important;
          margin: 0 !important;
          page-break-after: always;
        }
      }
    `;
    document.head.appendChild(style);
  }

  // ── Event Setup ────────────────────────────────────────────────────

  function setupEvents() {
    const pdfContainer = container.querySelector('.pdf-container');
    if (!pdfContainer) return;

    // Toolbar button delegation
    pdfContainer.addEventListener('click', handleToolbarClick);

    // Page input
    const pageInput = container.querySelector('.pdf-page-input');
    if (pageInput) {
      pageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const page = parseInt(pageInput.value, 10);
          if (page >= 1 && page <= totalPages) {
            scrollToPage(page);
          } else {
            pageInput.value = currentPage;
            window.showToast(`Page must be between 1 and ${totalPages}`, 'info');
          }
        }
      });
    }

    // Search input
    const searchInput = container.querySelector('.pdf-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
          search(searchInput.value.trim());
        }, SEARCH_DEBOUNCE);
      });
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (e.shiftKey) {
            navigateSearch(-1);
          } else {
            navigateSearch(1);
          }
        }
        if (e.key === 'Escape') {
          toggleSearch(false);
        }
      });
    }

    // Sidebar tabs
    const sidebarTabs = container.querySelectorAll('.pdf-sidebar-tab');
    sidebarTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const tabName = tab.getAttribute('data-tab');
        switchSidebarTab(tabName);
      });
    });

    // Scroll tracking on main area
    const pdfMain = container.querySelector('.pdf-main');
    if (pdfMain) {
      // Ctrl+Scroll zoom
      pdfMain.addEventListener(
        'wheel',
        (e) => {
          if (e.ctrlKey) {
            e.preventDefault();
            if (e.deltaY < 0) {
              zoomIn();
            } else {
              zoomOut();
            }
          }
        },
        { passive: false }
      );

      // Highlight mode: mouseup to capture selection
      pdfMain.addEventListener('mouseup', handleHighlightMouseUp);
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', handleKeyDown);
  }

  function handleToolbarClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const action = btn.getAttribute('data-action');
    switch (action) {
      case 'toggle-sidebar':
        toggleSidebar();
        break;
      case 'prev-page':
        scrollToPage(Math.max(1, currentPage - 1));
        break;
      case 'next-page':
        scrollToPage(Math.min(totalPages, currentPage + 1));
        break;
      case 'zoom-out':
        zoomOut();
        break;
      case 'zoom-in':
        zoomIn();
        break;
      case 'fit-width':
        fitWidth();
        break;
      case 'fit-page':
        fitPage();
        break;
      case 'rotate':
        rotate();
        break;
      case 'toggle-search':
        toggleSearch();
        break;
      case 'toggle-dark':
        toggleDarkMode();
        break;
      case 'bookmark':
        addBookmark();
        break;
      case 'toggle-highlight':
        toggleHighlightMode();
        break;
      case 'search-prev':
        navigateSearch(-1);
        break;
      case 'search-next':
        navigateSearch(1);
        break;
      case 'search-close':
        toggleSearch(false);
        break;
    }
  }

  function handleKeyDown(e) {
    // Only handle when viewer is open
    if (!container || !pdfDoc) return;

    if (e.ctrlKey && e.key === 'f') {
      e.preventDefault();
      toggleSearch(true);
      return;
    }
    if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      zoomIn();
      return;
    }
    if (e.ctrlKey && e.key === '-') {
      e.preventDefault();
      zoomOut();
      return;
    }
    if (e.ctrlKey && e.key === '0') {
      e.preventDefault();
      setZoom(1.0);
      return;
    }
    if (e.key === 'Escape') {
      const searchBar = container.querySelector('.pdf-search-bar');
      if (searchBar && !searchBar.classList.contains('hidden')) {
        toggleSearch(false);
        return;
      }
    }
    if (e.key === 'PageDown') {
      e.preventDefault();
      scrollToPage(Math.min(totalPages, currentPage + 1));
      return;
    }
    if (e.key === 'PageUp') {
      e.preventDefault();
      scrollToPage(Math.max(1, currentPage - 1));
      return;
    }
    if (e.key === 'Home' && !e.ctrlKey) {
      e.preventDefault();
      scrollToPage(1);
      return;
    }
    if (e.key === 'End' && !e.ctrlKey) {
      e.preventDefault();
      scrollToPage(totalPages);
      return;
    }
  }

  // ── Page Containers & Rendering ────────────────────────────────────

  function createPageContainers() {
    const pagesDiv = container.querySelector('.pdf-pages');
    if (!pagesDiv) return;
    pagesDiv.innerHTML = '';

    const thumbnailsPanel = container.querySelector('.pdf-thumbnails-panel');
    if (thumbnailsPanel) thumbnailsPanel.innerHTML = '';

    for (let i = 1; i <= totalPages; i++) {
      // Main page container (placeholder)
      const pageDiv = document.createElement('div');
      pageDiv.className = 'pdf-page-container';
      pageDiv.setAttribute('data-page', i);
      // Set a placeholder size — will be updated on render
      pageDiv.style.width = '612px';
      pageDiv.style.height = '792px';

      const loadingIndicator = document.createElement('div');
      loadingIndicator.className = 'pdf-page-loading';
      loadingIndicator.textContent = `Page ${i}`;
      pageDiv.appendChild(loadingIndicator);

      const canvas = document.createElement('canvas');
      canvas.style.display = 'none';
      pageDiv.appendChild(canvas);

      const textLayerDiv = document.createElement('div');
      textLayerDiv.className = 'pdf-text-layer';
      pageDiv.appendChild(textLayerDiv);

      const annotationLayerDiv = document.createElement('div');
      annotationLayerDiv.className = 'pdf-annotation-layer';
      pageDiv.appendChild(annotationLayerDiv);

      pagesDiv.appendChild(pageDiv);

      // Thumbnail container
      if (thumbnailsPanel) {
        const thumbContainer = document.createElement('div');
        thumbContainer.className = 'pdf-thumbnail-container';
        thumbContainer.setAttribute('data-page', i);

        const thumbWrap = document.createElement('div');
        thumbWrap.className = 'pdf-thumbnail-canvas-wrap';
        const thumbCanvas = document.createElement('canvas');
        thumbCanvas.width = THUMBNAIL_WIDTH;
        thumbCanvas.height = Math.round(THUMBNAIL_WIDTH * 1.294); // approximate A4 ratio
        thumbWrap.appendChild(thumbCanvas);

        const thumbLabel = document.createElement('div');
        thumbLabel.className = 'pdf-thumbnail-label';
        thumbLabel.textContent = i;

        thumbContainer.appendChild(thumbWrap);
        thumbContainer.appendChild(thumbLabel);

        thumbContainer.addEventListener('click', () => scrollToPage(i));
        thumbnailsPanel.appendChild(thumbContainer);
      }
    }

    // Pre-calculate page dimensions so containers have correct sizes before rendering
    preCalculatePageSizes();
  }

  async function preCalculatePageSizes() {
    // Calculate sizes for first few pages to set container dimensions
    // Then let intersection observer handle the rest
    const limit = Math.min(totalPages, 20);
    for (let i = 1; i <= limit; i++) {
      try {
        const page = await pdfDoc.getPage(i);
        const viewport = page.getViewport({ scale: currentScale, rotation });
        pageDimensions.set(i, {
          width: viewport.width,
          height: viewport.height,
        });
        updatePageContainerSize(i, viewport.width, viewport.height);
      } catch (err) {
        console.warn(`Failed to get size for page ${i}:`, err);
      }
    }
  }

  function updatePageContainerSize(pageNum, width, height) {
    const pageDiv = container.querySelector(
      `.pdf-page-container[data-page="${pageNum}"]`
    );
    if (pageDiv) {
      pageDiv.style.width = `${Math.floor(width)}px`;
      pageDiv.style.height = `${Math.floor(height)}px`;
    }
  }

  function setupIntersectionObserver() {
    const pdfMain = container.querySelector('.pdf-main');
    if (!pdfMain) return;

    if (observer) observer.disconnect();

    observer = new IntersectionObserver(
      (entries) => {
        let mostVisiblePage = currentPage;
        let maxRatio = 0;

        entries.forEach((entry) => {
          const pageNum = parseInt(entry.target.getAttribute('data-page'), 10);

          if (entry.isIntersecting) {
            // Render this page and nearby pages
            scheduleRenderNearby(pageNum);
          }

          if (entry.intersectionRatio > maxRatio) {
            maxRatio = entry.intersectionRatio;
            mostVisiblePage = pageNum;
          }
        });

        if (maxRatio > 0 && mostVisiblePage !== currentPage) {
          updateCurrentPage(mostVisiblePage);
        }
      },
      {
        root: pdfMain,
        rootMargin: '200px 0px',
        threshold: [0, 0.1, 0.25, 0.5, 0.75, 1.0],
      }
    );

    const pageContainers = container.querySelectorAll('.pdf-page-container');
    pageContainers.forEach((el) => observer.observe(el));

    // Render the first page immediately
    scheduleRenderNearby(1);
  }

  function setupThumbnailObserver() {
    const sidebarContent = container.querySelector('.pdf-sidebar-content');
    if (!sidebarContent) return;

    if (thumbnailObserver) thumbnailObserver.disconnect();

    thumbnailObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const pageNum = parseInt(
              entry.target.getAttribute('data-page'),
              10
            );
            if (!thumbnailCanvases.has(pageNum)) {
              renderThumbnail(pageNum);
            }
          }
        });
      },
      {
        root: sidebarContent,
        rootMargin: '100px 0px',
        threshold: 0,
      }
    );

    const thumbContainers = container.querySelectorAll(
      '.pdf-thumbnail-container'
    );
    thumbContainers.forEach((el) => thumbnailObserver.observe(el));
  }

  function scheduleRenderNearby(pageNum) {
    const start = Math.max(1, pageNum - RENDER_BUFFER);
    const end = Math.min(totalPages, pageNum + RENDER_BUFFER);
    for (let i = start; i <= end; i++) {
      if (!pageCanvases.has(i)) {
        renderPage(i);
      }
    }
  }

  async function renderPage(pageNum) {
    if (pageCanvases.has(pageNum)) return;
    // Mark as being rendered to prevent duplicate calls
    pageCanvases.set(pageNum, true);

    const pageDiv = container.querySelector(
      `.pdf-page-container[data-page="${pageNum}"]`
    );
    if (!pageDiv) {
      pageCanvases.delete(pageNum);
      return;
    }

    try {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: currentScale, rotation });

      pageDimensions.set(pageNum, {
        width: viewport.width,
        height: viewport.height,
      });

      // Update container size
      pageDiv.style.width = `${Math.floor(viewport.width)}px`;
      pageDiv.style.height = `${Math.floor(viewport.height)}px`;

      // Canvas
      const canvas = pageDiv.querySelector('canvas');
      const ctx = canvas.getContext('2d');
      const outputScale = window.devicePixelRatio || 1;

      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      ctx.setTransform(outputScale, 0, 0, outputScale, 0, 0);

      // Cancel existing render task
      if (renderTasks.has(pageNum)) {
        const old = renderTasks.get(pageNum);
        if (old && typeof old.cancel === 'function') {
          old.cancel();
        }
      }

      const renderTask = page.render({ canvasContext: ctx, viewport });
      renderTasks.set(pageNum, renderTask);

      await renderTask.promise;
      renderTasks.delete(pageNum);

      // Hide loading, show canvas
      const loading = pageDiv.querySelector('.pdf-page-loading');
      if (loading) loading.style.display = 'none';
      canvas.style.display = 'block';

      // Dark mode
      if (darkMode) {
        pageDiv.classList.add('dark-mode');
      }

      // Text layer
      await renderTextLayer(page, pageNum, viewport);

      // Annotations overlay
      renderAnnotationsOnPage(pageNum);

      // Search highlights
      if (searchResults.length > 0) {
        renderSearchHighlightsOnPage(pageNum);
      }
    } catch (err) {
      if (err.name !== 'RenderingCancelledException') {
        console.error(`Error rendering page ${pageNum}:`, err);
        pageCanvases.delete(pageNum);
      }
    }
  }

  async function renderTextLayer(page, pageNum, viewport) {
    const pageDiv = container.querySelector(
      `.pdf-page-container[data-page="${pageNum}"]`
    );
    if (!pageDiv) return;

    const textLayerDiv = pageDiv.querySelector('.pdf-text-layer');
    textLayerDiv.innerHTML = '';
    textLayerDiv.style.width = `${Math.floor(viewport.width)}px`;
    textLayerDiv.style.height = `${Math.floor(viewport.height)}px`;

    try {
      const textContent = await page.getTextContent();
      pageTextContents.set(pageNum, textContent);

      const textLayer = new pdfjsLib.TextLayer({
        textContentSource: textContent,
        container: textLayerDiv,
        viewport: viewport,
      });

      await textLayer.render();
      pageTextLayers.set(pageNum, textLayer);
    } catch (err) {
      console.warn(`Text layer error on page ${pageNum}:`, err);
    }
  }

  async function renderThumbnail(pageNum) {
    if (thumbnailCanvases.has(pageNum)) return;
    thumbnailCanvases.set(pageNum, true);

    const thumbContainer = container.querySelector(
      `.pdf-thumbnail-container[data-page="${pageNum}"]`
    );
    if (!thumbContainer) {
      thumbnailCanvases.delete(pageNum);
      return;
    }

    try {
      const page = await pdfDoc.getPage(pageNum);
      const defaultViewport = page.getViewport({ scale: 1.0, rotation });
      const thumbScale = THUMBNAIL_WIDTH / defaultViewport.width;
      const viewport = page.getViewport({ scale: thumbScale, rotation });

      const canvas = thumbContainer.querySelector('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);

      // Cancel existing thumbnail render
      if (thumbnailRenderTasks.has(pageNum)) {
        const old = thumbnailRenderTasks.get(pageNum);
        if (old && typeof old.cancel === 'function') old.cancel();
      }

      const renderTask = page.render({ canvasContext: ctx, viewport });
      thumbnailRenderTasks.set(pageNum, renderTask);
      await renderTask.promise;
      thumbnailRenderTasks.delete(pageNum);
    } catch (err) {
      if (err.name !== 'RenderingCancelledException') {
        console.warn(`Thumbnail error page ${pageNum}:`, err);
        thumbnailCanvases.delete(pageNum);
      }
    }
  }

  async function reRenderAllVisiblePages() {
    // Clear all rendered page state
    for (const [, task] of renderTasks) {
      if (task && typeof task.cancel === 'function') task.cancel();
    }
    renderTasks.clear();
    pageCanvases.clear();
    pageTextLayers.clear();
    pageTextContents.clear();
    pageDimensions.clear();

    // Reset page containers
    const pageContainers = container.querySelectorAll('.pdf-page-container');
    pageContainers.forEach((el) => {
      const canvas = el.querySelector('canvas');
      if (canvas) canvas.style.display = 'none';
      const loading = el.querySelector('.pdf-page-loading');
      if (loading) loading.style.display = 'flex';
      const textLayer = el.querySelector('.pdf-text-layer');
      if (textLayer) textLayer.innerHTML = '';
      const annotLayer = el.querySelector('.pdf-annotation-layer');
      if (annotLayer) annotLayer.innerHTML = '';
    });

    // Re-calculate sizes and re-render visible pages
    await preCalculatePageSizes();

    // Re-render thumbnails
    for (const [, task] of thumbnailRenderTasks) {
      if (task && typeof task.cancel === 'function') task.cancel();
    }
    thumbnailRenderTasks.clear();
    thumbnailCanvases.clear();

    // Trigger intersection observer recalculation
    if (observer) {
      observer.disconnect();
      setupIntersectionObserver();
    }
    if (thumbnailObserver) {
      thumbnailObserver.disconnect();
      setupThumbnailObserver();
    }
  }

  // ── Page Navigation ────────────────────────────────────────────────

  function updateCurrentPage(pageNum) {
    if (pageNum === currentPage) return;
    currentPage = pageNum;

    const pageInput = container.querySelector('.pdf-page-input');
    if (pageInput) pageInput.value = currentPage;

    // Update thumbnail highlight
    const thumbs = container.querySelectorAll('.pdf-thumbnail-container');
    thumbs.forEach((el) => {
      const p = parseInt(el.getAttribute('data-page'), 10);
      el.classList.toggle('active', p === currentPage);
    });

    // Scroll thumbnail into view
    const activeThumb = container.querySelector(
      `.pdf-thumbnail-container[data-page="${currentPage}"]`
    );
    if (activeThumb) {
      activeThumb.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    // Update bookmark icon
    updateBookmarkIcon();

    // Schedule progress save
    scheduleProgressSave();
  }

  function scrollToPage(pageNum) {
    if (pageNum < 1 || pageNum > totalPages) return;

    const pageDiv = container.querySelector(
      `.pdf-page-container[data-page="${pageNum}"]`
    );
    const pdfMain = container.querySelector('.pdf-main');
    if (!pageDiv || !pdfMain) return;

    pageDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
    updateCurrentPage(pageNum);
  }

  // ── Zoom ───────────────────────────────────────────────────────────

  function setZoom(scale) {
    currentScale = Math.max(0.25, Math.min(5.0, scale));
    const zoomLabel = container.querySelector('.pdf-zoom-level');
    if (zoomLabel) zoomLabel.textContent = `${Math.round(currentScale * 100)}%`;
    reRenderAllVisiblePages();
  }

  function zoomIn() {
    // Find next level
    let nextScale = currentScale;
    for (const level of ZOOM_LEVELS) {
      if (level > currentScale + 0.01) {
        nextScale = level;
        break;
      }
    }
    if (nextScale === currentScale) nextScale = Math.min(5.0, currentScale + 0.25);
    setZoom(nextScale);
  }

  function zoomOut() {
    let prevScale = currentScale;
    for (let i = ZOOM_LEVELS.length - 1; i >= 0; i--) {
      if (ZOOM_LEVELS[i] < currentScale - 0.01) {
        prevScale = ZOOM_LEVELS[i];
        break;
      }
    }
    if (prevScale === currentScale) prevScale = Math.max(0.25, currentScale - 0.25);
    setZoom(prevScale);
  }

  function fitWidth() {
    const pdfMain = container.querySelector('.pdf-main');
    if (!pdfMain || !pdfDoc) return;

    pdfDoc.getPage(currentPage).then((page) => {
      const viewport = page.getViewport({ scale: 1.0, rotation });
      const availableWidth = pdfMain.clientWidth - 40; // padding
      const scale = availableWidth / viewport.width;
      setZoom(scale);
    });
  }

  function fitPage() {
    const pdfMain = container.querySelector('.pdf-main');
    if (!pdfMain || !pdfDoc) return;

    pdfDoc.getPage(currentPage).then((page) => {
      const viewport = page.getViewport({ scale: 1.0, rotation });
      const availableWidth = pdfMain.clientWidth - 40;
      const availableHeight = pdfMain.clientHeight - 30;
      const scaleW = availableWidth / viewport.width;
      const scaleH = availableHeight / viewport.height;
      setZoom(Math.min(scaleW, scaleH));
    });
  }

  // ── Rotation ───────────────────────────────────────────────────────

  function rotate() {
    rotation = (rotation + 90) % 360;
    reRenderAllVisiblePages();
  }

  // ── Dark Mode ──────────────────────────────────────────────────────

  function toggleDarkMode() {
    darkMode = !darkMode;
    const btn = container.querySelector('.pdf-dark-toggle');
    if (btn) {
      const icon = btn.querySelector('i');
      if (icon) {
        icon.className = darkMode ? 'fas fa-sun' : 'fas fa-moon';
      }
    }

    const pages = container.querySelectorAll('.pdf-page-container');
    pages.forEach((el) => {
      el.classList.toggle('dark-mode', darkMode);
    });
  }

  // ── Sidebar ────────────────────────────────────────────────────────

  function toggleSidebar() {
    sidebarVisible = !sidebarVisible;
    const sidebar = container.querySelector('.pdf-sidebar');
    if (sidebar) {
      sidebar.style.display = sidebarVisible ? '' : 'none';
    }
  }

  function switchSidebarTab(tabName) {
    const tabs = container.querySelectorAll('.pdf-sidebar-tab');
    tabs.forEach((t) => {
      t.classList.toggle('active', t.getAttribute('data-tab') === tabName);
    });

    const panels = container.querySelectorAll('.pdf-sidebar-panel');
    panels.forEach((p) => {
      p.classList.remove('active');
    });

    if (tabName === 'thumbnails') {
      container
        .querySelector('.pdf-thumbnails-panel')
        ?.classList.add('active');
    } else if (tabName === 'bookmarks') {
      container
        .querySelector('.pdf-bookmarks-panel')
        ?.classList.add('active');
    } else if (tabName === 'annotations') {
      container
        .querySelector('.pdf-annotations-panel')
        ?.classList.add('active');
    }
  }

  // ── Search ─────────────────────────────────────────────────────────

  function toggleSearch(forceState) {
    const searchBar = container.querySelector('.pdf-search-bar');
    if (!searchBar) return;

    const shouldShow =
      forceState !== undefined
        ? forceState
        : searchBar.classList.contains('hidden');

    searchBar.classList.toggle('hidden', !shouldShow);

    if (shouldShow) {
      const input = container.querySelector('.pdf-search-input');
      if (input) {
        input.focus();
        input.select();
      }
    } else {
      clearSearchHighlights();
      searchResults = [];
      currentSearchIndex = -1;
      searchQuery = '';
      const count = container.querySelector('.pdf-search-count');
      if (count) count.textContent = '0 / 0';
    }
  }

  async function search(query) {
    clearSearchHighlights();
    searchResults = [];
    currentSearchIndex = -1;
    searchQuery = query;

    if (!query || query.length < 2) {
      const count = container.querySelector('.pdf-search-count');
      if (count) count.textContent = '0 / 0';
      return;
    }

    const queryLower = query.toLowerCase();

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      let textContent = pageTextContents.get(pageNum);

      if (!textContent) {
        try {
          const page = await pdfDoc.getPage(pageNum);
          textContent = await page.getTextContent();
          pageTextContents.set(pageNum, textContent);
        } catch (err) {
          continue;
        }
      }

      // Build full text and item map for position tracking
      const items = textContent.items;
      let fullText = '';
      const itemPositions = []; // { itemIndex, startOffset, endOffset }

      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const text = item.str || '';
        const startOffset = fullText.length;
        fullText += text;
        itemPositions.push({
          itemIndex: idx,
          startOffset,
          endOffset: fullText.length,
        });
        // Add space between items for natural text flow
        if (text && !text.endsWith(' ')) {
          fullText += ' ';
        }
      }

      const fullTextLower = fullText.toLowerCase();
      let searchFrom = 0;

      while (true) {
        const matchIndex = fullTextLower.indexOf(queryLower, searchFrom);
        if (matchIndex === -1) break;

        searchResults.push({
          page: pageNum,
          matchIndex,
          matchLength: query.length,
          items: items,
          itemPositions: itemPositions,
        });

        searchFrom = matchIndex + 1;
      }
    }

    const count = container.querySelector('.pdf-search-count');
    if (searchResults.length > 0) {
      currentSearchIndex = 0;
      if (count) count.textContent = `1 / ${searchResults.length}`;
      highlightSearchResults();
      scrollToSearchResult(currentSearchIndex);
    } else {
      if (count) count.textContent = `0 / 0`;
    }
  }

  function highlightSearchResults() {
    clearSearchHighlights();

    // Group results by page
    const byPage = new Map();
    searchResults.forEach((result, idx) => {
      if (!byPage.has(result.page)) byPage.set(result.page, []);
      byPage.get(result.page).push({ ...result, globalIndex: idx });
    });

    for (const [pageNum, results] of byPage) {
      renderSearchHighlightsOnPage(pageNum, results);
    }
  }

  function renderSearchHighlightsOnPage(pageNum, results) {
    if (!results) {
      // Derive results from searchResults
      results = [];
      searchResults.forEach((r, idx) => {
        if (r.page === pageNum) results.push({ ...r, globalIndex: idx });
      });
    }
    if (results.length === 0) return;

    const pageDiv = container.querySelector(
      `.pdf-page-container[data-page="${pageNum}"]`
    );
    if (!pageDiv) return;

    const textLayerDiv = pageDiv.querySelector('.pdf-text-layer');
    if (!textLayerDiv) return;

    const spans = textLayerDiv.querySelectorAll('span');
    if (spans.length === 0) return;

    const annotLayer = pageDiv.querySelector('.pdf-annotation-layer');
    if (!annotLayer) return;

    // For each result, find matching text spans and create highlight overlays
    results.forEach((result) => {
      // Try to find the text in the text layer spans
      const queryLower = searchQuery.toLowerCase();
      let accumulated = '';
      const spanTexts = [];

      spans.forEach((span, idx) => {
        const startOffset = accumulated.length;
        accumulated += span.textContent;
        spanTexts.push({
          span,
          startOffset,
          endOffset: accumulated.length,
          index: idx,
        });
        if (!span.textContent.endsWith(' ')) {
          accumulated += ' ';
        }
      });

      const accLower = accumulated.toLowerCase();
      let pos = -1;
      let count = 0;

      // Find the Nth occurrence matching result.matchIndex
      let searchFrom = 0;
      while (true) {
        const found = accLower.indexOf(queryLower, searchFrom);
        if (found === -1) break;
        if (found === result.matchIndex) {
          pos = found;
          break;
        }
        searchFrom = found + 1;
        count++;
      }

      if (pos === -1) return;

      const matchEnd = pos + queryLower.length;

      // Find all spans that intersect with this match
      spanTexts.forEach((st) => {
        const spanStart = st.startOffset;
        const spanEnd = st.endOffset;

        if (spanEnd > pos && spanStart < matchEnd) {
          const rect = st.span.getBoundingClientRect();
          const containerRect = pageDiv.getBoundingClientRect();

          const highlight = document.createElement('div');
          highlight.className = 'pdf-search-highlight';
          if (result.globalIndex === currentSearchIndex) {
            highlight.classList.add('current');
          }
          highlight.setAttribute('data-search-index', result.globalIndex);
          highlight.style.left = `${rect.left - containerRect.left}px`;
          highlight.style.top = `${rect.top - containerRect.top}px`;
          highlight.style.width = `${rect.width}px`;
          highlight.style.height = `${rect.height}px`;

          annotLayer.appendChild(highlight);
        }
      });
    });
  }

  function clearSearchHighlights() {
    if (!container) return;
    const highlights = container.querySelectorAll('.pdf-search-highlight');
    highlights.forEach((el) => el.remove());
  }

  function navigateSearch(direction) {
    if (searchResults.length === 0) return;

    currentSearchIndex += direction;
    if (currentSearchIndex < 0) currentSearchIndex = searchResults.length - 1;
    if (currentSearchIndex >= searchResults.length) currentSearchIndex = 0;

    const count = container.querySelector('.pdf-search-count');
    if (count)
      count.textContent = `${currentSearchIndex + 1} / ${searchResults.length}`;

    // Update highlights
    const allHighlights = container.querySelectorAll('.pdf-search-highlight');
    allHighlights.forEach((el) => {
      const idx = parseInt(el.getAttribute('data-search-index'), 10);
      el.classList.toggle('current', idx === currentSearchIndex);
    });

    scrollToSearchResult(currentSearchIndex);
  }

  function scrollToSearchResult(index) {
    if (index < 0 || index >= searchResults.length) return;
    const result = searchResults[index];

    // Ensure the page is rendered, then scroll
    scrollToPage(result.page);

    // After scrolling, try to scroll to the specific highlight
    requestAnimationFrame(() => {
      setTimeout(() => {
        const highlight = container.querySelector(
          `.pdf-search-highlight.current`
        );
        if (highlight) {
          highlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 300);
    });
  }

  // ── Bookmarks ──────────────────────────────────────────────────────

  async function loadBookmarks() {
    try {
      const data = await window.VaultAPI.get(
        `/api/bookmarks?file=${fileId}`
      );
      bookmarks = Array.isArray(data) ? data : data.bookmarks || [];
      renderBookmarksList();
      updateBookmarkIcon();
    } catch (err) {
      console.warn('Failed to load bookmarks:', err);
      bookmarks = [];
    }
  }

  async function addBookmark() {
    const existing = bookmarks.find((b) => b.page === currentPage);
    if (existing) {
      // Already bookmarked, offer to remove
      try {
        const result = await window.showModal(
          'Remove Bookmark',
          `<p>Remove bookmark on page ${currentPage}?</p>`,
          [
            { label: 'Cancel', value: false },
            { label: 'Remove', value: true, className: 'btn-danger' },
          ]
        );
        if (result) {
          await window.VaultAPI.del(`/api/bookmarks/${existing.id}`);
          window.showToast('Bookmark removed', 'success');
          await loadBookmarks();
        }
      } catch (err) {
        console.warn('Bookmark removal cancelled or failed:', err);
      }
      return;
    }

    try {
      const label = await window.showModal(
        'Add Bookmark',
        `<p>Bookmark label:</p>
         <input type="text" id="bookmark-label-input" class="form-control" value="Page ${currentPage}" style="width:100%;padding:8px;margin-top:8px;">`,
        [
          { label: 'Cancel', value: false },
          { label: 'Add', value: true, className: 'btn-primary' },
        ]
      );

      if (label) {
        const labelInput = document.getElementById('bookmark-label-input');
        const bookmarkLabel = labelInput
          ? labelInput.value.trim() || `Page ${currentPage}`
          : `Page ${currentPage}`;

        await window.VaultAPI.post('/api/bookmarks', {
          fileId,
          page: currentPage,
          label: bookmarkLabel,
        });

        window.showToast('Bookmark added', 'success');
        await loadBookmarks();
      }
    } catch (err) {
      if (err) {
        console.error('Failed to add bookmark:', err);
        window.showToast('Failed to add bookmark', 'error');
      }
    }
  }

  function renderBookmarksList() {
    const panel = container.querySelector('.pdf-bookmarks-panel');
    if (!panel) return;

    if (bookmarks.length === 0) {
      panel.innerHTML =
        '<div class="pdf-sidebar-empty"><i class="fas fa-bookmark" style="font-size:24px;margin-bottom:8px;display:block;opacity:0.4;"></i>No bookmarks yet.<br>Click the bookmark icon to add one.</div>';
      return;
    }

    panel.innerHTML = '';
    const sorted = [...bookmarks].sort((a, b) => a.page - b.page);

    sorted.forEach((bm) => {
      const item = document.createElement('div');
      item.className = 'pdf-bookmark-item';
      item.innerHTML = `
        <span class="bookmark-label">${escapeHtml(bm.label || `Page ${bm.page}`)}</span>
        <span class="bookmark-page">p. ${bm.page}</span>
        <span class="bookmark-delete" title="Delete bookmark"><i class="fas fa-trash-alt"></i></span>
      `;

      item.addEventListener('click', (e) => {
        if (e.target.closest('.bookmark-delete')) return;
        scrollToPage(bm.page);
      });

      const deleteBtn = item.querySelector('.bookmark-delete');
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await window.VaultAPI.del(`/api/bookmarks/${bm.id}`);
          window.showToast('Bookmark removed', 'success');
          await loadBookmarks();
        } catch (err) {
          window.showToast('Failed to delete bookmark', 'error');
        }
      });

      panel.appendChild(item);
    });
  }

  function updateBookmarkIcon() {
    const btn = container.querySelector('.pdf-bookmark-btn');
    if (!btn) return;
    const icon = btn.querySelector('i');
    if (!icon) return;

    const hasBookmark = bookmarks.some((b) => b.page === currentPage);
    icon.className = hasBookmark ? 'fas fa-bookmark' : 'far fa-bookmark';
  }

  // ── Annotations / Highlights ───────────────────────────────────────

  async function loadAnnotations() {
    try {
      const data = await window.VaultAPI.get(
        `/api/annotations/${fileId}`
      );
      annotations = Array.isArray(data)
        ? data
        : data.annotations || [];
      renderAnnotationsList();
      // Re-render annotations on all visible pages
      pageCanvases.forEach((_, pageNum) => {
        renderAnnotationsOnPage(pageNum);
      });
    } catch (err) {
      console.warn('Failed to load annotations:', err);
      annotations = [];
    }
  }

  function toggleHighlightMode() {
    highlightMode = !highlightMode;
    const btn = container.querySelector('.pdf-highlight-toggle');
    if (btn) {
      btn.classList.toggle('active', highlightMode);
    }

    const pdfMain = container.querySelector('.pdf-main');
    if (pdfMain) {
      pdfMain.classList.toggle('highlight-mode', highlightMode);
    }

    // Show/hide color picker
    let picker = container.querySelector('.pdf-highlight-color-picker');
    if (highlightMode) {
      if (!picker) {
        picker = createColorPicker();
        btn.style.position = 'relative';
        btn.appendChild(picker);
      }
      picker.classList.add('visible');
    } else {
      if (picker) picker.classList.remove('visible');
    }
  }

  function createColorPicker() {
    const picker = document.createElement('div');
    picker.className = 'pdf-highlight-color-picker';

    HIGHLIGHT_COLORS.forEach((color) => {
      const swatch = document.createElement('div');
      swatch.className = 'pdf-highlight-color-swatch';
      if (color === selectedHighlightColor) swatch.classList.add('active');
      swatch.style.backgroundColor = HIGHLIGHT_COLOR_MAP[color];
      swatch.setAttribute('data-color', color);

      swatch.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedHighlightColor = color;
        picker.querySelectorAll('.pdf-highlight-color-swatch').forEach((s) => {
          s.classList.toggle('active', s.getAttribute('data-color') === color);
        });
      });

      picker.appendChild(swatch);
    });

    return picker;
  }

  function handleHighlightMouseUp(e) {
    if (!highlightMode) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) return;

    const selectedText = selection.toString().trim();
    if (selectedText.length === 0) return;

    // Find which page this selection is in
    const range = selection.getRangeAt(0);
    const pageContainer = range.startContainer.parentElement?.closest(
      '.pdf-page-container'
    );
    if (!pageContainer) return;

    const pageNum = parseInt(pageContainer.getAttribute('data-page'), 10);
    if (!pageNum) return;

    // Get selection rects relative to page container
    const containerRect = pageContainer.getBoundingClientRect();
    const dims = pageDimensions.get(pageNum);
    if (!dims) return;

    const rects = [];
    const rangeRects = range.getClientRects();
    for (let i = 0; i < rangeRects.length; i++) {
      const r = rangeRects[i];
      rects.push({
        x: (r.left - containerRect.left) / dims.width,
        y: (r.top - containerRect.top) / dims.height,
        w: r.width / dims.width,
        h: r.height / dims.height,
      });
    }

    if (rects.length === 0) return;

    // Clear selection
    selection.removeAllRanges();

    // Save annotation
    saveHighlightAnnotation(pageNum, rects, selectedText);
  }

  async function saveHighlightAnnotation(pageNum, rects, text) {
    try {
      await window.VaultAPI.post('/api/annotations', {
        fileId,
        page: pageNum,
        type: 'highlight',
        data: {
          rects,
          color: selectedHighlightColor,
          text,
        },
      });

      window.showToast('Highlight saved', 'success');
      await loadAnnotations();
    } catch (err) {
      console.error('Failed to save highlight:', err);
      window.showToast('Failed to save highlight', 'error');
    }
  }

  function renderAnnotationsOnPage(pageNum) {
    const pageDiv = container.querySelector(
      `.pdf-page-container[data-page="${pageNum}"]`
    );
    if (!pageDiv) return;

    const annotLayer = pageDiv.querySelector('.pdf-annotation-layer');
    if (!annotLayer) return;

    // Remove existing annotation overlays (keep search highlights)
    annotLayer
      .querySelectorAll('.pdf-highlight-overlay')
      .forEach((el) => el.remove());

    const dims = pageDimensions.get(pageNum);
    if (!dims) return;

    const pageAnnotations = annotations.filter(
      (a) => a.page === pageNum && a.type === 'highlight'
    );

    pageAnnotations.forEach((annot) => {
      const data = typeof annot.data === 'string' ? JSON.parse(annot.data) : annot.data;
      if (!data || !data.rects) return;

      const color = HIGHLIGHT_COLOR_MAP[data.color] || HIGHLIGHT_COLOR_MAP.yellow;

      data.rects.forEach((rect) => {
        const overlay = document.createElement('div');
        overlay.className = 'pdf-highlight-overlay';
        overlay.style.left = `${rect.x * dims.width}px`;
        overlay.style.top = `${rect.y * dims.height}px`;
        overlay.style.width = `${rect.w * dims.width}px`;
        overlay.style.height = `${rect.h * dims.height}px`;
        overlay.style.backgroundColor = color;
        overlay.setAttribute('data-annotation-id', annot.id);

        overlay.addEventListener('click', (e) => {
          e.stopPropagation();
          showAnnotationContextMenu(e, annot);
        });

        annotLayer.appendChild(overlay);
      });
    });
  }

  function showAnnotationContextMenu(event, annot) {
    // Remove any existing context menu
    const existing = container.querySelector('.pdf-annotation-context-menu');
    if (existing) existing.remove();

    const data = typeof annot.data === 'string' ? JSON.parse(annot.data) : annot.data;

    const menu = document.createElement('div');
    menu.className = 'pdf-annotation-context-menu';
    menu.style.cssText = `
      position: fixed;
      left: ${event.clientX}px;
      top: ${event.clientY}px;
      background: #fff;
      border: 1px solid #ddd;
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 1000;
      padding: 4px 0;
      min-width: 140px;
    `;

    if (data.text) {
      const textItem = document.createElement('div');
      textItem.style.cssText =
        'padding: 6px 12px; font-size: 12px; color: #666; border-bottom: 1px solid #eee; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
      textItem.textContent = `"${data.text}"`;
      menu.appendChild(textItem);
    }

    const deleteItem = document.createElement('div');
    deleteItem.style.cssText =
      'padding: 8px 12px; cursor: pointer; font-size: 13px; color: #d32f2f; display: flex; align-items: center; gap: 6px;';
    deleteItem.innerHTML =
      '<i class="fas fa-trash-alt"></i> Delete highlight';
    deleteItem.addEventListener('click', async () => {
      menu.remove();
      try {
        await window.VaultAPI.del(`/api/annotations/${annot.id}`);
        window.showToast('Highlight removed', 'success');
        await loadAnnotations();
      } catch (err) {
        window.showToast('Failed to delete highlight', 'error');
      }
    });
    deleteItem.addEventListener('mouseenter', () => {
      deleteItem.style.background = '#fbe9e7';
    });
    deleteItem.addEventListener('mouseleave', () => {
      deleteItem.style.background = '';
    });
    menu.appendChild(deleteItem);

    document.body.appendChild(menu);

    // Close on click outside
    const closeMenu = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', closeMenu, true);
      }
    };
    setTimeout(() => {
      document.addEventListener('click', closeMenu, true);
    }, 10);
  }

  function renderAnnotationsList() {
    const panel = container.querySelector('.pdf-annotations-panel');
    if (!panel) return;

    const highlights = annotations.filter((a) => a.type === 'highlight');

    if (highlights.length === 0) {
      panel.innerHTML =
        '<div class="pdf-sidebar-empty"><i class="fas fa-highlighter" style="font-size:24px;margin-bottom:8px;display:block;opacity:0.4;"></i>No highlights yet.<br>Enable highlight mode and select text.</div>';
      return;
    }

    panel.innerHTML = '';
    const sorted = [...highlights].sort((a, b) => a.page - b.page);

    sorted.forEach((annot) => {
      const data =
        typeof annot.data === 'string' ? JSON.parse(annot.data) : annot.data;
      const color = HIGHLIGHT_COLOR_MAP[data.color] || HIGHLIGHT_COLOR_MAP.yellow;

      const item = document.createElement('div');
      item.className = 'pdf-annotation-item';
      item.innerHTML = `
        <div class="pdf-annotation-color-dot" style="background-color: ${color}"></div>
        <span class="annotation-text">${escapeHtml(data.text || 'Highlight')}</span>
        <span class="annotation-page">p. ${annot.page}</span>
        <span class="annotation-delete" title="Delete highlight"><i class="fas fa-trash-alt"></i></span>
      `;

      item.addEventListener('click', (e) => {
        if (e.target.closest('.annotation-delete')) return;
        scrollToPage(annot.page);
      });

      const deleteBtn = item.querySelector('.annotation-delete');
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await window.VaultAPI.del(`/api/annotations/${annot.id}`);
          window.showToast('Highlight removed', 'success');
          await loadAnnotations();
        } catch (err) {
          window.showToast('Failed to delete highlight', 'error');
        }
      });

      panel.appendChild(item);
    });
  }

  // ── Reading Progress ───────────────────────────────────────────────

  async function loadProgress() {
    try {
      const data = await window.VaultAPI.get(`/api/progress/${fileId}`);
      if (data && data.lastPage && data.lastPage > 1) {
        window.showToast(
          `Resume from page ${data.lastPage}?`,
          'info'
        );
        // Automatically scroll to last position after a short delay to let pages render
        setTimeout(() => {
          scrollToPage(data.lastPage);
        }, 500);
      }
    } catch (err) {
      // No progress saved yet, that's fine
    }
  }

  function scheduleProgressSave() {
    clearTimeout(progressSaveTimer);
    progressSaveTimer = setTimeout(() => {
      saveProgressImmediate();
    }, PROGRESS_SAVE_DELAY);
  }

  async function saveProgressImmediate() {
    if (!fileId || currentPage < 1) return;
    try {
      await window.VaultAPI.put(`/api/progress/${fileId}`, {
        lastPage: currentPage,
      });
    } catch (err) {
      console.warn('Failed to save reading progress:', err);
    }
  }

  async function saveProgress() {
    await saveProgressImmediate();
  }

  // ── Utilities ──────────────────────────────────────────────────────

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Export ─────────────────────────────────────────────────────────

  return { open, close };
})();

window.PDFViewerApp = PDFViewerApp;
