// ==UserScript==
// @name         APP体验防重助手（纳入与排除检测·可折叠贴边版）
// @namespace    https://tampermonkey.net/
// @version      1.1.0
// @description  安卓端浏览器专用：支持折叠贴边半隐藏，不遮挡日常浏览；纳入已体验的APP名称/关键字后，点击“排除”检索当前网页界面，命中变红预警、未命中变绿放行。
// @author       Gemini
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // 避免在嵌套 iframe 中重复生成悬浮窗
  if (window.top !== window.self) return;

  const STORAGE_KEY_KEYWORDS = 'tm_app_tracker_keywords_v1';
  const STORAGE_KEY_CONFIG = 'tm_app_tracker_config_v1';
  const HOST_ID = 'tm-app-tracker-shadow-host';
  const HIGHLIGHT_CLASS = 'tm-app-tracker-highlight-mark';

  // ==================== 1. 存储层（兼容油猴跨域名存储与普通浏览器 localStorage） ====================
  function loadData(key, defaultVal) {
    try {
      if (typeof GM_getValue === 'function') {
        const val = GM_getValue(key, null);
        if (val !== null && val !== undefined) {
          return typeof val === 'string' ? JSON.parse(val) : val;
        }
      }
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : defaultVal;
    } catch (e) {
      console.warn('[APP防重助手] 读取存储失败:', e);
      return defaultVal;
    }
  }

  function saveData(key, val) {
    try {
      const serialized = JSON.stringify(val);
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, serialized);
      }
      localStorage.setItem(key, serialized);
    } catch (e) {
      console.warn('[APP防重助手] 保存存储失败:', e);
    }
  }

  // 词库数据结构：[{ word: '某某APP', addedAt: 1700000000000 }]
  let keywordList = loadData(STORAGE_KEY_KEYWORDS, []);
  let config = Object.assign(
    {
      posY: null,
      dockSide: 'right', // 'left' | 'right'
      isCollapsed: true, // 默认折叠贴边，不影响日常浏览
      autoCollapseOutside: true, // 点击网页空白处自动折叠回贴边状态
      caseSensitive: false,
      highlightOnPage: true,
      autoCheckOnLoad: false,
    },
    loadData(STORAGE_KEY_CONFIG, {})
  );

  // 缓存最近一次在网页中长按选中的文字（防止展开折叠球时选区丢失）
  let lastSelectedText = '';
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection ? window.getSelection().toString().trim() : '';
    if (sel) {
      lastSelectedText = sel;
    }
  });

  // ==================== 2. 网页正文高亮样式注入 ====================
  function ensurePageHighlightStyle() {
    if (document.getElementById('tm-app-tracker-page-style')) return;
    const style = document.createElement('style');
    style.id = 'tm-app-tracker-page-style';
    style.textContent = `
      .${HIGHLIGHT_CLASS} {
        background-color: #ffeb3b !important;
        color: #b71c1c !important;
        font-weight: bold !important;
        padding: 0 2px !important;
        border-radius: 3px !important;
        box-shadow: 0 0 0 2px rgba(229, 57, 53, 0.45) !important;
      }
    `;
    document.head.appendChild(style);
  }

  function clearPageHighlights() {
    const marks = document.querySelectorAll(`.${HIGHLIGHT_CLASS}`);
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    });
  }

  function highlightMatchesInDOM(matchedWords) {
    clearPageHighlights();
    if (!config.highlightOnPage || !matchedWords || matchedWords.length === 0) return;
    ensurePageHighlightStyle();

    const sorted = [...matchedWords].sort((a, b) => b.length - a.length);
    const escaped = sorted.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const flags = config.caseSensitive ? 'g' : 'gi';
    const regex = new RegExp(`(${escaped.join('|')})`, flags);

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (
          tag === 'SCRIPT' ||
          tag === 'STYLE' ||
          tag === 'NOSCRIPT' ||
          tag === 'TEXTAREA' ||
          tag === 'INPUT' ||
          parent.id === HOST_ID ||
          parent.closest(`#${HOST_ID}`) ||
          parent.classList.contains(HIGHLIGHT_CLASS)
        ) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const textNodes = [];
    let currentNode;
    while ((currentNode = walker.nextNode())) {
      regex.lastIndex = 0;
      if (regex.test(currentNode.nodeValue)) {
        textNodes.push(currentNode);
      }
    }

    textNodes.slice(0, 120).forEach((textNode) => {
      const text = textNode.nodeValue;
      regex.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let lastIdx = 0;
      let match;
      while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIdx) {
          frag.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
        }
        const mark = document.createElement('mark');
        mark.className = HIGHLIGHT_CLASS;
        mark.textContent = match[0];
        frag.appendChild(mark);
        lastIdx = regex.lastIndex;
        if (match[0].length === 0) regex.lastIndex++;
      }
      if (lastIdx < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx)));
      }
      if (textNode.parentNode) {
        textNode.parentNode.replaceChild(frag, textNode);
      }
    });
  }

  // ==================== 3. 创建 Shadow DOM 隔离界面 ====================
  const hostEl = document.createElement('div');
  hostEl.id = HOST_ID;
  hostEl.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0; width: 0; height: 0;';
  document.documentElement.appendChild(hostEl);

  const shadow = hostEl.attachShadow({ mode: 'open' });

  const styleEl = document.createElement('style');
  styleEl.textContent = `
    * {
      box-sizing: border-box;
      -webkit-tap-highlight-color: transparent;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
    }

    /* 悬浮主容器 */
    .widget-container {
      position: fixed;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      user-select: none;
      touch-action: none;
      transition: left 0.2s cubic-bezier(0.2, 0.8, 0.2, 1), right 0.2s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.2s ease;
    }
    .widget-container.dragging {
      transition: none !important;
    }
    .widget-container.dock-right {
      align-items: flex-end;
    }
    .widget-container.dock-left {
      align-items: flex-start;
    }

    /* 展开态胶囊 */
    .main-pill {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 6px 9px;
      border-radius: 999px;
      color: #ffffff;
      font-size: 13px;
      font-weight: 600;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
      transition: all 0.22s ease;
      border: 1.5px solid rgba(255, 255, 255, 0.85);
      backdrop-filter: blur(6px);
      cursor: pointer;
    }

    /* 折叠态：小巧贴边半隐藏悬浮球 */
    .widget-container.collapsed .main-pill {
      padding: 6px 8px;
      gap: 3px;
      opacity: 0.55;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    }
    .widget-container.collapsed.dock-right .main-pill {
      border-top-right-radius: 0;
      border-bottom-right-radius: 0;
      border-right: none;
      padding-right: 10px;
      transform: translateX(35%);
    }
    .widget-container.collapsed.dock-left .main-pill {
      border-top-left-radius: 0;
      border-bottom-left-radius: 0;
      border-left: none;
      padding-left: 10px;
      transform: translateX(-35%);
    }
    /* 命中变红或变绿时，折叠球保持稍高清晰度方便一眼看清颜色 */
    .widget-container.collapsed .main-pill.state-red,
    .widget-container.collapsed .main-pill.state-green {
      opacity: 0.92;
      transform: translateX(15%);
    }
    .widget-container.collapsed.dock-left .main-pill.state-red,
    .widget-container.collapsed.dock-left .main-pill.state-green {
      transform: translateX(-15%);
    }

    /* 折叠时隐藏操作按钮和长文字，只留状态圆点与简短标记 */
    .widget-container.collapsed .expanded-only {
      display: none !important;
    }
    .collapsed-only {
      display: none;
      font-size: 11px;
      font-weight: 700;
      line-height: 1;
    }
    .widget-container.collapsed .collapsed-only {
      display: inline-block;
    }

    /* 三种核心状态颜色：默认灰蓝、命中变红、未命中变绿 */
    .state-idle {
      background: linear-gradient(135deg, #455a64, #263238);
    }
    .state-red {
      background: linear-gradient(135deg, #e53935, #b71c1c);
      box-shadow: 0 0 0 3px rgba(229, 57, 53, 0.35), 0 6px 16px rgba(183, 28, 28, 0.5);
      animation: pulse-red 1.6s infinite;
    }
    .state-green {
      background: linear-gradient(135deg, #2e7d32, #1b5e20);
      box-shadow: 0 0 0 3px rgba(46, 125, 50, 0.3), 0 6px 16px rgba(27, 94, 32, 0.45);
    }

    @keyframes pulse-red {
      0% { box-shadow: 0 0 0 0 rgba(229, 57, 53, 0.6), 0 4px 12px rgba(183, 28, 28, 0.4); }
      70% { box-shadow: 0 0 0 8px rgba(229, 57, 53, 0), 0 4px 12px rgba(183, 28, 28, 0.4); }
      100% { box-shadow: 0 0 0 0 rgba(229, 57, 53, 0), 0 4px 12px rgba(183, 28, 28, 0.4); }
    }

    .status-dot {
      width: 11px;
      height: 11px;
      border-radius: 50%;
      background: #b0bec5;
      border: 1.5px solid #fff;
      flex-shrink: 0;
    }
    .state-red .status-dot {
      background: #ffeb3b;
    }
    .state-green .status-dot {
      background: #69f0ae;
    }

    .status-label {
      padding-right: 2px;
      white-space: nowrap;
      letter-spacing: 0.2px;
    }

    .pill-btn {
      border: none;
      outline: none;
      background: rgba(255, 255, 255, 0.2);
      color: #ffffff;
      font-size: 12px;
      font-weight: 600;
      padding: 4px 8px;
      border-radius: 999px;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s;
    }
    .pill-btn:active {
      background: rgba(255, 255, 255, 0.4);
      transform: scale(0.95);
    }
    .pill-btn-fold {
      background: rgba(0, 0, 0, 0.22);
      padding: 4px 7px;
      font-size: 11px;
    }

    /* 命中结果快捷浮条（仅展开时显示） */
    .match-banner {
      margin-top: 6px;
      max-width: 250px;
      background: rgba(33, 33, 33, 0.94);
      color: #fff;
      padding: 7px 11px;
      border-radius: 10px;
      font-size: 12px;
      line-height: 1.4;
      box-shadow: 0 4px 12px rgba(0,0,0,0.25);
      display: none;
      word-break: break-all;
    }
    .match-banner.show {
      display: block;
    }
    .widget-container.collapsed .match-banner {
      display: none !important;
    }
    .match-banner .match-words {
      color: #ff8a80;
      font-weight: bold;
    }
    .match-banner .jump-btn {
      display: inline-block;
      margin-top: 4px;
      padding: 2px 7px;
      background: #e53935;
      color: #fff;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      border: none;
    }

    /* 弹窗面板（纳入 & 词库管理） */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 16px;
      z-index: 2147483647;
    }
    .modal-backdrop.open {
      display: flex;
    }

    .modal-card {
      width: 100%;
      max-width: 380px;
      max-height: 82vh;
      background: #ffffff;
      color: #212121;
      border-radius: 16px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .modal-header {
      padding: 14px 16px;
      background: #263238;
      color: #ffffff;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 15px;
      font-weight: 600;
    }
    .close-btn {
      background: none;
      border: none;
      color: #cfd8dc;
      font-size: 20px;
      line-height: 1;
      padding: 0 4px;
      cursor: pointer;
    }

    .modal-body {
      padding: 14px 16px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
      font-size: 13px;
    }

    .input-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .input-group label {
      font-weight: 600;
      color: #37474f;
      font-size: 12px;
    }
    .text-input {
      width: 100%;
      padding: 9px 11px;
      border: 1px solid #cfd8dc;
      border-radius: 8px;
      font-size: 14px;
      outline: none;
      resize: vertical;
      min-height: 42px;
    }
    .text-input:focus {
      border-color: #1976d2;
    }

    .action-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .btn {
      flex: 1;
      padding: 9px 12px;
      border: none;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      text-align: center;
    }
    .btn-primary {
      background: #1976d2;
      color: #fff;
    }
    .btn-success {
      background: #2e7d32;
      color: #fff;
    }
    .btn-danger {
      background: #d32f2f;
      color: #fff;
    }
    .btn-secondary {
      background: #eceff1;
      color: #37474f;
    }

    .section-title {
      font-size: 12px;
      font-weight: 600;
      color: #546e7a;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-top: 1px solid #eceff1;
      padding-top: 10px;
    }

    .keyword-list {
      max-height: 180px;
      overflow-y: auto;
      border: 1px solid #eceff1;
      border-radius: 8px;
      padding: 6px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      background: #fafafa;
    }
    .kw-tag {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      border-radius: 6px;
      background: #e3f2fd;
      color: #0d47a1;
      font-size: 12px;
      max-width: 100%;
      word-break: break-all;
    }
    .kw-tag.matched {
      background: #ffebee;
      color: #b71c1c;
      border: 1px solid #ef9a9a;
      font-weight: 600;
    }
    .kw-del {
      border: none;
      background: rgba(0, 0, 0, 0.12);
      color: inherit;
      border-radius: 50%;
      width: 16px;
      height: 16px;
      font-size: 11px;
      line-height: 16px;
      text-align: center;
      padding: 0;
      cursor: pointer;
      flex-shrink: 0;
    }

    .empty-tip {
      color: #90a4ae;
      font-size: 12px;
      padding: 12px;
      text-align: center;
      width: 100%;
    }

    .switch-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 14px;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
      color: #455a64;
      padding: 4px 0;
    }

    .toast {
      position: fixed;
      bottom: 64px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(38, 50, 56, 0.95);
      color: #fff;
      padding: 8px 16px;
      border-radius: 999px;
      font-size: 13px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease;
      z-index: 2147483647;
      white-space: nowrap;
    }
    .toast.show {
      opacity: 1;
    }
  `;
  shadow.appendChild(styleEl);

  // ==================== 4. 构建界面 DOM ====================
  const widget = document.createElement('div');
  widget.className = 'widget-container';
  widget.innerHTML = `
    <div class="main-pill state-idle" id="mainPill" title="点击展开/按住可上下拖动">
      <span class="status-dot"></span>
      <span class="collapsed-only" id="miniLabel">防重</span>
      <span class="status-label expanded-only" id="statusLabel">待检测</span>
      <button class="pill-btn expanded-only" id="btnInclude">纳入</button>
      <button class="pill-btn expanded-only" id="btnExclude">排除</button>
      <button class="pill-btn expanded-only" id="btnManage">词库</button>
      <button class="pill-btn pill-btn-fold expanded-only" id="btnCollapse" title="折叠贴边">收起</button>
    </div>
    <div class="match-banner" id="matchBanner">
      <div>⚠️ 发现已纳入APP：<span class="match-words" id="matchWordsText"></span></div>
      <button class="jump-btn" id="btnJumpHighlight">定位到页面位置</button>
    </div>
  `;
  shadow.appendChild(widget);

  const modalBackdrop = document.createElement('div');
  modalBackdrop.className = 'modal-backdrop';
  modalBackdrop.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <span id="modalTitle">APP 纳入与词库管理</span>
        <button class="close-btn" id="btnCloseModal">×</button>
      </div>
      <div class="modal-body">
        <div class="input-group">
          <label>纳入新 APP 关键字/全称（支持换行或逗号批量添加）：</label>
          <textarea class="text-input" id="kwInput" rows="2" placeholder="输入已体验的APP名称或关键字..."></textarea>
        </div>
        <div class="action-row">
          <button class="btn btn-primary" id="btnConfirmAdd">确认纳入</button>
          <button class="btn btn-secondary" id="btnFillSelection">填入网页选中字</button>
          <button class="btn btn-success" id="btnModalExclude">立即排除检测</button>
        </div>

        <div class="section-title">
          <span>已纳入词库 (<span id="kwCount">0</span>)</span>
          <input type="text" id="kwSearch" placeholder="搜索词库..." style="padding:3px 7px;border:1px solid #cfd8dc;border-radius:6px;font-size:12px;width:130px;">
        </div>
        <div class="keyword-list" id="kwListContainer"></div>

        <div class="switch-row">
          <label><input type="checkbox" id="chkHighlight"> 命中时在网页高亮</label>
          <label><input type="checkbox" id="chkAutoCheck"> 打开网页自动检测</label>
          <label><input type="checkbox" id="chkAutoCollapse"> 点击网页空白处自动折叠</label>
        </div>

        <div class="action-row" style="border-top:1px solid #eceff1;padding-top:10px;">
          <button class="btn btn-secondary" id="btnExport">导出备份</button>
          <button class="btn btn-secondary" id="btnImport">导入词库</button>
          <button class="btn btn-danger" id="btnClearAll">清空全部</button>
        </div>
      </div>
    </div>
  `;
  shadow.appendChild(modalBackdrop);

  const toastEl = document.createElement('div');
  toastEl.className = 'toast';
  shadow.appendChild(toastEl);

  // 获取 DOM 引用
  const mainPill = shadow.getElementById('mainPill');
  const miniLabel = shadow.getElementById('miniLabel');
  const statusLabel = shadow.getElementById('statusLabel');
  const btnInclude = shadow.getElementById('btnInclude');
  const btnExclude = shadow.getElementById('btnExclude');
  const btnManage = shadow.getElementById('btnManage');
  const btnCollapse = shadow.getElementById('btnCollapse');
  const matchBanner = shadow.getElementById('matchBanner');
  const matchWordsText = shadow.getElementById('matchWordsText');
  const btnJumpHighlight = shadow.getElementById('btnJumpHighlight');

  const btnCloseModal = shadow.getElementById('btnCloseModal');
  const kwInput = shadow.getElementById('kwInput');
  const btnConfirmAdd = shadow.getElementById('btnConfirmAdd');
  const btnFillSelection = shadow.getElementById('btnFillSelection');
  const btnModalExclude = shadow.getElementById('btnModalExclude');
  const kwCount = shadow.getElementById('kwCount');
  const kwSearch = shadow.getElementById('kwSearch');
  const kwListContainer = shadow.getElementById('kwListContainer');
  const chkHighlight = shadow.getElementById('chkHighlight');
  const chkAutoCheck = shadow.getElementById('chkAutoCheck');
  const chkAutoCollapse = shadow.getElementById('chkAutoCollapse');
  const btnExport = shadow.getElementById('btnExport');
  const btnImport = shadow.getElementById('btnImport');
  const btnClearAll = shadow.getElementById('btnClearAll');

  chkHighlight.checked = !!config.highlightOnPage;
  chkAutoCheck.checked = !!config.autoCheckOnLoad;
  chkAutoCollapse.checked = config.autoCollapseOutside !== false;

  let toastTimer = null;
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('show');
    }, 2200);
  }

  // ==================== 5. 折叠贴边与触屏拖拽控制 ====================
  function clampY(y) {
    const maxH = window.innerHeight - 54;
    return Math.max(12, Math.min(y, maxH > 12 ? maxH : window.innerHeight - 45));
  }

  function renderDockPosition() {
    const y = clampY(typeof config.posY === 'number' ? config.posY : Math.floor(window.innerHeight * 0.72));
    widget.style.top = `${y}px`;

    widget.classList.toggle('collapsed', !!config.isCollapsed);
    widget.classList.toggle('dock-left', config.dockSide === 'left');
    widget.classList.toggle('dock-right', config.dockSide !== 'left');

    if (config.dockSide === 'left') {
      widget.style.left = config.isCollapsed ? '0px' : '8px';
      widget.style.right = 'auto';
    } else {
      widget.style.right = config.isCollapsed ? '0px' : '8px';
      widget.style.left = 'auto';
    }
  }

  function setCollapsed(collapsed) {
    config.isCollapsed = !!collapsed;
    saveData(STORAGE_KEY_CONFIG, config);
    renderDockPosition();
  }

  let isDragging = false;
  let hasMoved = false;
  let startX = 0;
  let startY = 0;
  let initialLeft = 0;
  let initialTop = 0;

  function onDragStart(clientX, clientY, target) {
    // 如果在展开状态点击了功能按钮，交给按钮事件处理
    if (!config.isCollapsed && target && target.tagName === 'BUTTON') return;
    isDragging = true;
    hasMoved = false;
    startX = clientX;
    startY = clientY;
    const rect = widget.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;
    widget.classList.add('dragging');
  }

  function onDragMove(clientX, clientY) {
    if (!isDragging) return;
    const dx = clientX - startX;
    const dy = clientY - startY;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
      hasMoved = true;
    }
    if (hasMoved) {
      const rect = widget.getBoundingClientRect();
      const maxX = window.innerWidth - (rect.width || 60);
      const nextX = Math.max(0, Math.min(initialLeft + dx, maxX));
      const nextY = clampY(initialTop + dy);
      widget.style.left = `${nextX}px`;
      widget.style.right = 'auto';
      widget.style.top = `${nextY}px`;
    }
  }

  function onDragEnd() {
    if (!isDragging) return;
    isDragging = false;
    widget.classList.remove('dragging');
    if (hasMoved) {
      // 根据松手时的水平中心位置，自动吸附到左边缘或右边缘
      const rect = widget.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      config.dockSide = centerX < window.innerWidth / 2 ? 'left' : 'right';
      config.posY = Math.round(clampY(rect.top));
      saveData(STORAGE_KEY_CONFIG, config);
      renderDockPosition();
    }
  }

  mainPill.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 1) {
        onDragStart(e.touches[0].clientX, e.touches[0].clientY, e.target);
      }
    },
    { passive: true }
  );
  window.addEventListener(
    'touchmove',
    (e) => {
      if (isDragging && e.touches.length === 1) {
        onDragMove(e.touches[0].clientX, e.touches[0].clientY);
      }
    },
    { passive: true }
  );
  window.addEventListener('touchend', onDragEnd);

  mainPill.addEventListener('mousedown', (e) => {
    onDragStart(e.clientX, e.clientY, e.target);
  });
  window.addEventListener('mousemove', (e) => {
    if (isDragging) onDragMove(e.clientX, e.clientY);
  });
  window.addEventListener('mouseup', onDragEnd);

  window.addEventListener('resize', () => {
    renderDockPosition();
  });

  // 点击网页空白区域自动收起回贴边折叠状态（不打扰日常浏览）
  document.addEventListener(
    'touchstart',
    (e) => {
      if (!config.autoCollapseOutside || config.isCollapsed) return;
      if (modalBackdrop.classList.contains('open')) return;
      if (e.target === hostEl || hostEl.contains(e.target)) return;
      setCollapsed(true);
    },
    { passive: true }
  );
  document.addEventListener('mousedown', (e) => {
    if (!config.autoCollapseOutside || config.isCollapsed) return;
    if (modalBackdrop.classList.contains('open')) return;
    if (e.target === hostEl || hostEl.contains(e.target)) return;
    setCollapsed(true);
  });

  // ==================== 6. 核心功能：纳入（Include）与排除（Exclude） ====================
  let currentMatchedSet = new Set();

  function getPageVisibleText() {
    if (!document.body) return '';
    return document.body.innerText || document.body.textContent || '';
  }

  function runExcludeCheck(showNotice = true) {
    if (!keywordList || keywordList.length === 0) {
      mainPill.className = 'main-pill state-idle';
      statusLabel.textContent = '词库为空';
      miniLabel.textContent = '防重';
      matchBanner.classList.remove('show');
      clearPageHighlights();
      if (showNotice) {
        showToast('⚠️ 尚未纳入任何关键字，请先点击“纳入”');
      }
      return;
    }

    const rawPageText = getPageVisibleText();
    const pageText = config.caseSensitive ? rawPageText : rawPageText.toLowerCase();

    const matchedWords = [];
    currentMatchedSet.clear();

    for (const item of keywordList) {
      const word = (item.word || '').trim();
      if (!word) continue;
      const target = config.caseSensitive ? word : word.toLowerCase();
      if (pageText.includes(target)) {
        matchedWords.push(word);
        currentMatchedSet.add(word);
      }
    }

    if (matchedWords.length > 0) {
      // 命中已纳入关键字 -> 图标变红！
      mainPill.className = 'main-pill state-red';
      statusLabel.textContent = `已纳入(${matchedWords.length})`;
      miniLabel.textContent = `红(${matchedWords.length})`;
      matchWordsText.textContent =
        matchedWords.slice(0, 6).join('、') + (matchedWords.length > 6 ? ` 等${matchedWords.length}个` : '');
      matchBanner.classList.add('show');
      highlightMatchesInDOM(matchedWords);
      if (showNotice) {
        showToast(`🔴 命中已体验APP：${matchedWords.slice(0, 3).join('、')}`);
      }
    } else {
      // 未命中任何关键字 -> 图标变绿！
      mainPill.className = 'main-pill state-green';
      statusLabel.textContent = '未纳入(绿)';
      miniLabel.textContent = '绿✓';
      matchBanner.classList.remove('show');
      clearPageHighlights();
      if (showNotice) {
        showToast('🟢 当前页面未检索到已纳入关键字，可放心体验！');
      }
    }

    renderKeywordList(kwSearch.value.trim());
  }

  function includeKeywords(rawInput) {
    if (!rawInput || !rawInput.trim()) {
      showToast('请输入或选中要纳入的APP关键字');
      return 0;
    }

    const parts = rawInput
      .split(/[\n,，;；]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (parts.length === 0) return 0;

    const existingSet = new Set(
      keywordList.map((item) => (config.caseSensitive ? item.word : item.word.toLowerCase()))
    );

    let addedCount = 0;
    const now = Date.now();
    for (const part of parts) {
      const norm = config.caseSensitive ? part : part.toLowerCase();
      if (!existingSet.has(norm)) {
        keywordList.unshift({ word: part, addedAt: now });
        existingSet.add(norm);
        addedCount++;
      }
    }

    if (addedCount > 0) {
      saveData(STORAGE_KEY_KEYWORDS, keywordList);
      renderKeywordList(kwSearch.value.trim());
      showToast(`✅ 已成功纳入 ${addedCount} 个关键字（共 ${keywordList.length} 个）`);
    } else {
      showToast('ℹ️ 该关键字已在纳入词库中');
    }
    return addedCount;
  }

  function removeKeyword(wordToRemove) {
    keywordList = keywordList.filter((item) => item.word !== wordToRemove);
    saveData(STORAGE_KEY_KEYWORDS, keywordList);
    renderKeywordList(kwSearch.value.trim());
    showToast(`已移除：${wordToRemove}`);
  }

  function renderKeywordList(filterText = '') {
    kwCount.textContent = String(keywordList.length);
    kwListContainer.innerHTML = '';

    const normFilter = filterText.toLowerCase();
    const filtered = keywordList.filter((item) =>
      !normFilter ? true : item.word.toLowerCase().includes(normFilter)
    );

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-tip';
      empty.textContent = filterText ? '没有匹配的关键字' : '暂无纳入的APP关键字，可通过上方输入框或选中文字后纳入';
      kwListContainer.appendChild(empty);
      return;
    }

    const sorted = [...filtered].sort((a, b) => {
      const aHit = currentMatchedSet.has(a.word) ? 1 : 0;
      const bHit = currentMatchedSet.has(b.word) ? 1 : 0;
      return bHit - aHit;
    });

    sorted.forEach((item) => {
      const tag = document.createElement('span');
      const isHit = currentMatchedSet.has(item.word);
      tag.className = `kw-tag${isHit ? ' matched' : ''}`;
      tag.title = isHit ? '当前网页包含此关键字' : '';

      const textSpan = document.createElement('span');
      textSpan.textContent = item.word;

      const delBtn = document.createElement('button');
      delBtn.className = 'kw-del';
      delBtn.textContent = '×';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeKeyword(item.word);
      });

      tag.appendChild(textSpan);
      tag.appendChild(delBtn);
      kwListContainer.appendChild(tag);
    });
  }

  // ==================== 7. 按钮交互绑定 ====================
  // 折叠状态下点击悬浮球 -> 展开完整工具栏
  mainPill.addEventListener('click', (e) => {
    if (hasMoved) return;
    if (config.isCollapsed) {
      e.stopPropagation();
      setCollapsed(false);
    }
  });

  // 点击【收起】按钮 -> 折叠回贴边半隐藏小图标
  btnCollapse.addEventListener('click', (e) => {
    e.stopPropagation();
    setCollapsed(true);
  });

  // 点击【纳入】：若当前页面或刚才有划词选中文字，自动填入
  btnInclude.addEventListener('click', (e) => {
    e.stopPropagation();
    const currentSel = (window.getSelection && window.getSelection().toString().trim()) || lastSelectedText;
    if (currentSel) {
      kwInput.value = currentSel;
      lastSelectedText = '';
      if (window.getSelection) {
        window.getSelection().removeAllRanges();
      }
      openModal();
      showToast('已自动提取网页选中文字，点击“确认纳入”即可保存');
    } else {
      openModal();
      setTimeout(() => kwInput.focus(), 80);
    }
  });

  // 点击【排除】：立即检索当前网页界面并变色（命中变红，未命中变绿）
  btnExclude.addEventListener('click', (e) => {
    e.stopPropagation();
    runExcludeCheck(true);
  });

  // 点击【词库】：打开词库与管理弹窗
  btnManage.addEventListener('click', (e) => {
    e.stopPropagation();
    openModal();
  });

  // 展开状态下点击状态文字也可快速触发“排除”检测
  statusLabel.addEventListener('click', (e) => {
    if (!hasMoved && !config.isCollapsed) {
      e.stopPropagation();
      runExcludeCheck(true);
    }
  });

  // 定位到网页上第一个高亮命中词位置
  let jumpIdx = 0;
  btnJumpHighlight.addEventListener('click', (e) => {
    e.stopPropagation();
    const marks = document.querySelectorAll(`.${HIGHLIGHT_CLASS}`);
    if (marks.length === 0) {
      showToast('当前未开启高亮或元素不可滚动定位');
      return;
    }
    jumpIdx = jumpIdx % marks.length;
    const target = marks[jumpIdx];
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    showToast(`定位第 ${jumpIdx + 1}/${marks.length} 处：${target.textContent}`);
    jumpIdx++;
  });

  function openModal() {
    renderKeywordList(kwSearch.value.trim());
    modalBackdrop.classList.add('open');
  }

  function closeModal() {
    modalBackdrop.classList.remove('open');
  }

  btnCloseModal.addEventListener('click', closeModal);
  modalBackdrop.addEventListener('click', (e) => {
    if (e.target === modalBackdrop) closeModal();
  });

  btnConfirmAdd.addEventListener('click', () => {
    const added = includeKeywords(kwInput.value);
    if (added > 0) {
      kwInput.value = '';
      runExcludeCheck(false);
    }
  });

  btnFillSelection.addEventListener('click', () => {
    const sel = (window.getSelection && window.getSelection().toString().trim()) || lastSelectedText;
    if (sel) {
      kwInput.value = kwInput.value ? `${kwInput.value}\n${sel}` : sel;
      showToast('已填入网页选中文本');
    } else {
      showToast('请先在网页上长按选中APP名称文字');
    }
  });

  btnModalExclude.addEventListener('click', () => {
    if (kwInput.value.trim()) {
      includeKeywords(kwInput.value);
      kwInput.value = '';
    }
    closeModal();
    runExcludeCheck(true);
  });

  kwSearch.addEventListener('input', () => {
    renderKeywordList(kwSearch.value.trim());
  });

  chkHighlight.addEventListener('change', () => {
    config.highlightOnPage = chkHighlight.checked;
    saveData(STORAGE_KEY_CONFIG, config);
    if (!config.highlightOnPage) {
      clearPageHighlights();
    } else if (currentMatchedSet.size > 0) {
      highlightMatchesInDOM(Array.from(currentMatchedSet));
    }
  });

  chkAutoCheck.addEventListener('change', () => {
    config.autoCheckOnLoad = chkAutoCheck.checked;
    saveData(STORAGE_KEY_CONFIG, config);
    showToast(config.autoCheckOnLoad ? '已开启打开网页自动排除检测' : '已切换为手动点击“排除”检测');
  });

  chkAutoCollapse.addEventListener('change', () => {
    config.autoCollapseOutside = chkAutoCollapse.checked;
    saveData(STORAGE_KEY_CONFIG, config);
    showToast(config.autoCollapseOutside ? '已开启点击空白处自动折叠' : '已关闭点击空白处自动折叠');
  });

  // 导出备份
  btnExport.addEventListener('click', () => {
    if (keywordList.length === 0) {
      showToast('当前词库为空，无需导出');
      return;
    }
    const text = keywordList.map((i) => i.word).join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => showToast(`✅ 已复制 ${keywordList.length} 个关键字到剪贴板`))
        .catch(() => {
          kwInput.value = text;
          showToast('已将全部词库填入上方输入框，可全选复制');
        });
    } else {
      kwInput.value = text;
      showToast('已将全部词库填入上方输入框，可全选复制');
    }
  });

  // 导入词库
  btnImport.addEventListener('click', () => {
    if (kwInput.value.trim()) {
      includeKeywords(kwInput.value);
      kwInput.value = '';
      runExcludeCheck(false);
    } else {
      showToast('请先将备份的关键字粘贴到上方输入框，再点击“导入词库”或“确认纳入”');
    }
  });

  // 清空全部
  btnClearAll.addEventListener('click', () => {
    if (keywordList.length === 0) return;
    if (window.confirm(`确定要清空全部已纳入的 ${keywordList.length} 个APP关键字吗？`)) {
      keywordList = [];
      currentMatchedSet.clear();
      saveData(STORAGE_KEY_KEYWORDS, keywordList);
      renderKeywordList();
      mainPill.className = 'main-pill state-idle';
      statusLabel.textContent = '待检测';
      miniLabel.textContent = '防重';
      matchBanner.classList.remove('show');
      clearPageHighlights();
      showToast('已清空全部词库');
    }
  });

  // 注册油猴菜单快捷入口
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('🔍 立即排除检测当前网页', () => runExcludeCheck(true));
    GM_registerMenuCommand('➕ 打开APP纳入与词库管理', () => openModal());
  }

  // 初始化贴边折叠位置与可选自动检测
  renderDockPosition();
  if (config.autoCheckOnLoad && keywordList.length > 0) {
    setTimeout(() => runExcludeCheck(false), 600);
  }
})();