// ==UserScript==
// @name         APP体验防重助手（纳入与排除检测·可折叠贴边版）
// @namespace    https://tampermonkey.net/
// @version      1.2.0
// @description  安卓端浏览器专用：仅在检测到页面包含 .apk 或 .exe 资源/文本时唤醒悬浮检测界面，避免干扰日常浏览；支持本页安装包一键提取纳入、自动/手动排除检测、命中红灯高亮定位、未命中绿灯放行、贴边折叠与导入导出备份。
// @author       Gemini
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // 避免在嵌套 iframe 中重复运行
  if (window.top !== window.self) return;

  const STORAGE_KEY_KEYWORDS = 'tm_app_tracker_keywords_v1';
  const STORAGE_KEY_CONFIG = 'tm_app_tracker_config_v1';
  const HOST_ID = 'tm-app-tracker-shadow-host';
  const HIGHLIGHT_CLASS = 'tm-app-tracker-highlight-mark';
  const HIGHLIGHT_ACTIVE_CLASS = 'tm-app-tracker-highlight-active';

  // 匹配独立的文件后缀 .apk 或 .exe（避免误匹配 .execute / .apks 等词）
  const PKG_EXT_REGEX = /\.(?:apk|exe)(?![a-z0-9_])/i;
  const PKG_EXTRACT_REGEX = /([^\s"'<>()[\]{}，。；：、\\/]{1,64}\.(?:apk|exe))(?![a-z0-9_])/gi;

  // ==================== 1. 存储层（兼容油猴跨域名存储与 localStorage） ====================
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
  if (!Array.isArray(keywordList)) keywordList = [];

  let config = Object.assign(
    {
      posY: null,
      dockSide: 'right', // 'left' | 'right'
      isCollapsed: true,
      autoCollapseOutside: true,
      caseSensitive: false,
      highlightOnPage: true,
      autoCheckOnLoad: true, // 仅在 .apk/.exe 页面出现，默认自动静默检测更舒适
    },
    loadData(STORAGE_KEY_CONFIG, {})
  );

  // 缓存最近一次在网页中长按选中的文字（防止操作悬浮球时选区丢失）
  let lastSelectedText = '';
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection ? window.getSelection().toString().trim() : '';
    if (sel) {
      lastSelectedText = sel;
    }
  });

  // ==================== 2. 页面 .apk / .exe 探测与候选包名提取 ====================
  function cleanCandidateName(raw) {
    if (!raw) return '';
    let name = String(raw).trim();
    try {
      name = decodeURIComponent(name);
    } catch (_) {}
    // 取路径最后一段文件名
    const seg = name.split(/[\\/]/).pop() || name;
    // 去掉 query / hash
    const noQuery = seg.split(/[?#]/)[0].trim();
    // 去掉后缀与常见版本号尾巴，提取更有用的核心名称
    const base = noQuery.replace(/\.(?:apk|exe)$/i, '').trim();
    const cleaned = base
      .replace(/[_-]v?\d+(?:\.\d+){1,3}(?:[_-]?(?:arm64|armeabi|x64|x86|win64|win32|release|official|beta|alpha|signed))*$/i, '')
      .replace(/[_-](?:setup|installer|portable|android|windows)$/i, '')
      .trim();
    return cleaned || base;
  }

  function scanPagePackageSignals() {
    let detected = false;
    const rawPackages = new Set();
    const candidateNames = new Set();
    const linkHints = [];

    // 1) 检查当前 URL
    let decodedHref = location.href;
    try {
      decodedHref = decodeURIComponent(location.href);
    } catch (_) {}
    if (PKG_EXT_REGEX.test(decodedHref)) {
      detected = true;
      const matches = decodedHref.match(PKG_EXTRACT_REGEX) || [];
      matches.forEach((m) => {
        rawPackages.add(m);
        const clean = cleanCandidateName(m);
        if (clean && clean.length >= 2) candidateNames.add(clean);
      });
    }

    // 2) 检查下载链接与按钮属性
    const linkEls = document.querySelectorAll(
      'a[href], a[download], button, [data-url], [data-href], [data-download], [data-file], [title]'
    );
    for (const el of linkEls) {
      if (el.id === HOST_ID || el.closest(`#${HOST_ID}`)) continue;
      const attrs = [
        el.getAttribute('href'),
        el.getAttribute('download'),
        el.getAttribute('data-url'),
        el.getAttribute('data-href'),
        el.getAttribute('data-download'),
        el.getAttribute('data-file'),
        el.getAttribute('title'),
        el.getAttribute('aria-label'),
      ].filter(Boolean);

      let elMatched = false;
      for (const val of attrs) {
        let decoded = val;
        try {
          decoded = decodeURIComponent(val);
        } catch (_) {}
        if (PKG_EXT_REGEX.test(decoded)) {
          detected = true;
          elMatched = true;
          linkHints.push(decoded);
          const matches = decoded.match(PKG_EXTRACT_REGEX) || [];
          matches.forEach((m) => {
            rawPackages.add(m);
            const clean = cleanCandidateName(m);
            if (clean && clean.length >= 2) candidateNames.add(clean);
          });
        }
      }

      const txt = (el.textContent || '').trim();
      if (txt && PKG_EXT_REGEX.test(txt)) {
        detected = true;
        elMatched = true;
        const matches = txt.match(PKG_EXTRACT_REGEX) || [];
        matches.forEach((m) => {
          rawPackages.add(m);
          const clean = cleanCandidateName(m);
          if (clean && clean.length >= 2) candidateNames.add(clean);
        });
      } else if (elMatched && txt && txt.length >= 2 && txt.length <= 36) {
        // 如果链接本身指向 .apk/.exe 且按钮文字不是泛用词，也可作为候选名称
        if (!/^(?:下载|立即下载|高速下载|本地下载|点击下载|免费下载|download|apk|exe)$/i.test(txt)) {
          candidateNames.add(txt.replace(/\s*(?:下载|安装包)$/i, '').trim());
        }
      }

      if (rawPackages.size >= 20 && candidateNames.size >= 16) break;
    }

    // 3) 检查页面可见正文（body.innerText 不包含 script/style/Shadow DOM）
    const bodyText = document.body ? document.body.innerText || document.body.textContent || '' : '';
    if (bodyText && PKG_EXT_REGEX.test(bodyText)) {
      detected = true;
      let match;
      PKG_EXTRACT_REGEX.lastIndex = 0;
      let count = 0;
      while ((match = PKG_EXTRACT_REGEX.exec(bodyText)) !== null && count < 15) {
        const pkg = match[1];
        rawPackages.add(pkg);
        const clean = cleanCandidateName(pkg);
        if (clean && clean.length >= 2) candidateNames.add(clean);
        count++;
      }
    }

    return {
      detected,
      packageCount: rawPackages.size,
      rawPackages: Array.from(rawPackages).slice(0, 12),
      candidates: Array.from(candidateNames).slice(0, 10),
      searchableAttrText: linkHints.join('\n'),
    };
  }

  // ==================== 3. 网页正文高亮注入 ====================
  function ensurePageHighlightStyle() {
    if (document.getElementById('tm-app-tracker-page-style')) return;
    const style = document.createElement('style');
    style.id = 'tm-app-tracker-page-style';
    style.textContent = `
      .${HIGHLIGHT_CLASS} {
        background-color: #fff176 !important;
        color: #b71c1c !important;
        font-weight: 700 !important;
        padding: 0 3px !important;
        border-radius: 4px !important;
        box-shadow: 0 0 0 1.5px rgba(229, 57, 53, 0.45) !important;
      }
      .${HIGHLIGHT_CLASS}.${HIGHLIGHT_ACTIVE_CLASS} {
        background-color: #ff5252 !important;
        color: #ffffff !important;
        box-shadow: 0 0 0 3px rgba(255, 82, 82, 0.45) !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
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
    if (!config.highlightOnPage || !matchedWords || matchedWords.length === 0 || !document.body) return;
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
          tag === 'TEMPLATE' ||
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
        if (textNodes.length >= 160) break;
      }
    }

    textNodes.forEach((textNode) => {
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

  // ==================== 4. 惰性挂载 Shadow DOM 界面（仅检测到 .apk/.exe 或手动唤醒时创建） ====================
  let uiMounted = false;
  let uiVisible = false;
  let forceShown = false;
  let lastSignals = { detected: false, packageCount: 0, rawPackages: [], candidates: [], searchableAttrText: '' };

  let hostEl = null;
  let shadow = null;
  let els = null;
  let currentMatchedSet = new Set();
  let jumpIdx = 0;
  let toastTimer = null;

  function showToast(msg) {
    if (!uiMounted || !els) return;
    els.toastEl.textContent = msg;
    els.toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toastEl.classList.remove('show');
    }, 2400);
  }

  function clampY(y) {
    const topSafe = 12;
    const maxH = window.innerHeight - 64;
    return Math.max(topSafe, Math.min(y, maxH > topSafe ? maxH : window.innerHeight - 48));
  }

  function renderDockPosition() {
    if (!uiMounted || !els) return;
    const y = clampY(typeof config.posY === 'number' ? config.posY : Math.floor(window.innerHeight * 0.7));
    els.widget.style.top = `${y}px`;
    els.widget.classList.toggle('collapsed', !!config.isCollapsed);
    els.widget.classList.toggle('dock-left', config.dockSide === 'left');
    els.widget.classList.toggle('dock-right', config.dockSide !== 'left');

    if (config.dockSide === 'left') {
      els.widget.style.left = config.isCollapsed ? '0px' : '10px';
      els.widget.style.right = 'auto';
    } else {
      els.widget.style.right = config.isCollapsed ? '0px' : '10px';
      els.widget.style.left = 'auto';
    }
  }

  function setCollapsed(collapsed) {
    config.isCollapsed = !!collapsed;
    saveData(STORAGE_KEY_CONFIG, config);
    renderDockPosition();
  }

  function getPageSearchText() {
    const visibleText = document.body ? document.body.innerText || document.body.textContent || '' : '';
    return `${visibleText}\n${lastSignals.searchableAttrText || ''}`;
  }

  function runExcludeCheck(showNotice = true) {
    if (!uiMounted) mountUI();

    if (!keywordList || keywordList.length === 0) {
      els.mainPill.className = 'main-pill state-idle';
      els.statusLabel.textContent = '词库为空';
      els.miniLabel.textContent = '防重';
      els.matchBanner.classList.remove('show');
      clearPageHighlights();
      if (showNotice) {
        showToast('⚠️ 词库为空，请先点击“纳入”添加关键字');
      }
      renderKeywordList(els.kwSearch.value.trim());
      renderCandidateChips();
      return;
    }

    const rawPageText = getPageSearchText();
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

    jumpIdx = 0;

    if (matchedWords.length > 0) {
      els.mainPill.className = 'main-pill state-red';
      els.statusLabel.textContent = `已体验(${matchedWords.length})`;
      els.miniLabel.textContent = `红·${matchedWords.length}`;
      els.matchWordsText.textContent =
        matchedWords.slice(0, 6).join('、') + (matchedWords.length > 6 ? ` 等${matchedWords.length}个` : '');
      els.matchBanner.classList.add('show');
      highlightMatchesInDOM(matchedWords);
      updateJumpButtonLabel();
      if (showNotice) {
        showToast(`🔴 发现 ${matchedWords.length} 个已体验关键字：${matchedWords.slice(0, 3).join('、')}`);
      }
    } else {
      els.mainPill.className = 'main-pill state-green';
      els.statusLabel.textContent = '未体验·放行';
      els.miniLabel.textContent = '绿✓';
      els.matchBanner.classList.remove('show');
      clearPageHighlights();
      if (showNotice) {
        showToast('🟢 未命中已纳入关键字，可放心体验');
      }
    }

    renderKeywordList(els.kwSearch.value.trim());
    renderCandidateChips();
  }

  function updateJumpButtonLabel() {
    if (!els) return;
    const marks = document.querySelectorAll(`.${HIGHLIGHT_CLASS}`);
    if (marks.length > 0) {
      els.btnJumpHighlight.textContent = `定位命中 (${marks.length}处)`;
      els.btnJumpHighlight.style.display = 'inline-flex';
    } else {
      els.btnJumpHighlight.style.display = 'none';
    }
  }

  function includeKeywords(rawInput) {
    if (!rawInput || !rawInput.trim()) {
      showToast('请输入或选择要纳入的APP名称');
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
      if (uiMounted) {
        renderKeywordList(els.kwSearch.value.trim());
        renderCandidateChips();
      }
      showToast(`✅ 已纳入 ${addedCount} 个关键字（词库共 ${keywordList.length} 个）`);
    } else {
      showToast('ℹ️ 该关键字已在词库中');
    }
    return addedCount;
  }

  function removeKeyword(wordToRemove) {
    keywordList = keywordList.filter((item) => item.word !== wordToRemove);
    currentMatchedSet.delete(wordToRemove);
    saveData(STORAGE_KEY_KEYWORDS, keywordList);
    if (uiMounted) {
      renderKeywordList(els.kwSearch.value.trim());
      renderCandidateChips();
    }
    showToast(`已移除：${wordToRemove}`);
  }

  function renderCandidateChips() {
    if (!els) return;
    const container = els.candidateList;
    container.innerHTML = '';

    const candidates = lastSignals.candidates || [];
    if (candidates.length === 0) {
      els.candidateSection.style.display = 'none';
      return;
    }

    els.candidateSection.style.display = 'block';
    const existingSet = new Set(
      keywordList.map((item) => (config.caseSensitive ? item.word : item.word.toLowerCase()))
    );

    candidates.forEach((word) => {
      const norm = config.caseSensitive ? word : word.toLowerCase();
      const alreadyAdded = existingSet.has(norm);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `cand-chip${alreadyAdded ? ' added' : ''}`;
      chip.textContent = alreadyAdded ? `✓ ${word}` : `+ ${word}`;
      chip.title = alreadyAdded ? '已在词库中' : '点击一键纳入词库';
      chip.addEventListener('click', () => {
        if (alreadyAdded) {
          showToast(`“${word}” 已在词库中`);
          return;
        }
        const added = includeKeywords(word);
        if (added > 0) {
          runExcludeCheck(false);
        }
      });
      container.appendChild(chip);
    });
  }

  function renderKeywordList(filterText = '') {
    if (!els) return;
    els.kwCount.textContent = String(keywordList.length);
    els.kwListContainer.innerHTML = '';

    const normFilter = filterText.toLowerCase();
    const filtered = keywordList.filter((item) =>
      !normFilter ? true : item.word.toLowerCase().includes(normFilter)
    );

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-tip';
      empty.textContent = filterText ? '没有匹配的关键字' : '词库暂无数据，点击上方安装包标签或手动输入即可纳入';
      els.kwListContainer.appendChild(empty);
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

      const textSpan = document.createElement('span');
      textSpan.textContent = item.word;

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'kw-del';
      delBtn.textContent = '×';
      delBtn.setAttribute('aria-label', `删除 ${item.word}`);
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeKeyword(item.word);
      });

      tag.appendChild(textSpan);
      tag.appendChild(delBtn);
      els.kwListContainer.appendChild(tag);
    });
  }

  function openModal() {
    if (!uiMounted) mountUI();
    showWidget();
    lastSignals = scanPagePackageSignals();
    els.signalBadge.textContent = lastSignals.detected
      ? `本页含 .apk/.exe（识别到 ${Math.max(1, lastSignals.packageCount)} 处）`
      : '当前页面未发现 .apk/.exe（手动打开）';
    renderCandidateChips();
    renderKeywordList(els.kwSearch.value.trim());
    els.modalBackdrop.classList.add('open');
  }

  function closeModal() {
    if (!els) return;
    els.modalBackdrop.classList.remove('open');
  }

  function mountUI() {
    if (uiMounted) return;
    uiMounted = true;

    hostEl = document.createElement('div');
    hostEl.id = HOST_ID;
    hostEl.style.cssText =
      'all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0; width: 0; height: 0; pointer-events: auto;';
    document.documentElement.appendChild(hostEl);

    shadow = hostEl.attachShadow({ mode: 'open' });

    const styleEl = document.createElement('style');
    styleEl.textContent = `
      * {
        box-sizing: border-box;
        -webkit-tap-highlight-color: transparent;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
      }

      .widget-container {
        position: fixed;
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        user-select: none;
        touch-action: none;
        transition: left 0.22s cubic-bezier(0.2, 0.8, 0.2, 1), right 0.22s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.2s ease;
      }
      .widget-container.hidden-ui {
        display: none !important;
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

      /* 悬浮胶囊 */
      .main-pill {
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 40px;
        padding: 5px 10px;
        border-radius: 999px;
        color: #ffffff;
        font-size: 13px;
        font-weight: 600;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
        transition: all 0.22s ease;
        border: 1.5px solid rgba(255, 255, 255, 0.78);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        cursor: pointer;
      }

      /* 折叠态：小巧贴边半隐藏 */
      .widget-container.collapsed .main-pill {
        min-height: 36px;
        padding: 5px 10px;
        gap: 5px;
        opacity: 0.68;
        box-shadow: 0 3px 10px rgba(0, 0, 0, 0.22);
      }
      .widget-container.collapsed.dock-right .main-pill {
        border-top-right-radius: 0;
        border-bottom-right-radius: 0;
        border-right: none;
        padding-right: 12px;
        transform: translateX(26%);
      }
      .widget-container.collapsed.dock-left .main-pill {
        border-top-left-radius: 0;
        border-bottom-left-radius: 0;
        border-left: none;
        padding-left: 12px;
        transform: translateX(-26%);
      }
      .widget-container.collapsed .main-pill.state-red,
      .widget-container.collapsed .main-pill.state-green {
        opacity: 0.96;
        transform: translateX(8%);
      }
      .widget-container.collapsed.dock-left .main-pill.state-red,
      .widget-container.collapsed.dock-left .main-pill.state-green {
        transform: translateX(-8%);
      }

      .widget-container.collapsed .expanded-only {
        display: none !important;
      }
      .collapsed-only {
        display: none;
        font-size: 12px;
        font-weight: 700;
        line-height: 1;
        letter-spacing: 0.3px;
      }
      .widget-container.collapsed .collapsed-only {
        display: inline-block;
      }

      .state-idle {
        background: linear-gradient(135deg, #37474f, #1c262b);
      }
      .state-red {
        background: linear-gradient(135deg, #e53935, #b71c1c);
        box-shadow: 0 0 0 3px rgba(229, 57, 53, 0.35), 0 6px 18px rgba(183, 28, 28, 0.5);
        animation: pulse-red 1.8s infinite;
      }
      .state-green {
        background: linear-gradient(135deg, #2e7d32, #1b5e20);
        box-shadow: 0 0 0 3px rgba(46, 125, 50, 0.28), 0 6px 18px rgba(27, 94, 32, 0.45);
      }

      @keyframes pulse-red {
        0% { box-shadow: 0 0 0 0 rgba(229, 57, 53, 0.55), 0 4px 14px rgba(183, 28, 28, 0.4); }
        70% { box-shadow: 0 0 0 9px rgba(229, 57, 53, 0), 0 4px 14px rgba(183, 28, 28, 0.4); }
        100% { box-shadow: 0 0 0 0 rgba(229, 57, 53, 0), 0 4px 14px rgba(183, 28, 28, 0.4); }
      }

      .status-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #b0bec5;
        border: 1.5px solid #ffffff;
        flex-shrink: 0;
      }
      .state-red .status-dot { background: #ffeb3b; }
      .state-green .status-dot { background: #69f0ae; }

      .status-label {
        padding-right: 2px;
        white-space: nowrap;
        font-size: 12.5px;
      }

      .pill-btn {
        border: none;
        outline: none;
        background: rgba(255, 255, 255, 0.2);
        color: #ffffff;
        font-size: 12.5px;
        font-weight: 600;
        min-height: 30px;
        padding: 4px 10px;
        border-radius: 999px;
        cursor: pointer;
        white-space: nowrap;
        transition: background 0.15s, transform 0.1s;
      }
      .pill-btn:active {
        background: rgba(255, 255, 255, 0.38);
        transform: scale(0.95);
      }
      .pill-btn-fold {
        background: rgba(0, 0, 0, 0.26);
        padding: 4px 9px;
        font-size: 12px;
      }

      /* 命中结果快捷浮条 */
      .match-banner {
        margin-top: 8px;
        width: min(290px, calc(100vw - 24px));
        background: rgba(24, 26, 30, 0.96);
        color: #f5f5f5;
        padding: 10px 12px;
        border-radius: 14px;
        font-size: 12.5px;
        line-height: 1.45;
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
        display: none;
        word-break: break-word;
      }
      .match-banner.show { display: block; }
      .widget-container.collapsed .match-banner { display: none !important; }
      .match-banner .match-words {
        color: #ff8a80;
        font-weight: 700;
      }
      .banner-actions {
        display: flex;
        gap: 6px;
        margin-top: 8px;
        flex-wrap: wrap;
      }
      .banner-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 28px;
        padding: 3px 10px;
        border-radius: 8px;
        font-size: 11.5px;
        font-weight: 600;
        cursor: pointer;
        border: none;
      }
      .banner-btn-jump {
        background: #e53935;
        color: #ffffff;
      }
      .banner-btn-clear {
        background: rgba(255, 255, 255, 0.14);
        color: #e0e0e0;
      }

      /* 安卓适配 Bottom-Sheet / 居中弹窗 */
      .modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.55);
        backdrop-filter: blur(3px);
        -webkit-backdrop-filter: blur(3px);
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
        max-width: 440px;
        max-height: 86dvh;
        background: #ffffff;
        color: #1f2937;
        border-radius: 20px;
        box-shadow: 0 18px 45px rgba(0, 0, 0, 0.32);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      @media (max-width: 600px) {
        .modal-backdrop {
          align-items: flex-end;
          padding: 0;
        }
        .modal-card {
          max-width: 100%;
          max-height: 88dvh;
          border-radius: 22px 22px 0 0;
          padding-bottom: env(safe-area-inset-bottom, 0px);
        }
      }

      .sheet-handle {
        display: none;
        width: 38px;
        height: 4px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.38);
        margin: 8px auto 2px;
      }
      @media (max-width: 600px) {
        .sheet-handle { display: block; }
      }

      .modal-header {
        background: linear-gradient(135deg, #1f2937, #111827);
        color: #ffffff;
        padding: 4px 16px 12px;
        flex-shrink: 0;
      }
      @media (min-width: 601px) {
        .modal-header { padding-top: 14px; }
      }
      .modal-header-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .modal-title {
        font-size: 16px;
        font-weight: 700;
      }
      .signal-badge {
        margin-top: 4px;
        display: inline-block;
        font-size: 11.5px;
        color: #93c5fd;
        background: rgba(59, 130, 246, 0.16);
        padding: 2px 8px;
        border-radius: 999px;
      }
      .close-btn {
        background: rgba(255, 255, 255, 0.14);
        border: none;
        color: #e5e7eb;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        font-size: 20px;
        line-height: 1;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .modal-body {
        padding: 14px 16px 18px;
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
        display: flex;
        flex-direction: column;
        gap: 14px;
        font-size: 13.5px;
      }

      .candidate-box {
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        padding: 10px 12px;
      }
      .candidate-title {
        font-size: 12px;
        font-weight: 700;
        color: #334155;
        margin-bottom: 8px;
      }
      .candidate-list {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .cand-chip {
        border: 1px solid #bfdbfe;
        background: #eff6ff;
        color: #1d4ed8;
        font-size: 12px;
        font-weight: 600;
        padding: 5px 10px;
        border-radius: 999px;
        cursor: pointer;
      }
      .cand-chip.added {
        border-color: #bbf7d0;
        background: #f0fdf4;
        color: #15803d;
      }

      .input-group {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .input-group label {
        font-weight: 700;
        color: #334155;
        font-size: 12.5px;
      }
      .text-input {
        width: 100%;
        padding: 10px 12px;
        border: 1.5px solid #cbd5e1;
        border-radius: 12px;
        font-size: 14px;
        outline: none;
        resize: vertical;
        min-height: 52px;
        background: #ffffff;
        color: #0f172a;
      }
      .text-input:focus {
        border-color: #2563eb;
      }

      .action-row {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 8px;
      }
      .action-row-4 {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 8px;
      }
      @media (min-width: 420px) {
        .action-row-4 {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      .btn {
        min-height: 40px;
        padding: 8px 10px;
        border: none;
        border-radius: 11px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        text-align: center;
      }
      .btn:active { transform: scale(0.97); }
      .btn-primary { background: #2563eb; color: #fff; }
      .btn-success { background: #16a34a; color: #fff; }
      .btn-danger { background: #dc2626; color: #fff; }
      .btn-secondary { background: #f1f5f9; color: #334155; }

      .section-title {
        font-size: 12.5px;
        font-weight: 700;
        color: #475569;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        border-top: 1px solid #e2e8f0;
        padding-top: 12px;
      }
      .search-input {
        padding: 6px 10px;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        font-size: 12.5px;
        width: 145px;
        outline: none;
      }

      .keyword-list {
        max-height: 170px;
        overflow-y: auto;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        padding: 8px;
        display: flex;
        flex-wrap: wrap;
        gap: 7px;
        background: #f8fafc;
      }
      .kw-tag {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 5px 9px;
        border-radius: 8px;
        background: #e0f2fe;
        color: #0369a1;
        font-size: 12.5px;
        font-weight: 500;
        max-width: 100%;
        word-break: break-all;
      }
      .kw-tag.matched {
        background: #fee2e2;
        color: #b91c1c;
        border: 1px solid #fca5a5;
        font-weight: 700;
      }
      .kw-del {
        border: none;
        background: rgba(0, 0, 0, 0.14);
        color: inherit;
        border-radius: 50%;
        width: 18px;
        height: 18px;
        font-size: 12px;
        line-height: 18px;
        text-align: center;
        padding: 0;
        cursor: pointer;
        flex-shrink: 0;
      }

      .empty-tip {
        color: #94a3b8;
        font-size: 12.5px;
        padding: 14px 8px;
        text-align: center;
        width: 100%;
      }

      .settings-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        padding: 10px 12px;
        font-size: 12.5px;
        color: #334155;
      }
      .switch-item {
        display: flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
      }
      .switch-item input {
        width: 16px;
        height: 16px;
        accent-color: #2563eb;
      }

      .toast {
        position: fixed;
        bottom: calc(24px + env(safe-area-inset-bottom, 0px));
        left: 50%;
        transform: translateX(-50%);
        background: rgba(17, 24, 39, 0.94);
        color: #ffffff;
        padding: 9px 16px;
        border-radius: 999px;
        font-size: 13px;
        max-width: 88vw;
        text-align: center;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s ease;
        z-index: 2147483647;
      }
      .toast.show {
        opacity: 1;
      }
    `;
    shadow.appendChild(styleEl);

    const widget = document.createElement('div');
    widget.className = 'widget-container';
    widget.innerHTML = `
      <div class="main-pill state-idle" id="mainPill" title="点击展开 / 按住可拖拽">
        <span class="status-dot"></span>
        <span class="collapsed-only" id="miniLabel">防重</span>
        <span class="status-label expanded-only" id="statusLabel">待检测</span>
        <button type="button" class="pill-btn expanded-only" id="btnInclude">纳入</button>
        <button type="button" class="pill-btn expanded-only" id="btnExclude">排除</button>
        <button type="button" class="pill-btn expanded-only" id="btnManage">词库</button>
        <button type="button" class="pill-btn pill-btn-fold expanded-only" id="btnCollapse" title="折叠贴边">收起</button>
      </div>
      <div class="match-banner" id="matchBanner">
        <div>⚠️ 发现已体验 APP：<span class="match-words" id="matchWordsText"></span></div>
        <div class="banner-actions">
          <button type="button" class="banner-btn banner-btn-jump" id="btnJumpHighlight">定位命中</button>
          <button type="button" class="banner-btn banner-btn-clear" id="btnHideHighlight">隐藏高亮</button>
        </div>
      </div>
    `;
    shadow.appendChild(widget);

    const modalBackdrop = document.createElement('div');
    modalBackdrop.className = 'modal-backdrop';
    modalBackdrop.innerHTML = `
      <div class="modal-card">
        <div class="modal-header">
          <div class="sheet-handle"></div>
          <div class="modal-header-row">
            <span class="modal-title">APP 体验防重助手</span>
            <button type="button" class="close-btn" id="btnCloseModal" aria-label="关闭">×</button>
          </div>
          <div class="signal-badge" id="signalBadge">检测状态</div>
        </div>
        <div class="modal-body">
          <div class="candidate-box" id="candidateSection" style="display:none;">
            <div class="candidate-title">📦 本页识别到的 .apk/.exe 名称（点击一键纳入）：</div>
            <div class="candidate-list" id="candidateList"></div>
          </div>

          <div class="input-group">
            <label for="kwInput">纳入新 APP 关键字（换行或逗号可批量添加）：</label>
            <textarea class="text-input" id="kwInput" rows="2" placeholder="输入已体验的 APP 名称或关键字..."></textarea>
          </div>

          <div class="action-row">
            <button type="button" class="btn btn-primary" id="btnConfirmAdd">确认纳入</button>
            <button type="button" class="btn btn-secondary" id="btnFillSelection">填入选中字</button>
            <button type="button" class="btn btn-success" id="btnModalExclude">立即排除</button>
          </div>

          <div class="section-title">
            <span>已纳入词库 (<span id="kwCount">0</span>)</span>
            <input type="text" class="search-input" id="kwSearch" placeholder="搜索词库...">
          </div>
          <div class="keyword-list" id="kwListContainer"></div>

          <div class="settings-grid">
            <label class="switch-item"><input type="checkbox" id="chkAutoCheck"> 发现包时自动检测</label>
            <label class="switch-item"><input type="checkbox" id="chkHighlight"> 命中高亮网页</label>
            <label class="switch-item"><input type="checkbox" id="chkAutoCollapse"> 点空白处收起</label>
            <label class="switch-item"><input type="checkbox" id="chkCaseSensitive"> 区分大小写</label>
          </div>

          <div class="action-row-4">
            <button type="button" class="btn btn-secondary" id="btnExportClip">复制导出</button>
            <button type="button" class="btn btn-secondary" id="btnExportFile">导出文件</button>
            <button type="button" class="btn btn-secondary" id="btnImport">导入词库</button>
            <button type="button" class="btn btn-danger" id="btnClearAll">清空全部</button>
          </div>
          <input type="file" id="fileImportInput" accept=".txt,.json,text/plain,application/json" style="display:none;">
        </div>
      </div>
    `;
    shadow.appendChild(modalBackdrop);

    const toastEl = document.createElement('div');
    toastEl.className = 'toast';
    shadow.appendChild(toastEl);

    els = {
      widget,
      mainPill: shadow.getElementById('mainPill'),
      miniLabel: shadow.getElementById('miniLabel'),
      statusLabel: shadow.getElementById('statusLabel'),
      btnInclude: shadow.getElementById('btnInclude'),
      btnExclude: shadow.getElementById('btnExclude'),
      btnManage: shadow.getElementById('btnManage'),
      btnCollapse: shadow.getElementById('btnCollapse'),
      matchBanner: shadow.getElementById('matchBanner'),
      matchWordsText: shadow.getElementById('matchWordsText'),
      btnJumpHighlight: shadow.getElementById('btnJumpHighlight'),
      btnHideHighlight: shadow.getElementById('btnHideHighlight'),
      modalBackdrop,
      signalBadge: shadow.getElementById('signalBadge'),
      candidateSection: shadow.getElementById('candidateSection'),
      candidateList: shadow.getElementById('candidateList'),
      btnCloseModal: shadow.getElementById('btnCloseModal'),
      kwInput: shadow.getElementById('kwInput'),
      btnConfirmAdd: shadow.getElementById('btnConfirmAdd'),
      btnFillSelection: shadow.getElementById('btnFillSelection'),
      btnModalExclude: shadow.getElementById('btnModalExclude'),
      kwCount: shadow.getElementById('kwCount'),
      kwSearch: shadow.getElementById('kwSearch'),
      kwListContainer: shadow.getElementById('kwListContainer'),
      chkAutoCheck: shadow.getElementById('chkAutoCheck'),
      chkHighlight: shadow.getElementById('chkHighlight'),
      chkAutoCollapse: shadow.getElementById('chkAutoCollapse'),
      chkCaseSensitive: shadow.getElementById('chkCaseSensitive'),
      btnExportClip: shadow.getElementById('btnExportClip'),
      btnExportFile: shadow.getElementById('btnExportFile'),
      btnImport: shadow.getElementById('btnImport'),
      btnClearAll: shadow.getElementById('btnClearAll'),
      fileImportInput: shadow.getElementById('fileImportInput'),
      toastEl,
    };

    els.chkAutoCheck.checked = config.autoCheckOnLoad !== false;
    els.chkHighlight.checked = !!config.highlightOnPage;
    els.chkAutoCollapse.checked = config.autoCollapseOutside !== false;
    els.chkCaseSensitive.checked = !!config.caseSensitive;

    bindWidgetEvents();
    renderDockPosition();
  }

  function showWidget() {
    if (!uiMounted) mountUI();
    uiVisible = true;
    els.widget.classList.remove('hidden-ui');
    renderDockPosition();
  }

  function hideWidget() {
    if (!uiMounted) return;
    uiVisible = false;
    els.widget.classList.add('hidden-ui');
    closeModal();
    clearPageHighlights();
  }

  function bindWidgetEvents() {
    let isDragging = false;
    let hasMoved = false;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    function onDragStart(clientX, clientY, target) {
      if (!config.isCollapsed && target && target.tagName === 'BUTTON') return;
      isDragging = true;
      hasMoved = false;
      startX = clientX;
      startY = clientY;
      const rect = els.widget.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      els.widget.classList.add('dragging');
    }

    function onDragMove(clientX, clientY) {
      if (!isDragging) return;
      const dx = clientX - startX;
      const dy = clientY - startY;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
        hasMoved = true;
      }
      if (hasMoved) {
        const rect = els.widget.getBoundingClientRect();
        const maxX = window.innerWidth - (rect.width || 60);
        const nextX = Math.max(0, Math.min(initialLeft + dx, maxX));
        const nextY = clampY(initialTop + dy);
        els.widget.style.left = `${nextX}px`;
        els.widget.style.right = 'auto';
        els.widget.style.top = `${nextY}px`;
      }
    }

    function onDragEnd() {
      if (!isDragging) return;
      isDragging = false;
      els.widget.classList.remove('dragging');
      if (hasMoved) {
        const rect = els.widget.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        config.dockSide = centerX < window.innerWidth / 2 ? 'left' : 'right';
        config.posY = Math.round(clampY(rect.top));
        saveData(STORAGE_KEY_CONFIG, config);
        renderDockPosition();
      }
    }

    els.mainPill.addEventListener(
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

    els.mainPill.addEventListener('mousedown', (e) => {
      onDragStart(e.clientX, e.clientY, e.target);
    });
    window.addEventListener('mousemove', (e) => {
      if (isDragging) onDragMove(e.clientX, e.clientY);
    });
    window.addEventListener('mouseup', onDragEnd);
    window.addEventListener('resize', renderDockPosition);

    // 点击网页空白处自动收起
    document.addEventListener(
      'touchstart',
      (e) => {
        if (!uiVisible || !config.autoCollapseOutside || config.isCollapsed) return;
        if (els.modalBackdrop.classList.contains('open')) return;
        if (e.target === hostEl || hostEl.contains(e.target)) return;
        setCollapsed(true);
      },
      { passive: true }
    );
    document.addEventListener('mousedown', (e) => {
      if (!uiVisible || !config.autoCollapseOutside || config.isCollapsed) return;
      if (els.modalBackdrop.classList.contains('open')) return;
      if (e.target === hostEl || hostEl.contains(e.target)) return;
      setCollapsed(true);
    });

    els.mainPill.addEventListener('click', (e) => {
      if (hasMoved) return;
      if (config.isCollapsed) {
        e.stopPropagation();
        setCollapsed(false);
      }
    });

    els.btnCollapse.addEventListener('click', (e) => {
      e.stopPropagation();
      setCollapsed(true);
    });

    els.btnInclude.addEventListener('click', (e) => {
      e.stopPropagation();
      const currentSel = (window.getSelection && window.getSelection().toString().trim()) || lastSelectedText;
      openModal();
      if (currentSel) {
        els.kwInput.value = currentSel;
        lastSelectedText = '';
        if (window.getSelection) {
          window.getSelection().removeAllRanges();
        }
        showToast('已自动提取网页选中文字，点击“确认纳入”即可保存');
      } else if ((lastSignals.candidates || []).length === 0) {
        setTimeout(() => els.kwInput.focus(), 80);
      }
    });

    els.btnExclude.addEventListener('click', (e) => {
      e.stopPropagation();
      lastSignals = scanPagePackageSignals();
      runExcludeCheck(true);
    });

    els.btnManage.addEventListener('click', (e) => {
      e.stopPropagation();
      openModal();
    });

    els.statusLabel.addEventListener('click', (e) => {
      if (!hasMoved && !config.isCollapsed) {
        e.stopPropagation();
        lastSignals = scanPagePackageSignals();
        runExcludeCheck(true);
      }
    });

    els.btnJumpHighlight.addEventListener('click', (e) => {
      e.stopPropagation();
      const marks = document.querySelectorAll(`.${HIGHLIGHT_CLASS}`);
      if (marks.length === 0) {
        showToast('当前未开启高亮或页面无高亮节点');
        return;
      }
      marks.forEach((m) => m.classList.remove(HIGHLIGHT_ACTIVE_CLASS));
      jumpIdx = jumpIdx % marks.length;
      const target = marks[jumpIdx];
      target.classList.add(HIGHLIGHT_ACTIVE_CLASS);
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      showToast(`定位第 ${jumpIdx + 1}/${marks.length} 处：${target.textContent}`);
      jumpIdx++;
    });

    els.btnHideHighlight.addEventListener('click', (e) => {
      e.stopPropagation();
      clearPageHighlights();
      els.btnJumpHighlight.style.display = 'none';
      showToast('已清除当前页高亮标记');
    });

    els.btnCloseModal.addEventListener('click', closeModal);
    els.modalBackdrop.addEventListener('click', (e) => {
      if (e.target === els.modalBackdrop) closeModal();
    });

    els.btnConfirmAdd.addEventListener('click', () => {
      const added = includeKeywords(els.kwInput.value);
      if (added > 0) {
        els.kwInput.value = '';
        runExcludeCheck(false);
      }
    });

    els.btnFillSelection.addEventListener('click', () => {
      const sel = (window.getSelection && window.getSelection().toString().trim()) || lastSelectedText;
      if (sel) {
        els.kwInput.value = els.kwInput.value ? `${els.kwInput.value}\n${sel}` : sel;
        showToast('已填入网页选中文本');
      } else {
        showToast('请先在网页上长按选中 APP 名称');
      }
    });

    els.btnModalExclude.addEventListener('click', () => {
      if (els.kwInput.value.trim()) {
        includeKeywords(els.kwInput.value);
        els.kwInput.value = '';
      }
      closeModal();
      lastSignals = scanPagePackageSignals();
      runExcludeCheck(true);
    });

    els.kwSearch.addEventListener('input', () => {
      renderKeywordList(els.kwSearch.value.trim());
    });

    els.chkAutoCheck.addEventListener('change', () => {
      config.autoCheckOnLoad = els.chkAutoCheck.checked;
      saveData(STORAGE_KEY_CONFIG, config);
      showToast(config.autoCheckOnLoad ? '已开启发现 .apk/.exe 时自动检测' : '已切换为手动点击“排除”检测');
    });

    els.chkHighlight.addEventListener('change', () => {
      config.highlightOnPage = els.chkHighlight.checked;
      saveData(STORAGE_KEY_CONFIG, config);
      if (!config.highlightOnPage) {
        clearPageHighlights();
      } else if (currentMatchedSet.size > 0) {
        highlightMatchesInDOM(Array.from(currentMatchedSet));
      }
      updateJumpButtonLabel();
    });

    els.chkAutoCollapse.addEventListener('change', () => {
      config.autoCollapseOutside = els.chkAutoCollapse.checked;
      saveData(STORAGE_KEY_CONFIG, config);
      showToast(config.autoCollapseOutside ? '已开启点击空白处自动收起' : '已关闭点击空白处自动收起');
    });

    els.chkCaseSensitive.addEventListener('change', () => {
      config.caseSensitive = els.chkCaseSensitive.checked;
      saveData(STORAGE_KEY_CONFIG, config);
      runExcludeCheck(false);
      showToast(config.caseSensitive ? '已开启区分英文大小写' : '已关闭区分大小写');
    });

    els.btnExportClip.addEventListener('click', () => {
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
            els.kwInput.value = text;
            showToast('剪贴板受限，已填入上方输入框请全选复制');
          });
      } else {
        els.kwInput.value = text;
        showToast('已将全部词库填入上方输入框，可全选复制');
      }
    });

    els.btnExportFile.addEventListener('click', () => {
      if (keywordList.length === 0) {
        showToast('当前词库为空，无需导出');
        return;
      }
      const text = keywordList.map((i) => i.word).join('\n');
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `app_tracker_keywords_${new Date().toISOString().slice(0, 10)}.txt`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      showToast(`✅ 已导出 ${keywordList.length} 个关键字文件`);
    });

    els.btnImport.addEventListener('click', () => {
      if (els.kwInput.value.trim()) {
        const added = includeKeywords(els.kwInput.value);
        if (added > 0) {
          els.kwInput.value = '';
          runExcludeCheck(false);
        }
      } else {
        els.fileImportInput.value = '';
        els.fileImportInput.click();
      }
    });

    els.fileImportInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        let content = String(reader.result || '').trim();
        if (!content) {
          showToast('所选文件内容为空');
          return;
        }
        try {
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed)) {
            content = parsed.map((x) => (typeof x === 'string' ? x : x && x.word)).filter(Boolean).join('\n');
          }
        } catch (_) {}
        const added = includeKeywords(content);
        if (added > 0) runExcludeCheck(false);
      };
      reader.readAsText(file, 'utf-8');
    });

    els.btnClearAll.addEventListener('click', () => {
      if (keywordList.length === 0) return;
      if (window.confirm(`确定要清空全部已纳入的 ${keywordList.length} 个 APP 关键字吗？`)) {
        keywordList = [];
        currentMatchedSet.clear();
        saveData(STORAGE_KEY_KEYWORDS, keywordList);
        renderKeywordList();
        renderCandidateChips();
        els.mainPill.className = 'main-pill state-idle';
        els.statusLabel.textContent = '待检测';
        els.miniLabel.textContent = '防重';
        els.matchBanner.classList.remove('show');
        clearPageHighlights();
        showToast('已清空全部词库');
      }
    });
  }

  // ==================== 5. 按需唤醒逻辑（仅检测到 .apk/.exe 时激活） ====================
  let evaluateTimer = null;
  function evaluatePageActivation(isRouteChange = false) {
    lastSignals = scanPagePackageSignals();

    if (lastSignals.detected || forceShown) {
      const firstActivate = !uiVisible;
      showWidget();
      if (firstActivate || isRouteChange) {
        if (config.autoCheckOnLoad && keywordList.length > 0) {
          runExcludeCheck(false);
        } else {
          renderCandidateChips();
        }
      }
    } else if (isRouteChange && uiVisible && !forceShown) {
      hideWidget();
    }
  }

  function scheduleEvaluate(delay = 450, isRouteChange = false) {
    clearTimeout(evaluateTimer);
    evaluateTimer = setTimeout(() => evaluatePageActivation(isRouteChange), delay);
  }

  // 监听动态加载（网盘/应用市场/SPA 异步渲染 .apk 或 .exe 链接）
  if (document.body) {
    const observer = new MutationObserver((mutations) => {
      if (uiVisible) return; // 已激活后无需频繁重扫
      for (const m of mutations) {
        if (m.target && (m.target.id === HOST_ID || (m.target.closest && m.target.closest(`#${HOST_ID}`)))) {
          continue;
        }
        scheduleEvaluate(500, false);
        break;
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'download', 'data-url', 'data-href'],
    });
  }

  // 监听 SPA 路由变化
  let lastUrl = location.href;
  function onUrlMaybeChanged() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      forceShown = false;
      scheduleEvaluate(500, true);
    }
  }
  const origPushState = history.pushState;
  const origReplaceState = history.replaceState;
  history.pushState = function (...args) {
    const ret = origPushState.apply(this, args);
    onUrlMaybeChanged();
    return ret;
  };
  history.replaceState = function (...args) {
    const ret = origReplaceState.apply(this, args);
    onUrlMaybeChanged();
    return ret;
  };
  window.addEventListener('popstate', onUrlMaybeChanged);
  window.addEventListener('hashchange', onUrlMaybeChanged);

  // 注册油猴菜单快捷入口（即使非 .apk/.exe 页面也可手动唤醒）
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('🔍 立即排除检测当前网页', () => {
      forceShown = true;
      showWidget();
      lastSignals = scanPagePackageSignals();
      runExcludeCheck(true);
    });
    GM_registerMenuCommand('➕ 打开 APP 纳入与词库管理', () => {
      forceShown = true;
      openModal();
    });
    GM_registerMenuCommand('👁️ 显示/隐藏防重悬浮球', () => {
      if (uiVisible) {
        forceShown = false;
        hideWidget();
      } else {
        forceShown = true;
        showWidget();
        lastSignals = scanPagePackageSignals();
        runExcludeCheck(false);
      }
    });
  }

  // 首次检测页面是否包含 .apk 或 .exe
  evaluatePageActivation(false);
})();
