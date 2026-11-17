// ==UserScript==
// @name         安卓网页离线保存器（HTML / PNG）
// @namespace    https://local.example/offline-saver
// @version      1.0.0
// @description  在安卓油猴中将当前网页界面保存为离线 HTML 或 PNG 长截图
// @author       OpenAI
// @match        *://*/*
// @run-at       document-end
// @grant        GM_download
// @grant        GM_registerMenuCommand
// @noframes
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// ==/UserScript==

(function () {
    'use strict';

    const APP_ID = '__android_offline_page_saver__';
    const VERSION = '1.0.0';
    const H2C_MAX_SCALE = 2;
    const RESOURCE_CACHE = new Map();

    if (window[APP_ID]) return;
    window[APP_ID] = { version: VERSION };

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    function safeFileName(name) {
        return (name || '网页')
            .replace(/[\\/:*?"<>|]+/g, '_')
            .replace(/[\u0000-\u001F]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 100) || '网页';
    }

    function stamp() {
        const d = new Date();
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    }

    function toast(message, type = 'info', duration = 2200) {
        let box = document.getElementById(`${APP_ID}-toast`);

        if (!box) {
            box = document.createElement('div');
            box.id = `${APP_ID}-toast`;

            box.style.cssText = [
                'position:fixed',
                'left:50%',
                'bottom:78px',
                'transform:translateX(-50%)',
                'z-index:2147483647',
                'max-width:88vw',
                'padding:10px 14px',
                'border-radius:12px',
                'background:rgba(25,25,25,.94)',
                'color:#fff',
                'font:14px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
                'box-shadow:0 8px 28px rgba(0,0,0,.3)',
                'text-align:center',
                'pointer-events:none',
                'opacity:0',
                'transition:opacity .15s ease'
            ].join(';');

            document.documentElement.appendChild(box);
        }

        box.textContent = message;
        box.style.opacity = '1';
        box.dataset.type = type;

        clearTimeout(box.__timer);

        box.__timer = setTimeout(() => {
            box.style.opacity = '0';
        }, duration);
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
                        conflictAction: 'uniquify'
                    });

                    return;
                } catch (_) {
                    // 某些旧版 Tampermonkey 不接受 Blob。
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

    async function resourceToDataURL(url) {
        if (
            !url ||
            url.startsWith('data:') ||
            url.startsWith('blob:')
        ) {
            return url;
        }

        if (RESOURCE_CACHE.has(url)) {
            return RESOURCE_CACHE.get(url);
        }

        const p = (async () => {
            try {
                const response = await fetch(url, {
                    credentials: 'include',
                    mode: 'cors',
                    cache: 'force-cache'
                });

                if (!response.ok) {
                    return null;
                }

                const blob = await response.blob();

                if (!blob.type && !blob.size) {
                    return null;
                }

                return await new Promise(resolve => {
                    const reader = new FileReader();

                    reader.onload = () => {
                        resolve(reader.result);
                    };

                    reader.onerror = () => {
                        resolve(null);
                    };

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
        const matches = [
            ...cssText.matchAll(/url\((['"]?)(.*?)\1\)/gi)
        ];

        const urls = [
            ...new Set(
                matches
                    .map(m => m[2].trim())
                    .filter(u =>
                        u &&
                        !u.startsWith('data:') &&
                        !u.startsWith('blob:')
                    )
            )
        ]
        .map(u => {
            try {
                return new URL(u, baseURL).href;
            } catch (_) {
                return null;
            }
        })
        .filter(Boolean);

        const pairs = await Promise.all(
            urls.map(async absolute => [
                absolute,
                await resourceToDataURL(absolute)
            ])
        );

        for (const [absolute, dataURL] of pairs) {
            if (dataURL) {
                const escaped =
                    absolute.replace(
                        /[.*+?^${}()|[\]\\]/g,
                        '\\$&'
                    );

                cssText = cssText.replace(
                    new RegExp(escaped, 'g'),
                    dataURL
                );
            }
        }

        return cssText;
    }

    async function inlineResourceAttributes(root, baseURL) {
        const elements =
            root.querySelectorAll(
                'img[src], source[src], video[poster], input[src]'
            );

        const tasks = [];

        for (const el of elements) {
            if (
                el.tagName === 'IMG' ||
                el.tagName === 'SOURCE' ||
                el.tagName === 'INPUT'
            ) {
                const attr = el.getAttribute('src');

                if (attr) {
                    let absolute;

                    try {
                        absolute = new URL(attr, baseURL).href;
                    } catch (_) {
                        absolute = null;
                    }

                    if (absolute) {
                        tasks.push(
                            (async () => {
                                const dataURL =
                                    await resourceToDataURL(absolute);

                                if (dataURL) {
                                    el.setAttribute(
                                        'src',
                                        dataURL
                                    );
                                }
                            })()
                        );
                    }
                }
            }

            if (el.tagName === 'VIDEO') {
                const attr = el.getAttribute('poster');

                if (attr) {
                    let absolute;

                    try {
                        absolute = new URL(attr, baseURL).href;
                    } catch (_) {
                        absolute = null;
                    }

                    if (absolute) {
                        tasks.push(
                            (async () => {
                                const dataURL =
                                    await resourceToDataURL(absolute);

                                if (dataURL) {
                                    el.setAttribute(
                                        'poster',
                                        dataURL
                                    );
                                }
                            })()
                        );
                    }
                }
            }
        }

        await Promise.allSettled(tasks);
    }

    function copyLiveState(sourceRoot, cloneRoot) {
        const src = [
            sourceRoot,
            ...sourceRoot.querySelectorAll('*')
        ];

        const dst = [
            cloneRoot,
            ...cloneRoot.querySelectorAll('*')
        ];

        const len = Math.min(src.length, dst.length);

        for (let i = 0; i < len; i++) {
            const a = src[i];
            const b = dst[i];

            if (
                !a ||
                !b ||
                a.nodeType !== 1 ||
                b.nodeType !== 1
            ) {
                continue;
            }

            if (
                a instanceof HTMLInputElement &&
                b instanceof HTMLInputElement
            ) {
                b.value = a.value;
                b.setAttribute('value', a.value);

                if (
                    a.type === 'checkbox' ||
                    a.type === 'radio'
                ) {
                    b.checked = a.checked;
                    b.toggleAttribute(
                        'checked',
                        a.checked
                    );
                }

            } else if (
                a instanceof HTMLTextAreaElement &&
                b instanceof HTMLTextAreaElement
            ) {
                b.value = a.value;
                b.textContent = a.value;

            } else if (
                a instanceof HTMLSelectElement &&
                b instanceof HTMLSelectElement
            ) {
                for (
                    let j = 0;
                    j < a.options.length;
                    j++
                ) {
                    if (b.options[j]) {
                        b.options[j].selected =
                            a.options[j].selected;
                    }
                }

            } else if (
                a instanceof HTMLOptionElement &&
                b instanceof HTMLOptionElement
            ) {
                b.selected = a.selected;

            } else if (
                a instanceof HTMLDetailsElement &&
                b instanceof HTMLDetailsElement
            ) {
                b.open = a.open;

                b.toggleAttribute(
                    'open',
                    a.open
                );
            }

            if (
                a.scrollTop > 0 ||
                a.scrollLeft > 0
            ) {
                b.setAttribute(
                    'data-offline-scroll-top',
                    String(a.scrollTop)
                );

                b.setAttribute(
                    'data-offline-scroll-left',
                    String(a.scrollLeft)
                );
            }
        }
    }

    function copyCanvasPixels(sourceRoot, cloneRoot) {
        const sourceCanvases =
            sourceRoot.querySelectorAll('canvas');

        const cloneCanvases =
            cloneRoot.querySelectorAll('canvas');

        for (
            let i = 0;
            i < Math.min(
                sourceCanvases.length,
                cloneCanvases.length
            );
            i++
        ) {
            try {
                const src = sourceCanvases[i];
                const dst = cloneCanvases[i];

                dst.width = src.width;
                dst.height = src.height;

                const ctx = dst.getContext('2d');

                ctx.drawImage(src, 0, 0);

            } catch (_) {
                // 跨域 Canvas 无法复制。
            }
        }
    }

    async function buildOfflineHTML() {
        toast(
            '正在生成离线 HTML…',
            'info',
            5000
        );

        const clone =
            document.documentElement.cloneNode(true);

        copyLiveState(
            document.documentElement,
            clone
        );

        copyCanvasPixels(
            document.documentElement,
            clone
        );

        // 删除运行脚本及可能产生安全问题的内容。
        clone
            .querySelectorAll(
                'script, noscript, iframe, frame, object, embed'
            )
            .forEach(el => el.remove());

        clone
            .querySelectorAll(
                `[id^="${APP_ID}"]`
            )
            .forEach(el => el.remove());

        // 将链接转换成绝对 URL。
        clone
            .querySelectorAll('a[href]')
            .forEach(a => {
                try {
                    a.setAttribute(
                        'href',
                        new URL(
                            a.getAttribute('href'),
                            location.href
                        ).href
                    );
                } catch (_) {}
            });

        // 将当前计算后的 CSS 直接写入每个元素。
        const originals = [
            document.documentElement,
            ...document.documentElement.querySelectorAll('*')
        ];

        const copies = [
            clone,
            ...clone.querySelectorAll('*')
        ];

        const styleTasks = [];

        const limit =
            Math.min(
                originals.length,
                copies.length
            );

        for (let i = 0; i < limit; i++) {
            const original = originals[i];
            const copy = copies[i];

            if (
                !(original instanceof Element) ||
                !(copy instanceof Element)
            ) {
                continue;
            }

            try {
                const cs =
                    getComputedStyle(original);

                let cssText = '';

                for (
                    let j = 0;
                    j < cs.length;
                    j++
                ) {
                    const name = cs[j];

                    cssText +=
                        `${name}:${cs.getPropertyValue(name)};`;
                }

                copy.setAttribute(
                    'style',
                    cssText
                );

                if (cssText.includes('url(')) {
                    styleTasks.push(
                        (async () => {
                            const rewritten =
                                await inlineUrlsInCss(
                                    cssText,
                                    location.href
                                );

                            copy.setAttribute(
                                'style',
                                rewritten
                            );
                        })()
                    );
                }

            } catch (_) {}
        }

        // 尝试读取可访问的 CSSOM。
        const accessibleCSS = [];

        for (
            const sheet
            of Array.from(document.styleSheets)
        ) {
            try {
                const rules =
                    Array.from(
                        sheet.cssRules || []
                    )
                    .map(r => r.cssText)
                    .join('\n');

                if (rules) {
                    accessibleCSS.push(
                        await inlineUrlsInCss(
                            rules,
                            sheet.href ||
                            location.href
                        )
                    );
                }

            } catch (_) {
                // 跨域 CSS 无法读取。
            }
        }

        await inlineResourceAttributes(
            clone,
            location.href
        );

        await Promise.allSettled(
            styleTasks
        );

        // 删除原站外部 CSS。
        clone
            .querySelectorAll(
                'link[rel="stylesheet"]'
            )
            .forEach(link => link.remove());

        clone
            .querySelectorAll(
                'style[data-offline-snapshot]'
            )
            .forEach(el => el.remove());

        const head =
            clone.querySelector('head') ||
            clone;

        const style =
            document.createElement('style');

        style.setAttribute(
            'data-offline-snapshot',
            'true'
        );

        style.textContent = [
            'html{scroll-behavior:auto!important}',
            '[data-offline-scroll-top],[data-offline-scroll-left]{overscroll-behavior:auto}',
            ...accessibleCSS
        ].join('\n');

        head.appendChild(style);

        // 页面加载后尽量恢复滚动位置。
        const restoreScript =
            document.createElement('script');

        restoreScript.textContent = `
(() => {
    const run = () => {
        for (
            const el of document.querySelectorAll(
                '[data-offline-scroll-top],[data-offline-scroll-left]'
            )
        ) {
            const top = Number(
                el.getAttribute(
                    'data-offline-scroll-top'
                ) || 0
            );

            const left = Number(
                el.getAttribute(
                    'data-offline-scroll-left'
                ) || 0
            );

            try {
                el.scrollTop = top;
                el.scrollLeft = left;
            } catch (_) {}
        }
    };

    addEventListener(
        'load',
        run,
        { once: true }
    );

    setTimeout(run, 50);
})();
`;

        head.appendChild(
            restoreScript
        );

        const meta =
            document.createElement('meta');

        meta.name =
            'offline-page-snapshot';

        meta.content =
            `Generated ${new Date().toISOString()} from ${location.href}`;

        head.appendChild(meta);

        const html =
            '<!doctype html>\n' +
            clone.outerHTML;

        const blob =
            new Blob(
                [html],
                {
                    type:
                        'text/html;charset=utf-8'
                }
            );

        const filename =
            `${safeFileName(
                document.title || '网页'
            )}_${stamp()}.html`;

        downloadBlob(
            blob,
            filename
        );

        toast(
            'HTML 已保存，可在断网状态打开。',
            'ok'
        );
    }

    function canRender() {
        return (
            typeof window.html2canvas ===
            'function'
        );
    }

    async function exportPNG() {
        if (!canRender()) {
            toast(
                'PNG 引擎未加载，请重新打开页面后再试。',
                'error',
                4000
            );

            return;
        }

        const ui =
            document.getElementById(
                `${APP_ID}-root`
            );

        if (ui) {
            ui.style.display = 'none';
        }

        toast(
            '正在生成 PNG 长截图…',
            'info',
            10000
        );

        const oldOverflow =
            document.documentElement.style.overflow;

        try {
            await sleep(250);

            document.documentElement.style.overflow =
                'visible';

            const width =
                Math.max(
                    document.documentElement.scrollWidth,
                    document.body
                        ? document.body.scrollWidth
                        : 0,
                    document.documentElement.clientWidth
                );

            const height =
                Math.max(
                    document.documentElement.scrollHeight,
                    document.body
                        ? document.body.scrollHeight
                        : 0,
                    document.documentElement.clientHeight
                );

            const scale =
                Math.min(
                    H2C_MAX_SCALE,
                    Math.max(
                        1,
                        window.devicePixelRatio || 1
                    )
                );

            const canvas =
                await window.html2canvas(
                    document.documentElement,
                    {
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

                        windowWidth:
                            Math.max(
                                width,
                                window.innerWidth
                            ),

                        windowHeight:
                            Math.max(
                                height,
                                window.innerHeight
                            ),

                        ignoreElements:
                            el =>
                                el.id ===
                                    `${APP_ID}-root` ||
                                el.id ===
                                    `${APP_ID}-toast`
                    }
                );

            canvas.toBlob(
                blob => {
                    if (!blob) {
                        toast(
                            'PNG 生成失败：浏览器没有返回图像数据。',
                            'error',
                            4500
                        );

                        return;
                    }

                    const filename =
                        `${safeFileName(
                            document.title || '网页'
                        )}_${stamp()}.png`;

                    downloadBlob(
                        blob,
                        filename
                    );

                    toast(
                        'PNG 已保存。',
                        'ok'
                    );
                },
                'image/png'
            );

        } catch (error) {
            console.error(
                '[离线保存器] PNG error:',
                error
            );

            toast(
                'PNG 失败：网页太长、存在跨域资源或浏览器画布限制。可先保存 HTML。',
                'error',
                6500
            );

        } finally {
            document.documentElement.style.overflow =
                oldOverflow;

            if (ui) {
                ui.style.display = '';
            }
        }
    }

    function buildUI() {
        const root =
            document.createElement('div');

        root.id =
            `${APP_ID}-root`;

        root.setAttribute(
            'data-html2canvas-ignore',
            'true'
        );

        root.style.cssText = [
            'position:fixed',
            'right:12px',
            'bottom:18px',
            'z-index:2147483646',
            'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
            'user-select:none'
        ].join(';');

        const fab =
            document.createElement('button');

        fab.type = 'button';

        fab.textContent = '↓';

        fab.title = '网页离线保存';

        fab.style.cssText = [
            'width:48px',
            'height:48px',
            'border:0',
            'border-radius:50%',
            'background:#202124',
            'color:#fff',
            'font-size:24px',
            'line-height:48px',
            'box-shadow:0 5px 18px rgba(0,0,0,.28)',
            'padding:0',
            'touch-action:manipulation'
        ].join(';');

        const panel =
            document.createElement('div');

        panel.hidden = true;

        panel.style.cssText = [
            'position:absolute',
            'right:0',
            'bottom:58px',
            'width:205px',
            'padding:8px',
            'border-radius:14px',
            'background:rgba(28,28,30,.96)',
            'box-shadow:0 10px 35px rgba(0,0,0,.35)',
            'backdrop-filter:blur(10px)'
        ].join(';');

        function addAction(label, handler) {
            const btn =
                document.createElement('button');

            btn.type = 'button';

            btn.textContent = label;

            btn.style.cssText = [
                'display:block',
                'width:100%',
                'border:0',
                'background:transparent',
                'color:#fff',
                'padding:12px 10px',
                'text-align:left',
                'border-radius:10px',
                'font-size:14px',
                'touch-action:manipulation'
            ].join(';');

            btn.addEventListener(
                'touchstart',
                () => {
                    btn.style.background =
                        'rgba(255,255,255,.12)';
                },
                { passive: true }
            );

            btn.addEventListener(
                'touchend',
                () => {
                    btn.style.background =
                        'transparent';
                },
                { passive: true }
            );

            btn.addEventListener(
                'click',
                async () => {
                    panel.hidden = true;

                    try {
                        await handler();
                    } catch (e) {
                        console.error(
                            '[离线保存器]',
                            e
                        );

                        toast(
                            '操作失败，请查看控制台错误。',
                            'error',
                            4000
                        );
                    }
                }
            );

            panel.appendChild(btn);
        }

        addAction(
            '保存为离线 HTML',
            buildOfflineHTML
        );

        addAction(
            '保存为 PNG 长截图',
            exportPNG
        );

        addAction(
            '关闭悬浮按钮',
            () => {
                root.remove();
            }
        );

        fab.addEventListener(
            'click',
            () => {
                panel.hidden =
                    !panel.hidden;
            }
        );

        root.append(
            panel,
            fab
        );

        (
            document.body ||
            document.documentElement
        ).appendChild(root);

        return root;
    }

    const root =
        buildUI();

    if (
        typeof GM_registerMenuCommand ===
        'function'
    ) {
        GM_registerMenuCommand(
            '保存当前页为离线 HTML',
            buildOfflineHTML
        );

        GM_registerMenuCommand(
            '保存当前页为 PNG 长截图',
            exportPNG
        );

        GM_registerMenuCommand(
            '隐藏悬浮按钮',
            () => root.remove()
        );
    }
})();

/*
 * PNG 功能使用 html2canvas 1.4.1（MIT License）。
 * https://github.com/niklasvh/html2canvas
 */