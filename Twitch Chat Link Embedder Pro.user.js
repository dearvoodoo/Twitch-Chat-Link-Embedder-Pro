// ==UserScript==
// @name         Twitch Chat Link Embedder Pro
// @namespace    http://tampermonkey.net/
// @version      2.5.1
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

(function() {
    'use strict';

    // Configuration avec valeurs par défaut
    const CONFIG = {
        EMBED_API_URL: 'https://api.the-coven.fr',
        MAX_RETRIES: 15,
        RETRY_DELAY: 1000,
        POLL_INTERVAL: 3000,
        MAX_API_RETRIES: 3,
        API_RETRY_DELAY: 500,
        DEBOUNCE_DELAY: 500,
        BATCH_PROCESSING_DELAY: 50,
        CACHE_DURATION: 120000,
        REQUEST_TIMEOUT: 10000
    };

    // Système de logging amélioré
    const Logger = {
        levels: { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 },
        level: 2, // INFO par défaut

        setDebugMode(debug) {
            this.level = debug ? this.levels.DEBUG : this.levels.INFO;
        },

        log(level, message, ...args) {
            if (level <= this.level) {
                const prefixes = ['❌ [TwitchEmbed]', '⚠️ [TwitchEmbed]', 'ℹ️ [TwitchEmbed]', '🐛 [TwitchEmbed]'];
                const styles = [
                    'color: #ff4444; font-weight: bold;',
                    'color: #ffaa00; font-weight: bold;',
                    'color: #44aaff; font-weight: bold;',
                    'color: #00aa44; font-weight: bold;'
                ];
                console.log(`%c${prefixes[level]} ${message}`, styles[level], ...args);
            }
        },

        error: function(msg, ...args) { this.log(0, msg, ...args); },
        warn: function(msg, ...args) { this.log(1, msg, ...args); },
        info: function(msg, ...args) { this.log(2, msg, ...args); },
        debug: function(msg, ...args) { this.log(3, msg, ...args); }
    };

    // Système de stockage
    const Storage = {
        get(key, defaultValue) {
            try {
                const value = GM_getValue(key, defaultValue);
                Logger.debug(`Storage get: ${key} =`, value);
                return value;
            } catch (error) {
                Logger.error('Storage get error:', error);
                return defaultValue;
            }
        },
        set(key, value) {
            try {
                Logger.debug(`Storage set: ${key} =`, value);
                GM_setValue(key, value);
            } catch (error) {
                Logger.error('Storage set error:', error);
            }
        }
    };

    // Configuration utilisateur avec valeurs par défaut
    const USER_CONFIG = {
        embedStyle: Storage.get('embedStyle', 'dark-glass'),
        enableYouTube: Storage.get('enableYouTube', true),
        enableDiscord: Storage.get('enableDiscord', true),
        enableTwitch: Storage.get('enableTwitch', true),
        enableSteam: Storage.get('enableSteam', true),
        enableMeta: Storage.get('enableMeta', true),
        enableImages: Storage.get('enableImages', true),
        enableAllLinks: Storage.get('enableAllLinks', true),
        debugMode: Storage.get('debugMode', true),
        // NOUVEAUX PARAMÈTRES IMAGES
        enableImageEmbeds: Storage.get('enableImageEmbeds', true),
        maxImageWidth: Storage.get('maxImageWidth', 300),
        maxImageHeight: Storage.get('maxImageHeight', 200),
        // NOUVELLES OPTIONS AJOUTÉES
        enableGamesPlanet: Storage.get('enableGamesPlanet', true),
        enableKoFi: Storage.get('enableKoFi', true),
        enableEneba: Storage.get('enableEneba', true)
    };

    // Mettre à jour le mode debug du logger
    Logger.setDebugMode(USER_CONFIG.debugMode);

    Logger.info('Script Twitch Chat Link Embedder Pro initializing...');

    // Cache pour les sélecteurs fréquents
    const SELECTORS = {
        chat: [
            '.chat-scrollable-area__message-container',
            '[data-test-selector="chat-scrollable-area__message-container"]',
            '[data-a-target="chat-scrollable-area"]',
            '.stream-chat',
            'twitch-chat',
            '.chat-list',
            '.chat-room'
        ],
        message: '.chat-line__message, [data-a-target="chat-line-message"]',
        link: 'a[href^="http"]:not([data-ptl-embed])',
        chatButtons: '.Layout-sc-1xcs6mc-0.cUmVME',
        chatSettings: '[data-a-target="chat-settings"]'
    };

    // Variables globales
    let chatObserver = null;
    let backupInterval = null;
    let currentChatContainer = null;
    let isInitialized = false;
    let optionsModal = null;

    // Utilitaires
    const Utils = {
        debounce(func, wait) {
            let timeout;
            return function executedFunction(...args) {
                const later = () => {
                    clearTimeout(timeout);
                    func(...args);
                };
                clearTimeout(timeout);
                timeout = setTimeout(later, wait);
            };
        },

        throttle(func, limit) {
            let inThrottle;
            return function(...args) {
                if (!inThrottle) {
                    func.apply(this, args);
                    inThrottle = true;
                    setTimeout(() => inThrottle = false, limit);
                }
            };
        },

        formatNumber(num) {
            if (!num) return '0';
            num = typeof num === 'string' ? parseInt(num) : num;
            return Intl.NumberFormat('fr-FR', {
                notation: 'compact',
                maximumFractionDigits: 1
            }).format(num);
        },

        isValidUrl(string) {
            try {
                const url = new URL(string);
                return url.protocol === 'http:' || url.protocol === 'https:';
            } catch (_) {
                return false;
            }
        },

        escapeHtml(unsafe) {
            if (unsafe === null || unsafe === undefined) {
                return '';
            }
            const safeString = String(unsafe);
            return safeString
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        },

        createElement(html) {
            const template = document.createElement('template');
            template.innerHTML = html.trim();
            return template.content.firstElementChild;
        },

        getScriptInfo() {
            return {
                name: 'Twitch Chat Link Embedder Pro',
                version: '2.5.1'
            };
        }
    };

    // Gestionnaire de requêtes unifié avec cache et retry
    class RequestManager {
        constructor() {
            this.cache = new Map();
            this.pendingRequests = new Map();
            this.failedRequests = new Map();
        }

        async fetchWithCache(url, options = {}, parseAs = 'json') {
            const cacheKey = `${url}-${JSON.stringify(options)}-${parseAs}`;

            // Évite les requêtes qui ont échoué récemment
            if (this.failedRequests.has(cacheKey)) {
                const { timestamp } = this.failedRequests.get(cacheKey);
                if (Date.now() - timestamp < 30000) {
                    throw new Error('Request failed recently, skipping retry');
                }
                this.failedRequests.delete(cacheKey);
            }

            // Retourne la promesse existante si même requête en cours
            if (this.pendingRequests.has(cacheKey)) {
                return this.pendingRequests.get(cacheKey);
            }

            // Cache simple
            if (this.cache.has(cacheKey)) {
                const { timestamp, data } = this.cache.get(cacheKey);
                if (Date.now() - timestamp < CONFIG.CACHE_DURATION) {
                    return data;
                }
                this.cache.delete(cacheKey);
            }

            const requestPromise = this._doFetch(url, options, parseAs)
            .then(result => {
                this.cache.set(cacheKey, {
                    timestamp: Date.now(),
                    data: result
                });
                return result;
            })
            .catch(error => {
                this.failedRequests.set(cacheKey, {
                    timestamp: Date.now(),
                    error: error.message
                });
                throw error;
            })
            .finally(() => {
                this.pendingRequests.delete(cacheKey);
            });

            this.pendingRequests.set(cacheKey, requestPromise);
            return requestPromise;
        }

        async _doFetch(url, options = {}, parseAs = 'json', retries = CONFIG.MAX_API_RETRIES) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);

            try {
                const response = await fetch(url, {
                    ...options,
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    if (response.status >= 500 || response.status === 429) {
                        throw new Error(`HTTP error! status: ${response.status}`);
                    }
                    return { error: true, status: response.status };
                }

                let data;
                switch (parseAs) {
                    case 'json':
                        data = await response.json();
                        break;
                    case 'text':
                        data = await response.text();
                        break;
                    default:
                        data = await response.text();
                }

                return data;

            } catch (error) {
                clearTimeout(timeoutId);
                Logger.debug(`Fetch error for ${url}:`, error.message);

                if (retries > 0 && this._isRetryableError(error)) {
                    const delay = CONFIG.API_RETRY_DELAY * Math.pow(2, CONFIG.MAX_API_RETRIES - retries);
                    Logger.debug(`Retrying fetch (${CONFIG.MAX_API_RETRIES - retries + 1}/${CONFIG.MAX_API_RETRIES}) for ${url} in ${delay}ms`);

                    await new Promise(resolve => setTimeout(resolve, delay));
                    return this._doFetch(url, options, parseAs, retries - 1);
                }
                throw error;
            }
        }

        _isRetryableError(error) {
            return error.message.includes('HTTP error! status: 5') ||
                error.message.includes('HTTP error! status: 429') ||
                error.message.includes('Failed to fetch') ||
                error.message.includes('abort');
        }

        clearCache() {
            this.cache.clear();
            this.pendingRequests.clear();
            this.failedRequests.clear();
        }
    }

    const requestManager = new RequestManager();

    // Détecteurs de contenu
    const ContentDetectors = {
        youtube(url) {
            const urlString = url.href;

            // 1️⃣ Playlist via /playlist?list=...
            const playlistMatch = url.search.match(/[?&]list=([a-zA-Z0-9_-]+)/);
            if (playlistMatch) {
                return { type: 'playlist', id: playlistMatch[1] };
            }

            // 2️⃣ Vidéo courte youtu.be/ID
            if (url.hostname.includes('youtu.be')) {
                const videoId = url.pathname.split('/')[1];
                return { type: 'video', id: videoId };
            }

            // 3️⃣ Vidéo avec v=ID (et optionnellement list=ID)
            const videoMatch = url.search.match(/[?&]v=([^&#]+)/);
            if (videoMatch) {
                return { type: 'video', id: videoMatch[1] };
            }

            // 4️⃣ Chaîne ou utilisateur
            const path = url.pathname;
            if (path.startsWith('/@') || path.startsWith('/channel/') ||
                path.startsWith('/c/') || path.startsWith('/user/') || /^\/[^/]+$/.test(path)) {
                return { type: 'channel', id: this.extractYouTubeChannelId(url) };
            }

            // 5️⃣ Cas inconnu
            return { type: 'unknown' };
        },

        extractYouTubeChannelId(url) {
            const path = url.pathname;
            if (path.startsWith('/@')) return path.split('/')[1];
            if (path.startsWith('/channel/')) return path.split('/')[2];
            if (path.startsWith('/c/')) return path.split('/')[2];
            if (path.startsWith('/user/')) return path.split('/')[2];
            if (/^\/[^/]+$/.test(path)) return `@${path.split('/')[1]}`;
            return null;
        },

        twitch(url) {
            const path = url.pathname;

            if (/^\/subs\/([a-zA-Z0-9_]+)$/i.test(path) || /^\/([a-zA-Z0-9_]+)\/subs?$/i.test(path)) {
                return { type: 'sub', id: path.match(/\/([a-zA-Z0-9_]+)/)[1] };
            }

            const clipMatch = path.match(/\/(?:[^/]+\/)?clip\/([a-zA-Z0-9_-]+)/i);
            if (clipMatch) return { type: 'clip', id: clipMatch[1] };

            const videoMatch = path.match(/\/videos\/([0-9]+)/i);
            if (videoMatch) return { type: 'video', id: videoMatch[1] };

            const channelMatch = path.match(/^\/([a-zA-Z0-9_]+)\/?$/i);
            if (channelMatch) return { type: 'channel', id: channelMatch[1] };

            return { type: 'unknown' };
        },

        discord(url) {
            const match = url.pathname.match(/^\/(?:invite\/)?([a-zA-Z0-9_-]+)$/);
            return match ? { type: 'invite', id: match[1] } : { type: 'unknown' };
        },

        steam(url) {
            // Vérifier si c'est une page de jeu (app) ou autre (news, etc.)
            const appMatch = url.pathname.match(/^\/app\/(\d+)/);
            if (appMatch) {
                return { type: 'game', id: appMatch[1] };
            }

            // Si c'est une news ou autre contenu Steam, on utilise meta embed
            if (url.hostname.includes('steampowered.com')) {
                return { type: 'meta' };
            }

            return { type: 'unknown' };
        },

        image(url) {
            const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];
            const path = url.pathname.toLowerCase();

            // Vérifier l'extension du fichier
            const isImage = imageExtensions.some(ext => path.endsWith(ext));

            // Vérifier les URLs d'images communes (Imgur, etc.)
            const imageHosts = ['i.imgur.com', 'cdn.discordapp.com', 'media.discordapp.net'];
            const isImageHost = imageHosts.some(host => url.hostname.includes(host));

            if (isImage || isImageHost) {
                return {
                    type: 'image',
                    url: url.href,
                    extension: path.split('.').pop()
                };
            }

            return { type: 'unknown' };
        }
    };

    // Gestionnaire des styles d'embed (seulement glass)
    const EmbedStyles = {
        'dark-glass': {
            background: 'rgba(255, 255, 255, 0.1)',
            border: '1px solid rgba(255, 255, 255, 0.2)',
            hoverBackground: 'rgba(255, 255, 255, 0.15)',
            hoverBorder: 'rgba(255, 255, 255, 0.3)',
            textColor: 'rgba(255, 255, 255, 0.95)',
            secondaryText: 'rgba(255, 255, 255, 0.8)',
            backdropFilter: 'blur(10px)'
        },
        'light-glass': {
            background: 'rgba(255, 255, 255, 0.8)',
            border: '1px solid rgba(255, 255, 255, 0.9)',
            hoverBackground: 'rgba(255, 255, 255, 0.9)',
            hoverBorder: 'rgba(255, 255, 255, 1)',
            textColor: 'rgba(0, 0, 0, 0.9)',
            secondaryText: 'rgba(0, 0, 0, 0.7)',
            backdropFilter: 'blur(10px)'
        }
    };

    // Logos SVG pour les différentes plateformes
    const PlatformLogos = {
        youtube: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/>
        </svg>`,
        discord: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M14.82 4.26a10.14 10.14 0 0 0-.53 1.1 14.66 14.66 0 0 0-4.58 0 10.14 10.14 0 0 0-.53-1.1 16 16 0 0 0-4.13 1.3 17.33 17.33 0 0 0-3 11.59 16.6 16.6 0 0 0 5.07 2.59A12.89 12.89 0 0 0 8.23 18a9.65 9.65 0 0 1-1.71-.83 3.39 3.39 0 0 0 .42-.33 11.66 11.66 0 0 0 10.12 0c.14.09.28.19.42.33a10.9 10.9 0 0 1-1.71.84 12.89 12.89 0 0 0 1.08 1.78 16.44 16.44 0 0 0 5.06-2.59 17.22 17.22 0 0 0-3-11.59 16.09 16.09 0 0 0-4.09-1.35zM8.68 14.81a1.94 1.94 0 0 1-1.8-2 1.93 1.93 0 0 1 1.8-2 1.93 1.93 0 0 1 1.8 2 1.93 1.93 0 0 1-1.8 2zm6.64 0a1.94 1.94 0 0 1-1.8-2 1.93 1.93 0 0 1 1.8-2 1.92 1.92 0 0 1 1.8 2 1.92 1.92 0 0 1-1.8 2z"/>
        </svg>`,
        twitch: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/>
        </svg>`,
        steam: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.29-.249-1.878-.03l1.523.63c.956.4 1.409 1.5 1.009 2.455-.397.957-1.497 1.41-2.454 1.012H7.54zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.665 0-3.015 1.353-3.015 3.015 0 1.665 1.35 3.015 3.015 3.015 1.663 0 3.015-1.35 3.015-3.015zm-5.273-.005c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.253 0-2.265-1.014-2.265-2.265z"/>
        </svg>`,
        meta: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0 22.5C6.21 22.5 1.5 17.79 1.5 12S6.21 1.5 12 1.5 22.5 6.21 22.5 12 17.79 22.5 12 22.5z"/>
            <path d="M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12zm0 9.75a3.75 3.75 0 1 1 0-7.5 3.75 3.75 0 0 1 0 7.5z"/>
        </svg>`,
        image: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>
        </svg>`,
        default: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
        </svg>`
    };

    // Factory pour les embeds avec styles dynamiques
    class EmbedFactory {
        static async createEmbed(url) {
            const cleanHostname = url.hostname.replace('www.', '').toLowerCase();
            Logger.info(`Processing URL: ${url.href}`, `Hostname: ${cleanHostname}`);

            // Vérification des paramètres utilisateur
            if (!USER_CONFIG.enableAllLinks) {
                Logger.debug('All links disabled by user settings');
                return null;
            }

            // Détection d'image en premier
            const imageInfo = ContentDetectors.image(url);
            if (imageInfo.type === 'image' && USER_CONFIG.enableImageEmbeds) {
                Logger.debug('Detected image URL, creating image embed');
                return this.createImageEmbed(url);
            }

            try {
                const embedMap = {
                    'youtube.com': () => USER_CONFIG.enableYouTube ? this.createYoutubeEmbed(url) : null,
                    'youtu.be': () => USER_CONFIG.enableYouTube ? this.createYoutubeEmbed(url) : null,
                    'discord.com': () => USER_CONFIG.enableDiscord ? this.createDiscordEmbed(url) : null,
                    'discord.gg': () => USER_CONFIG.enableDiscord ? this.createDiscordEmbed(url) : null,
                    'twitch.tv': () => USER_CONFIG.enableTwitch ? this.createTwitchEmbed(url) : null,
                    'subs.twitch.tv': () => USER_CONFIG.enableTwitch ? this.createTwitchEmbed(url) : null,
                    'store.steampowered.com': () => USER_CONFIG.enableSteam ? this.createSteamEmbed(url) : null,
                    'steampowered.com': () => USER_CONFIG.enableSteam ? this.createSteamEmbed(url) : null,
                    'fr.gamesplanet.com': () => USER_CONFIG.enableGamesPlanet ? this.createGamesPlanetEmbed(url) : null,
                    'gamesplanet.com': () => USER_CONFIG.enableGamesPlanet ? this.createGamesPlanetEmbed(url) : null,
                    'ko-fi.com': () => USER_CONFIG.enableKoFi ? this.createMetaEmbed(url) : null,
                    'eneba.com': () => USER_CONFIG.enableEneba ? this.createMetaEmbed(url) : null
                };

                const embedCreator = embedMap[cleanHostname];
                if (embedCreator) {
                    Logger.debug(`Using embed creator for: ${cleanHostname}`);
                    const embed = await embedCreator();
                    if (embed) {
                        Logger.debug(`Successfully created embed for: ${cleanHostname}`);
                        return embed;
                    }
                }

                Logger.debug(`No embed creator found for: ${cleanHostname}, using default`);
                return USER_CONFIG.enableAllLinks ? this.createDefaultEmbed(url) : null;

            } catch (error) {
                Logger.error(`Embed creation failed for ${cleanHostname}:`, error);
                return USER_CONFIG.enableAllLinks ? this.createDefaultEmbed(url) : null;
            }
        }

        static async createYoutubeEmbed(url) {
            const contentInfo = ContentDetectors.youtube(url);
            Logger.debug(`Creating YouTube embed (${contentInfo.type})`);

            if (!contentInfo.id) return null;

            try {
                let api_url, data;

                switch (contentInfo.type) {
                    case 'video':
                        api_url = `${CONFIG.EMBED_API_URL}/youtube/video?id=${contentInfo.id}`;
                        data = await requestManager.fetchWithCache(api_url);
                        if (!data) return null;

                        return this._buildEmbed(`
                            <div class="embed-header">
                                <div class="embed-platform-logo">
                                    ${PlatformLogos.youtube}
                                </div>
                                <div class="embed-platform-name">YouTube - Vidéo</div>
                            </div>
                            <div class="embed-body">
                                <div class="embed-thumbnail">
                                    <img src="${data.thumbnail.maxres || data.thumbnail.default}" loading="lazy">
                                    <div class="embed-play-button">
                                        <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
                                            <path d="M8 5v14l11-7z"/>
                                        </svg>
                                    </div>
                                </div>
                                <div class="embed-content">
                                    <div class="embed-title">${Utils.escapeHtml(data.title)}</div>
                                    <div class="embed-details">
                                        <div class="embed-channel">${Utils.escapeHtml(data.channel_title)}</div>
                                        <div class="embed-stats">
                                            <span class="embed-stat">${Utils.formatNumber(data.view)} vues</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        `, 'youtube', url);

                    case 'channel':
                        api_url = `${CONFIG.EMBED_API_URL}/youtube/channel?channel=${contentInfo.id}`;
                        data = await requestManager.fetchWithCache(api_url);
                        if (!data) return null;

                        return this._buildEmbed(`
                            <div class="embed-header">
                                <div class="embed-platform-logo">
                                    ${PlatformLogos.youtube}
                                </div>
                                <div class="embed-platform-name">YouTube - Channel</div>
                            </div>
                            <div class="embed-body">
                                <div class="embed-thumbnail squared">
                                    <img src="${data.thumbnail}" loading="lazy">
                                </div>
                                <div class="embed-content">
                                    <div class="embed-title">${Utils.escapeHtml(data.title)}</div>
                                    <div class="embed-details">
                                        <div class="embed-stats">
                                            <span class="embed-stat">${Utils.formatNumber(data.statistics.view_count)} vues</span>
                                            <span class="embed-stat">${Utils.formatNumber(data.statistics.video_count)} vidéos</span>
                                            <span class="embed-stat">${Utils.formatNumber(data.statistics.subscriber_count)} abonnés</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        `, 'youtube', url);

                    case 'playlist':
                        api_url = `${CONFIG.EMBED_API_URL}/youtube/playlist?id=${contentInfo.id}`;
                        data = await requestManager.fetchWithCache(api_url);
                        if (!data) return null;

                        return this._buildEmbed(`
                            <div class="embed-header">
                                <div class="embed-platform-logo">
                                    ${PlatformLogos.youtube}
                                </div>
                                <div class="embed-platform-name">YouTube - Playlist</div>
                            </div>
                            <div class="embed-body">
                                <div class="embed-thumbnail">
                                    <img src="${data.thumbnail.maxres || data.thumbnail.default}" loading="lazy">
                                </div>
                                <div class="embed-content">
                                    <div class="embed-title">${Utils.escapeHtml(data.title)}</div>
                                    <div class="embed-details">
                                        <div class="embed-channel">${Utils.escapeHtml(data.channelTitle)}</div>
                                        <div class="embed-stats">
                                            <span class="embed-stat">${Utils.formatNumber(data.itemCount)} vidéos</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        `, 'youtube', url);
                }
            } catch (error) {
                Logger.error('YouTube Embed Failed:', error);
                return null;
            }
        }

        static async createDiscordEmbed(url) {
            const contentInfo = ContentDetectors.discord(url);
            if (contentInfo.type !== 'invite') return null;

            Logger.debug('Creating Discord embed');
            try {
                const api_url = `https://discord.com/api/v9/invites/${contentInfo.id}?with_counts=true`;
                const data = await requestManager.fetchWithCache(api_url);

                if (!data || !data.guild) return null;

                return this._buildEmbed(`
                    <div class="embed-header">
                        <div class="embed-platform-logo">
                            ${PlatformLogos.discord}
                        </div>
                        <div class="embed-platform-name">Discord</div>
                    </div>
                    <div class="embed-body">
                        <div class="embed-thumbnail squared">
                            <img src="https://cdn.discordapp.com/icons/${data.guild.id}/${data.guild.icon}.png" loading="lazy">
                        </div>
                        <div class="embed-content">
                            <div class="embed-title">${Utils.escapeHtml(data.guild.name)}</div>
                            <div class="embed-details">
                                <div class="embed-stats">
                                    <span class="embed-stat">${Utils.formatNumber(data.approximate_member_count)} membres</span>
                                    ${data.inviter ? `<span class="embed-stat">Invité par ${Utils.escapeHtml(data.inviter.global_name)}</span>` : ''}
                                </div>
                            </div>
                        </div>
                    </div>
                `, 'discord', url);
            } catch (error) {
                Logger.error('Discord Embed Failed:', error);
                return null;
            }
        }

        static async createTwitchEmbed(url) {
            const contentInfo = ContentDetectors.twitch(url);
            Logger.debug(`Creating Twitch embed (${contentInfo.type})`);

            if (!contentInfo.id) return null;

            try {
                let api_url, data;

                switch (contentInfo.type) {
                    case 'clip':
                        api_url = `${CONFIG.EMBED_API_URL}/twitch/clip?id=${contentInfo.id}`;
                        data = await requestManager.fetchWithCache(api_url);
                        if (!data) return null;

                        return this._buildEmbed(`
                            <div class="embed-header">
                                <div class="embed-platform-logo">
                                    ${PlatformLogos.twitch}
                                </div>
                                <div class="embed-platform-name">Twitch - Clip</div>
                            </div>
                            <div class="embed-body">
                                <div class="embed-thumbnail">
                                    <img src="${data.clip.thumbnail_url}" loading="lazy">
                                    <div class="embed-play-button">
                                        <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
                                            <path d="M8 5v14l11-7z"/>
                                        </svg>
                                    </div>
                                </div>
                                <div class="embed-content">
                                    <div class="embed-title">${Utils.escapeHtml(data.clip.title)}</div>
                                    <div class="embed-details">
                                        <div class="embed-channel">Clippé par ${Utils.escapeHtml(data.clip.creator_name)}</div>
                                        <div class="embed-stats">
                                            <span class="embed-stat">${Utils.formatNumber(data.clip.view_count)} vues</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        `, 'twitch', url);

                    case 'channel':
                        api_url = `${CONFIG.EMBED_API_URL}/twitch/channel?username=${contentInfo.id}`;
                        data = await requestManager.fetchWithCache(api_url);
                        if (!data) return null;

                        return this._buildEmbed(`
                            <div class="embed-header">
                                <div class="embed-platform-logo">
                                    ${PlatformLogos.twitch}
                                </div>
                                <div class="embed-platform-name">Twitch - Channel</div>
                                ${data.is_live ? '<div class="embed-live-badge">LIVE</div>' : ''}
                            </div>
                            <div class="embed-body">
                                <div class="embed-thumbnail squared">
                                    <img src="${data.user.profile_image_url}" loading="lazy">
                                </div>
                                <div class="embed-content">
                                    <div class="embed-title">${Utils.escapeHtml(data.user.display_name)}</div>
                                    <div class="embed-details">
                                        <div class="embed-stats">
                                            ${data.is_live ? `<span class="embed-stat">${data.stream.viewer_count} viewers</span>` : ''}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        `, 'twitch', url);

                    case 'sub':
                        api_url = `${CONFIG.EMBED_API_URL}/twitch/channel?username=${contentInfo.id}`;
                        data = await requestManager.fetchWithCache(api_url);
                        if (!data) return null;

                        return this._buildEmbed(`
                            <div class="embed-header">
                                <div class="embed-platform-logo">
                                    ${PlatformLogos.twitch}
                                </div>
                                <div class="embed-platform-name">Twitch - Sub</div>
                            </div>
                            <div class="embed-body">
                                <div class="embed-thumbnail squared">
                                    <img src="${data.user.profile_image_url}" loading="lazy">
                                </div>
                                <div class="embed-content">
                                    <div class="embed-title">Abonnez-vous à ${Utils.escapeHtml(data.user.display_name)}</div>
                                    <div class="embed-details">
                                        <div class="embed-description">
                                            💜 Soutenez le streamer avec un abonnement ! Obtenez des émotes exclusives et des avantages en discutant tout en l'aidant à continuer de créer.
                                        </div>
                                    </div>
                                </div>
                            </div>
                        `, 'twitch', url);

                    case 'video':
                        return this.createDefaultEmbed(url);
                }
            } catch (error) {
                Logger.error('Twitch Embed Failed:', error);
                return null;
            }
        }

        static async createSteamEmbed(url) {
            try {
                const contentInfo = ContentDetectors.steam(url);

                if (contentInfo.type === 'game') {
                    const info = await this._getSteamInfo(url);
                    if (!info) return null;

                    Logger.debug('Creating Steam game embed');
                    return this._buildEmbed(`
                        <div class="embed-header">
                            <div class="embed-platform-logo">
                                ${PlatformLogos.steam}
                            </div>
                            <div class="embed-platform-name">Steam</div>
                        </div>
                        <div class="embed-body">
                            <div class="embed-thumbnail">
                                <img src="${info.cover}" loading="lazy">
                            </div>
                            <div class="embed-content">
                                <div class="embed-title">${Utils.escapeHtml(info.name)}</div>
                                <div class="embed-details">
                                    <div class="embed-description">${Utils.escapeHtml(info.description)}</div>
                                    <div class="embed-stats">
                                        <span class="embed-price">${Utils.escapeHtml(info.prix)}</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    `, 'steam', url);
                } else {
                    return this.createMetaEmbed(url);
                }
            } catch (error) {
                Logger.error('Steam Embed Failed:', error);
                return null;
            }
        }

        static async createGamesPlanetEmbed(url) {
            if (!USER_CONFIG.enableGamesPlanet) return null;

            Logger.debug('Creating GamesPlanet embed');

            return new Promise((resolve) => {
                try {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: url.href,
                        onload: (response) => {
                            try {
                                const htmlText = response.responseText;
                                const parser = new DOMParser();
                                const doc = parser.parseFromString(htmlText, 'text/html');

                                // Meta info
                                const meta = {
                                    title: doc.querySelector('meta[property="og:title"]')?.content
                                          || doc.querySelector('meta[name="twitter:title"]')?.content
                                          || doc.title
                                          || 'No title',
                                    description: doc.querySelector('meta[property="og:description"]')?.content
                                                || doc.querySelector('meta[name="twitter:description"]')?.content
                                                || doc.querySelector('meta[name="description"]')?.content
                                                || 'No description available',
                                    image: doc.querySelector('meta[property="og:image"]')?.content
                                         || doc.querySelector('meta[name="twitter:image"]')?.content
                                         || null,
                                };

                                // Favicon GamesPlanet
                                const faviconUrl = `${url.protocol}//${url.hostname}/favicon.ico`;

                                // Prix uniquement si page de jeu
                                const isGamePage = url.pathname.includes('/game/');
                                let priceHtml = '';
                                if (isGamePage) {
                                    const priceEl = doc.querySelector('.prices');
                                    if (priceEl) {
                                        const text = priceEl.textContent.trim();
                                        const match = text.match(/([\d,.]+€)\s*-\s*(\d+%)\s*([\d,.]+€)/); // ex: 59,99€ -10% 53,99€
                                        if (match) {
                                            const [_, oldPrice, discount, newPrice] = match;
                                            priceHtml = `<span class="price-old" style="text-decoration:line-through;color:#888;margin-right:4px;">${Utils.escapeHtml(oldPrice)}</span>
                                                         <span class="price-new">${Utils.escapeHtml(newPrice)}</span>
                                                         <span class="price-discount" style="color:#ff4d4f;font-weight:bold;margin-left:4px;">${Utils.escapeHtml(discount)}</span>`;
                                        } else {
                                            priceHtml = `<span class="price-new">${Utils.escapeHtml(text)}</span>`;
                                        }
                                    }
                                }

                                let platformName = 'GamesPlanet';
                                const ref = url.searchParams.get('ref');
                                if (ref) {
                                    platformName += ` × ${ref.charAt(0).toUpperCase()}${ref.slice(1)}`;
                                }

                                // Build l'embed
                                const embedHtml = `
                                    <div class="embed-header">
                                        <div class="embed-platform-logo">
                                            <img src="${faviconUrl}">
                                        </div>
                                        <div class="embed-platform-name">${Utils.escapeHtml(platformName)}</div>
                                    </div>
                                    <div class="embed-body">
                                        ${meta.image ? `
                                        <div class="embed-thumbnail squared">
                                            <img src="${meta.image}" loading="lazy" onerror="this.style.display='none'">
                                        </div>
                                        ` : ''}
                                        <div class="embed-content ${!meta.image ? 'full-width' : ''}">
                                            <div class="embed-title">${Utils.escapeHtml(meta.title)}</div>
                                            <div class="embed-details">
                                                <div class="embed-description">${Utils.escapeHtml(meta.description)}</div>
                                                ${priceHtml ? `<div class="embed-stats"><div class="embed-price">${priceHtml}</div></div>` : ''}
                                            </div>
                                        </div>
                                    </div>
                                `;

                                resolve(this._buildEmbed(embedHtml, 'gamesplanet', url));

                            } catch (err) {
                                Logger.error('Parsing GamesPlanet HTML failed:', err);
                                resolve(this.createDefaultEmbed(url));
                            }
                        },
                        onerror: (err) => {
                            Logger.error('GM_xmlhttpRequest failed for GamesPlanet:', err);
                            resolve(this.createDefaultEmbed(url));
                        }
                    });
                } catch (error) {
                    Logger.error('GamesPlanet Embed Failed:', error);
                    resolve(this.createDefaultEmbed(url));
                }
            });
        }

        static createMetaEmbed(url) {
            if (!USER_CONFIG.enableMeta) return null;

            Logger.debug('Creating Meta embed');

            return new Promise((resolve) => {
                try {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: url.href,
                        onload: (response) => {
                            try {
                                const htmlText = response.responseText;
                                const parser = new DOMParser();
                                const doc = parser.parseFromString(htmlText, 'text/html');

                                // Récupération des meta tags
                                const meta = {
                                    title: doc.querySelector('meta[property="og:title"]')?.content
                                          || doc.querySelector('meta[name="twitter:title"]')?.content
                                          || doc.title
                                          || 'No title',
                                    description: doc.querySelector('meta[property="og:description"]')?.content
                                                || doc.querySelector('meta[name="twitter:description"]')?.content
                                                || doc.querySelector('meta[name="description"]')?.content
                                                || 'No description available',
                                    image: doc.querySelector('meta[property="og:image"]')?.content
                                         || doc.querySelector('meta[name="twitter:image"]')?.content
                                         || null,
                                    siteName: doc.querySelector('meta[property="og:site_name"]')?.content
                                           || url.hostname.replace('www.', ''),
                                };

                                // URL favicon classique
                                const faviconUrl = `${url.protocol}//${url.hostname}/favicon.ico`;

                                // Build l'embed
                                const embedHtml = `
                                    <div class="embed-header">
                                        <div class="embed-platform-logo">
                                            <img src="${faviconUrl}">
                                        </div>
                                        <div class="embed-platform-name">${Utils.escapeHtml(meta.siteName)}</div>
                                    </div>
                                    <div class="embed-body">
                                        ${meta.image ? `
                                        <div class="embed-thumbnail squared">
                                            <img src="${meta.image}" loading="lazy" onerror="this.style.display='none'">
                                        </div>
                                        ` : ''}
                                        <div class="embed-content ${!meta.image ? 'full-width' : ''}">
                                            <div class="embed-title">${Utils.escapeHtml(meta.title)}</div>
                                            <div class="embed-details">
                                                <div class="embed-description">${Utils.escapeHtml(meta.description)}</div>
                                            </div>
                                        </div>
                                    </div>
                                `;

                                resolve(this._buildEmbed(embedHtml, 'meta', url));

                            } catch (err) {
                                Logger.error('Parsing HTML failed:', err);
                                resolve(this.createDefaultEmbed(url));
                            }
                        },
                        onerror: (err) => {
                            Logger.error('GM_xmlhttpRequest failed:', err);
                            resolve(this.createDefaultEmbed(url));
                        }
                    });
                } catch (error) {
                    Logger.error('Meta Embed Failed:', error);
                    resolve(this.createDefaultEmbed(url));
                }
            });
        }

        static async createImageEmbed(url) {
            Logger.debug('Creating image embed');

            try {
                if (!USER_CONFIG.enableImageEmbeds) {
                    return null;
                }

                return this._buildImageEmbed(url.href);

            } catch (error) {
                Logger.error('Image Embed Failed:', error);
                return null;
            }
        }

        static createDefaultEmbed(url) {
            Logger.debug('Creating default embed');

            const faviconUrl = `${url.protocol}//${url.hostname}/favicon.ico`;

            const embedHtml = `
                <div class="embed-header">
                    <div class="embed-platform-logo">
                        <img src="${faviconUrl}"/>
                    </div>
                    <div class="embed-platform-name">${Utils.escapeHtml(url.hostname.replace('www.', ''))}</div>
                </div>
                <div class="embed-body">
                    <div class="embed-content full-width">
                        <div class="embed-url">${Utils.escapeHtml(url.href)}</div>
                    </div>
                </div>
            `;

            return this._buildEmbed(embedHtml, 'default', url);
        }

        static _buildEmbed(html, type, url) {
            const embed = document.createElement('div');
            embed.className = `${type}-embed coven-embed`;
            embed.innerHTML = html;
            embed.onclick = () => window.open(url.href, '_blank');

            embed.dataset.originalUrl = url.href;
            embed.dataset.embedType = type;
            this._applyEmbedStyle(embed);

            return embed;
        }

        static _buildImageEmbed(imageUrl) {
            const maxWidth = USER_CONFIG.maxImageWidth;
            const maxHeight = USER_CONFIG.maxImageHeight;

            const embed = document.createElement('div');
            embed.className = 'image-embed coven-embed';
            embed.innerHTML = `
                <div class="embed-header">
                    <div class="embed-platform-logo">
                        ${PlatformLogos.image}
                    </div>
                    <div class="embed-platform-name">Image</div>
                </div>
                <div class="embed-body">
                    <div class="embed-image-container">
                        <img src="${imageUrl}"
                             loading="lazy"
                             style="max-width: ${maxWidth}px; max-height: ${maxHeight}px;"
                             onerror="this.style.display='none'; this.parentNode.querySelector('.image-error').style.display='block';"
                             onclick="event.stopPropagation();">
                        <div class="image-error" style="display: none;">
                            ❌ Impossible de charger l'image
                        </div>
                    </div>
                    <div class="embed-content">
                        <div class="embed-filename">${new URL(imageUrl).pathname.split('/').pop()}</div>
                    </div>
                </div>
            `;

            embed.dataset.originalUrl = imageUrl;
            embed.dataset.embedType = 'image';
            embed.onclick = (e) => {
                if (!e.target.matches('img')) {
                    window.open(imageUrl, '_blank');
                }
            };

            this._applyEmbedStyle(embed);
            return embed;
        }

        static _applyEmbedStyle(embed) {
            const style = EmbedStyles[USER_CONFIG.embedStyle];
            if (!style) return;

            if (!embed.dataset.originalUrl) {
                const link = embed.querySelector('a');
                if (link) {
                    embed.dataset.originalUrl = link.href;
                }
            }

            embed.style.transition = 'all 0.3s ease';
            embed.style.background = style.background;
            embed.style.border = style.border;
            embed.style.color = style.textColor;

            if (style.backdropFilter) {
                embed.style.backdropFilter = style.backdropFilter;
            } else {
                embed.style.backdropFilter = 'none';
            }

            const existingHoverHandlers = embed._ptlHoverHandlers;
            if (existingHoverHandlers) {
                embed.removeEventListener('mouseenter', existingHoverHandlers.mouseenter);
                embed.removeEventListener('mouseleave', existingHoverHandlers.mouseleave);
            }

            const mouseenterHandler = () => {
                embed.style.background = style.hoverBackground;
                embed.style.border = style.hoverBorder;
                embed.style.transform = 'translateY(-2px)';
            };

            const mouseleaveHandler = () => {
                embed.style.background = style.background;
                embed.style.border = style.border;
                embed.style.transform = 'translateY(0)';
            };

            embed.addEventListener('mouseenter', mouseenterHandler);
            embed.addEventListener('mouseleave', mouseleaveHandler);

            embed._ptlHoverHandlers = {
                mouseenter: mouseenterHandler,
                mouseleave: mouseleaveHandler
            };

            const secondaryElements = embed.querySelectorAll('.embed-platform-name, .embed-channel, .embed-description, .embed-stat, .embed-url, .embed-filename');
            secondaryElements.forEach(el => {
                el.style.color = style.secondaryText;
            });
        }

        static _getSteamInfo(steamUrl) {
            return new Promise((resolve) => {
                try {
                    const pathMatch = steamUrl.pathname.match(/^\/app\/(\d+)/);
                    if (!pathMatch) {
                        Logger.debug('URL Steam non reconnue comme jeu');
                        return resolve(null);
                    }

                    const appId = pathMatch[1];
                    const apiUrl = `https://store.steampowered.com/api/appdetails?appids=${appId}`;

                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: apiUrl,
                        headers: { 'Accept': 'application/json' },
                        onload: (response) => {
                            try {
                                const data = JSON.parse(response.responseText);

                                if (!data[appId]?.success) {
                                    throw new Error("Échec de récupération des données du jeu.");
                                }

                                const gameData = data[appId].data;

                                resolve({
                                    name: gameData.name,
                                    description: gameData.short_description,
                                    prix: gameData.is_free ? "F2P" : (gameData.price_overview?.final_formatted || ""),
                                    cover: gameData.header_image
                                });
                            } catch (err) {
                                Logger.error('Parsing JSON échoué:', err.message);
                                resolve(null);
                            }
                        },
                        onerror: (err) => {
                            Logger.error('Erreur GM_xmlhttpRequest:', err);
                            resolve(null);
                        }
                    });

                } catch (error) {
                    Logger.error('Erreur dans getSteamInfo:', error.message);
                    resolve(null);
                }
            });
        }
    }

    // Preloader pour les liens
    function createLinkPreloader(url) {
        const preloader = document.createElement('div');
        preloader.className = 'link-preloader coven-embed';
        preloader.innerHTML = `
            <div class="embed-header">
                <div class="embed-platform-logo">
                    ${PlatformLogos.default}
                </div>
                <div class="embed-platform-name">Chargement...</div>
            </div>
            <div class="embed-body">
                <div class="preloader-content">
                    <div class="preloader-spinner"></div>
                    <div class="preloader-url">${Utils.escapeHtml(url.href)}</div>
                </div>
            </div>
        `;
        preloader.onclick = () => window.open(url.href, '_blank');
        preloader.dataset.originalUrl = url.href;

        const style = EmbedStyles[USER_CONFIG.embedStyle];
        if (style) {
            preloader.style.background = style.background;
            preloader.style.border = style.border;
            preloader.style.color = style.textColor;
            if (style.backdropFilter) {
                preloader.style.backdropFilter = style.backdropFilter;
            }
        }

        return preloader;
    }

    // Gestionnaire du chat avec régénération des embeds
    class ChatManager {
        constructor() {
            this.observer = null;
            this.currentContainer = null;
            this.processedMessages = new WeakSet();
            this.retryCount = 0;
            this.maxRetries = 10;
        }

        init() {
            Logger.info('Initializing chat manager...');
            this.findAndObserveChat();

            // Backup polling
            this.backupInterval = setInterval(() => {
                if (!this.currentContainer || !document.contains(this.currentContainer)) {
                    Logger.debug('Chat container lost, reinitializing...');
                    this.findAndObserveChat();
                }
            }, 2000);
        }

        findAndObserveChat() {
            const chatContainer = this.findChatContainer();

            if (chatContainer && chatContainer !== this.currentContainer) {
                Logger.info('Chat container found:', chatContainer);
                if (this.observer) this.observer.disconnect();

                this.setupChatObserver(chatContainer);
                this.currentContainer = chatContainer;
                this.retryCount = 0;
                this.showLoadConfirmation(chatContainer);
                return true;
            } else if (this.retryCount < this.maxRetries) {
                this.retryCount++;
                Logger.debug(`Chat container not found, retrying... (${this.retryCount}/${this.maxRetries})`);
                setTimeout(() => this.findAndObserveChat(), 1000);
                return false;
            } else {
                Logger.warn('Max retries reached, chat container not found');
                return false;
            }
        }

        findChatContainer() {
            for (const selector of SELECTORS.chat) {
                const element = document.querySelector(selector);
                if (element) {
                    Logger.debug(`Found chat container with selector: ${selector}`);
                    return element;
                }
            }

            // Fallback: chercher par structure
            const fallbackSelectors = [
                '[class*="chat-scrollable-area"]',
                '[class*="message-container"]',
                '[class*="chat-list"]',
                '.chat-room',
                'section[aria-label*="chat"]'
            ];

            for (const selector of fallbackSelectors) {
                const element = document.querySelector(selector);
                if (element) {
                    Logger.debug(`Found chat container with fallback selector: ${selector}`);
                    return element;
                }
            }

            return null;
        }

        setupChatObserver(container) {
            Logger.info('Setting up chat observer...');

            this.observer = new MutationObserver((mutations) => {
                const addedNodes = [];

                for (const mutation of mutations) {
                    if (Array.from(mutation.removedNodes).includes(container)) {
                        Logger.debug('Chat container removed, reinitializing...');
                        this.findAndObserveChat();
                        return;
                    }

                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === 1 && this.isValidMessageNode(node) && !this.processedMessages.has(node)) {
                            this.processedMessages.add(node);
                            addedNodes.push(node);
                        }
                    }
                }

                if (addedNodes.length > 0) {
                    Logger.debug(`Processing ${addedNodes.length} new messages`);
                    this.processMessagesBatch(addedNodes);
                }
            });

            const observerConfig = {
                childList: true,
                subtree: true,
                characterData: false
            };

            this.observer.observe(container, observerConfig);
            container.dataset.ptlObserved = true;

            // Traiter les messages existants
            setTimeout(() => {
                this.processExistingMessages(container);
            }, 1000);
        }

        isValidMessageNode(node) {
            if (node.nodeType !== 1) return false;

            // Vérifier si c'est un message de chat
            if (node.matches && node.matches(SELECTORS.message)) {
                return true;
            }

            // Vérifier si contient un message de chat
            if (node.querySelector && node.querySelector(SELECTORS.message)) {
                return true;
            }

            // Vérifier par structure
            if (node.classList && (
                node.classList.contains('chat-line__message') ||
                node.getAttribute('data-a-target') === 'chat-line-message'
            )) {
                return true;
            }

            return false;
        }

        async processMessagesBatch(nodes) {
            const linksToProcess = [];

            nodes.forEach(node => {
                const messageElement = node.matches(SELECTORS.message) ? node : node.querySelector(SELECTORS.message);
                if (messageElement) {
                    const links = messageElement.querySelectorAll(SELECTORS.link);
                    if (links.length > 0) {
                        Logger.debug(`Found ${links.length} links in message`);
                        linksToProcess.push(...Array.from(links));
                    }
                }
            });

            if (linksToProcess.length > 0) {
                Logger.info(`Found ${linksToProcess.length} links to process`);
                await this.processLinksSequentially(linksToProcess);
            }
        }

        async processLinksSequentially(links) {
            for (const link of links) {
                if (!document.contains(link)) {
                    Logger.debug('Link no longer in DOM, skipping');
                    continue;
                }

                try {
                    // Vérifier si le lien a déjà été traité
                    if (link.dataset.ptlEmbed) {
                        Logger.debug('Link already processed, skipping');
                        continue;
                    }

                    link.dataset.ptlEmbed = "processing";
                    const url = new URL(link.href);

                    Logger.debug(`Processing link: ${url.href}`);

                    // Remplace par le preloader
                    const preloader = createLinkPreloader(url);
                    link.parentNode.replaceChild(preloader, link);

                    // Crée l'embed
                    const embed = await EmbedFactory.createEmbed(url);

                    if (document.contains(preloader)) {
                        if (embed) {
                            preloader.replaceWith(embed);
                            Logger.debug(`Embed created for: ${url.href}`);
                        } else {
                            // Si l'embed est désactivé, remettre le lien original
                            const originalLink = document.createElement('a');
                            originalLink.href = url.href;
                            originalLink.textContent = url.href;
                            originalLink.target = '_blank';
                            originalLink.style.color = '#bf94ff';
                            preloader.replaceWith(originalLink);
                        }
                    }
                } catch (error) {
                    Logger.error('Error processing link:', error);
                    // En cas d'erreur, remettre le lien original
                    if (document.body.contains(preloader)) {
                        const originalLink = document.createElement('a');
                        originalLink.href = link.href;
                        originalLink.textContent = link.href;
                        originalLink.target = '_blank';
                        originalLink.style.color = '#bf94ff';
                        preloader.replaceWith(originalLink);
                    }
                }

                await new Promise(resolve => setTimeout(resolve, CONFIG.BATCH_PROCESSING_DELAY));
            }
        }

        processExistingMessages(container) {
            const messages = container.querySelectorAll(SELECTORS.message);
            const linksToProcess = [];

            Logger.debug(`Processing ${messages.length} existing messages`);

            messages.forEach(msg => {
                if (!this.processedMessages.has(msg)) {
                    this.processedMessages.add(msg);
                    const links = msg.querySelectorAll(SELECTORS.link);
                    if (links.length > 0) {
                        linksToProcess.push(...Array.from(links));
                    }
                }
            });

            if (linksToProcess.length > 0) {
                Logger.info(`Processing ${linksToProcess.length} existing links`);
                this.processLinksSequentially(linksToProcess);
            }
        }

        // NOUVELLE MÉTHODE : Régénérer tous les embeds du chat
        async regenerateAllEmbeds() {
            Logger.info('Regenerating all embeds in chat...');

            if (!this.currentContainer) {
                Logger.warn('No chat container found for regeneration');
                return;
            }

            // Récupérer tous les embeds existants
            const existingEmbeds = this.currentContainer.querySelectorAll('.coven-embed');
            Logger.debug(`Found ${existingEmbeds.length} embeds to regenerate`);

            for (const embed of existingEmbeds) {
                try {
                    const originalUrl = embed.dataset.originalUrl;
                    const embedType = embed.dataset.embedType;

                    if (!originalUrl) {
                        Logger.debug('Embed has no original URL, skipping');
                        continue;
                    }

                    const url = new URL(originalUrl);

                    // Vérifier si cet embed type est maintenant activé
                    const shouldRegenerate = this.shouldRegenerateEmbed(embedType, url);

                    if (shouldRegenerate) {
                        Logger.debug(`Regenerating embed for: ${originalUrl}`);

                        // Créer un nouveau preloader
                        const preloader = createLinkPreloader(url);
                        embed.replaceWith(preloader);

                        // Créer le nouvel embed
                        const newEmbed = await EmbedFactory.createEmbed(url);

                        if (document.contains(preloader)) {
                            if (newEmbed) {
                                preloader.replaceWith(newEmbed);
                                Logger.debug(`Embed regenerated for: ${originalUrl}`);
                            } else {
                                // Remettre le lien original si l'embed n'est pas créé
                                const originalLink = document.createElement('a');
                                originalLink.href = originalUrl;
                                originalLink.textContent = originalUrl;
                                originalLink.target = '_blank';
                                originalLink.style.color = '#bf94ff';
                                preloader.replaceWith(originalLink);
                            }
                        }
                    } else {
                        Logger.debug(`Embed type ${embedType} disabled, converting to link`);
                        // Convertir en lien simple
                        const originalLink = document.createElement('a');
                        originalLink.href = originalUrl;
                        originalLink.textContent = originalUrl;
                        originalLink.target = '_blank';
                        originalLink.style.color = '#bf94ff';
                        embed.replaceWith(originalLink);
                    }

                    await new Promise(resolve => setTimeout(resolve, CONFIG.BATCH_PROCESSING_DELAY));

                } catch (error) {
                    Logger.error('Error regenerating embed:', error);
                }
            }

            Logger.info('Embed regeneration completed');
        }

        // Vérifier si un embed doit être régénéré basé sur les paramètres actuels
        shouldRegenerateEmbed(embedType, url) {
            const cleanHostname = url.hostname.replace('www.', '').toLowerCase();

            switch (embedType) {
                case 'youtube':
                    return USER_CONFIG.enableYouTube;
                case 'discord':
                    return USER_CONFIG.enableDiscord;
                case 'twitch':
                    return USER_CONFIG.enableTwitch;
                case 'steam':
                    return USER_CONFIG.enableSteam;
                case 'gamesplanet':
                    return USER_CONFIG.enableGamesPlanet;
                case 'meta':
                    return USER_CONFIG.enableMeta;
                case 'image':
                    return USER_CONFIG.enableImageEmbeds;
                case 'default':
                    return USER_CONFIG.enableAllLinks;
                default:
                    // Pour les types inconnus, vérifier par hostname
                    const hostConfigMap = {
                        'ko-fi.com': USER_CONFIG.enableKoFi,
                        'eneba.com': USER_CONFIG.enableEneba
                    };
                    return hostConfigMap[cleanHostname] !== false;
            }
        }

        refreshExistingEmbeds() {
            Logger.info('Refreshing existing embeds with new styles...');

            const existingEmbeds = document.querySelectorAll('.coven-embed');
            Logger.debug(`Found ${existingEmbeds.length} embeds to refresh`);

            existingEmbeds.forEach(embed => {
                EmbedFactory._applyEmbedStyle(embed);

                if (embed.classList.contains('image-embed')) {
                    const img = embed.querySelector('img');
                    if (img) {
                        img.style.maxWidth = `${USER_CONFIG.maxImageWidth}px`;
                        img.style.maxHeight = `${USER_CONFIG.maxImageHeight}px`;
                    }
                }
            });

            Logger.info('Existing embeds refreshed successfully');
        }

        showLoadConfirmation(chatContainer) {
            const scriptInfo = Utils.getScriptInfo();
            const confirmation = document.createElement('div');
            confirmation.className = 'chat-line__message';
            confirmation.innerHTML = `
                <div style="color:rgb(117, 68, 250); font-style: italic; padding: 8px;">
                    ${scriptInfo.name} v${scriptInfo.version}<br>
                    <strong>LOADED SUCCESSFULLY</strong><br>
                    <small>Monitoring chat for links...</small>
                </div>
            `;

            if (chatContainer.firstChild) {
                chatContainer.insertBefore(confirmation, chatContainer.firstChild);
            } else {
                chatContainer.appendChild(confirmation);
            }

            setTimeout(() => {
                confirmation.style.opacity = '0';
                confirmation.style.transition = 'opacity 1s ease';
                setTimeout(() => {
                    if (confirmation.parentNode) {
                        confirmation.parentNode.removeChild(confirmation);
                    }
                }, 1000);
            }, 5000);
        }

        destroy() {
            if (this.observer) {
                this.observer.disconnect();
                this.observer = null;
            }
            if (this.backupInterval) {
                clearInterval(this.backupInterval);
                this.backupInterval = null;
            }
            this.processedMessages = new WeakSet();
            this.currentContainer = null;
        }
    }

    // Système d'options avec régénération
    class OptionsManager {
        constructor() {
            this.modal = null;
            this.isOpen = false;
            this.buttonObserver = null;
        }

        init() {
            Logger.info('Initializing options manager...');
            this.createOptionsModal();
            this.injectOptionsButton();

            try {
                GM_registerMenuCommand('Twitch Embed Options', () => this.openOptionsModal());
            } catch (e) {
                Logger.debug('GM_registerMenuCommand not available');
            }
        }

        injectOptionsButton() {
            this.buttonObserver = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === 1) {
                            if (node.matches && (node.matches(SELECTORS.chatButtons) || node.querySelector(SELECTORS.chatSettings))) {
                                this.addOptionsButtonToChat();
                            }

                            const chatButtons = node.querySelectorAll ? node.querySelectorAll(SELECTORS.chatButtons) : [];
                            for (const buttonContainer of chatButtons) {
                                if (buttonContainer.querySelector(SELECTORS.chatSettings)) {
                                    this.addOptionsButtonToChat();
                                    break;
                                }
                            }
                        }
                    }
                }
            });

            this.buttonObserver.observe(document.body, {
                childList: true,
                subtree: true
            });

            setTimeout(() => {
                this.addOptionsButtonToChat();
            }, 2000);
        }

        addOptionsButtonToChat() {
            if (document.querySelector('[data-twitch-embed-options]')) {
                return;
            }

            const chatButtonsContainer = document.querySelector(SELECTORS.chatButtons);
            if (!chatButtonsContainer) {
                Logger.debug('Chat buttons container not found');
                return;
            }

            Logger.debug('Injecting options button into chat');

            const optionsButton = Utils.createElement(`
                <div class="Layout-sc-1xcs6mc-0 cUmVME">
                    <div class="InjectLayout-sc-1i43xsx-0 iDMNUO">
                        <button class="ScCoreButton-sc-ocjdkq-0 iPkwTD ScButtonIcon-sc-9yap0r-0 dcNXJO" data-twitch-embed-options aria-label="Twitch Embed Options">
                            <div class="ButtonIconFigure-sc-1emm8lf-0 lnTwMD">
                                <div class="ScSvgWrapper-sc-wkgzod-0 kccyMt tw-svg">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-image-up-icon lucide-image-up"><path d="M10.3 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10l-3.1-3.1a2 2 0 0 0-2.814.014L6 21"/><path d="m14 19.5 3-3 3 3"/><path d="M17 22v-5.5"/><circle cx="9" cy="9" r="2"/></svg>
                                </div>
                            </div>
                        </button>
                    </div>
                </div>
            `);

            const settingsButton = chatButtonsContainer.querySelector(SELECTORS.chatSettings);
            if (settingsButton && settingsButton.parentNode) {
                settingsButton.parentNode.parentNode.insertBefore(optionsButton, settingsButton.parentNode);
                Logger.info('Options button injected into chat successfully');
            } else {
                chatButtonsContainer.appendChild(optionsButton);
                Logger.info('Options button injected into chat (fallback)');
            }

            const button = optionsButton.querySelector('button');
            button.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.openOptionsModal();
            });
        }

        createOptionsModal() {
            if (this.modal) return;

            const scriptInfo = Utils.getScriptInfo();

            this.modal = Utils.createElement(`
                <div class="twitch-embed-options-modal" style="
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: rgba(0, 0, 0, 0.8);
                    display: none;
                    justify-content: center;
                    align-items: center;
                    z-index: 10000;
                    backdrop-filter: blur(5px);
                ">
                    <div class="modal-content" style="
                        background: #1f1f23;
                        border: 1px solid #464648;
                        border-radius: 8px;
                        padding: 24px;
                        width: 90%;
                        max-width: 500px;
                        max-height: 80vh;
                        overflow-y: auto;
                        color: #efeff1;
                    ">
                        <div class="modal-header" style="
                            display: flex;
                            justify-content: space-between;
                            align-items: center;
                            margin-bottom: 20px;
                            border-bottom: 1px solid #464648;
                            padding-bottom: 15px;
                        ">
                            <h2 style="margin: 0; font-size: 18px; color: #efeff1;">${scriptInfo.name} v${scriptInfo.version}</h2>
                            <button class="close-btn" style="
                                background: none;
                                border: none;
                                color: #efeff1;
                                font-size: 24px;
                                cursor: pointer;
                                padding: 0;
                                width: 30px;
                                height: 30px;
                                display: flex;
                                align-items: center;
                                justify-content: center;
                            ">×</button>
                        </div>

                        <div class="options-section">
                            <h3 style="margin: 0 0 15px 0; font-size: 16px; color: #bf94ff;">Style des Embeds</h3>
                            <div class="style-options" style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 20px;">
                                ${this.createStyleOptions()}
                            </div>
                        </div>

                        <div class="options-section">
                            <h3 style="margin: 0 0 15px 0; font-size: 16px; color: #bf94ff;">Plateformes Activées</h3>
                            <div class="platform-options" style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px;">
                                ${this.createPlatformOptions()}
                            </div>
                        </div>

                        <div class="options-section">
                            <h3 style="margin: 0 0 15px 0; font-size: 16px; color: #bf94ff;">Sites Web</h3>
                            <div class="website-options" style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px;">
                                ${this.createWebsiteOptions()}
                            </div>
                        </div>

                        <div class="options-section">
                            <h3 style="margin: 0 0 15px 0; font-size: 16px; color: #bf94ff;">Paramètres Généraux</h3>
                            <div class="general-options" style="display: flex; flex-direction: column; gap: 10px;">
                                ${this.createGeneralOptions()}
                            </div>
                        </div>

                        <div class="modal-actions" style="
                            display: flex;
                            justify-content: flex-end;
                            gap: 10px;
                            margin-top: 20px;
                            border-top: 1px solid #464648;
                            padding-top: 15px;
                        ">
                            <button class="save-btn" style="
                                background: #9147ff;
                                color: white;
                                border: none;
                                padding: 8px 16px;
                                border-radius: 4px;
                                cursor: pointer;
                                font-weight: bold;
                            ">Sauvegarder</button>
                            <button class="cancel-btn" style="
                                background: #464648;
                                color: #efeff1;
                                border: none;
                                padding: 8px 16px;
                                border-radius: 4px;
                                cursor: pointer;
                            ">Annuler</button>
                        </div>
                    </div>
                </div>
            `);

            document.body.appendChild(this.modal);

            this.modal.querySelector('.close-btn').addEventListener('click', () => this.closeOptionsModal());
            this.modal.querySelector('.cancel-btn').addEventListener('click', () => this.closeOptionsModal());
            this.modal.querySelector('.save-btn').addEventListener('click', () => this.saveOptions());

            this.modal.addEventListener('click', (e) => {
                if (e.target === this.modal) {
                    this.closeOptionsModal();
                }
            });

            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this.isOpen) {
                    this.closeOptionsModal();
                }
            });

            this.setupStyleSelection();
        }

        createStyleOptions() {
            const styles = [
                { value: 'dark-glass', label: 'Dark Glass', description: 'Sombre avec effet verre' },
                { value: 'light-glass', label: 'Light Glass', description: 'Clair avec effet verre' }
            ];

            return styles.map(style => `
                <label class="style-option" style="
                    border: 2px solid ${USER_CONFIG.embedStyle === style.value ? '#9147ff' : '#464648'};
                    border-radius: 8px;
                    padding: 16px;
                    cursor: pointer;
                    background: ${USER_CONFIG.embedStyle === style.value ? 'rgba(145, 71, 255, 0.15)' : 'rgba(255, 255, 255, 0.05)'};
                    transition: all 0.3s ease;
                    position: relative;
                    overflow: hidden;
                " data-style-value="${style.value}">
                    <input type="radio" name="embedStyle" value="${style.value}"
                           ${USER_CONFIG.embedStyle === style.value ? 'checked' : ''}
                           style="position: absolute; opacity: 0; pointer-events: none;">
                    <div style="display: flex; flex-direction: column; align-items: center; text-align: center;">
                        <div class="style-preview" style="width: 60px; height: 40px; border-radius: 6px; margin-bottom: 8px;
                                    background: ${style.value === 'dark-glass' ? 'linear-gradient(135deg, rgba(255,255,255,0.1), rgba(255,255,255,0.05))' : 'linear-gradient(135deg, rgba(255,255,255,0.9), rgba(255,255,255,0.7))'};
                                    border: 1px solid ${style.value === 'dark-glass' ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.9)'};
                                    backdrop-filter: blur(10px);
                                    box-shadow: ${USER_CONFIG.embedStyle === style.value ? '0 0 0 2px #9147ff' : 'none'};">
                        </div>
                        <div class="style-label" style="font-weight: bold; margin-bottom: 4px; color: ${USER_CONFIG.embedStyle === style.value ? '#bf94ff' : '#efeff1'};">${style.label}</div>
                        <div style="font-size: 12px; color: #adadb8;">${style.description}</div>
                    </div>
                    ${USER_CONFIG.embedStyle === style.value ? `
                    <div class="style-checkmark" style="position: absolute; top: 8px; right: 8px; width: 20px; height: 20px;
                                background: #9147ff; border-radius: 50%; display: flex; align-items: center; justify-content: center;">
                        <span style="color: white; font-size: 12px; font-weight: bold;">✓</span>
                    </div>
                    ` : ''}
                </label>
            `).join('');
        }

        createPlatformOptions() {
            const platforms = [
                { key: 'enableYouTube', label: 'YouTube Embeds', description: 'Afficher les embeds YouTube' },
                { key: 'enableDiscord', label: 'Discord Embeds', description: 'Afficher les embeds Discord' },
                { key: 'enableTwitch', label: 'Twitch Embeds', description: 'Afficher les embeds Twitch' },
                { key: 'enableSteam', label: 'Steam Embeds', description: 'Afficher les embeds Steam' }
            ];

            return platforms.map(platform => `
                <label class="platform-option" style="
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    padding: 12px;
                    border-radius: 6px;
                    background: rgba(255, 255, 255, 0.05);
                    cursor: pointer;
                    transition: all 0.2s ease;
                    border: 1px solid transparent;
                ">
                    <input type="checkbox" name="${platform.key}"
                           ${USER_CONFIG[platform.key] ? 'checked' : ''}
                           style="margin: 0; width: 16px; height: 16px;">
                    <div style="flex: 1;">
                        <div style="font-weight: bold; color: ${USER_CONFIG[platform.key] ? '#bf94ff' : '#efeff1'};">${platform.label}</div>
                        <div style="font-size: 12px; color: #adadb8;">${platform.description}</div>
                    </div>
                    ${USER_CONFIG[platform.key] ? `
                    <div style="width: 20px; height: 20px; background: #9147ff; border-radius: 4px;
                                display: flex; align-items: center; justify-content: center;">
                        <span style="color: white; font-size: 12px; font-weight: bold;">✓</span>
                    </div>
                    ` : ''}
                </label>
            `).join('');
        }

        createWebsiteOptions() {
            const websites = [
                { key: 'enableGamesPlanet', label: 'GamesPlanet', description: 'Afficher les embeds GamesPlanet' },
                { key: 'enableKoFi', label: 'Ko-fi', description: 'Afficher les embeds Ko-fi' },
                { key: 'enableEneba', label: 'Eneba', description: 'Afficher les embeds Eneba' },
                { key: 'enableMeta', label: 'Autres sites web', description: 'Afficher les embeds pour autres sites' }
            ];

            return websites.map(website => `
                <label class="website-option" style="
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    padding: 12px;
                    border-radius: 6px;
                    background: rgba(255, 255, 255, 0.05);
                    cursor: pointer;
                    transition: all 0.2s ease;
                    border: 1px solid transparent;
                ">
                    <input type="checkbox" name="${website.key}"
                           ${USER_CONFIG[website.key] ? 'checked' : ''}
                           style="margin: 0; width: 16px; height: 16px;">
                    <div style="flex: 1;">
                        <div style="font-weight: bold; color: ${USER_CONFIG[website.key] ? '#bf94ff' : '#efeff1'};">${website.label}</div>
                        <div style="font-size: 12px; color: #adadb8;">${website.description}</div>
                    </div>
                    ${USER_CONFIG[website.key] ? `
                    <div style="width: 20px; height: 20px; background: #9147ff; border-radius: 4px;
                                display: flex; align-items: center; justify-content: center;">
                        <span style="color: white; font-size: 12px; font-weight: bold;">✓</span>
                    </div>
                    ` : ''}
                </label>
            `).join('');
        }

        createGeneralOptions() {
            return `
                <label class="general-option" style="
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    padding: 12px;
                    border-radius: 6px;
                    background: rgba(255, 255, 255, 0.05);
                    cursor: pointer;
                    transition: all 0.2s ease;
                    border: 1px solid transparent;
                ">
                    <input type="checkbox" name="enableAllLinks"
                           ${USER_CONFIG.enableAllLinks ? 'checked' : ''}
                           style="margin: 0; width: 16px; height: 16px;">
                    <div style="flex: 1;">
                        <div style="font-weight: bold; color: ${USER_CONFIG.enableAllLinks ? '#bf94ff' : '#efeff1'};">Embeds pour tous les liens</div>
                        <div style="font-size: 12px; color: #adadb8;">Afficher les embeds pour tous les types de liens</div>
                    </div>
                    ${USER_CONFIG.enableAllLinks ? `
                    <div style="width: 20px; height: 20px; background: #9147ff; border-radius: 4px;
                                display: flex; align-items: center; justify-content: center;">
                        <span style="color: white; font-size: 12px; font-weight: bold;">✓</span>
                    </div>
                    ` : ''}
                </label>
                <label class="general-option" style="
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    padding: 12px;
                    border-radius: 6px;
                    background: rgba(255, 255, 255, 0.05);
                    cursor: pointer;
                    transition: all 0.2s ease;
                    border: 1px solid transparent;
                ">
                    <input type="checkbox" name="enableImages"
                           ${USER_CONFIG.enableImages ? 'checked' : ''}
                           style="margin: 0; width: 16px; height: 16px;">
                    <div style="flex: 1;">
                        <div style="font-weight: bold; color: ${USER_CONFIG.enableImages ? '#bf94ff' : '#efeff1'};">Afficher les images</div>
                        <div style="font-size: 12px; color: #adadb8;">Charger les images dans les embeds</div>
                    </div>
                    ${USER_CONFIG.enableImages ? `
                    <div style="width: 20px; height: 20px; background: #9147ff; border-radius: 4px;
                                display: flex; align-items: center; justify-content: center;">
                        <span style="color: white; font-size: 12px; font-weight: bold;">✓</span>
                    </div>
                    ` : ''}
                </label>
                <label class="general-option" style="
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    padding: 12px;
                    border-radius: 6px;
                    background: rgba(255, 255, 255, 0.05);
                    cursor: pointer;
                    transition: all 0.2s ease;
                    border: 1px solid transparent;
                ">
                    <input type="checkbox" name="enableImageEmbeds"
                           ${USER_CONFIG.enableImageEmbeds ? 'checked' : ''}
                           style="margin: 0; width: 16px; height: 16px;">
                    <div style="flex: 1;">
                        <div style="font-weight: bold; color: ${USER_CONFIG.enableImageEmbeds ? '#bf94ff' : '#efeff1'};">Afficher les images directes</div>
                        <div style="font-size: 12px; color: #adadb8;">Afficher les images .jpg, .png, .gif directement dans le chat</div>
                    </div>
                    ${USER_CONFIG.enableImageEmbeds ? `
                    <div style="width: 20px; height: 20px; background: #9147ff; border-radius: 4px;
                                display: flex; align-items: center; justify-content: center;">
                        <span style="color: white; font-size: 12px; font-weight: bold;">✓</span>
                    </div>
                    ` : ''}
                </label>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                    <div>
                        <label style="display: block; margin-bottom: 5px; font-size: 12px; font-weight: bold; color: #bf94ff;">Largeur max (px)</label>
                        <input type="number" name="maxImageWidth" value="${USER_CONFIG.maxImageWidth}"
                               min="100" max="800" step="10"
                               style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #464648; background: #0e0e10; color: #efeff1;">
                    </div>
                    <div>
                        <label style="display: block; margin-bottom: 5px; font-size: 12px; font-weight: bold; color: #bf94ff;">Hauteur max (px)</label>
                        <input type="number" name="maxImageHeight" value="${USER_CONFIG.maxImageHeight}"
                               min="100" max="600" step="10"
                               style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #464648; background: #0e0e10; color: #efeff1;">
                    </div>
                </div>
                <label class="general-option" style="
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    padding: 12px;
                    border-radius: 6px;
                    background: rgba(255, 255, 255, 0.05);
                    cursor: pointer;
                    transition: all 0.2s ease;
                    border: 1px solid transparent;
                ">
                    <input type="checkbox" name="debugMode"
                           ${USER_CONFIG.debugMode ? 'checked' : ''}
                           style="margin: 0; width: 16px; height: 16px;">
                    <div style="flex: 1;">
                        <div style="font-weight: bold; color: ${USER_CONFIG.debugMode ? '#bf94ff' : '#efeff1'};">Mode Debug</div>
                        <div style="font-size: 12px; color: #adadb8;">Afficher les logs détaillés dans la console</div>
                    </div>
                    ${USER_CONFIG.debugMode ? `
                    <div style="width: 20px; height: 20px; background: #9147ff; border-radius: 4px;
                                display: flex; align-items: center; justify-content: center;">
                        <span style="color: white; font-size: 12px; font-weight: bold;">✓</span>
                    </div>
                    ` : ''}
                </label>
            `;
        }

        setupStyleSelection() {
            if (!this.modal) return;

            const styleOptions = this.modal.querySelectorAll('.style-option');

            styleOptions.forEach(option => {
                option.addEventListener('click', () => {
                    const selectedValue = option.dataset.styleValue;

                    styleOptions.forEach(opt => {
                        opt.style.border = '2px solid #464648';
                        opt.style.background = 'rgba(255, 255, 255, 0.05)';

                        const preview = opt.querySelector('.style-preview');
                        const label = opt.querySelector('.style-label');
                        const checkmark = opt.querySelector('.style-checkmark');

                        if (preview) preview.style.boxShadow = 'none';
                        if (label) label.style.color = '#efeff1';
                        if (checkmark) checkmark.style.display = 'none';

                        const input = opt.querySelector('input[type="radio"]');
                        if (input) input.checked = false;
                    });

                    option.style.border = '2px solid #9147ff';
                    option.style.background = 'rgba(145, 71, 255, 0.15)';

                    const preview = option.querySelector('.style-preview');
                    const label = option.querySelector('.style-label');

                    if (preview) preview.style.boxShadow = '0 0 0 2px #9147ff';
                    if (label) label.style.color = '#bf94ff';

                    let checkmark = option.querySelector('.style-checkmark');
                    if (!checkmark) {
                        checkmark = document.createElement('div');
                        checkmark.className = 'style-checkmark';
                        checkmark.innerHTML = '<span style="color: white; font-size: 12px; font-weight: bold;">✓</span>';
                        checkmark.style.cssText = 'position: absolute; top: 8px; right: 8px; width: 20px; height: 20px; background: #9147ff; border-radius: 50%; display: flex; align-items: center; justify-content: center;';
                        option.appendChild(checkmark);
                    } else {
                        checkmark.style.display = 'flex';
                    }

                    const input = option.querySelector('input[type="radio"]');
                    if (input) input.checked = true;

                    Logger.debug(`Style selectionné: ${selectedValue}`);
                });
            });
        }

        openOptionsModal() {
            if (!this.modal) this.createOptionsModal();
            this.modal.style.display = 'flex';
            this.isOpen = true;
            this.refreshStyleDisplay();
            Logger.info('Options modal opened');
        }

        closeOptionsModal() {
            if (this.modal) {
                this.modal.style.display = 'none';
                this.isOpen = false;
                Logger.info('Options modal closed');
            }
        }

        saveOptions() {
            // Style d'embed
            const embedStyle = this.modal.querySelector('input[name="embedStyle"]:checked')?.value;
            if (embedStyle) {
                USER_CONFIG.embedStyle = embedStyle;
                Storage.set('embedStyle', embedStyle);
            }

            // Plateformes
            const platforms = ['enableYouTube', 'enableDiscord', 'enableTwitch', 'enableSteam'];
            platforms.forEach(platform => {
                USER_CONFIG[platform] = this.modal.querySelector(`input[name="${platform}"]`)?.checked || false;
                Storage.set(platform, USER_CONFIG[platform]);
            });

            // Sites web
            const websites = ['enableGamesPlanet', 'enableKoFi', 'enableEneba', 'enableMeta'];
            websites.forEach(website => {
                USER_CONFIG[website] = this.modal.querySelector(`input[name="${website}"]`)?.checked || false;
                Storage.set(website, USER_CONFIG[website]);
            });

            // Options générales
            USER_CONFIG.enableAllLinks = this.modal.querySelector('input[name="enableAllLinks"]')?.checked || false;
            USER_CONFIG.enableImages = this.modal.querySelector('input[name="enableImages"]')?.checked || false;
            USER_CONFIG.enableImageEmbeds = this.modal.querySelector('input[name="enableImageEmbeds"]')?.checked || false;
            USER_CONFIG.debugMode = this.modal.querySelector('input[name="debugMode"]')?.checked || false;

            // Tailles d'images
            const maxImageWidth = parseInt(this.modal.querySelector('input[name="maxImageWidth"]')?.value) || 300;
            const maxImageHeight = parseInt(this.modal.querySelector('input[name="maxImageHeight"]')?.value) || 200;
            USER_CONFIG.maxImageWidth = Math.max(100, Math.min(800, maxImageWidth));
            USER_CONFIG.maxImageHeight = Math.max(100, Math.min(600, maxImageHeight));

            Storage.set('enableAllLinks', USER_CONFIG.enableAllLinks);
            Storage.set('enableImages', USER_CONFIG.enableImages);
            Storage.set('enableImageEmbeds', USER_CONFIG.enableImageEmbeds);
            Storage.set('debugMode', USER_CONFIG.debugMode);
            Storage.set('maxImageWidth', USER_CONFIG.maxImageWidth);
            Storage.set('maxImageHeight', USER_CONFIG.maxImageHeight);

            // Mettre à jour le mode debug du logger
            Logger.setDebugMode(USER_CONFIG.debugMode);

            this.closeOptionsModal();
            Logger.info('Options saved successfully', USER_CONFIG);

            // Régénérer tous les embeds avec les nouveaux paramètres
            this.regenerateAllEmbeds();

            // Afficher la confirmation
            this.showSaveConfirmation();
        }

        // NOUVELLE MÉTHODE : Régénérer tous les embeds
        async regenerateAllEmbeds() {
            Logger.info('Starting embed regeneration with new settings...');

            if (window.chatManager && window.chatManager.regenerateAllEmbeds) {
                await window.chatManager.regenerateAllEmbeds();
            } else {
                Logger.warn('Chat manager not available for regeneration');
            }
        }

        refreshExistingEmbeds() {
            Logger.info('Refreshing existing embeds with new settings...');

            if (window.chatManager && window.chatManager.refreshExistingEmbeds) {
                window.chatManager.refreshExistingEmbeds();
            }
        }

        showSaveConfirmation() {
            const confirmation = document.createElement('div');
            confirmation.innerHTML = `
                <div style="
                    position: fixed;
                    top: 20px;
                    right: 20px;
                    background: #00b894;
                    color: white;
                    padding: 12px 20px;
                    border-radius: 6px;
                    font-weight: bold;
                    z-index: 10001;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                    animation: slideInRight 0.3s ease;
                ">
                    ✅ Options sauvegardées - Régénération des embeds...
                </div>
            `;

            document.body.appendChild(confirmation);

            if (!document.querySelector('#save-confirmation-styles')) {
                const style = document.createElement('style');
                style.id = 'save-confirmation-styles';
                style.textContent = `
                    @keyframes slideInRight {
                        from {
                            transform: translateX(100%);
                            opacity: 0;
                        }
                        to {
                            transform: translateX(0);
                            opacity: 1;
                        }
                    }
                `;
                document.head.appendChild(style);
            }

            setTimeout(() => {
                confirmation.style.opacity = '0';
                confirmation.style.transition = 'opacity 0.5s ease';
                setTimeout(() => {
                    if (confirmation.parentNode) {
                        confirmation.parentNode.removeChild(confirmation);
                    }
                }, 500);
            }, 3000);
        }

        refreshStyleDisplay() {
            if (!this.modal) return;

            const styleOptions = this.modal.querySelectorAll('.style-option');

            styleOptions.forEach(option => {
                const styleValue = option.dataset.styleValue;
                const isActive = USER_CONFIG.embedStyle === styleValue;

                option.style.border = isActive ? '2px solid #9147ff' : '2px solid #464648';
                option.style.background = isActive ? 'rgba(145, 71, 255, 0.15)' : 'rgba(255, 255, 255, 0.05)';

                const preview = option.querySelector('.style-preview');
                const label = option.querySelector('.style-label');
                const checkmark = option.querySelector('.style-checkmark');
                const input = option.querySelector('input[type="radio"]');

                if (preview) preview.style.boxShadow = isActive ? '0 0 0 2px #9147ff' : 'none';
                if (label) label.style.color = isActive ? '#bf94ff' : '#efeff1';
                if (input) input.checked = isActive;

                if (isActive) {
                    if (!checkmark) {
                        const newCheckmark = document.createElement('div');
                        newCheckmark.className = 'style-checkmark';
                        newCheckmark.innerHTML = '<span style="color: white; font-size: 12px; font-weight: bold;">✓</span>';
                        newCheckmark.style.cssText = 'position: absolute; top: 8px; right: 8px; width: 20px; height: 20px; background: #9147ff; border-radius: 50%; display: flex; align-items: center; justify-content: center;';
                        option.appendChild(newCheckmark);
                    } else {
                        checkmark.style.display = 'flex';
                    }
                } else if (checkmark) {
                    checkmark.style.display = 'none';
                }
            });
        }
    }

    // Injection des styles
    function injectStyles() {
        const styleSheet = document.createElement("style");
        styleSheet.textContent = optimizedStyles;
        document.head.appendChild(styleSheet);
        Logger.info('Styles injected');
    }

    // Initialisation
    function initializeExtension() {
        if (isInitialized) {
            Logger.debug('Extension already initialized');
            return;
        }

        Logger.info('Initializing Twitch Chat Link Embedder Pro v2.5.1...');

        injectStyles();

        // Initialiser le gestionnaire d'options
        const optionsManager = new OptionsManager();
        optionsManager.init();

        // Initialiser le gestionnaire de chat
        window.chatManager = new ChatManager();
        window.chatManager.init();

        isInitialized = true;
        Logger.info('Twitch Chat Link Embedder Pro initialized successfully');
    }

    // Démarrer l'extension
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeExtension);
    } else {
        setTimeout(initializeExtension, 1000);
    }

    // Styles CSS (identique à votre version précédente)
    const optimizedStyles = `
        .coven-embed {
            contain: layout style paint;
            will-change: transform;
            margin: 4px 0;
            border-radius: 12px;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            width: 100% !important;
            max-width: 100% !important;
            min-width: 100% !important;
            box-sizing: border-box !important;
            display: flex !important;
            flex-direction: column;
            float: none !important;
            clear: both !important;
            overflow: hidden;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
        }

        .coven-embed:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
        }

        /* Header avec logo et nom de la plateforme */
        .embed-header {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 12px 16px 8px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }

        .embed-platform-logo {
            width: 20px;
            height: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0.9;
        }

        .embed-platform-name {
            font-size: 0.8em;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            opacity: 0.8;
        }

        .embed-live-badge {
            background: #e91916;
            color: white;
            padding: 4px 8px;
            border-radius: 12px;
            font-size: 0.7em;
            font-weight: bold;
            margin-left: auto;
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.7; }
        }

        /* Corps de l'embed */
        .embed-body {
            display: flex;
            gap: 12px;
            padding: 12px 16px;
            align-items: flex-start;
        }
        .image-embed .embed-body {
  display: flex;
  gap: 12px;
  padding: 12px 16px;
  align-items: flex-start;
  flex-direction: column;
}

        /* Miniatures */
        .embed-thumbnail {
            width: 120px;
            flex-shrink: 0;
            position: relative;
            border-radius: 8px;
            overflow: hidden;
        }

        .embed-thumbnail.squared {
            width: 80px;
            height: 80px;
        }

        .embed-thumbnail img {
            width: 100%;
            height: auto;
            display: block;
            border-radius: 8px;
            transition: transform 0.3s ease;
        }

        .coven-embed:hover .embed-thumbnail img {
            transform: scale(1.05);
        }

        .embed-play-button {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.7);
            border-radius: 50%;
            width: 48px;
            height: 48px;
            display: flex;
            align-items: center;
            justify-content: center;
            backdrop-filter: blur(10px);
            border: 2px solid rgba(255, 255, 255, 0.8);
        }

        /* Contenu */
        .embed-content {
            flex: 1;
            min-width: 0;
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        .embed-content.full-width {
            width: 100%;
        }

        .embed-title {
            font-weight: 700;
            font-size: 0.95em;
            line-height: 1.3;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
            margin: 0;
        }

        .embed-details {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .embed-channel {
            font-size: 0.85em;
            font-weight: 500;
            opacity: 0.9;
        }

        .embed-description {
            font-size: 0.85em;
            line-height: 1.4;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
            opacity: 0.8;
        }

        .embed-stats {
            display: flex;
            gap: 12px;
            flex-wrap: wrap;
        }

        .embed-stat {
            font-size: 0.8em;
            font-weight: 500;
            opacity: 0.8;
        }

        .embed-price {
            font-size: 0.9em;
            font-weight: 700;
            color: #00b894 !important;
        }

        .embed-url, .embed-filename {
            font-size: 0.8em;
            font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
            word-break: break-all;
            opacity: 0.7;
        }

        /* Images */
        .embed-image-container {
            width: 100%;
            display: flex;
            justify-content: center;
            align-items: center;
            border-radius: 8px;
            overflow: hidden;
        }

        .embed-image-container img {
            max-width: 100%;
            height: auto;
            border-radius: 8px;
            cursor: zoom-in;
            transition: transform 0.3s ease;
        }

        .embed-image-container img:hover {
            transform: scale(1.02);
        }

        .image-error {
            font-style: italic;
            opacity: 0.7;
            text-align: center;
            padding: 20px;
        }

        /* Preloader */
        .link-preloader {
            border-radius: 12px;
            padding: 0;
            cursor: pointer;
            transition: all 0.3s ease;
            width: 100% !important;
            max-width: 100% !important;
            min-width: 100% !important;
            box-sizing: border-box !important;
        }

        .preloader-content {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px 16px;
        }

        .preloader-spinner {
            width: 20px;
            height: 20px;
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-top: 2px solid #9147ff;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            flex-shrink: 0;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .preloader-url {
            font-size: 0.85em;
            opacity: 0.7;
            word-break: break-all;
        }

        /* Responsive */
        @media (max-width: 768px) {
            .embed-body {
                flex-direction: column;
                gap: 8px;
            }

            .embed-thumbnail {
                width: 100%;
                max-width: 200px;
                align-self: center;
            }

            .embed-thumbnail.squared {
                width: 80px;
                height: 80px;
                align-self: flex-start;
            }

            .embed-header {
                padding: 10px 12px 6px;
            }

            .embed-platform-logo {
                width: 18px;
                height: 18px;
            }

            .embed-platform-name {
                font-size: 0.75em;
            }
        }

        /* Compatibilité chat Twitch */
        .chat-line__message .coven-embed,
        [data-a-target="chat-line-message"] .coven-embed,
        .twitch-chat .coven-embed,
        .chat-list .coven-embed,
        .chat-scrollable-area__message-container .coven-embed,
        [data-a-target="chat-scrollable-area"] .coven-embed,
        .stream-chat .coven-embed {
            width: 100% !important;
            max-width: 100% !important;
            min-width: 100% !important;
        }

        .chat-line__message,
        [data-a-target="chat-line-message"] {
            width: 100% !important;
            max-width: 100% !important;
        }

        .twitch-chat .chat-line__message,
        [data-a-target="chat-messages"] .chat-line__message {
            min-width: 100% !important;
        }

        [style*="width"] .coven-embed {
            width: 100% !important;
            min-width: 100% !important;
            max-width: 100% !important;
        }

        /* Styles pour le modal d'options */
        .twitch-embed-options-modal * {
            box-sizing: border-box;
        }

        .style-option:hover {
            border-color: #9147ff !important;
            background: rgba(145, 71, 255, 0.1) !important;
            transform: translateY(-2px);
        }

        .platform-option:hover, .general-option:hover, .website-option:hover {
            background: rgba(255, 255, 255, 0.1) !important;
            border-color: #464648 !important;
        }

        .save-btn:hover {
            background: #772ce8 !important;
            transform: translateY(-1px);
        }

        .cancel-btn:hover {
            background: #5c5c5c !important;
            transform: translateY(-1px);
        }

        .close-btn:hover {
            background: rgba(255, 255, 255, 0.1) !important;
            border-radius: 50%;
        }
    `;
})();
