// ==UserScript==
// @name         Twitch Chat Link Embedder Pro
// @namespace    http://tampermonkey.net/
// @version      2.6.1
// @description  Transforme les liens du chat Twitch en embeds propres et interactifs.
// @author       VooDoo
// @match        *://*.twitch.tv/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      *
// @updateURL    https://raw.githubusercontent.com/dearvoodoo/Twitch-Chat-Link-Embedder-Pro/main/Twitch%20Chat%20Link%20Embedder%20Pro.user.js
// @downloadURL  https://raw.githubusercontent.com/dearvoodoo/Twitch-Chat-Link-Embedder-Pro/main/Twitch%20Chat%20Link%20Embedder%20Pro.user.js
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // ─────────────────────────────────────────────
    //  CONFIG
    // ─────────────────────────────────────────────
    const SCRIPT_NAME    = 'Twitch Chat Link Embedder Pro';
    const SCRIPT_VERSION = '2.6.1';

    const CONFIG = {
        EMBED_API_URL:          'https://api.the-coven.fr',
        MAX_RETRIES:            15,
        RETRY_DELAY:            1000,
        POLL_INTERVAL:          3000,
        MAX_API_RETRIES:        3,
        API_RETRY_DELAY:        500,
        DEBOUNCE_DELAY:         500,
        BATCH_PROCESSING_DELAY: 50,
        CACHE_DURATION:         120_000,   // 2 min
        CACHE_PURGE_INTERVAL:   60_000,    // purge toutes les 60 s
        REQUEST_TIMEOUT:        10_000,
        BUTTON_INJECT_DEBOUNCE: 300,
    };

    // ─────────────────────────────────────────────
    //  LOGGER
    // ─────────────────────────────────────────────
    const Logger = {
        levels: { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 },
        level: 2,
        setDebugMode(debug) { this.level = debug ? this.levels.DEBUG : this.levels.INFO; },
        log(level, message, ...args) {
            if (level > this.level) return;
            const prefixes = ['❌ [TwitchEmbed]', '⚠️ [TwitchEmbed]', 'ℹ️ [TwitchEmbed]', '🐛 [TwitchEmbed]'];
            const styles   = [
                'color:#ff4444;font-weight:bold;',
                'color:#ffaa00;font-weight:bold;',
                'color:#44aaff;font-weight:bold;',
                'color:#00aa44;font-weight:bold;',
            ];
            console.log(`%c${prefixes[level]} ${message}`, styles[level], ...args);
        },
        error: function (m, ...a) { this.log(0, m, ...a); },
        warn:  function (m, ...a) { this.log(1, m, ...a); },
        info:  function (m, ...a) { this.log(2, m, ...a); },
        debug: function (m, ...a) { this.log(3, m, ...a); },
    };

    // ─────────────────────────────────────────────
    //  STORAGE
    // ─────────────────────────────────────────────
    const Storage = {
        get(key, def) {
            try { return GM_getValue(key, def); }
            catch (e) { Logger.error('Storage.get:', e); return def; }
        },
        set(key, val) {
            try { GM_setValue(key, val); }
            catch (e) { Logger.error('Storage.set:', e); }
        },
    };

    // ─────────────────────────────────────────────
    //  USER CONFIG
    // ─────────────────────────────────────────────
    const USER_CONFIG = {
        embedStyle:        Storage.get('embedStyle',        'dark-glass'),
        compactMode:       Storage.get('compactMode',       false),
        enableYouTube:     Storage.get('enableYouTube',     true),
        enableDiscord:     Storage.get('enableDiscord',     true),
        enableTwitch:      Storage.get('enableTwitch',      true),
        enableSteam:       Storage.get('enableSteam',       true),
        enableMeta:        Storage.get('enableMeta',        true),
        enableImages:      Storage.get('enableImages',      true),
        enableAllLinks:    Storage.get('enableAllLinks',    true),
        debugMode:         Storage.get('debugMode',         false),
        enableImageEmbeds: Storage.get('enableImageEmbeds', true),
        maxImageWidth:     Storage.get('maxImageWidth',     300),
        maxImageHeight:    Storage.get('maxImageHeight',    200),
        enableGamesPlanet: Storage.get('enableGamesPlanet', true),
        enableKoFi:        Storage.get('enableKoFi',        true),
        enableEneba:       Storage.get('enableEneba',       true),
    };

    Logger.setDebugMode(USER_CONFIG.debugMode);
    Logger.info(`${SCRIPT_NAME} v${SCRIPT_VERSION} initializing…`);

    // ─────────────────────────────────────────────
    //  SELECTORS
    // ─────────────────────────────────────────────
    const SELECTORS = {
        chat: [
            '.chat-scrollable-area__message-container',
            '[data-test-selector="chat-scrollable-area__message-container"]',
            '[data-a-target="chat-scrollable-area"]',
            '.stream-chat',
            'twitch-chat',
            '.chat-list',
            '.chat-room',
        ],
        message:      '.chat-line__message, [data-a-target="chat-line-message"]',
        link:         'a[href^="http"]:not([data-ptl-embed])',
        chatButtons:  '.Layout-sc-1xcs6mc-0.cUmVME',
        chatSettings: '[data-a-target="chat-settings"]',
    };

    // ─────────────────────────────────────────────
    //  UTILS
    // ─────────────────────────────────────────────
    const Utils = {
        debounce(fn, wait) {
            let t;
            return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
        },

        formatNumber(num) {
            if (!num) return '0';
            return Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 }).format(
                typeof num === 'string' ? parseInt(num, 10) : num
            );
        },

        /** Échappe HTML. Retourne '' si null/undefined. */
        escapeHtml(unsafe) {
            if (unsafe == null) return '';
            return String(unsafe)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        },

        /**
         * Valide qu'une URL est http(s) seulement.
         * Retourne l'URL nettoyée ou '#' si invalide/dangereux.
         */
        sanitizeUrl(raw) {
            try {
                const u = new URL(raw);
                if (u.protocol !== 'http:' && u.protocol !== 'https:') return '#';
                return u.href;
            } catch (_) { return '#'; }
        },

        createElement(html) {
            const t = document.createElement('template');
            t.innerHTML = html.trim();
            return t.content.firstElementChild;
        },
    };

    // ─────────────────────────────────────────────
    //  REQUEST MANAGER  (cache + dédup + retry + purge)
    // ─────────────────────────────────────────────
    class RequestManager {
        constructor() {
            this.cache          = new Map();
            this.pendingReqs    = new Map();
            this.failedReqs     = new Map();

            // Purge périodique des entrées expirées
            setInterval(() => this._purgeCache(), CONFIG.CACHE_PURGE_INTERVAL);
        }

        _purgeCache() {
            const now = Date.now();
            for (const [k, { timestamp }] of this.cache) {
                if (now - timestamp > CONFIG.CACHE_DURATION) this.cache.delete(k);
            }
            for (const [k, { timestamp }] of this.failedReqs) {
                if (now - timestamp > 30_000) this.failedReqs.delete(k);
            }
        }

        // Clé simple : on évite JSON.stringify sur options répétitif
        _cacheKey(url, parseAs) { return `${parseAs}::${url}`; }

        async fetchWithCache(url, options = {}, parseAs = 'json') {
            const key = this._cacheKey(url, parseAs);

            if (this.failedReqs.has(key)) {
                throw new Error('Request failed recently, skipping retry');
            }
            if (this.pendingReqs.has(key)) {
                return this.pendingReqs.get(key);
            }
            const cached = this.cache.get(key);
            if (cached && Date.now() - cached.timestamp < CONFIG.CACHE_DURATION) {
                return cached.data;
            }

            const p = this._doFetch(url, options, parseAs)
            .then(data => { this.cache.set(key, { timestamp: Date.now(), data }); return data; })
            .catch(err => { this.failedReqs.set(key, { timestamp: Date.now() }); throw err; })
            .finally(() => this.pendingReqs.delete(key));

            this.pendingReqs.set(key, p);
            return p;
        }

        async _doFetch(url, options = {}, parseAs = 'json', retries = CONFIG.MAX_API_RETRIES) {
            const ctrl = new AbortController();
            const tid  = setTimeout(() => ctrl.abort(), CONFIG.REQUEST_TIMEOUT);
            try {
                const res = await fetch(url, { ...options, signal: ctrl.signal });
                clearTimeout(tid);
                if (!res.ok) {
                    if (res.status >= 500 || res.status === 429)
                        throw new Error(`HTTP ${res.status}`);
                    return { error: true, status: res.status };
                }
                return parseAs === 'json' ? res.json() : res.text();
            } catch (err) {
                clearTimeout(tid);
                if (retries > 0 && this._isRetryable(err)) {
                    const delay = CONFIG.API_RETRY_DELAY * Math.pow(2, CONFIG.MAX_API_RETRIES - retries);
                    await new Promise(r => setTimeout(r, delay));
                    return this._doFetch(url, options, parseAs, retries - 1);
                }
                throw err;
            }
        }

        _isRetryable(err) {
            return /HTTP 5|HTTP 429|Failed to fetch|abort/.test(err.message);
        }

        clearCache() {
            this.cache.clear();
            this.pendingReqs.clear();
            this.failedReqs.clear();
        }
    }

    const requestManager = new RequestManager();

    // ─────────────────────────────────────────────
    //  CONTENT DETECTORS
    // ─────────────────────────────────────────────
    const ContentDetectors = {
        youtube(url) {
            // Shorts
            const shortsMatch = url.pathname.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
            if (shortsMatch) return { type: 'video', id: shortsMatch[1] };

            // Playlist
            const plMatch = url.search.match(/[?&]list=([a-zA-Z0-9_-]+)/);
            if (plMatch) return { type: 'playlist', id: plMatch[1] };

            // youtu.be
            if (url.hostname.includes('youtu.be')) {
                const id = url.pathname.split('/')[1];
                return { type: 'video', id };
            }

            // ?v=
            const vMatch = url.search.match(/[?&]v=([^&#]+)/);
            if (vMatch) return { type: 'video', id: vMatch[1] };

            // Channel / user
            const p = url.pathname;
            if (p.startsWith('/@') || p.startsWith('/channel/') ||
                p.startsWith('/c/') || p.startsWith('/user/') || /^\/[^/]+$/.test(p)) {
                return { type: 'channel', id: this._ytChannelId(url) };
            }
            return { type: 'unknown' };
        },

        _ytChannelId(url) {
            const p = url.pathname;
            if (p.startsWith('/@'))       return p.split('/')[1];
            if (p.startsWith('/channel/')) return p.split('/')[2];
            if (p.startsWith('/c/'))       return p.split('/')[2];
            if (p.startsWith('/user/'))    return p.split('/')[2];
            if (/^\/[^/]+$/.test(p))      return `@${p.split('/')[1]}`;
            return null;
        },

        twitch(url) {
            const path = url.pathname;
            if (/^\/drops\/inventory\/?$/i.test(path)) return { type: 'drop', id: 666 };
            if (url.hostname === 'subs.twitch.tv') {
                const m = path.match(/^\/([a-zA-Z0-9_]+)$/i);
                if (m) return { type: 'sub', id: m[1] };
            }
            if (/^\/subs\/([a-zA-Z0-9_]+)$/i.test(path) || /^\/([a-zA-Z0-9_]+)\/subs?$/i.test(path)) {
                return { type: 'sub', id: path.match(/\/([a-zA-Z0-9_]+)/)[1] };
            }
            const clip  = path.match(/\/(?:[^/]+\/)?clip\/([a-zA-Z0-9_-]+)/i);
            if (clip)  return { type: 'clip',    id: clip[1] };
            const video = path.match(/\/videos\/([0-9]+)/i);
            if (video) return { type: 'video',   id: video[1] };
            const chan  = path.match(/^\/([a-zA-Z0-9_]+)\/?$/i);
            if (chan)  return { type: 'channel', id: chan[1] };
            return { type: 'unknown' };
        },

        discord(url) {
            const m = url.pathname.match(/^\/(?:invite\/)?([a-zA-Z0-9_-]+)$/);
            return m ? { type: 'invite', id: m[1] } : { type: 'unknown' };
        },

        steam(url) {
            const app = url.pathname.match(/^\/app\/(\d+)/);
            if (app) return { type: 'game', id: app[1] };
            if (url.hostname.includes('steampowered.com')) return { type: 'meta' };
            return { type: 'unknown' };
        },

        image(url) {
            const exts   = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];
            const path   = url.pathname.toLowerCase();
            const isExt  = exts.some(e => path.endsWith(e));
            const isHost = ['i.imgur.com', 'cdn.discordapp.com', 'media.discordapp.net']
            .some(h => url.hostname.includes(h));
            if (isExt || isHost) return { type: 'image', url: url.href };
            return { type: 'unknown' };
        },
    };

    // ─────────────────────────────────────────────
    //  EMBED STYLES
    // ─────────────────────────────────────────────
    const EmbedStyles = {
        'dark-glass': {
            background:       'rgba(15, 15, 20, 0.75)',
            border:           '1px solid rgba(255,255,255,0.12)',
            hoverBackground:  'rgba(30, 30, 40, 0.85)',
            hoverBorder:      'rgba(145,71,255,0.5)',
            textColor:        'rgba(255,255,255,0.95)',
            secondaryText:    'rgba(255,255,255,0.6)',
            backdropFilter:   'blur(12px) saturate(180%)',
        },
        'light-glass': {
            background:       'rgba(255,255,255,0.82)',
            border:           '1px solid rgba(0,0,0,0.08)',
            hoverBackground:  'rgba(255,255,255,0.95)',
            hoverBorder:      'rgba(145,71,255,0.45)',
            textColor:        'rgba(0,0,0,0.88)',
            secondaryText:    'rgba(0,0,0,0.55)',
            backdropFilter:   'blur(12px) saturate(180%)',
        },
    };

    // ─────────────────────────────────────────────
    //  PLATFORM LOGOS (SVG inline)
    // ─────────────────────────────────────────────
    const PlatformLogos = {
        youtube: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/></svg>`,
        discord: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M14.82 4.26a10.14 10.14 0 0 0-.53 1.1 14.66 14.66 0 0 0-4.58 0 10.14 10.14 0 0 0-.53-1.1 16 16 0 0 0-4.13 1.3 17.33 17.33 0 0 0-3 11.59 16.6 16.6 0 0 0 5.07 2.59A12.89 12.89 0 0 0 8.23 18a9.65 9.65 0 0 1-1.71-.83 3.39 3.39 0 0 0 .42-.33 11.66 11.66 0 0 0 10.12 0c.14.09.28.19.42.33a10.9 10.9 0 0 1-1.71.84 12.89 12.89 0 0 0 1.08 1.78 16.44 16.44 0 0 0 5.06-2.59 17.22 17.22 0 0 0-3-11.59 16.09 16.09 0 0 0-4.09-1.35zM8.68 14.81a1.94 1.94 0 0 1-1.8-2 1.93 1.93 0 0 1 1.8-2 1.93 1.93 0 0 1 1.8 2 1.93 1.93 0 0 1-1.8 2zm6.64 0a1.94 1.94 0 0 1-1.8-2 1.93 1.93 0 0 1 1.8-2 1.92 1.92 0 0 1 1.8 2 1.92 1.92 0 0 1-1.8 2z"/></svg>`,
        twitch:  `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/></svg>`,
        steam:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.29-.249-1.878-.03l1.523.63c.956.4 1.409 1.5 1.009 2.455-.397.957-1.497 1.41-2.454 1.012H7.54zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.665 0-3.015 1.353-3.015 3.015 0 1.665 1.35 3.015 3.015 3.015 1.663 0 3.015-1.35 3.015-3.015zm-5.273-.005c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.253 0-2.265-1.014-2.265-2.265z"/></svg>`,
        image:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>`,
        default: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>`,
    };

    // ─────────────────────────────────────────────
    //  GM XHR CACHE  (pour GM_xmlhttpRequest, non mis en cache par RequestManager)
    // ─────────────────────────────────────────────
    const gmCache = new Map();

    function gmFetchCached(url) {
        const key = url;
        if (gmCache.has(key)) {
            const { ts, p } = gmCache.get(key);
            if (Date.now() - ts < CONFIG.CACHE_DURATION) return p;
        }
        const p = new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method:  'GET',
                url,
                onload:  r => resolve(r.responseText),
                onerror: e => reject(e),
            });
        });
        gmCache.set(key, { ts: Date.now(), p });
        return p;
    }

    // ─────────────────────────────────────────────
    //  EMBED FACTORY
    // ─────────────────────────────────────────────
    class EmbedFactory {

        static async createEmbed(url) {
            const host = url.hostname.replace('www.', '').toLowerCase();
            Logger.info(`Processing: ${url.href}`);

            if (!USER_CONFIG.enableAllLinks) return null;

            // Image directe
            const imgInfo = ContentDetectors.image(url);
            if (imgInfo.type === 'image' && USER_CONFIG.enableImageEmbeds)
                return this.createImageEmbed(url);

            try {
                const map = {
                    'youtube.com':         () => USER_CONFIG.enableYouTube     ? this.createYoutubeEmbed(url)     : null,
                    'youtu.be':            () => USER_CONFIG.enableYouTube     ? this.createYoutubeEmbed(url)     : null,
                    'discord.com':         () => USER_CONFIG.enableDiscord     ? this.createDiscordEmbed(url)     : null,
                    'discord.gg':          () => USER_CONFIG.enableDiscord     ? this.createDiscordEmbed(url)     : null,
                    'twitch.tv':           () => USER_CONFIG.enableTwitch      ? this.createTwitchEmbed(url)      : null,
                    'subs.twitch.tv':      () => USER_CONFIG.enableTwitch      ? this.createTwitchEmbed(url)      : null,
                    'store.steampowered.com': () => USER_CONFIG.enableSteam   ? this.createSteamEmbed(url)       : null,
                    'steampowered.com':    () => USER_CONFIG.enableSteam      ? this.createSteamEmbed(url)       : null,
                    'fr.gamesplanet.com':  () => USER_CONFIG.enableGamesPlanet? this.createGamesPlanetEmbed(url) : null,
                    'gamesplanet.com':     () => USER_CONFIG.enableGamesPlanet? this.createGamesPlanetEmbed(url) : null,
                    'ko-fi.com':           () => USER_CONFIG.enableKoFi        ? this.createMetaEmbed(url)        : null,
                    'eneba.com':           () => USER_CONFIG.enableEneba       ? this.createMetaEmbed(url)        : null,
                };

                const creator = map[host];
                if (creator) {
                    const embed = await creator();
                    if (embed) return embed;
                }
                return USER_CONFIG.enableAllLinks ? this.createDefaultEmbed(url) : null;
            } catch (err) {
                Logger.error(`Embed creation failed for ${host}:`, err);
                return USER_CONFIG.enableAllLinks ? this.createDefaultEmbed(url) : null;
            }
        }

        // ── YouTube ──────────────────────────────
        static async createYoutubeEmbed(url) {
            const info = ContentDetectors.youtube(url);
            if (!info.id) return null;
            try {
                let apiUrl, data;
                switch (info.type) {
                    case 'video':
                        apiUrl = `${CONFIG.EMBED_API_URL}/youtube/video?id=${info.id}`;
                        data   = await requestManager.fetchWithCache(apiUrl);
                        if (!data) return null;
                        return this._build(`
                            <div class="embed-header">
                                <div class="embed-platform-logo">${PlatformLogos.youtube}</div>
                                <div class="embed-platform-name">YouTube · Vidéo</div>
                            </div>
                            <div class="embed-body">
                                <div class="embed-thumbnail">
                                    <img src="${Utils.sanitizeUrl(data.thumbnail?.maxres || data.thumbnail?.default)}" loading="lazy" alt="">
                                    <div class="embed-play-button"><svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg></div>
                                </div>
                                <div class="embed-content">
                                    <div class="embed-title">${Utils.escapeHtml(data.title)}</div>
                                    <div class="embed-details">
                                        <div class="embed-channel">${Utils.escapeHtml(data.channel_title)}</div>
                                        <div class="embed-stats"><span class="embed-stat">${Utils.formatNumber(data.view)} vues</span></div>
                                    </div>
                                </div>
                            </div>`, 'youtube', url);

                    case 'channel':
                        apiUrl = `${CONFIG.EMBED_API_URL}/youtube/channel?channel=${info.id}`;
                        data   = await requestManager.fetchWithCache(apiUrl);
                        if (!data) return null;
                        return this._build(`
                            <div class="embed-header">
                                <div class="embed-platform-logo">${PlatformLogos.youtube}</div>
                                <div class="embed-platform-name">YouTube · Chaîne</div>
                            </div>
                            <div class="embed-body">
                                <div class="embed-thumbnail squared">
                                    <img src="${Utils.sanitizeUrl(data.thumbnail)}" loading="lazy" alt="">
                                </div>
                                <div class="embed-content">
                                    <div class="embed-title">${Utils.escapeHtml(data.title)}</div>
                                    <div class="embed-stats">
                                        <span class="embed-stat">${Utils.formatNumber(data.statistics?.view_count)} vues</span>
                                        <span class="embed-stat">${Utils.formatNumber(data.statistics?.video_count)} vidéos</span>
                                        <span class="embed-stat">${Utils.formatNumber(data.statistics?.subscriber_count)} abonnés</span>
                                    </div>
                                </div>
                            </div>`, 'youtube', url);

                    case 'playlist':
                        apiUrl = `${CONFIG.EMBED_API_URL}/youtube/playlist?id=${info.id}`;
                        data   = await requestManager.fetchWithCache(apiUrl);
                        if (!data) return null;
                        return this._build(`
                            <div class="embed-header">
                                <div class="embed-platform-logo">${PlatformLogos.youtube}</div>
                                <div class="embed-platform-name">YouTube · Playlist</div>
                            </div>
                            <div class="embed-body">
                                <div class="embed-thumbnail">
                                    <img src="${Utils.sanitizeUrl(data.thumbnail?.maxres || data.thumbnail?.default)}" loading="lazy" alt="">
                                </div>
                                <div class="embed-content">
                                    <div class="embed-title">${Utils.escapeHtml(data.title)}</div>
                                    <div class="embed-channel">${Utils.escapeHtml(data.channelTitle)}</div>
                                    <div class="embed-stats"><span class="embed-stat">${Utils.formatNumber(data.itemCount)} vidéos</span></div>
                                </div>
                            </div>`, 'youtube', url);
                }
            } catch (err) { Logger.error('YouTube embed failed:', err); return null; }
        }

        // ── Discord ──────────────────────────────
        static async createDiscordEmbed(url) {
            const info = ContentDetectors.discord(url);
            if (info.type !== 'invite') return null;
            try {
                const data = await requestManager.fetchWithCache(
                    `https://discord.com/api/v9/invites/${info.id}?with_counts=true`
                );
                if (!data?.guild) return null;
                const icon = data.guild.icon
                ? Utils.sanitizeUrl(`https://cdn.discordapp.com/icons/${data.guild.id}/${data.guild.icon}.png`)
                : '';
                return this._build(`
                    <div class="embed-header">
                        <div class="embed-platform-logo">${PlatformLogos.discord}</div>
                        <div class="embed-platform-name">Discord · Invitation</div>
                    </div>
                    <div class="embed-body">
                        ${icon ? `<div class="embed-thumbnail squared"><img src="${icon}" loading="lazy" alt=""></div>` : ''}
                        <div class="embed-content">
                            <div class="embed-title">${Utils.escapeHtml(data.guild.name)}</div>
                            <div class="embed-stats">
                                <span class="embed-stat">${Utils.formatNumber(data.approximate_member_count)} membres</span>
                                ${data.inviter ? `<span class="embed-stat">Via ${Utils.escapeHtml(data.inviter.global_name)}</span>` : ''}
                            </div>
                        </div>
                    </div>`, 'discord', url);
            } catch (err) { Logger.error('Discord embed failed:', err); return null; }
        }

        // ── Twitch ───────────────────────────────
        static async createTwitchEmbed(url) {
            const info = ContentDetectors.twitch(url);
            if (!info.id) return null;
            try {
                let apiUrl, data;
                switch (info.type) {
                    case 'clip':
                        apiUrl = `${CONFIG.EMBED_API_URL}/twitch/clip?id=${info.id}`;
                        data   = await requestManager.fetchWithCache(apiUrl);
                        if (!data) return null;
                        return this._build(`
                            <div class="embed-header">
                                <div class="embed-platform-logo">${PlatformLogos.twitch}</div>
                                <div class="embed-platform-name">Twitch · Clip</div>
                            </div>
                            <div class="embed-body">
                                <div class="embed-thumbnail">
                                    <img src="${Utils.sanitizeUrl(data.clip.thumbnail_url)}" loading="lazy" alt="">
                                    <div class="embed-play-button"><svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg></div>
                                </div>
                                <div class="embed-content">
                                    <div class="embed-title">${Utils.escapeHtml(data.clip.title)}</div>
                                    <div class="embed-channel">Clippé par ${Utils.escapeHtml(data.clip.creator_name)}</div>
                                    <div class="embed-stats"><span class="embed-stat">${Utils.formatNumber(data.clip.view_count)} vues</span></div>
                                </div>
                            </div>`, 'twitch', url);

                    case 'channel':
                        apiUrl = `${CONFIG.EMBED_API_URL}/twitch/channel?username=${info.id}`;
                        data   = await requestManager.fetchWithCache(apiUrl);
                        if (!data) return null;
                        return this._build(`
                            <div class="embed-header">
                                <div class="embed-platform-logo">${PlatformLogos.twitch}</div>
                                <div class="embed-platform-name">Twitch · Chaîne</div>
                                ${data.is_live ? '<div class="embed-live-badge">LIVE</div>' : ''}
                            </div>
                            <div class="embed-body">
                                <div class="embed-thumbnail squared">
                                    <img src="${Utils.sanitizeUrl(data.user.profile_image_url)}" loading="lazy" alt="">
                                </div>
                                <div class="embed-content">
                                    <div class="embed-title">${Utils.escapeHtml(data.user.display_name)}</div>
                                    <div class="embed-stats">
                                        ${data.is_live ? `<span class="embed-stat">${Utils.formatNumber(data.stream.viewer_count)} viewers</span>` : ''}
                                    </div>
                                </div>
                            </div>`, 'twitch', url);

                    case 'sub':
                        apiUrl = `${CONFIG.EMBED_API_URL}/twitch/channel?username=${info.id}`;
                        data   = await requestManager.fetchWithCache(apiUrl);
                        if (!data) return null;
                        return this._build(`
                            <div class="embed-header">
                                <div class="embed-platform-logo">${PlatformLogos.twitch}</div>
                                <div class="embed-platform-name">Twitch · Abonnement</div>
                            </div>
                            <div class="embed-body">
                                <div class="embed-thumbnail squared">
                                    <img src="${Utils.sanitizeUrl(data.user.profile_image_url)}" loading="lazy" alt="">
                                </div>
                                <div class="embed-content">
                                    <div class="embed-title">S'abonner à ${Utils.escapeHtml(data.user.display_name)}</div>
                                    <div class="embed-description">💜 Soutenez le streamer avec un abonnement et obtenez des émotes exclusives.</div>
                                </div>
                            </div>`, 'twitch', url);

                    case 'video':
                        apiUrl = `${CONFIG.EMBED_API_URL}/twitch/video?id=${info.id}`;
                        data   = await requestManager.fetchWithCache(apiUrl);
                        if (!data) return null;
                        return this._build(`
                            <div class="embed-header">
                                <div class="embed-platform-logo">${PlatformLogos.twitch}</div>
                                <div class="embed-platform-name">Twitch · VOD</div>
                            </div>
                            <div class="embed-body">
                                <div class="embed-thumbnail">
                                    <img src="${Utils.sanitizeUrl(data.video.thumbnail_url)}" loading="lazy" alt="">
                                    <div class="embed-play-button"><svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg></div>
                                </div>
                                <div class="embed-content">
                                    <div class="embed-title">${Utils.escapeHtml(data.video.title)}</div>
                                    <div class="embed-channel">${Utils.escapeHtml(data.video.user_name)}</div>
                                    <div class="embed-stats">
                                        <span class="embed-stat">${Utils.formatNumber(data.video.view_count)} vues</span>
                                        <span class="embed-stat">${Utils.escapeHtml(data.video.duration)}</span>
                                    </div>
                                </div>
                            </div>`, 'twitch', url);

                    case 'drop':
                        return this._build(`
                            <div class="embed-header">
                                <div class="embed-platform-logo">${PlatformLogos.twitch}</div>
                                <div class="embed-platform-name">Twitch · Drop</div>
                            </div>
                            <div class="embed-body">
                                <div class="embed-content full-width">
                                    <div class="embed-title">Inventaire de Drops Twitch</div>
                                    <div class="embed-description">Consulte tes drops et récupère tes récompenses.</div>
                                </div>
                            </div>`, 'twitch', url);
                }
            } catch (err) { Logger.error('Twitch embed failed:', err); return null; }
        }

        // ── Steam ────────────────────────────────
        static async createSteamEmbed(url) {
            const info = ContentDetectors.steam(url);
            if (info.type !== 'game') return this.createMetaEmbed(url);
            try {
                const appId  = url.pathname.match(/^\/app\/(\d+)/)[1];
                const apiUrl = `https://store.steampowered.com/api/appdetails?appids=${appId}`;
                const raw    = await new Promise((res, rej) => {
                    // Via GM pour éviter CORS
                    GM_xmlhttpRequest({
                        method:  'GET',
                        url:     apiUrl,
                        headers: { Accept: 'application/json' },
                        onload:  r => res(r.responseText),
                        onerror: rej,
                    });
                });
                const json = JSON.parse(raw);
                if (!json[appId]?.success) return null;
                const g = json[appId].data;
                return this._build(`
                    <div class="embed-header">
                        <div class="embed-platform-logo">${PlatformLogos.steam}</div>
                        <div class="embed-platform-name">Steam</div>
                    </div>
                    <div class="embed-body">
                        <div class="embed-thumbnail">
                            <img src="${Utils.sanitizeUrl(g.header_image)}" loading="lazy" alt="">
                        </div>
                        <div class="embed-content">
                            <div class="embed-title">${Utils.escapeHtml(g.name)}</div>
                            <div class="embed-description">${Utils.escapeHtml(g.short_description)}</div>
                            <div class="embed-stats">
                                <span class="embed-price">${Utils.escapeHtml(g.is_free ? 'F2P' : (g.price_overview?.final_formatted || ''))}</span>
                            </div>
                        </div>
                    </div>`, 'steam', url);
            } catch (err) { Logger.error('Steam embed failed:', err); return null; }
        }

        // ── GamesPlanet ──────────────────────────
        static async createGamesPlanetEmbed(url) {
            try {
                const html = await gmFetchCached(url.href);
                const doc  = new DOMParser().parseFromString(html, 'text/html');
                const meta = this._parseMeta(doc, url);

                let priceHtml = '';
                if (url.pathname.includes('/game/')) {
                    const priceEl = doc.querySelector('.prices');
                    if (priceEl) {
                        const txt = priceEl.textContent.trim();
                        const m   = txt.match(/([\d,.]+€)\s*-\s*(\d+%)\s*([\d,.]+€)/);
                        if (m) {
                            priceHtml = `<span class="price-old">${Utils.escapeHtml(m[1])}</span>
                                         <span class="embed-price">${Utils.escapeHtml(m[3])}</span>
                                         <span class="price-discount">${Utils.escapeHtml(m[2])}</span>`;
                        } else {
                            priceHtml = `<span class="embed-price">${Utils.escapeHtml(txt)}</span>`;
                        }
                    }
                }

                const ref      = url.searchParams.get('ref');
                const platform = ref ? `GamesPlanet × ${ref.charAt(0).toUpperCase() + ref.slice(1)}` : 'GamesPlanet';
                const favicon  = Utils.sanitizeUrl(`${url.protocol}//${url.hostname}/favicon.ico`);

                return this._build(`
                    <div class="embed-header">
                        <div class="embed-platform-logo"><img src="${favicon}" width="16" height="16" alt=""></div>
                        <div class="embed-platform-name">${Utils.escapeHtml(platform)}</div>
                    </div>
                    <div class="embed-body">
                        ${meta.image ? `<div class="embed-thumbnail squared"><img src="${meta.image}" loading="lazy" alt="" onerror="this.style.display='none'"></div>` : ''}
                        <div class="embed-content ${!meta.image ? 'full-width' : ''}">
                            <div class="embed-title">${Utils.escapeHtml(meta.title)}</div>
                            <div class="embed-description">${Utils.escapeHtml(meta.description)}</div>
                            ${priceHtml ? `<div class="embed-stats">${priceHtml}</div>` : ''}
                        </div>
                    </div>`, 'gamesplanet', url);
            } catch (err) {
                Logger.error('GamesPlanet embed failed:', err);
                return this.createDefaultEmbed(url);
            }
        }

        // ── Meta (OG) ────────────────────────────
        static async createMetaEmbed(url) {
            try {
                const html  = await gmFetchCached(url.href);
                const doc   = new DOMParser().parseFromString(html, 'text/html');
                const meta  = this._parseMeta(doc, url);
                const favicon = Utils.sanitizeUrl(`${url.protocol}//${url.hostname}/favicon.ico`);

                return this._build(`
                    <div class="embed-header">
                        <div class="embed-platform-logo"><img src="${favicon}" width="16" height="16" alt=""></div>
                        <div class="embed-platform-name">${Utils.escapeHtml(meta.siteName)}</div>
                    </div>
                    <div class="embed-body">
                        ${meta.image ? `<div class="embed-thumbnail squared"><img src="${meta.image}" loading="lazy" alt="" onerror="this.style.display='none'"></div>` : ''}
                        <div class="embed-content ${!meta.image ? 'full-width' : ''}">
                            <div class="embed-title">${Utils.escapeHtml(meta.title)}</div>
                            <div class="embed-description">${Utils.escapeHtml(meta.description)}</div>
                        </div>
                    </div>`, 'meta', url);
            } catch (err) {
                Logger.error('Meta embed failed:', err);
                return this.createDefaultEmbed(url);
            }
        }

        // ── Image ────────────────────────────────
        static createImageEmbed(url) {
            const safeUrl  = Utils.sanitizeUrl(url.href);
            const filename = url.pathname.split('/').pop();
            const embed    = document.createElement('div');
            embed.className = 'image-embed coven-embed';
            embed.innerHTML = `
                <div class="embed-header">
                    <div class="embed-platform-logo">${PlatformLogos.image}</div>
                    <div class="embed-platform-name">Image</div>
                </div>
                <div class="embed-body embed-body--col">
                    <div class="embed-image-container">
                        <img src="${safeUrl}" loading="lazy"
                             style="max-width:${USER_CONFIG.maxImageWidth}px;max-height:${USER_CONFIG.maxImageHeight}px;"
                             onerror="this.style.display='none';this.nextElementSibling.style.display='block';"
                             onclick="event.stopPropagation();" alt="">
                        <div class="image-error" style="display:none;">❌ Image indisponible</div>
                    </div>
                    <div class="embed-content">
                        <div class="embed-filename">${Utils.escapeHtml(filename)}</div>
                    </div>
                </div>`;
            embed.dataset.originalUrl = safeUrl;
            embed.dataset.embedType   = 'image';
            embed.onclick = e => { if (!e.target.matches('img')) window.open(safeUrl, '_blank'); };
            this._applyStyle(embed);
            return embed;
        }

        // ── Default ──────────────────────────────
        static createDefaultEmbed(url) {
            const safeUrl = Utils.sanitizeUrl(url.href);
            const favicon = Utils.sanitizeUrl(`${url.protocol}//${url.hostname}/favicon.ico`);
            return this._build(`
                <div class="embed-header">
                    <div class="embed-platform-logo"><img src="${favicon}" width="16" height="16" alt=""></div>
                    <div class="embed-platform-name">${Utils.escapeHtml(url.hostname.replace('www.', ''))}</div>
                </div>
                <div class="embed-body">
                    <div class="embed-content full-width">
                        <div class="embed-url">${Utils.escapeHtml(safeUrl)}</div>
                    </div>
                </div>`, 'default', url);
        }

        // ── Helpers ──────────────────────────────
        static _parseMeta(doc, url) {
            const q = (s) => doc.querySelector(s)?.content || null;
            return {
                title:       q('meta[property="og:title"]') || q('meta[name="twitter:title"]') || doc.title || 'Sans titre',
                description: q('meta[property="og:description"]') || q('meta[name="twitter:description"]') || q('meta[name="description"]') || '',
                image:       q('meta[property="og:image"]') || q('meta[name="twitter:image"]') || null,
                siteName:    q('meta[property="og:site_name"]') || url.hostname.replace('www.', ''),
            };
        }

        static _build(html, type, url) {
            const safeUrl = Utils.sanitizeUrl(url.href);
            const el      = document.createElement('div');
            el.className  = `${type}-embed coven-embed`;
            el.innerHTML  = html;
            el.onclick    = () => window.open(safeUrl, '_blank');
            el.dataset.originalUrl = safeUrl;
            el.dataset.embedType   = type;
            this._applyStyle(el);
            return el;
        }

        static _applyStyle(embed) {
            const style = EmbedStyles[USER_CONFIG.embedStyle] || EmbedStyles['dark-glass'];
            embed.style.cssText += `
                background:${style.background};
                border:${style.border};
                color:${style.textColor};
                backdrop-filter:${style.backdropFilter};
                -webkit-backdrop-filter:${style.backdropFilter};
            `;
            // Compact mode
            if (USER_CONFIG.compactMode) embed.classList.add('coven-compact');

            // Hover handlers — cleanup anciens avant d'en ajouter de nouveaux
            if (embed._ptlHover) {
                embed.removeEventListener('mouseenter', embed._ptlHover.in);
                embed.removeEventListener('mouseleave', embed._ptlHover.out);
            }
            const hIn  = () => { embed.style.background = style.hoverBackground; embed.style.borderColor = style.hoverBorder.replace('1px solid ',''); };
            const hOut = () => { embed.style.background = style.background; embed.style.border = style.border; };
            embed.addEventListener('mouseenter', hIn);
            embed.addEventListener('mouseleave', hOut);
            embed._ptlHover = { in: hIn, out: hOut };

            // Couleur texte secondaire
            embed.querySelectorAll('.embed-platform-name,.embed-channel,.embed-description,.embed-stat,.embed-url,.embed-filename')
                .forEach(el => el.style.color = style.secondaryText);
        }
    }

    // ─────────────────────────────────────────────
    //  PRELOADER
    // ─────────────────────────────────────────────
    function createPreloader(url) {
        const safeUrl = Utils.sanitizeUrl(url.href);
        const style   = EmbedStyles[USER_CONFIG.embedStyle] || EmbedStyles['dark-glass'];
        const el      = document.createElement('div');
        el.className  = 'link-preloader coven-embed';
        if (USER_CONFIG.compactMode) el.classList.add('coven-compact');
        el.innerHTML  = `
            <div class="embed-header">
                <div class="embed-platform-logo">${PlatformLogos.default}</div>
                <div class="embed-platform-name">Chargement…</div>
            </div>
            <div class="embed-body">
                <div class="preloader-content">
                    <div class="preloader-spinner"></div>
                    <div class="preloader-url">${Utils.escapeHtml(safeUrl)}</div>
                </div>
            </div>`;
        el.onclick = () => window.open(safeUrl, '_blank');
        el.dataset.originalUrl = safeUrl;
        el.style.background    = style.background;
        el.style.border        = style.border;
        el.style.color         = style.textColor;
        el.style.backdropFilter = style.backdropFilter;
        return el;
    }

    // ─────────────────────────────────────────────
    //  CHAT MANAGER
    // ─────────────────────────────────────────────
    class ChatManager {
        constructor() {
            this.observer          = null;
            this.backupInterval    = null;
            this.currentContainer  = null;
            this.processedMessages = new WeakSet();
            this.retryCount        = 0;
            this.maxRetries        = 10;
        }

        init() {
            Logger.info('Initializing chat manager…');
            this.findAndObserveChat();
            this.backupInterval = setInterval(() => {
                if (!this.currentContainer || !document.contains(this.currentContainer)) {
                    Logger.debug('Chat container lost, reinitializing…');
                    this.findAndObserveChat();
                }
            }, 2000);
        }

        findAndObserveChat() {
            const container = this._findContainer();
            if (container && container !== this.currentContainer) {
                Logger.info('Chat container found:', container);
                this.observer?.disconnect();
                this._setupObserver(container);
                this.currentContainer = container;
                this.retryCount = 0;
                this._showLoadBanner(container);
                return true;
            } else if (this.retryCount < this.maxRetries) {
                this.retryCount++;
                Logger.debug(`Retry ${this.retryCount}/${this.maxRetries}…`);
                setTimeout(() => this.findAndObserveChat(), 1000);
            } else {
                Logger.warn('Max retries reached — chat not found');
            }
            return false;
        }

        _findContainer() {
            const all = [
                ...SELECTORS.chat,
                '[class*="chat-scrollable-area"]',
                '[class*="message-container"]',
                '[class*="chat-list"]',
                'section[aria-label*="chat"]',
            ];
            for (const sel of all) {
                const el = document.querySelector(sel);
                if (el) return el;
            }
            return null;
        }

        _setupObserver(container) {
            this.observer = new MutationObserver(mutations => {
                const toProcess = [];
                for (const mut of mutations) {
                    // Détection suppression du container
                    if ([...mut.removedNodes].includes(container)) {
                        Logger.debug('Container removed, reinitializing…');
                        this.findAndObserveChat();
                        return;
                    }
                    // ⚡ Ne traiter que les nodes ajoutés au premier niveau du container
                    if (mut.target !== container && mut.target.parentNode !== container) continue;

                    for (const node of mut.addedNodes) {
                        if (node.nodeType === 1 && this._isMessage(node) && !this.processedMessages.has(node)) {
                            this.processedMessages.add(node);
                            toProcess.push(node);
                        }
                    }
                }
                if (toProcess.length) this._processBatch(toProcess);
            });

            this.observer.observe(container, { childList: true, subtree: true });
            container.dataset.ptlObserved = 'true';

            setTimeout(() => this._processExisting(container), 1000);
        }

        _isMessage(node) {
            if (node.matches?.(SELECTORS.message)) return true;
            if (node.querySelector?.(SELECTORS.message)) return true;
            return node.classList?.contains('chat-line__message') ||
                node.getAttribute?.('data-a-target') === 'chat-line-message';
        }

        async _processBatch(nodes) {
            const links = [];
            nodes.forEach(node => {
                const msg = node.matches(SELECTORS.message) ? node : node.querySelector(SELECTORS.message);
                if (msg) links.push(...msg.querySelectorAll(SELECTORS.link));
            });
            if (links.length) await this._processLinks(links);
        }

        async _processLinks(links) {
            for (const link of links) {
                if (!document.contains(link) || link.dataset.ptlEmbed) continue;
                link.dataset.ptlEmbed = 'processing';

                // ⚡ FIX : preloader déclaré avant le try pour éviter ReferenceError dans catch
                let preloader = null;
                try {
                    const url = new URL(link.href);
                    // Valider le protocole avant tout
                    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;

                    preloader = createPreloader(url);
                    link.parentNode.replaceChild(preloader, link);

                    const embed = await EmbedFactory.createEmbed(url);

                    if (document.contains(preloader)) {
                        if (embed) {
                            preloader.replaceWith(embed);
                        } else {
                            preloader.replaceWith(this._fallbackLink(link.href));
                        }
                    }
                } catch (err) {
                    Logger.error('Link processing error:', err);
                    if (preloader && document.body.contains(preloader)) {
                        preloader.replaceWith(this._fallbackLink(link.href));
                    }
                }
                await new Promise(r => setTimeout(r, CONFIG.BATCH_PROCESSING_DELAY));
            }
        }

        _fallbackLink(href) {
            const a = document.createElement('a');
            a.href        = Utils.sanitizeUrl(href);
            a.textContent = href;
            a.target      = '_blank';
            a.rel         = 'noopener noreferrer';
            a.style.color = '#bf94ff';
            return a;
        }

        _processExisting(container) {
            const links = [];
            container.querySelectorAll(SELECTORS.message).forEach(msg => {
                if (!this.processedMessages.has(msg)) {
                    this.processedMessages.add(msg);
                    links.push(...msg.querySelectorAll(SELECTORS.link));
                }
            });
            if (links.length) this._processLinks(links);
        }

        async regenerateAllEmbeds() {
            if (!this.currentContainer) return;
            const embeds = [...this.currentContainer.querySelectorAll('.coven-embed')];
            Logger.info(`Regenerating ${embeds.length} embeds…`);

            for (const embed of embeds) {
                const rawUrl  = embed.dataset.originalUrl;
                const type    = embed.dataset.embedType;
                if (!rawUrl) continue;

                try {
                    const url = new URL(rawUrl);
                    let preloader = null;
                    if (this._shouldRegen(type, url)) {
                        preloader = createPreloader(url);
                        embed.replaceWith(preloader);
                        const fresh = await EmbedFactory.createEmbed(url);
                        if (document.contains(preloader)) {
                            preloader.replaceWith(fresh || this._fallbackLink(rawUrl));
                        }
                    } else {
                        embed.replaceWith(this._fallbackLink(rawUrl));
                    }
                } catch (err) { Logger.error('Regen error:', err); }
                await new Promise(r => setTimeout(r, CONFIG.BATCH_PROCESSING_DELAY));
            }
            Logger.info('Regen complete');
        }

        refreshStyles() {
            document.querySelectorAll('.coven-embed').forEach(embed => {
                EmbedFactory._applyStyle(embed);
                if (embed.classList.contains('image-embed')) {
                    const img = embed.querySelector('img');
                    if (img) {
                        img.style.maxWidth  = `${USER_CONFIG.maxImageWidth}px`;
                        img.style.maxHeight = `${USER_CONFIG.maxImageHeight}px`;
                    }
                }
                // Compact mode toggle
                embed.classList.toggle('coven-compact', USER_CONFIG.compactMode);
            });
        }

        _shouldRegen(type, url) {
            const h = url.hostname.replace('www.', '').toLowerCase();
            const m = {
                youtube: USER_CONFIG.enableYouTube,
                discord: USER_CONFIG.enableDiscord,
                twitch:  USER_CONFIG.enableTwitch,
                steam:   USER_CONFIG.enableSteam,
                gamesplanet: USER_CONFIG.enableGamesPlanet,
                meta:    USER_CONFIG.enableMeta,
                image:   USER_CONFIG.enableImageEmbeds,
                default: USER_CONFIG.enableAllLinks,
            };
            if (type in m) return m[type];
            const hostMap = { 'ko-fi.com': USER_CONFIG.enableKoFi, 'eneba.com': USER_CONFIG.enableEneba };
            return hostMap[h] !== false;
        }

        _showLoadBanner(container) {
            const banner = document.createElement('div');
            banner.className = 'chat-line__message';
            banner.innerHTML = `<div class="ptl-banner">
                <span class="ptl-banner-name">${SCRIPT_NAME}</span>
                <span class="ptl-banner-version">v${SCRIPT_VERSION}</span>
                <span class="ptl-banner-status">✓ Actif</span>
            </div>`;
            container.firstChild
                ? container.insertBefore(banner, container.firstChild)
            : container.appendChild(banner);
            setTimeout(() => {
                banner.style.opacity    = '0';
                banner.style.transition = 'opacity 1s';
                setTimeout(() => banner.remove(), 1000);
            }, 4000);
        }

        destroy() {
            this.observer?.disconnect();
            clearInterval(this.backupInterval);
            this.observer         = null;
            this.backupInterval   = null;
            this.currentContainer = null;
            this.processedMessages = new WeakSet();
        }
    }

    // ─────────────────────────────────────────────
    //  OPTIONS MANAGER
    // ─────────────────────────────────────────────
    class OptionsManager {
        constructor() {
            this.modal          = null;
            this.isOpen         = false;
            this.buttonObserver = null;
            this._injectDebounced = Utils.debounce(() => this._addButton(), CONFIG.BUTTON_INJECT_DEBOUNCE);
        }

        init() {
            this._buildModal();
            this._watchForChatButtons();
            try { GM_registerMenuCommand('Twitch Embed Options', () => this.open()); } catch (_) {}
        }

        // ── Button injection ─────────────────────
        _watchForChatButtons() {
            this.buttonObserver = new MutationObserver(() => this._injectDebounced());
            this.buttonObserver.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => this._addButton(), 2000);
        }

        _addButton() {
            if (document.querySelector('[data-twitch-embed-options]')) return;

            // Cibler le container des icônes navbar (Prime, Notifs, Whispers...)
            const navContainer = document.querySelector('.Layout-sc-1xcs6mc-0.bZYcrx');
            if (!navContainer) return;

            const btn = Utils.createElement(`
        <div class="Layout-sc-1xcs6mc-0 VxLcr">
            <div class="Layout-sc-1xcs6mc-0 bkOPih">
                <div class="InjectLayout-sc-1i43xsx-0 iDMNUO">
                    <button class="ScCoreButton-sc-ocjdkq-0 glPhvE ScButtonIcon-sc-9yap0r-0 dgVYJo"
                            data-twitch-embed-options aria-label="Embed Options" title="Twitch Chat Link Embedder Pro">
                        <div class="ButtonIconFigure-sc-1emm8lf-0 lnTwMD">
                            <div class="ScSvgWrapper-sc-wkgzod-0 kccyMt tw-svg">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                                    <path fill-rule="evenodd" d="M4 5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H4Zm0 2h16v10H4V7Zm2 2v2h2V9H6Zm4 0v2h2V9h-2Zm4 0v2h4V9h-4Zm-8 4v2h4v-2H6Zm6 0v2h6v-2h-6Z" clip-rule="evenodd"/>
                                </svg>
                            </div>
                        </div>
                    </button>
                </div>
            </div>
        </div>`);

            // Insérer en premier dans le container navbar
            navContainer.insertBefore(btn, navContainer.firstChild);

            btn.querySelector('button').addEventListener('click', e => {
                e.preventDefault(); e.stopPropagation(); this.open();
            });
            Logger.info('Options button injected in navbar');
        }

        // ── Modal ────────────────────────────────
        _buildModal() {
            if (this.modal) return;
            this.modal = Utils.createElement(`
                <div class="ptl-overlay" role="dialog" aria-modal="true" aria-label="Options">
                    <div class="ptl-modal">
                        <div class="ptl-modal-header">
                            <div class="ptl-modal-title">
                                <span class="ptl-modal-name">${SCRIPT_NAME}</span>
                                <span class="ptl-modal-ver">v${SCRIPT_VERSION}</span>
                            </div>
                            <button class="ptl-close-btn" aria-label="Fermer">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
                            </button>
                        </div>
                        <div class="ptl-modal-body">

                            <section class="ptl-section">
                                <h3 class="ptl-section-title">Apparence</h3>
                                <div class="ptl-style-grid" id="ptl-style-grid"></div>
                            </section>

                            <section class="ptl-section">
                                <h3 class="ptl-section-title">Mode</h3>
                                <div class="ptl-toggles" id="ptl-mode-toggles"></div>
                            </section>

                            <section class="ptl-section">
                                <h3 class="ptl-section-title">Plateformes</h3>
                                <div class="ptl-toggles" id="ptl-platform-toggles"></div>
                            </section>

                            <section class="ptl-section">
                                <h3 class="ptl-section-title">Sites Web</h3>
                                <div class="ptl-toggles" id="ptl-website-toggles"></div>
                            </section>

                            <section class="ptl-section">
                                <h3 class="ptl-section-title">Images directes</h3>
                                <div class="ptl-toggles" id="ptl-image-toggles"></div>
                                <div class="ptl-size-grid" id="ptl-size-grid"></div>
                            </section>

                            <section class="ptl-section">
                                <h3 class="ptl-section-title">Général</h3>
                                <div class="ptl-toggles" id="ptl-general-toggles"></div>
                            </section>
                        </div>

                        <div class="ptl-modal-footer">
                            <button class="ptl-btn ptl-btn-secondary ptl-cancel-btn">Annuler</button>
                            <button class="ptl-btn ptl-btn-primary ptl-save-btn">Sauvegarder</button>
                        </div>
                    </div>
                </div>`);

            document.body.appendChild(this.modal);

            // Events
            this.modal.querySelector('.ptl-close-btn').addEventListener('click',  () => this.close());
            this.modal.querySelector('.ptl-cancel-btn').addEventListener('click', () => this.close());
            this.modal.querySelector('.ptl-save-btn').addEventListener('click',   () => this._save());
            this.modal.addEventListener('click', e => { if (e.target === this.modal) this.close(); });
            document.addEventListener('keydown', e => { if (e.key === 'Escape' && this.isOpen) this.close(); });

            this._fillModal();
        }

        _fillModal() {
            // Style cards
            const styleGrid = this.modal.querySelector('#ptl-style-grid');
            [
                { value: 'dark-glass',  label: 'Dark Glass',  desc: 'Verre sombre' },
                { value: 'light-glass', label: 'Light Glass', desc: 'Verre clair'  },
            ].forEach(({ value, label, desc }) => {
                const card = Utils.createElement(`
                    <label class="ptl-style-card ${USER_CONFIG.embedStyle === value ? 'active' : ''}" data-style="${value}">
                        <input type="radio" name="embedStyle" value="${value}"
                               ${USER_CONFIG.embedStyle === value ? 'checked' : ''}>
                        <div class="ptl-style-preview ptl-style-preview--${value}"></div>
                        <span class="ptl-style-label">${label}</span>
                        <span class="ptl-style-desc">${desc}</span>
                    </label>`);
                card.addEventListener('click', () => {
                    styleGrid.querySelectorAll('.ptl-style-card').forEach(c => c.classList.remove('active'));
                    card.classList.add('active');
                    card.querySelector('input').checked = true;
                });
                styleGrid.appendChild(card);
            });

            // Mode toggles
            this._buildToggles('#ptl-mode-toggles', [
                { key: 'compactMode', label: 'Mode compact', desc: 'Embeds plus petits, moins de padding' },
            ]);

            // Platform toggles
            this._buildToggles('#ptl-platform-toggles', [
                { key: 'enableYouTube', label: 'YouTube',  desc: 'Vidéos, chaînes, playlists, Shorts' },
                { key: 'enableDiscord', label: 'Discord',  desc: 'Liens d\'invitation' },
                { key: 'enableTwitch',  label: 'Twitch',   desc: 'Clips, VODs, chaînes, drops' },
                { key: 'enableSteam',   label: 'Steam',    desc: 'Pages de jeux' },
            ]);

            // Website toggles
            this._buildToggles('#ptl-website-toggles', [
                { key: 'enableGamesPlanet', label: 'GamesPlanet', desc: 'Embed avec prix et réduction' },
                { key: 'enableKoFi',        label: 'Ko-fi',       desc: 'Page de soutien' },
                { key: 'enableEneba',       label: 'Eneba',       desc: 'Marketplace de jeux' },
                { key: 'enableMeta',        label: 'Autres sites', desc: 'Aperçu Open Graph générique' },
                { key: 'enableAllLinks',    label: 'Tous les liens', desc: 'Embed minimaliste pour tout lien' },
            ]);

            // Image toggles
            this._buildToggles('#ptl-image-toggles', [
                { key: 'enableImageEmbeds', label: 'Images directes', desc: '.jpg .png .gif .webp affichés inline' },
            ]);

            // Size inputs
            const sizeGrid = this.modal.querySelector('#ptl-size-grid');
            sizeGrid.innerHTML = `
                <div class="ptl-size-row">
                    <label class="ptl-size-label">Largeur max (px)</label>
                    <input class="ptl-size-input" type="number" name="maxImageWidth"
                           value="${USER_CONFIG.maxImageWidth}" min="100" max="800" step="10">
                </div>
                <div class="ptl-size-row">
                    <label class="ptl-size-label">Hauteur max (px)</label>
                    <input class="ptl-size-input" type="number" name="maxImageHeight"
                           value="${USER_CONFIG.maxImageHeight}" min="100" max="600" step="10">
                </div>`;

            // General toggles
            this._buildToggles('#ptl-general-toggles', [
                { key: 'debugMode', label: 'Mode Debug', desc: 'Logs détaillés dans la console' },
            ]);
        }

        _buildToggles(selector, items) {
            const container = this.modal.querySelector(selector);
            items.forEach(({ key, label, desc }) => {
                const row = Utils.createElement(`
                    <label class="ptl-toggle-row">
                        <div class="ptl-toggle-info">
                            <span class="ptl-toggle-label">${label}</span>
                            <span class="ptl-toggle-desc">${desc}</span>
                        </div>
                        <div class="ptl-switch">
                            <input type="checkbox" name="${key}" ${USER_CONFIG[key] ? 'checked' : ''}>
                            <span class="ptl-switch-track">
                                <span class="ptl-switch-thumb"></span>
                            </span>
                        </div>
                    </label>`);
                container.appendChild(row);
            });
        }

        // Sync checkboxes avec USER_CONFIG à l'ouverture
        _syncToConfig() {
            this.modal.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                cb.checked = !!USER_CONFIG[cb.name];
            });
            this.modal.querySelectorAll('input[type="radio"]').forEach(r => {
                r.checked = USER_CONFIG.embedStyle === r.value;
            });
            this.modal.querySelectorAll('.ptl-style-card').forEach(c => {
                c.classList.toggle('active', USER_CONFIG.embedStyle === c.dataset.style);
            });
            const wInput = this.modal.querySelector('input[name="maxImageWidth"]');
            const hInput = this.modal.querySelector('input[name="maxImageHeight"]');
            if (wInput) wInput.value = USER_CONFIG.maxImageWidth;
            if (hInput) hInput.value = USER_CONFIG.maxImageHeight;
        }

        open() {
            if (!this.modal) this._buildModal();
            this._syncToConfig();
            this.modal.style.display = 'flex';
            this.isOpen = true;
        }

        close() {
            if (this.modal) { this.modal.style.display = 'none'; this.isOpen = false; }
        }

        _save() {
            // Style
            const styleChecked = this.modal.querySelector('input[name="embedStyle"]:checked');
            if (styleChecked) USER_CONFIG.embedStyle = styleChecked.value;

            // Tous les checkboxes
            this.modal.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                USER_CONFIG[cb.name] = cb.checked;
            });

            // Taille images
            const w = parseInt(this.modal.querySelector('input[name="maxImageWidth"]')?.value || 300, 10);
            const h = parseInt(this.modal.querySelector('input[name="maxImageHeight"]')?.value || 200, 10);
            USER_CONFIG.maxImageWidth  = Math.max(100, Math.min(800, w));
            USER_CONFIG.maxImageHeight = Math.max(100, Math.min(600, h));

            // Persist
            Object.keys(USER_CONFIG).forEach(k => Storage.set(k, USER_CONFIG[k]));
            Logger.setDebugMode(USER_CONFIG.debugMode);

            this.close();
            Logger.info('Options saved', USER_CONFIG);

            // Refresh / regen
            window.chatManager?.regenerateAllEmbeds();
            this._toast('✓ Options sauvegardées');
        }

        _toast(msg) {
            const t = document.createElement('div');
            t.className   = 'ptl-toast';
            t.textContent = msg;
            document.body.appendChild(t);
            requestAnimationFrame(() => t.classList.add('ptl-toast--visible'));
            setTimeout(() => {
                t.classList.remove('ptl-toast--visible');
                setTimeout(() => t.remove(), 400);
            }, 2800);
        }

        destroy() {
            this.buttonObserver?.disconnect();
            this.modal?.remove();
        }
    }

    // ─────────────────────────────────────────────
    //  STYLES
    // ─────────────────────────────────────────────
    function injectStyles() {
        const style = document.createElement('style');
        style.id    = 'ptl-styles';
        style.textContent = `
/* ── EMBED BASE ───────────────────────────────── */
.coven-embed {
    contain: layout style paint;
    will-change: transform;
    margin: 5px 0;
    border-radius: 10px;
    cursor: pointer;
    transition: transform 0.22s cubic-bezier(.4,0,.2,1), box-shadow 0.22s ease, border-color 0.22s ease, background 0.22s ease;
    width: 100% !important;
    max-width: 100% !important;
    box-sizing: border-box !important;
    display: flex !important;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 2px 10px rgba(0,0,0,0.18);
}
.coven-embed:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 20px rgba(0,0,0,0.28);
}

/* ── HEADER ───────────────────────────────────── */
.embed-header {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 9px 13px 7px;
    border-bottom: 1px solid rgba(128,128,128,0.15);
}
.embed-platform-logo {
    width: 18px;
    height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    opacity: 0.85;
}
.embed-platform-logo img { width:16px; height:16px; border-radius:3px; }
.embed-platform-name {
    font-size: 0.72em;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    opacity: 0.75;
}
.embed-live-badge {
    margin-left: auto;
    background: #e91916;
    color: #fff;
    padding: 2px 7px;
    border-radius: 10px;
    font-size: 0.65em;
    font-weight: 800;
    letter-spacing: 0.5px;
    animation: ptl-pulse 2s infinite;
}
@keyframes ptl-pulse { 0%,100%{opacity:1} 50%{opacity:.65} }

/* ── BODY ─────────────────────────────────────── */
.embed-body {
    display: flex;
    gap: 11px;
    padding: 10px 13px;
    align-items: flex-start;
}
.embed-body--col { flex-direction: column; }

/* ── THUMBNAIL ────────────────────────────────── */
.embed-thumbnail {
    width: 110px;
    flex-shrink: 0;
    position: relative;
    border-radius: 7px;
    overflow: hidden;
}
.embed-thumbnail.squared { width:72px; height:72px; }
.embed-thumbnail img {
    width: 100%;
    height: auto;
    display: block;
    border-radius: 7px;
    transition: transform 0.28s ease;
}
.coven-embed:hover .embed-thumbnail img { transform: scale(1.04); }
.embed-play-button {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0,0,0,0.35);
    opacity: 0;
    transition: opacity 0.2s;
}
.coven-embed:hover .embed-play-button { opacity: 1; }

/* ── CONTENT ──────────────────────────────────── */
.embed-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
}
.embed-content.full-width { width: 100%; }
.embed-title {
    font-weight: 700;
    font-size: 0.88em;
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}
.embed-channel, .embed-description {
    font-size: 0.8em;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}
.embed-stats { display: flex; gap: 10px; flex-wrap: wrap; }
.embed-stat  { font-size: 0.76em; font-weight: 500; opacity: 0.75; }
.embed-price { font-size: 0.86em; font-weight: 800; color: #00c896 !important; }
.price-old   { font-size: 0.8em; text-decoration: line-through; opacity: 0.5; }
.price-discount { font-size: 0.8em; font-weight: 800; color: #ff6b6b !important; }
.embed-url, .embed-filename {
    font-size: 0.75em;
    font-family: 'Monaco','Menlo','Ubuntu Mono',monospace;
    word-break: break-all;
    opacity: 0.6;
}

/* ── IMAGE ────────────────────────────────────── */
.embed-image-container {
    width: 100%;
    display: flex;
    justify-content: center;
    border-radius: 7px;
    overflow: hidden;
}
.embed-image-container img {
    border-radius: 7px;
    cursor: zoom-in;
    transition: transform 0.25s ease;
}
.embed-image-container img:hover { transform: scale(1.015); }
.image-error { font-size: 0.8em; opacity: 0.6; padding: 12px; text-align: center; }

/* ── COMPACT MODE ─────────────────────────────── */
.coven-compact .embed-header         { padding: 5px 10px; }
.coven-compact .embed-body           { padding: 6px 10px; gap: 8px; }
.coven-compact .embed-thumbnail      { width: 70px; }
.coven-compact .embed-thumbnail.squared { width: 48px; height: 48px; }
.coven-compact .embed-title          { font-size: 0.82em; -webkit-line-clamp: 1; }
.coven-compact .embed-description    { -webkit-line-clamp: 1; }
.coven-compact .embed-platform-name  { font-size: 0.67em; }

/* ── PRELOADER ────────────────────────────────── */
.link-preloader { border-radius: 10px; cursor: pointer; width: 100% !important; box-sizing: border-box !important; }
.preloader-content { display: flex; align-items: center; gap: 10px; padding: 10px 13px; }
.preloader-spinner {
    width: 16px; height: 16px;
    border: 2px solid rgba(255,255,255,0.2);
    border-top-color: #9147ff;
    border-radius: 50%;
    animation: ptl-spin 0.8s linear infinite;
    flex-shrink: 0;
}
@keyframes ptl-spin { to { transform: rotate(360deg); } }
.preloader-url { font-size: 0.78em; opacity: 0.6; word-break: break-all; }

/* ── CHAT FORCE WIDTH ─────────────────────────── */
.chat-line__message .coven-embed,
[data-a-target="chat-line-message"] .coven-embed {
    width: 100% !important; max-width: 100% !important;
}

/* ── LOAD BANNER ──────────────────────────────── */
.ptl-banner {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px;
    font-size: 0.78em;
    color: #9147ff;
    font-style: italic;
}
.ptl-banner-name   { font-weight: 700; }
.ptl-banner-version { opacity: 0.6; }
.ptl-banner-status  { color: #00c896; font-weight: 700; margin-left: auto; }

/* ════════════════════════════════════════════════
   MODAL
   ════════════════════════════════════════════════ */
.ptl-overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.75);
    display: none;
    justify-content: center;
    align-items: center;
    z-index: 10000;
    backdrop-filter: blur(6px);
    padding: 16px;
}

.ptl-modal {
    background: #141417;
    border: 1px solid rgba(255,255,255,0.09);
    border-radius: 14px;
    width: 100%;
    max-width: 480px;
    max-height: 88vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 24px 60px rgba(0,0,0,0.6);
}

.ptl-modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 20px 14px;
    border-bottom: 1px solid rgba(255,255,255,0.07);
    flex-shrink: 0;
}
.ptl-modal-title { display: flex; align-items: baseline; gap: 8px; }
.ptl-modal-name  { color: #efeff1; font-size: 15px; font-weight: 700; }
.ptl-modal-ver   { color: #9147ff; font-size: 11px; font-weight: 600;
                   background: rgba(145,71,255,0.15); padding: 1px 7px; border-radius: 20px; }

.ptl-close-btn {
    background: none; border: none; color: rgba(255,255,255,0.5); cursor: pointer;
    padding: 5px; border-radius: 6px; display: flex; align-items: center; justify-content: center;
    transition: background 0.15s, color 0.15s;
}
.ptl-close-btn:hover { background: rgba(255,255,255,0.08); color: #fff; }

.ptl-modal-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 22px;
    scrollbar-width: thin;
    scrollbar-color: rgba(145,71,255,0.4) transparent;
}

/* ── Section ────────────────────────────────── */
.ptl-section {}
.ptl-section-title {
    font-size: 10px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: #9147ff;
    margin: 0 0 10px;
}

/* ── Style cards ────────────────────────────── */
.ptl-style-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
}
.ptl-style-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 7px;
    padding: 14px 10px 12px;
    border-radius: 10px;
    border: 1.5px solid rgba(255,255,255,0.08);
    background: rgba(255,255,255,0.03);
    cursor: pointer;
    transition: border-color 0.2s, background 0.2s;
    position: relative;
}
.ptl-style-card input { display: none; }
.ptl-style-card:hover { border-color: rgba(145,71,255,0.4); background: rgba(145,71,255,0.06); }
.ptl-style-card.active { border-color: #9147ff; background: rgba(145,71,255,0.12); }
.ptl-style-card.active::after {
    content: '✓';
    position: absolute; top: 8px; right: 10px;
    color: #9147ff; font-size: 12px; font-weight: 800;
}
.ptl-style-preview {
    width: 64px; height: 38px; border-radius: 7px;
}
.ptl-style-preview--dark-glass {
    background: linear-gradient(135deg, rgba(255,255,255,0.09), rgba(255,255,255,0.03));
    border: 1px solid rgba(255,255,255,0.14);
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.04);
}
.ptl-style-preview--light-glass {
    background: linear-gradient(135deg, rgba(255,255,255,0.88), rgba(220,220,240,0.7));
    border: 1px solid rgba(0,0,0,0.09);
}
.ptl-style-label { font-size: 12px; font-weight: 700; color: #efeff1; }
.ptl-style-desc  { font-size: 10px; color: rgba(255,255,255,0.4); }

/* ── Toggle rows ────────────────────────────── */
.ptl-toggles { display: flex; flex-direction: column; gap: 6px; }

.ptl-toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 9px 12px;
    border-radius: 8px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.05);
    cursor: pointer;
    transition: background 0.15s;
    gap: 12px;
}
.ptl-toggle-row:hover { background: rgba(255,255,255,0.07); }

.ptl-toggle-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ptl-toggle-label { font-size: 12.5px; font-weight: 600; color: #efeff1; }
.ptl-toggle-desc  { font-size: 10.5px; color: rgba(255,255,255,0.4); }

/* Switch */
.ptl-switch { flex-shrink: 0; position: relative; }
.ptl-switch input { opacity: 0; width: 0; height: 0; position: absolute; }
.ptl-switch-track {
    display: flex;
    align-items: center;
    width: 36px; height: 20px;
    border-radius: 20px;
    background: rgba(255,255,255,0.12);
    transition: background 0.2s;
    padding: 3px;
    cursor: pointer;
}
.ptl-switch input:checked ~ .ptl-switch-track { background: #9147ff; }
.ptl-switch-thumb {
    width: 14px; height: 14px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.2s cubic-bezier(.4,0,.2,1);
    box-shadow: 0 1px 3px rgba(0,0,0,0.3);
}
.ptl-switch input:checked ~ .ptl-switch-track .ptl-switch-thumb { transform: translateX(16px); }

/* ── Size inputs ────────────────────────────── */
.ptl-size-grid { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.ptl-size-row  { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ptl-size-label { font-size: 11.5px; color: rgba(255,255,255,0.55); }
.ptl-size-input {
    width: 80px; padding: 5px 8px;
    border-radius: 6px;
    border: 1px solid rgba(255,255,255,0.1);
    background: rgba(255,255,255,0.06);
    color: #efeff1;
    font-size: 12px;
    text-align: right;
}
.ptl-size-input:focus { outline: none; border-color: #9147ff; }

/* ── Footer ─────────────────────────────────── */
.ptl-modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 14px 20px;
    border-top: 1px solid rgba(255,255,255,0.07);
    flex-shrink: 0;
}
.ptl-btn {
    padding: 8px 18px;
    border-radius: 7px;
    border: none;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    transition: opacity 0.15s, transform 0.15s;
}
.ptl-btn:hover { opacity: 0.88; transform: translateY(-1px); }
.ptl-btn-primary   { background: #9147ff; color: #fff; }
.ptl-btn-secondary { background: rgba(255,255,255,0.08); color: #efeff1; }

/* ── Toast ───────────────────────────────────── */
.ptl-toast {
    position: fixed;
    bottom: 24px; right: 24px;
    background: #00c896;
    color: #fff;
    padding: 10px 18px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 700;
    z-index: 10001;
    box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    opacity: 0;
    transform: translateY(8px);
    transition: opacity 0.25s, transform 0.25s;
}
.ptl-toast--visible { opacity: 1; transform: translateY(0); }
`;
        document.head.appendChild(style);
        Logger.info('Styles injected');
    }

// ─────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────
let isInitialized = false;

function init() {
    if (isInitialized) return;
    Logger.info(`Initializing ${SCRIPT_NAME} v${SCRIPT_VERSION}…`);

    injectStyles();

    const optionsManager = new OptionsManager();
    optionsManager.init();

    window.chatManager = new ChatManager();
    window.chatManager.init();

    isInitialized = true;
    Logger.info('Ready ✓');
}

document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', init)
: setTimeout(init, 1000);

})();
