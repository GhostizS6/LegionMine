// ==UserScript==
// @name         Mine Loot (RU)
// @namespace    mine-loot
// @version      1.1.0
// @description  Добыча руды в шахте: последняя руда, за сессию, инвентарь, уровень и опыт
// @match        https://play.multidonate.ru/c/*
// @downloadURL  https://raw.githubusercontent.com/GhostizS6/LegionMine/master/gains.user.js
// @updateURL    https://raw.githubusercontent.com/GhostizS6/LegionMine/master/gains.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
    "use strict";

    if (window.__MINE_LOOT_RU_V1__) return;
    window.__MINE_LOOT_RU_V1__ = true;

    const STORAGE_COLLAPSED = "mine-loot-ru-collapsed";
    const REFRESH_MS = 15000;
    const PANEL_ID = "mine-loot-ru";
    const STYLE_ID = "mine-loot-ru-style";

    const sessionGains = new Map();

    let baseline = new Map();
    let baselineReady = false;
    let inventory = new Map();
    let lastGain = new Map();
    let lastGainAt = 0;
    let startedAt = Date.now();
    let mastery = null;

    let panel = null;
    let bodyElement = null;
    let collapseButton = null;
    let collapsed = false;

    try {
        collapsed = localStorage.getItem(STORAGE_COLLAPSED) === "1";
    } catch (_) {}

    function apiBase() {
        const match = String(location.pathname || "").match(/^\/c\/([^/]+)/i);
        return match ? `/c/${encodeURIComponent(match[1])}/api` : "/api";
    }

    function formatValue(total) {
        const value = Math.max(0, Math.round(Number(total) || 0));
        const pieces = Math.floor(value / 100);
        const shards = value % 100;

        if (!shards) return `${pieces} шт`;
        if (!pieces) return `${shards} оск.`;

        return `${pieces} шт ${shards} оск.`;
    }

    function resourceName(id) {
        const names = window.LG_GAME_DATA && window.LG_GAME_DATA.res;
        return (names && names[id]) || id;
    }

    function totalsOf(hero) {
        const totals = new Map();

        for (const item of (hero && Array.isArray(hero.items) ? hero.items : [])) {
            if (!item || !item.qty) continue;

            const quantity = Number(item.q) || 0;
            if (quantity <= 0) continue;

            const resource = String(item.res || "").trim().toLowerCase();
            if (!resource) continue;

            totals.set(resource, (totals.get(resource) || 0) + quantity);
        }

        return totals;
    }

    function applyMastery(me) {
        const mx = me && me.mx;
        if (!mx) return;

        const lv = Number(mx.lv);
        if (!Number.isFinite(lv)) return;

        const next = {
            lv,
            xp: Number(mx.xp) || 0,
            need: Number(mx.need) || 0
        };

        if (
            mastery &&
            mastery.lv === next.lv &&
            mastery.xp === next.xp &&
            mastery.need === next.need
        ) {
            return;
        }

        mastery = next;
        render();
    }

    function observeHero(hero) {
        if (!hero || !Array.isArray(hero.items)) return;

        if (hero.mn && typeof hero.mn === "object") {
            for (const state of Object.values(hero.mn)) {
                if (state && typeof state === "object") applyMastery(state);
            }
        }

        const totals = totalsOf(hero);

        if (!baselineReady) {
            baseline = totals;
            inventory = totals;
            baselineReady = true;
            render();
            return;
        }

        const tick = new Map();

        for (const [resource, quantity] of totals) {
            const previous = baseline.get(resource) || 0;
            const delta = quantity - previous;

            if (delta <= 0) continue;

            sessionGains.set(
                resource,
                (sessionGains.get(resource) || 0) + delta
            );
            tick.set(resource, delta);
        }

        if (tick.size) {
            lastGain = tick;
            lastGainAt = Date.now();
        }

        baseline = totals;
        inventory = totals;

        render();
    }

    function pathnameOf(url) {
        try {
            return new URL(String(url), location.href).pathname;
        } catch (_) {
            return "";
        }
    }

    function isHeroPath(path) {
        return /\/api\/me$/i.test(path);
    }

    function isMineStatePath(path) {
        return /\/api\/mine\/(state|enter)$/i.test(path);
    }

    function handleJson(url, json) {
        if (!json || typeof json !== "object") return;

        const path = pathnameOf(url);

        if (isHeroPath(path)) {
            if (json.hero) observeHero(json.hero);
            return;
        }

        if (isMineStatePath(path)) {
            if (json.me) applyMastery(json.me);
            if (json.hero) observeHero(json.hero);
        }
    }

    const nativeFetch = window.fetch;

    if (typeof nativeFetch === "function") {
        window.fetch = function (...args) {
            const input = args[0];
            const url = typeof input === "string"
                ? input
                : input?.url || String(input);

            return nativeFetch.apply(this, args).then(response => {
                try {
                    const path = pathnameOf(url);

                    if (
                        response &&
                        response.ok &&
                        (isHeroPath(path) || isMineStatePath(path))
                    ) {
                        response.clone().json()
                            .then(json => handleJson(url, json))
                            .catch(() => {});
                    }
                } catch (_) {}

                return response;
            });
        };
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__mineLootRuUrl = String(url || "");
        return originalOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener("load", () => {
            try {
                const url = this.__mineLootRuUrl || "";
                const path = pathnameOf(url);

                if (
                    this.status >= 200 &&
                    this.status < 300 &&
                    (isHeroPath(path) || isMineStatePath(path))
                ) {
                    handleJson(url, JSON.parse(this.responseText));
                }
            } catch (_) {}
        });

        return originalSend.apply(this, args);
    };

    async function refreshHero() {
        const request = typeof nativeFetch === "function"
            ? nativeFetch
            : window.fetch;

        if (typeof request !== "function") return;

        const urls = [`${apiBase()}/me`, "/api/me"];

        for (const url of urls) {
            try {
                const response = await request.call(window, url, {
                    credentials: "same-origin",
                    headers: { "Accept": "application/json" }
                });

                if (!response || !response.ok) continue;

                const json = await response.json();
                if (json && json.hero) {
                    observeHero(json.hero);
                    return;
                }
            } catch (_) {}
        }
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);

        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;

        return node;
    }

    function card() {
        return el("div", "mloot-card");
    }

    function row(name, value) {
        const line = el("div", "mloot-row");
        line.append(el("span", "mloot-name", name), el("b", null, value));
        return line;
    }

    function fillRows(cardNode, map, empty) {
        const rows = [...map.entries()].sort((a, b) => b[1] - a[1]);

        if (!rows.length) {
            cardNode.append(el("div", "mloot-empty", empty));
            return 0;
        }

        const list = el("ul", "mloot-list");
        let total = 0;

        for (const [resource, value] of rows) {
            const line = el("li", "mloot-row");
            line.append(
                el("span", "mloot-name", resourceName(resource)),
                el("b", null, formatValue(value))
            );
            list.append(line);
            total += value;
        }

        cardNode.append(list);
        return total;
    }

    function render() {
        if (!bodyElement) return;

        const fragment = document.createDocumentFragment();

        const status = card();
        status.append(row("Сессия", new Date(startedAt).toLocaleTimeString("ru-RU")));

        if (mastery) {
            status.append(row("Уровень", `${mastery.lv} лвл`));

            if (mastery.need > 0) {
                const percent = Math.min(
                    100,
                    Math.max(0, mastery.xp / mastery.need * 100)
                );
                const bar = el("div", "mloot-bar");
                const fill = el("i");
                fill.style.width = `${percent.toFixed(1)}%`;
                bar.append(fill);
                status.append(
                    bar,
                    el("div", "mloot-muted", `${mastery.xp} / ${mastery.need}`)
                );
            } else {
                status.append(el("div", "mloot-muted", `${mastery.xp} / —`));
            }
        }

        fragment.append(status);

        const last = card();
        const lastHead = el("div", "mloot-kline");
        lastHead.append(el("div", "mloot-k", "Последняя руда"));

        if (lastGainAt) {
            lastHead.append(el("span", "mloot-time", new Date(lastGainAt).toLocaleTimeString("ru-RU")));
        }

        last.append(lastHead);
        fillRows(last, lastGain, "пока не было");
        fragment.append(last);

        const session = card();
        session.append(el("div", "mloot-k", "За сессию"));
        const sessionTotal = fillRows(session, sessionGains, "прироста пока нет");

        if (sessionTotal) {
            const total = row("Итого", formatValue(sessionTotal));
            total.classList.add("mloot-total");
            session.append(total);
        }

        fragment.append(session);

        const bag = card();
        bag.append(el("div", "mloot-k", "Инвентарь"));
        fillRows(bag, inventory, "пусто");
        fragment.append(bag);

        bodyElement.textContent = "";
        bodyElement.append(fragment);
    }

    function applyCollapsed() {
        if (!bodyElement || !collapseButton) return;

        bodyElement.style.display = collapsed ? "none" : "grid";
        collapseButton.textContent = collapsed ? "+" : "−";
        collapseButton.title = collapsed ? "Развернуть" : "Свернуть";
    }

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;

        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
            #${PANEL_ID} {
                --ml-bg: rgba(29, 22, 32, .96);
                --ml-card: rgba(255, 255, 255, .05);
                --ml-line: rgba(255, 255, 255, .08);
                --ml-gold: #ffcf6a;
                --ml-mute: #bfaab7;
                --ml-ink: #f3efe6;
                position: fixed;
                left: 16px;
                bottom: 16px;
                z-index: 2147483646;
                width: 320px;
                max-width: calc(100vw - 32px);
                overflow: hidden;
                color: var(--ml-ink);
                background: var(--ml-bg);
                border-radius: 22px;
                box-shadow: 0 18px 40px rgba(0, 0, 0, .4), inset 0 0 0 1px var(--ml-line);
                font-family: "Golos Text", Arial, sans-serif;
                font-size: 12px;
            }

            #${PANEL_ID} .mloot-head {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 14px 16px 10px;
                border-bottom: 1px solid rgba(255, 207, 106, .16);
                cursor: grab;
                user-select: none;
                touch-action: none;
            }

            #${PANEL_ID} .mloot-title {
                flex: 1;
                min-width: 0;
                font: 700 15px "Russo One", "Golos Text", Arial, sans-serif;
                letter-spacing: .02em;
                color: var(--ml-gold);
            }

            #${PANEL_ID} .mloot-btn {
                flex: 0 0 auto;
                padding: 5px 9px;
                color: var(--ml-ink);
                background: linear-gradient(#4a3f52, #3a3142);
                border: 2px solid #15122e;
                border-radius: 10px;
                box-shadow: inset 0 -2px 0 rgba(0, 0, 0, .35);
                font: 700 11px "Golos Text", Arial, sans-serif;
                cursor: pointer;
            }

            #${PANEL_ID} .mloot-btn:hover {
                filter: brightness(1.12);
            }

            #${PANEL_ID} .mloot-btn:active {
                transform: translateY(1px);
                box-shadow: inset 0 2px 0 rgba(0, 0, 0, .35);
            }

            #${PANEL_ID} .mloot-square {
                width: 26px;
                height: 26px;
                padding: 0;
                font-size: 14px;
                line-height: 1;
            }

            #${PANEL_ID} .mloot-body {
                display: grid;
                gap: 10px;
                padding: 12px;
                max-height: min(62vh, 460px);
                overflow: auto;
            }

            #${PANEL_ID} .mloot-card {
                display: grid;
                gap: 8px;
                padding: 12px 14px;
                border-radius: 16px;
                background: var(--ml-card);
                box-shadow: inset 0 0 0 1px var(--ml-line);
            }

            #${PANEL_ID} .mloot-k {
                font: 800 11px "Golos Text", Arial, sans-serif;
                text-transform: uppercase;
                letter-spacing: .08em;
                color: var(--ml-mute);
            }

            #${PANEL_ID} .mloot-kline {
                display: flex;
                align-items: baseline;
                justify-content: space-between;
                gap: 8px;
            }

            #${PANEL_ID} .mloot-time {
                color: var(--ml-mute);
                font: 700 10px "Golos Text", Arial, sans-serif;
                white-space: nowrap;
            }

            #${PANEL_ID} .mloot-list {
                display: grid;
                gap: 5px;
                margin: 0;
                padding: 0;
                list-style: none;
            }

            #${PANEL_ID} .mloot-row {
                display: flex;
                align-items: baseline;
                justify-content: space-between;
                gap: 8px;
                min-width: 0;
            }

            #${PANEL_ID} .mloot-row b {
                color: var(--ml-gold);
                font-weight: 700;
                white-space: nowrap;
            }

            #${PANEL_ID} .mloot-name {
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            #${PANEL_ID} .mloot-empty,
            #${PANEL_ID} .mloot-muted {
                color: var(--ml-mute);
                font-size: 11px;
            }

            #${PANEL_ID} .mloot-total {
                padding-top: 6px;
                border-top: 1px solid var(--ml-line);
            }

            #${PANEL_ID} .mloot-bar {
                height: 8px;
                padding: 1px;
                border-radius: 999px;
                background: rgba(21, 18, 46, .8);
                box-sizing: border-box;
                overflow: hidden;
            }

            #${PANEL_ID} .mloot-bar i {
                display: block;
                height: 100%;
                border-radius: 999px;
                background: linear-gradient(90deg, #ffcf6a, #ffe27a);
            }
        `;

        (document.head || document.documentElement).append(style);
    }

    function createPanel() {
        if (panel || !document.body) return;

        injectStyles();

        panel = document.createElement("div");
        panel.id = PANEL_ID;

        const header = el("div", "mloot-head");

        const title = el("div", "mloot-title", "Добыча");

        const resetButton = el("button", "mloot-btn", "Сбросить");
        resetButton.type = "button";
        resetButton.addEventListener("click", () => {
            sessionGains.clear();
            lastGain = new Map();
            lastGainAt = 0;
            baseline = new Map();
            baselineReady = false;
            inventory = new Map();
            startedAt = Date.now();
            render();
            void refreshHero();
        });

        collapseButton = el("button", "mloot-btn mloot-square");
        collapseButton.type = "button";
        collapseButton.addEventListener("click", () => {
            collapsed = !collapsed;

            try {
                localStorage.setItem(STORAGE_COLLAPSED, collapsed ? "1" : "0");
            } catch (_) {}

            applyCollapsed();
        });

        header.append(title, resetButton, collapseButton);

        bodyElement = el("div", "mloot-body");

        panel.append(header, bodyElement);
        document.body.append(panel);

        applyCollapsed();
        render();

        let drag = null;

        header.addEventListener("pointerdown", event => {
            if (event.target.closest("button")) return;

            const rect = panel.getBoundingClientRect();
            drag = {
                dx: event.clientX - rect.left,
                dy: event.clientY - rect.top
            };

            try {
                header.setPointerCapture(event.pointerId);
            } catch (_) {}

            header.style.cursor = "grabbing";
        });

        header.addEventListener("pointermove", event => {
            if (!drag) return;

            panel.style.left = `${Math.max(0, Math.min(
                window.innerWidth - panel.offsetWidth,
                event.clientX - drag.dx
            ))}px`;
            panel.style.top = `${Math.max(0, Math.min(
                window.innerHeight - panel.offsetHeight,
                event.clientY - drag.dy
            ))}px`;
            panel.style.bottom = "auto";
        });

        header.addEventListener("pointerup", () => {
            drag = null;
            header.style.cursor = "grab";
        });

        header.addEventListener("pointercancel", () => {
            drag = null;
            header.style.cursor = "grab";
        });
    }

    if (document.body) {
        createPanel();
    } else {
        document.addEventListener("DOMContentLoaded", createPanel, { once: true });
    }

    void refreshHero();
    setInterval(() => {
        if (!document.hidden) void refreshHero();
    }, REFRESH_MS);

    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) void refreshHero();
    });
})();
