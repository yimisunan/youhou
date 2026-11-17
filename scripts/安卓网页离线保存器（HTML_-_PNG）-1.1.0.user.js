// ==UserScript==
// @name         安卓网页离线保存器（HTML / PNG）
// @namespace    https://local.example/offline-saver
// @version      1.1.0
// @description  在安卓油猴中将当前网页界面保存为离线 HTML 或 PNG 长截图/当前屏截图；采用 Shadow DOM 隔离界面、可拖拽贴边悬浮球与安卓底部操作面板，支持跨域资源内联、懒加载图片修复、进度提示与画布上限自适应保护。
// @author       OpenAI
// @match        *://*/*
// @run-at       document-end
// @grant        GM_download
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      *
// @noframes
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// ==/UserScript==

(function () {
  'use strict';

  const APP_ID = '__android_offline_page_saver__';
  const HOST_ID = `${APP_ID}-host`;
  const STORAGE_KEY_CONFIG = 'tm_offline_saver_config_v1';
  const VERSION = '1.1.0';
  const H2C_MAX_SCALE = 2;
  const MAX_CANVAS_PIXELS = 20000000; // 约 2000 万像素，适配绝大多数安卓设备内存上限
  const MAX_CANVAS_SIDE = 14000;
  const RESOURCE_CACHE = new Map();
  const TEXT_CACHE = new Map();

  if (window[APP_ID]) return;
  window[APP_ID] = { version: VERSION };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ==================== 1. 存储与工具函数 ====================
  function loadConfig() {
    const defaults = {
      posY: null,
      dockSide: 'right',
      inlineResources: true,
      lockComputedStyles: false,
    };
    try {
      if (typeof GM_getValue === 'function') {
        const val = GM_getValue(STORAGE_KEY_CONFIG, null);
        if (val !== null && val !== undefined) {
          return Object.assign(defaults, typeof val === 'string' ? JSON.parse(val) : val);
        }
      }
      const raw = localStorage.getItem(STORAGE_KEY_CONFIG);
      return Object.assign(defaults, raw ? JSON.parse(raw) : {});
    } catch (_) {
      return defaults;
    }
  }

  function saveConfig(cfg) {
    try {
      const serialized = JSON.stringify(cfg);
      if (typeof GM_setValue === 'function') {
        GM_setValue(STORAGE_KEY_CONFIG, serialized);
      }
      localStorage.setItem(STORAGE_KEY_CONFIG, serialized);
    } catch (_) {}
  }

  const config = loadConfig();

  function safeFileName(name) {
    return (
      (name || '网页')
        .replace(/[\\/:*?"<>|]+/g, '_')
        .replace(/[\u0000-\u001F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 96) || '网页'
    );
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    try {
      if (typeof GM_download === 'function') {
        try {
          GM_download({
            url: blob,
            name: filename,
            saveAs: false,
            conflictAction: 'uniquify',
          });
          return;
        } catch (_) {
          // 部分移动端脚本管理器不支持直接传入 Blob
        }
      }

      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      a.style.display = 'none';
      (document.body || document.documentElement).appendChild(a);
      a.click();
      a.remove();
    } finally {
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 30000);
    }
  }

  async function runPool(items, concurrency, worker) {
    let idx = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (idx < items.length) {
        const current = idx++;
        await worker(items[current], current);
      }
    });
    await Promise.all(runners);
  }

  // ==================== 2. 网络资源抓取（优先 GM_xmlhttpRequest 突破跨域，回退 fetch） ====================
  function gmFetchBlob(url, timeoutMs = 10000) {
    return new Promise((resolve) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        resolve(null);
        return;
      }
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          responseType: 'blob',
          timeout: timeoutMs,
          onload(res) {
            if (res.status >= 200 && res.status < 400 && res.response) {
              resolve(res.response);
            } else {
              resolve(null);
            }
          },
          onerror: () => resolve(null),
          ontimeout: () => resolve(null),
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  function gmFetchText(url, timeoutMs = 10000) {
    return new Promise((resolve) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        resolve(null);
        return;
      }
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          responseType: 'text',
          timeout: timeoutMs,
          onload(res) {
            if (res.status >= 200 && res.status < 400 && typeof res.responseText === 'string') {
              resolve(res.responseText);
            } else {
              resolve(null);
            }
          },
          onerror: () => resolve(null),
          ontimeout: () => resolve(null),
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  async function fetchAsBlob(url) {
    const gmBlob = await gmFetchBlob(url);
    if (gmBlob && (gmBlob.size > 0 || gmBlob.type)) return gmBlob;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 9000);
      const response = await fetch(url, {
        credentials: 'include',
        mode: 'cors',
        cache: 'force-cache',
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) return null;
      return await response.blob();
    } catch (_) {
      return null;
    }
  }

  async function fetchCssText(url) {
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) return null;
    if (TEXT_CACHE.has(url)) return TEXT_CACHE.get(url);

    const p = (async () => {
      const gmTxt = await gmFetchText(url);
      if (gmTxt) return gmTxt;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 9000);
        const res = await fetch(url, {
          credentials: 'include',
          mode: 'cors',
          cache: 'force-cache',
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) return null;
        return await res.text();
      } catch (_) {
        return null;
      }
    })();

    TEXT_CACHE.set(url, p);
    return p;
  }

  async function resourceToDataURL(url) {
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) {
      return url;
    }
    if (RESOURCE_CACHE.has(url)) {
      return RESOURCE_CACHE.get(url);
    }

    const p = (async () => {
      try {
        const blob = await fetchAsBlob(url);
        if (!blob || (!blob.type && !blob.size)) return null;
        return await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      } catch (_) {
        return null;
      }
    })();

    RESOURCE_CACHE.set(url, p);
    return p;
  }

  async function inlineUrlsInCss(cssText, baseURL) {
    if (!cssText || !cssText.includes('url(')) return cssText;
    const matches = [...cssText.matchAll(/url\((['"]?)(.*?)\1\)/gi)];
    const rawToAbs = new Map();

    for (const m of matches) {
      const raw = (m[2] || '').trim();
      if (!raw || raw.startsWith('data:') || raw.startsWith('blob:') || raw.startsWith('#')) continue;
      try {
        const abs = new URL(raw, baseURL).href;
        rawToAbs.set(raw, abs);
      } catch (_) {}
    }

    const absList = Array.from(new Set(rawToAbs.values()));
    const absToData = new Map();

    await runPool(absList, 6, async (abs) => {
      const dataURL = await resourceToDataURL(abs);
      if (dataURL) absToData.set(abs, dataURL);
    });

    if (absToData.size === 0) return cssText;

    return cssText.replace(/url\((['"]?)(.*?)\1\)/gi, (full, quote, inner) => {
      const raw = (inner || '').trim();
      const abs = rawToAbs.get(raw);
      const dataURL = abs ? absToData.get(abs) : null;
      return dataURL ? `url("${dataURL}")` : full;
    });
  }

  // ==================== 3. 离线 HTML 构建引擎 ====================
  function copyLiveState(sourceRoot, cloneRoot) {
    const src = [sourceRoot, ...sourceRoot.querySelectorAll('*')];
    const dst = [cloneRoot, ...cloneRoot.querySelectorAll('*')];
    const len = Math.min(src.length, dst.length);

    for (let i = 0; i < len; i++) {
      const a = src[i];
      const b = dst[i];
      if (!a || !b || a.nodeType !== 1 || b.nodeType !== 1) continue;

      if (a instanceof HTMLInputElement && b instanceof HTMLInputElement) {
        b.value = a.value;
        b.setAttribute('value', a.value);
        if (a.type === 'checkbox' || a.type === 'radio') {
          b.checked = a.checked;
          b.toggleAttribute('checked', a.checked);
        }
      } else if (a instanceof HTMLTextAreaElement && b instanceof HTMLTextAreaElement) {
        b.value = a.value;
        b.textContent = a.value;
      } else if (a instanceof HTMLSelectElement && b instanceof HTMLSelectElement) {
        for (let j = 0; j < a.options.length; j++) {
          if (b.options[j]) {
            b.options[j].selected = a.options[j].selected;
          }
        }
      } else if (a instanceof HTMLOptionElement && b instanceof HTMLOptionElement) {
        b.selected = a.selected;
      } else if (a instanceof HTMLDetailsElement && b instanceof HTMLDetailsElement) {
        b.open = a.open;
        b.toggleAttribute('open', a.open);
      } else if (a instanceof HTMLImageElement && b instanceof HTMLImageElement) {
        // 优先保留懒加载真实地址或 srcset 实际加载地址
        const lazyUrl =
          a.getAttribute('data-src') ||
          a.getAttribute('data-original') ||
          a.getAttribute('data-lazy-src') ||
          a.getAttribute('data-url');
        const resolved = a.currentSrc || a.src || lazyUrl;
        if (resolved && (!b.getAttribute('src') || b.getAttribute('src').startsWith('data:image/gif'))) {
          b.setAttribute('src', resolved);
        }
      }

      if (a.scrollTop > 0 || a.scrollLeft > 0) {
        b.setAttribute('data-offline-scroll-top', String(a.scrollTop));
        b.setAttribute('data-offline-scroll-left', String(a.scrollLeft));
      }
    }
  }

  function copyCanvasPixels(sourceRoot, cloneRoot) {
    const sourceCanvases = sourceRoot.querySelectorAll('canvas');
    const cloneCanvases = cloneRoot.querySelectorAll('canvas');
    for (let i = 0; i < Math.min(sourceCanvases.length, cloneCanvases.length); i++) {
      try {
        const src = sourceCanvases[i];
        const dst = cloneCanvases[i];
        dst.width = src.width;
        dst.height = src.height;
        const ctx = dst.getContext('2d');
        if (ctx) ctx.drawImage(src, 0, 0);
      } catch (_) {}
    }
  }

  async function inlineResourceAttributes(root, baseURL, onProgress) {
    const elements = Array.from(
      root.querySelectorAll('img[src], img[data-src], img[data-original], source[src], video[poster], input[src], image')
    );
    let done = 0;
    const total = elements.length;

    await runPool(elements, 6, async (el) => {
      try {
        const tag = el.tagName.toUpperCase();
        if (tag === 'IMG' || tag === 'SOURCE' || tag === 'INPUT') {
          const rawSrc =
            el.getAttribute('src') ||
            el.getAttribute('data-src') ||
            el.getAttribute('data-original') ||
            '';
          if (rawSrc) {
            const abs = new URL(rawSrc, baseURL).href;
            const dataURL = await resourceToDataURL(abs);
            if (dataURL) {
              el.setAttribute('src', dataURL);
              el.removeAttribute('srcset');
              el.removeAttribute('loading');
            } else {
              el.setAttribute('src', abs);
            }
          }
        } else if (tag === 'VIDEO') {
          const poster = el.getAttribute('poster');
          if (poster) {
            const abs = new URL(poster, baseURL).href;
            const dataURL = await resourceToDataURL(abs);
            el.setAttribute('poster', dataURL || abs);
          }
        } else if (tag === 'IMAGE') {
          const href = el.getAttribute('href') || el.getAttribute('xlink:href');
          if (href) {
            const abs = new URL(href, baseURL).href;
            const dataURL = await resourceToDataURL(abs);
            if (dataURL) {
              if (el.hasAttribute('href')) el.setAttribute('href', dataURL);
              if (el.hasAttribute('xlink:href')) el.setAttribute('xlink:href', dataURL);
            }
          }
        }
      } catch (_) {}
      done++;
      if (onProgress && (done % 4 === 0 || done === total)) {
        onProgress(done, total);
      }
    });
  }

  async function buildOfflineHTML() {
    if (isBusy) return;
    setBusy(true, '正在准备离线快照…', 5);

    try {
      const clone = document.documentElement.cloneNode(true);

      setProgress('正在同步表单与画布状态…', 15);
      copyLiveState(document.documentElement, clone);
      copyCanvasPixels(document.documentElement, clone);

      // 删除脚本、弹窗及可能限制本地渲染的 CSP meta
      clone
        .querySelectorAll('script, noscript, iframe, frame, object, embed, meta[http-equiv="Content-Security-Policy"]')
        .forEach((el) => el.remove());

      clone.querySelectorAll(`[id^="${APP_ID}"]`).forEach((el) => el.remove());

      // 将超链接转为绝对 URL
      clone.querySelectorAll('a[href]').forEach((a) => {
        try {
          const raw = a.getAttribute('href');
          if (raw && !raw.startsWith('#') && !raw.startsWith('javascript:')) {
            a.setAttribute('href', new URL(raw, location.href).href);
          }
        } catch (_) {}
      });

      const doInlineResources = !!config.inlineResources;
      const doLockStyles = !!config.lockComputedStyles;

      // 收集样式表（支持 CSSOM 与跨域外链 CSS 拉取）
      setProgress('正在处理页面样式表…', 30);
      const collectedCSS = [];
      for (const sheet of Array.from(document.styleSheets)) {
        const sheetBase = sheet.href || location.href;
        let rawCss = '';
        try {
          rawCss = Array.from(sheet.cssRules || [])
            .map((r) => r.cssText)
            .join('\n');
        } catch (_) {
          // 跨域 CSS 无法直接读取 CSSOM，尝试主动拉取
          if (sheet.href) {
            rawCss = (await fetchCssText(sheet.href)) || '';
          }
        }
        if (rawCss) {
          collectedCSS.push(doInlineResources ? await inlineUrlsInCss(rawCss, sheetBase) : rawCss);
        }
      }

      // 处理已有内联 <style> 中的 url(...)
      if (doInlineResources) {
        const inlineStyles = Array.from(clone.querySelectorAll('style'));
        for (const st of inlineStyles) {
          if (st.textContent && st.textContent.includes('url(')) {
            st.textContent = await inlineUrlsInCss(st.textContent, location.href);
          }
        }
      }

      // 可选：全元素计算样式锁定（分批让出主线程避免手机卡死）
      if (doLockStyles) {
        setProgress('正在锁定全元素计算样式…', 50);
        const originals = [document.documentElement, ...document.documentElement.querySelectorAll('*')];
        const copies = [clone, ...clone.querySelectorAll('*')];
        const limit = Math.min(originals.length, copies.length);
        const urlStyleElements = [];

        for (let i = 0; i < limit; i++) {
          const original = originals[i];
          const copy = copies[i];
          if (!(original instanceof Element) || !(copy instanceof Element)) continue;
          try {
            const cs = getComputedStyle(original);
            let cssText = '';
            for (let j = 0; j < cs.length; j++) {
              const name = cs[j];
              if (name.startsWith('-webkit-')) continue;
              cssText += `${name}:${cs.getPropertyValue(name)};`;
            }
            copy.setAttribute('style', cssText);
            if (doInlineResources && cssText.includes('url(')) {
              urlStyleElements.push({ copy, cssText });
            }
          } catch (_) {}

          if (i % 160 === 0) {
            await sleep(0);
          }
        }

        if (urlStyleElements.length > 0) {
          await runPool(urlStyleElements, 6, async (item) => {
            item.copy.setAttribute('style', await inlineUrlsInCss(item.cssText, location.href));
          });
        }
      } else if (doInlineResources) {
        // 标准高保真模式：仅对元素原有行内 style 中的 url(...) 做资源内联
        const styledEls = Array.from(clone.querySelectorAll('[style*="url("]'));
        await runPool(styledEls, 6, async (el) => {
          const st = el.getAttribute('style');
          if (st) el.setAttribute('style', await inlineUrlsInCss(st, location.href));
        });
      }

      if (doInlineResources) {
        setProgress('正在内联图片与媒体封面…', 65);
        await inlineResourceAttributes(clone, location.href, (done, total) => {
          const pct = 65 + Math.round((done / Math.max(1, total)) * 25);
          setProgress(`正在内联图片资源 (${done}/${total})…`, pct);
        });
      }

      // 移除已合并的原外链样式表，防止断网打开时卡在加载请求
      clone.querySelectorAll('link[rel="stylesheet"]').forEach((link) => link.remove());
      clone.querySelectorAll('style[data-offline-snapshot]').forEach((el) => el.remove());

      const head = clone.querySelector('head') || clone;
      const snapshotStyle = document.createElement('style');
      snapshotStyle.setAttribute('data-offline-snapshot', 'true');
      snapshotStyle.textContent = [
        'html{scroll-behavior:auto!important}',
        '[data-offline-scroll-top],[data-offline-scroll-left]{overscroll-behavior:auto}',
        ...collectedCSS,
      ].join('\n');
      head.appendChild(snapshotStyle);

      // 注入轻量滚动位置恢复脚本
      const restoreScript = document.createElement('script');
      restoreScript.textContent = `(() => {
  const run = () => {
    for (const el of document.querySelectorAll('[data-offline-scroll-top],[data-offline-scroll-left]')) {
      const top = Number(el.getAttribute('data-offline-scroll-top') || 0);
      const left = Number(el.getAttribute('data-offline-scroll-left') || 0);
      try { el.scrollTop = top; el.scrollLeft = left; } catch (_) {}
    }
  };
  addEventListener('load', run, { once: true });
  setTimeout(run, 60);
})();`;
      head.appendChild(restoreScript);

      const meta = document.createElement('meta');
      meta.name = 'offline-page-snapshot';
      meta.content = `Generated ${new Date().toISOString()} from ${location.href}`;
      head.appendChild(meta);

      setProgress('正在打包生成 HTML 文件…', 95);
      const html = '<!doctype html>\n' + clone.outerHTML;
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const filename = `${safeFileName(document.title || '网页')}_${stamp()}.html`;
      downloadBlob(blob, filename);

      const sizeMB = (blob.size / (1024 * 1024)).toFixed(2);
      setProgress(`HTML 已保存（${sizeMB} MB）`, 100);
      showToast(`✅ 离线 HTML 已保存（${sizeMB} MB）`, 'ok', 3200);
    } catch (err) {
      console.error('[离线保存器] HTML error:', err);
      showToast('❌ 离线 HTML 生成失败，请查看控制台', 'error', 4000);
    } finally {
      setTimeout(() => setBusy(false), 600);
    }
  }

  // ==================== 4. PNG 截图引擎（支持长截图自动降级缩放 & 当前屏幕截图） ====================
  function getHtml2CanvasFn() {
    if (typeof html2canvas === 'function') return html2canvas;
    if (typeof window.html2canvas === 'function') return window.html2canvas;
    return null;
  }

  function computeSafeScale(width, height) {
    let scale = Math.min(H2C_MAX_SCALE, Math.max(1, window.devicePixelRatio || 1));
    const maxBySide = Math.min(MAX_CANVAS_SIDE / Math.max(1, width), MAX_CANVAS_SIDE / Math.max(1, height));
    const maxByPixels = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, width * height));
    scale = Math.min(scale, maxBySide, maxByPixels);
    return Math.max(0.4, Number(scale.toFixed(2)));
  }

  async function exportPNG(mode = 'full') {
    if (isBusy) return;
    const h2c = getHtml2CanvasFn();
    if (!h2c) {
      showToast('⚠️ PNG 引擎（html2canvas）未加载，请检查网络或刷新重试', 'error', 4200);
      return;
    }

    const isViewport = mode === 'viewport';
    setBusy(true, isViewport ? '正在截取当前屏幕…' : '正在计算页面尺寸并渲染 PNG…', 20);

    const oldOverflow = document.documentElement.style.overflow;
    if (hostEl) hostEl.style.display = 'none';

    try {
      await sleep(220);

      let width;
      let height;
      let options;

      if (isViewport) {
        width = window.innerWidth;
        height = window.innerHeight;
        const scale = computeSafeScale(width, height);
        options = {
          backgroundColor: null,
          useCORS: true,
          allowTaint: false,
          logging: false,
          scale,
          width,
          height,
          x: window.scrollX,
          y: window.scrollY,
          scrollX: 0,
          scrollY: 0,
          windowWidth: window.innerWidth,
          windowHeight: window.innerHeight,
          ignoreElements: (el) => el.id === HOST_ID,
        };
      } else {
        document.documentElement.style.overflow = 'visible';
        width = Math.max(
          document.documentElement.scrollWidth,
          document.body ? document.body.scrollWidth : 0,
          document.documentElement.clientWidth
        );
        height = Math.max(
          document.documentElement.scrollHeight,
          document.body ? document.body.scrollHeight : 0,
          document.documentElement.clientHeight
        );

        const scale = computeSafeScale(width, height);
        if (width * scale > 16384 || height * scale > 16384) {
          throw new Error('PAGE_TOO_LARGE');
        }

        options = {
          backgroundColor: null,
          useCORS: true,
          allowTaint: false,
          logging: false,
          scale,
          width,
          height,
          x: 0,
          y: 0,
          scrollX: 0,
          scrollY: 0,
          windowWidth: Math.max(width, window.innerWidth),
          windowHeight: Math.max(height, window.innerHeight),
          ignoreElements: (el) => el.id === HOST_ID,
        };
      }

      const canvas = await h2c(document.documentElement, options);

      await new Promise((resolve) => {
        canvas.toBlob((blob) => {
          if (!blob) {
            showToast('❌ PNG 生成失败：浏览器画布未返回图像数据，建议改用“当前屏幕”或离线 HTML', 'error', 4800);
            resolve();
            return;
          }
          const suffix = isViewport ? '_屏幕' : '_长图';
          const filename = `${safeFileName(document.title || '网页')}${suffix}_${stamp()}.png`;
          downloadBlob(blob, filename);
          const sizeMB = (blob.size / (1024 * 1024)).toFixed(2);
          showToast(`✅ PNG 已保存（${canvas.width}×${canvas.height}，${sizeMB} MB）`, 'ok', 3500);
          resolve();
        }, 'image/png');
      });
    } catch (error) {
      console.error('[离线保存器] PNG error:', error);
      const msg =
        error && error.message === 'PAGE_TOO_LARGE'
          ? '⚠️ 页面过长超出安卓画布上限，请使用“保存为 PNG（当前屏幕）”或“保存为离线 HTML”'
          : '❌ PNG 导出失败（页面过长或存在跨域受限资源），建议改用“当前屏幕”或离线 HTML';
      showToast(msg, 'error', 5500);
    } finally {
      document.documentElement.style.overflow = oldOverflow;
      if (hostEl) hostEl.style.display = '';
      setBusy(false);
    }
  }

  // ==================== 5. Shadow DOM 移动端交互界面 ====================
  let hostEl = null;
  let shadow = null;
  let els = null;
  let isBusy = false;
  let toastTimer = null;

  function showToast(message, type = 'info', duration = 2600) {
    if (!els) return;
    els.toastEl.textContent = message;
    els.toastEl.dataset.type = type;
    els.toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toastEl.classList.remove('show');
    }, duration);
  }

  function setProgress(text, percent) {
    if (!els) return;
    els.progressWrap.style.display = 'block';
    els.progressText.textContent = text;
    if (typeof percent === 'number') {
      els.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    }
  }

  function setBusy(busy, text = '', percent = 0) {
    isBusy = busy;
    if (!els) return;
    els.fab.classList.toggle('busy', busy);
    els.sheetActions.querySelectorAll('button').forEach((b) => {
      b.disabled = busy;
    });
    if (busy) {
      setProgress(text || '处理中…', percent);
      showToast(text || '正在处理…', 'info', 8000);
    } else {
      els.progressWrap.style.display = 'none';
      els.progressBar.style.width = '0%';
    }
  }

  function clampY(y) {
    const maxH = window.innerHeight - 66;
    return Math.max(14, Math.min(y, maxH > 14 ? maxH : window.innerHeight - 54));
  }

  function renderDockPosition() {
    if (!els) return;
    const y = clampY(typeof config.posY === 'number' ? config.posY : Math.floor(window.innerHeight * 0.78));
    els.fabWrap.style.top = `${y}px`;
    els.fabWrap.classList.toggle('dock-left', config.dockSide === 'left');
    els.fabWrap.classList.toggle('dock-right', config.dockSide !== 'left');
    if (config.dockSide === 'left') {
      els.fabWrap.style.left = '0px';
      els.fabWrap.style.right = 'auto';
    } else {
      els.fabWrap.style.right = '0px';
      els.fabWrap.style.left = 'auto';
    }
  }

  function openSheet() {
    if (!els) return;
    const w = Math.max(document.documentElement.scrollWidth, window.innerWidth);
    const h = Math.max(document.documentElement.scrollHeight, window.innerHeight);
    els.pageMetaTitle.textContent = document.title || '当前网页';
    els.pageMetaSub.textContent = `${location.hostname || '本地页面'} · ${w}×${h} px`;
    els.sheetBackdrop.classList.add('open');
  }

  function closeSheet() {
    if (!els) return;
    els.sheetBackdrop.classList.remove('open');
  }

  function buildUI() {
    hostEl = document.createElement('div');
    hostEl.id = HOST_ID;
    hostEl.setAttribute('data-html2canvas-ignore', 'true');
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

      /* 贴边可拖拽悬浮球 */
      .fab-wrap {
        position: fixed;
        z-index: 2147483646;
        touch-action: none;
        user-select: none;
        transition: left 0.2s cubic-bezier(0.2, 0.8, 0.2, 1), right 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
      }
      .fab-wrap.dragging {
        transition: none !important;
      }
      .fab-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        height: 44px;
        padding: 0 13px;
        border: 1.5px solid rgba(255, 255, 255, 0.72);
        background: rgba(24, 24, 28, 0.84);
        color: #ffffff;
        font-size: 13px;
        font-weight: 700;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        cursor: pointer;
        opacity: 0.82;
        transition: opacity 0.2s, transform 0.15s;
      }
      .fab-wrap.dock-right .fab-btn {
        border-radius: 999px 0 0 999px;
        border-right: none;
        padding-right: 11px;
      }
      .fab-wrap.dock-left .fab-btn {
        border-radius: 0 999px 999px 0;
        border-left: none;
        padding-left: 11px;
      }
      .fab-btn:active {
        transform: scale(0.96);
        opacity: 1;
      }
      .fab-btn.busy {
        background: #2563eb;
        opacity: 1;
      }

      /* 底部操作面板 */
      .sheet-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.52);
        backdrop-filter: blur(3px);
        -webkit-backdrop-filter: blur(3px);
        display: none;
        align-items: flex-end;
        justify-content: center;
        z-index: 2147483647;
      }
      .sheet-backdrop.open {
        display: flex;
      }
      @media (min-width: 601px) {
        .sheet-backdrop {
          align-items: center;
          padding: 16px;
        }
      }

      .sheet-card {
        width: 100%;
        max-width: 440px;
        max-height: 86dvh;
        background: #ffffff;
        color: #111827;
        border-radius: 22px 22px 0 0;
        box-shadow: 0 -10px 40px rgba(0, 0, 0, 0.28);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        padding-bottom: env(safe-area-inset-bottom, 0px);
      }
      @media (min-width: 601px) {
        .sheet-card {
          border-radius: 20px;
          padding-bottom: 0;
        }
      }

      .sheet-handle {
        width: 38px;
        height: 4px;
        border-radius: 999px;
        background: #d1d5db;
        margin: 10px auto 4px;
      }
      @media (min-width: 601px) {
        .sheet-handle { display: none; }
      }

      .sheet-header {
        padding: 10px 18px 12px;
        border-bottom: 1px solid #f1f5f9;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
      }
      .meta-title {
        font-size: 15px;
        font-weight: 700;
        color: #0f172a;
        line-height: 1.35;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .meta-sub {
        margin-top: 3px;
        font-size: 12px;
        color: #64748b;
      }
      .close-btn {
        border: none;
        background: #f1f5f9;
        color: #475569;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        font-size: 20px;
        line-height: 1;
        flex-shrink: 0;
        cursor: pointer;
      }

      .sheet-body {
        padding: 14px 16px 18px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .progress-wrap {
        display: none;
        background: #eff6ff;
        border: 1px solid #bfdbfe;
        border-radius: 12px;
        padding: 10px 12px;
      }
      .progress-text {
        font-size: 12.5px;
        font-weight: 600;
        color: #1d4ed8;
        margin-bottom: 6px;
      }
      .progress-track {
        width: 100%;
        height: 6px;
        background: #dbeafe;
        border-radius: 999px;
        overflow: hidden;
      }
      .progress-bar {
        width: 0%;
        height: 100%;
        background: #2563eb;
        border-radius: 999px;
        transition: width 0.2s ease;
      }

      .action-card {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 14px;
        border: 1px solid #e2e8f0;
        border-radius: 14px;
        background: #f8fafc;
        color: #0f172a;
        text-align: left;
        cursor: pointer;
        transition: background 0.15s, transform 0.1s;
      }
      .action-card:active {
        background: #e2e8f0;
        transform: scale(0.985);
      }
      .action-card:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .action-icon {
        width: 40px;
        height: 40px;
        border-radius: 11px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 19px;
        flex-shrink: 0;
      }
      .icon-html { background: #dbeafe; color: #1d4ed8; }
      .icon-png-full { background: #dcfce7; color: #15803d; }
      .icon-png-view { background: #fef3c7; color: #b45309; }

      .action-title {
        font-size: 14.5px;
        font-weight: 700;
        color: #0f172a;
      }
      .action-desc {
        margin-top: 2px;
        font-size: 12px;
        color: #64748b;
        line-height: 1.35;
      }

      .options-box {
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 9px;
        margin-top: 2px;
      }
      .opt-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        font-size: 13px;
        color: #334155;
        cursor: pointer;
      }
      .opt-row small {
        display: block;
        font-size: 11.5px;
        color: #64748b;
      }
      .opt-row input {
        width: 18px;
        height: 18px;
        accent-color: #2563eb;
        flex-shrink: 0;
      }

      .footer-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-top: 2px;
      }
      .footer-btn {
        min-height: 38px;
        border: none;
        border-radius: 10px;
        background: #f1f5f9;
        color: #475569;
        font-size: 12.5px;
        font-weight: 600;
        cursor: pointer;
      }

      .toast {
        position: fixed;
        left: 50%;
        bottom: calc(28px + env(safe-area-inset-bottom, 0px));
        transform: translateX(-50%);
        z-index: 2147483647;
        max-width: 88vw;
        padding: 10px 16px;
        border-radius: 999px;
        background: rgba(17, 24, 39, 0.94);
        color: #ffffff;
        font-size: 13px;
        line-height: 1.4;
        box-shadow: 0 8px 26px rgba(0, 0, 0, 0.32);
        text-align: center;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.18s ease;
      }
      .toast.show {
        opacity: 1;
      }
    `;
    shadow.appendChild(styleEl);

    const fabWrap = document.createElement('div');
    fabWrap.className = 'fab-wrap';
    fabWrap.innerHTML = `<button type="button" class="fab-btn" id="fabBtn" title="网页离线保存（可拖动）">↓ 保存</button>`;
    shadow.appendChild(fabWrap);

    const sheetBackdrop = document.createElement('div');
    sheetBackdrop.className = 'sheet-backdrop';
    sheetBackdrop.innerHTML = `
      <div class="sheet-card">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <div>
            <div class="meta-title" id="pageMetaTitle">当前网页</div>
            <div class="meta-sub" id="pageMetaSub">准备就绪</div>
          </div>
          <button type="button" class="close-btn" id="btnCloseSheet" aria-label="关闭">×</button>
        </div>
        <div class="sheet-body" id="sheetActions">
          <div class="progress-wrap" id="progressWrap">
            <div class="progress-text" id="progressText">处理中…</div>
            <div class="progress-track"><div class="progress-bar" id="progressBar"></div></div>
          </div>

          <button type="button" class="action-card" id="btnSaveHtml">
            <span class="action-icon icon-html">📄</span>
            <span>
              <div class="action-title">保存为离线 HTML</div>
              <div class="action-desc">单文件离线归档，断网可打开，自动同步表单/Canvas</div>
            </span>
          </button>

          <button type="button" class="action-card" id="btnSavePngFull">
            <span class="action-icon icon-png-full">🖼️</span>
            <span>
              <div class="action-title">保存为 PNG 长截图</div>
              <div class="action-desc">截取完整页面，自动适配安卓画布像素上限</div>
            </span>
          </button>

          <button type="button" class="action-card" id="btnSavePngView">
            <span class="action-icon icon-png-view">📱</span>
            <span>
              <div class="action-title">保存为 PNG（当前屏幕）</div>
              <div class="action-desc">仅截取当前可视区域，速度极快、长页面不崩溃</div>
            </span>
          </button>

          <div class="options-box">
            <label class="opt-row">
              <span>内联图片与样式资源<small>开启后可在完全断网环境下查看图片与排版</small></span>
              <input type="checkbox" id="chkInlineRes">
            </label>
            <label class="opt-row">
              <span>锁定全元素计算样式<small>极少数排版错乱页面可开启（文件体积较大）</small></span>
              <input type="checkbox" id="chkLockStyles">
            </label>
          </div>

          <div class="footer-row">
            <button type="button" class="footer-btn" id="btnResetPos">重置悬浮位置</button>
            <button type="button" class="footer-btn" id="btnHideFab">本次隐藏按钮</button>
          </div>
        </div>
      </div>
    `;
    shadow.appendChild(sheetBackdrop);

    const toastEl = document.createElement('div');
    toastEl.className = 'toast';
    shadow.appendChild(toastEl);

    els = {
      fabWrap,
      fab: shadow.getElementById('fabBtn'),
      sheetBackdrop,
      sheetActions: shadow.getElementById('sheetActions'),
      pageMetaTitle: shadow.getElementById('pageMetaTitle'),
      pageMetaSub: shadow.getElementById('pageMetaSub'),
      btnCloseSheet: shadow.getElementById('btnCloseSheet'),
      progressWrap: shadow.getElementById('progressWrap'),
      progressText: shadow.getElementById('progressText'),
      progressBar: shadow.getElementById('progressBar'),
      btnSaveHtml: shadow.getElementById('btnSaveHtml'),
      btnSavePngFull: shadow.getElementById('btnSavePngFull'),
      btnSavePngView: shadow.getElementById('btnSavePngView'),
      chkInlineRes: shadow.getElementById('chkInlineRes'),
      chkLockStyles: shadow.getElementById('chkLockStyles'),
      btnResetPos: shadow.getElementById('btnResetPos'),
      btnHideFab: shadow.getElementById('btnHideFab'),
      toastEl,
    };

    els.chkInlineRes.checked = config.inlineResources !== false;
    els.chkLockStyles.checked = !!config.lockComputedStyles;

    bindEvents();
    renderDockPosition();
  }

  function bindEvents() {
    let isDragging = false;
    let hasMoved = false;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    function onStart(x, y) {
      isDragging = true;
      hasMoved = false;
      startX = x;
      startY = y;
      const rect = els.fabWrap.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      els.fabWrap.classList.add('dragging');
    }

    function onMove(x, y) {
      if (!isDragging) return;
      const dx = x - startX;
      const dy = y - startY;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) hasMoved = true;
      if (hasMoved) {
        const rect = els.fabWrap.getBoundingClientRect();
        const maxX = window.innerWidth - (rect.width || 68);
        els.fabWrap.style.left = `${Math.max(0, Math.min(initialLeft + dx, maxX))}px`;
        els.fabWrap.style.right = 'auto';
        els.fabWrap.style.top = `${clampY(initialTop + dy)}px`;
      }
    }

    function onEnd() {
      if (!isDragging) return;
      isDragging = false;
      els.fabWrap.classList.remove('dragging');
      if (hasMoved) {
        const rect = els.fabWrap.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        config.dockSide = centerX < window.innerWidth / 2 ? 'left' : 'right';
        config.posY = Math.round(clampY(rect.top));
        saveConfig(config);
        renderDockPosition();
      }
    }

    els.fab.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length === 1) onStart(e.touches[0].clientX, e.touches[0].clientY);
      },
      { passive: true }
    );
    window.addEventListener(
      'touchmove',
      (e) => {
        if (isDragging && e.touches.length === 1) onMove(e.touches[0].clientX, e.touches[0].clientY);
      },
      { passive: true }
    );
    window.addEventListener('touchend', onEnd);

    els.fab.addEventListener('mousedown', (e) => onStart(e.clientX, e.clientY));
    window.addEventListener('mousemove', (e) => {
      if (isDragging) onMove(e.clientX, e.clientY);
    });
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('resize', renderDockPosition);

    els.fab.addEventListener('click', () => {
      if (hasMoved) return;
      openSheet();
    });

    els.btnCloseSheet.addEventListener('click', closeSheet);
    els.sheetBackdrop.addEventListener('click', (e) => {
      if (e.target === els.sheetBackdrop && !isBusy) closeSheet();
    });

    els.btnSaveHtml.addEventListener('click', buildOfflineHTML);
    els.btnSavePngFull.addEventListener('click', async () => {
      closeSheet();
      await exportPNG('full');
    });
    els.btnSavePngView.addEventListener('click', async () => {
      closeSheet();
      await exportPNG('viewport');
    });

    els.chkInlineRes.addEventListener('change', () => {
      config.inlineResources = els.chkInlineRes.checked;
      saveConfig(config);
    });
    els.chkLockStyles.addEventListener('change', () => {
      config.lockComputedStyles = els.chkLockStyles.checked;
      saveConfig(config);
    });

    els.btnResetPos.addEventListener('click', () => {
      config.posY = null;
      config.dockSide = 'right';
      saveConfig(config);
      renderDockPosition();
      showToast('已重置悬浮按钮位置');
    });

    els.btnHideFab.addEventListener('click', () => {
      closeSheet();
      els.fabWrap.style.display = 'none';
      showToast('已隐藏悬浮按钮，可从油猴菜单恢复');
    });
  }

  buildUI();

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('📄 保存当前页为离线 HTML', buildOfflineHTML);
    GM_registerMenuCommand('🖼️ 保存当前页为 PNG 长截图', () => exportPNG('full'));
    GM_registerMenuCommand('📱 保存当前屏幕为 PNG 截图', () => exportPNG('viewport'));
    GM_registerMenuCommand('👁️ 显示/隐藏离线保存悬浮按钮', () => {
      if (!els) return;
      const hidden = els.fabWrap.style.display === 'none';
      els.fabWrap.style.display = hidden ? '' : 'none';
      if (hidden) openSheet();
    });
  }
})();

/*
 * PNG 功能使用 html2canvas 1.4.1（MIT License）。
 * https://github.com/niklasvh/html2canvas
 */
