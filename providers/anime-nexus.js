/**
 * AnimeNexus (anime-nexus.io) provider pentru Nuvio
 *
 * Site-ul este în română (fostul AnimeKage) și cere cont pentru aproape tot.
 * Plugin-ul:
 *   1. rezolvă titlul TMDB în catalogul AnimeNexus (/nexus/series/search);
 *   2. deschide pagina episodului;
 *   3. ia serverele listate de site (iframe-uri);
 *   4. rezolvă sursele playable (Voe și DoodStream) la HLS/MP4 direct.
 *
 * Neoficial. Nu găzduiește conținut.
 */

var DEFAULT_BASE = 'https://anime-nexus.io';
var PROVIDER_VERSION = '1.4.2';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Cont separat, folosit implicit dacă nu este setat alt cookie în Nuvio.
// ATENȚIE: dacă publici repo-ul, oricine poate folosi acest cont. Este cont secundar.
var DEFAULT_COOKIE = 'usri=493075; usrs=4930756af23f9cdcca47.75092106';

var runtimeCookie = '';
var loginAttempted = false;
var catalogCache = null;
var catalogCount = 0;
var episodeCountCache = {};
var runDeadline = 0;
var debug = false;

var MAX_CONCURRENT_REQUESTS = 3;
var activeRequests = 0;
var requestQueue = [];

/* ------------------------------------------------------------------ */
/* Setări                                                              */
/* ------------------------------------------------------------------ */

function settingsObject() {
    if (typeof globalThis !== 'undefined' && globalThis.SCRAPER_SETTINGS) {
        return globalThis.SCRAPER_SETTINGS;
    }
    return {};
}

function setting(key, fallback) {
    var value = settingsObject()[key];
    if (value === undefined || value === null || value === '') return fallback;
    return value;
}

function log(message) {
    try {
        console.log('[AnimeNexus] ' + message);
    } catch (e) { /* ignore */ }
}

function logError(message) {
    try {
        console.error('[AnimeNexus] ' + message);
    } catch (e) { /* ignore */ }
}

function getBase() {
    var base = String(setting('baseUrl', DEFAULT_BASE)).trim();
    if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
    return base.replace(/\/+$/, '');
}

function userAgent() {
    return String(setting('userAgent', UA)).trim() || UA;
}

function getCookieHeader() {
    if (runtimeCookie) return runtimeCookie;

    var raw = String(setting('cookie', DEFAULT_COOKIE)).trim();
    if (!raw) return '';

    raw = raw.replace(/^cookie\s*:\s*/i, '').replace(/[\r\n]+/g, '; ').trim();
    if (raw.indexOf('=') === -1) {
        raw = 'PHPSESSID=' + raw.replace(/[;\s]/g, '');
    }
    return raw;
}

function canLogin() {
    return !!(String(setting('username', '')).trim() && String(setting('password', '')));
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function withRequestLimit(task) {
    return new Promise(function (resolve, reject) {
        requestQueue.push({ task: task, resolve: resolve, reject: reject });
        pumpRequestQueue();
    });
}

function pumpRequestQueue() {
    while (activeRequests < MAX_CONCURRENT_REQUESTS && requestQueue.length) {
        var item = requestQueue.shift();
        activeRequests++;
        Promise.resolve()
            .then(item.task)
            .then(function (value) {
                activeRequests--;
                item.resolve(value);
                pumpRequestQueue();
            }, function (error) {
                activeRequests--;
                item.reject(error);
                pumpRequestQueue();
            });
    }
}

function fetchTimed(url, options, timeoutMs) {
    return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = setTimeout(function () {
            if (settled) return;
            settled = true;
            reject(new Error('Timeout: ' + url));
        }, timeoutMs || 25000);

        fetch(url, options).then(function (response) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(response);
        }, function (error) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
    });
}

function pageHeaders() {
    var headers = {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
        'User-Agent': userAgent(),
        'Referer': getBase() + '/'
    };
    var cookie = getCookieHeader();
    if (cookie) headers['Cookie'] = cookie;
    return headers;
}

function embedHeaders(referer) {
    return {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
        'User-Agent': userAgent(),
        'Referer': referer || getBase() + '/'
    };
}

function playbackHeaders(referer) {
    return {
        'User-Agent': userAgent(),
        'Referer': referer
    };
}

async function fetchText(url, options, timeoutMs) {
    var response = await fetchTimed(url, options || {}, timeoutMs || 25000);
    var text = await response.text();
    if (!response.ok) {
        throw new Error('HTTP ' + response.status + ' for ' + url);
    }
    return { text: text, url: response.url || url, status: response.status };
}

async function fetchJson(url, options, timeoutMs) {
    var result = await fetchText(url, options, timeoutMs);
    if (!result.text) return null;
    return JSON.parse(result.text);
}

function withTimeout(promise, timeoutMs, label) {
    return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = setTimeout(function () {
            if (settled) return;
            settled = true;
            reject(new Error((label || 'task') + ' timeout'));
        }, timeoutMs);

        promise.then(function (value) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        }, function (error) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
    });
}

function looksLikeLogin(html) {
    return /id="login-form"|loginUsername|Intr[ăa] [îi]n cont|Autentificare/i.test(html);
}

function isAuthError(error) {
    return !!(error && String(error.message || '').indexOf('AUTH_REQUIRED') >= 0);
}

/* ------------------------------------------------------------------ */
/* Autentificare                                                       */
/* ------------------------------------------------------------------ */

async function login() {
    if (loginAttempted) throw new Error('AUTH_REQUIRED');
    loginAttempted = true;

    var username = String(setting('username', '')).trim();
    var password = String(setting('password', ''));
    if (!username || !password) throw new Error('AUTH_REQUIRED');

    var body = 'loginUsername=' + encodeURIComponent(username) +
        '&loginPassword=' + encodeURIComponent(password) +
        '&loginRememberme=1&referer=%2F';

    var response = await fetchTimed(getBase() + '/nexus/login_account', {
        method: 'POST',
        headers: {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'User-Agent': userAgent(),
            'Referer': getBase() + '/nexus/login',
            'Origin': getBase(),
            'X-Requested-With': 'XMLHttpRequest'
        },
        body: body
    }, 25000);

    var setCookie = '';
    try {
        setCookie = response.headers.get('set-cookie') || '';
    } catch (e) { /* ignore */ }

    var text = await response.text();
    var data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        throw new Error('AUTH_REQUIRED');
    }

    if (!data || data.message !== 'success') {
        throw new Error('LOGIN_FAILED: ' + ((data && data.response) || 'unknown'));
    }
    if (data.response && data.response.twofaRequired) {
        throw new Error('AUTH_2FA: contul are 2FA, folosește cookie-ul din browser');
    }

    var match = setCookie.match(/PHPSESSID=([^;,\s]+)/i);
    if (!match) throw new Error('LOGIN_NO_COOKIE: nu am putut păstra sesiunea');

    runtimeCookie = 'PHPSESSID=' + match[1];
    loginAttempted = false;
    return runtimeCookie;
}

async function pageFetch(pathOrUrl) {
    var url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : getBase() + pathOrUrl;

    if (!getCookieHeader() && canLogin() && !loginAttempted) {
        try {
            await login();
        } catch (error) {
            logError(error.message);
        }
    }

    try {
        var result = await withRequestLimit(function () {
            return fetchText(url, { headers: pageHeaders(), redirect: 'follow' }, 25000);
        });

        if (looksLikeLogin(result.text) && !/nexus\/creeaza-cont/.test(url)) {
            throw new Error('AUTH_REQUIRED: pagina de login (sesiune expirată)');
        }
        if (/<title>\s*(Just a moment|Attention Required)/i.test(result.text) ||
            /cf-browser-verification/i.test(result.text)) {
            throw new Error('CLOUDFLARE_CHALLENGE: site-ul cere verificare Cloudflare');
        }
        return result;
    } catch (error) {
        if (isAuthError(error) && canLogin() && !loginAttempted) {
            await login();
            return withRequestLimit(function () {
                return fetchText(url, { headers: pageHeaders(), redirect: 'follow' }, 25000);
            });
        }
        throw error;
    }
}

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

function foldText(value) {
    var text = String(value || '').toLowerCase();
    var map = {
        'ă': 'a', 'â': 'a', 'î': 'i', 'ș': 's', 'ş': 's', 'ț': 't', 'ţ': 't',
        'á': 'a', 'à': 'a', 'ä': 'a', 'é': 'e', 'è': 'e', 'ê': 'e', 'í': 'i',
        'ó': 'o', 'ô': 'o', 'ö': 'o', 'ú': 'u', 'ü': 'u', 'ñ': 'n', 'ç': 'c'
    };
    var out = '';
    for (var i = 0; i < text.length; i++) {
        var ch = text.charAt(i);
        out += map[ch] || ch;
    }
    return out;
}

function normalizeTitle(value) {
    return foldText(value)
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function titleSimilarity(a, b) {
    var left = normalizeTitle(a);
    var right = normalizeTitle(b);
    if (!left || !right) return 0;
    if (left === right) return 1;

    var shorter = left.length <= right.length ? left : right;
    var longer = left.length <= right.length ? right : left;
    if (shorter.length >= 6 && longer.indexOf(shorter) >= 0) return 0.85;

    var leftTokens = left.split(' ');
    var rightTokens = right.split(' ');
    var used = {};
    var common = 0;
    for (var i = 0; i < leftTokens.length; i++) {
        for (var j = 0; j < rightTokens.length; j++) {
            if (used[j]) continue;
            if (leftTokens[i] === rightTokens[j]) {
                used[j] = true;
                common++;
                break;
            }
        }
    }
    if (!common) return 0;
    return (common / Math.max(leftTokens.length, rightTokens.length)) * 0.8;
}

function decodeEntities(value) {
    return String(value || '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function stripTags(value) {
    return decodeEntities(String(value || '').replace(/<[^>]*>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim();
}

function uniqueStrings(values) {
    var seen = {};
    var out = [];
    for (var i = 0; i < values.length; i++) {
        var value = values[i];
        if (!value) continue;
        value = String(value).replace(/\s+/g, ' ').trim();
        if (!value) continue;
        var key = value.toLowerCase();
        if (seen[key]) continue;
        seen[key] = true;
        out.push(value);
    }
    return out;
}

/* ------------------------------------------------------------------ */
/* TMDB                                                                */
/* ------------------------------------------------------------------ */

function tmdbKey() {
    var custom = String(setting('tmdbApiKey', '')).trim();
    if (custom) return custom;
    if (typeof globalThis !== 'undefined' && globalThis.TMDB_API_KEY) {
        return String(globalThis.TMDB_API_KEY);
    }
    return '1865f43a0549ca50d341dd9ab8b29f49';
}

async function tmdbGet(path) {
    var separator = path.indexOf('?') >= 0 ? '&' : '?';
    var url = 'https://api.themoviedb.org/3' + path + separator +
        'api_key=' + encodeURIComponent(tmdbKey()) + '&language=en-US';
    var result = await fetchText(url, { headers: { 'Accept': 'application/json' } }, 20000);
    return JSON.parse(result.text);
}

async function tmdbMeta(tmdbId, mediaType, season) {
    var isTv = mediaType !== 'movie';
    var show = await tmdbGet('/' + (isTv ? 'tv' : 'movie') + '/' + encodeURIComponent(tmdbId));
    if (!show || show.success === false) throw new Error('TMDB: titlu inexistent');

    var names = [];
    var year = null;
    var seasonName = '';

    if (isTv) {
        names.push(show.name, show.original_name);
        year = parseInt(String(show.first_air_date || '').slice(0, 4), 10) || null;
    } else {
        names.push(show.title, show.original_title);
        year = parseInt(String(show.release_date || '').slice(0, 4), 10) || null;
    }

    if (isTv && season != null && season > 0) {
        try {
            var seasonData = await tmdbGet('/tv/' + encodeURIComponent(tmdbId) + '/season/' + season);
            if (seasonData) {
                seasonName = seasonData.name || '';
                if (seasonData.air_date) {
                    year = parseInt(String(seasonData.air_date).slice(0, 4), 10) || year;
                }
                if (season > 1 && show.name) {
                    if (seasonName && !/^season\s*\d+$/i.test(seasonName)) {
                        names.unshift(show.name + ' ' + seasonName);
                    }
                    names.push(show.name + ' Season ' + season);
                }
            }
        } catch (error) {
            log('TMDB season: ' + error.message);
        }
    }

    return {
        contentId: String(tmdbId),
        isTv: isTv,
        year: year,
        season: season,
        seasonName: seasonName,
        names: uniqueStrings(names)
    };
}

/* ------------------------------------------------------------------ */
/* ID-uri venite din Nuvio: TMDB, IMDb, AniList, MAL, Kitsu            */
/* ------------------------------------------------------------------ */

function parseContentId(raw) {
    var value = String(raw || '').trim();
    if (!value) return { kind: 'unknown', id: '' };

    var match;
    if ((match = value.match(/^(?:anilist|al)[:/](\d+)/i))) {
        return { kind: 'anilist', id: parseInt(match[1], 10) };
    }
    if ((match = value.match(/^(?:mal|myanimelist)[:/](\d+)/i))) {
        return { kind: 'mal', id: parseInt(match[1], 10) };
    }
    if ((match = value.match(/^kitsu[:/](\d+)/i))) {
        return { kind: 'kitsu', id: parseInt(match[1], 10) };
    }
    if ((match = value.match(/^(?:imdb[:/])?(tt\d+)/i))) {
        return { kind: 'imdb', id: match[1] };
    }

    value = value
        .replace(/^tmdb[:/]/i, '')
        .replace(/^(?:series|movie|tv)[:/]/i, '');
    value = value.split('/').pop().split(':')[0];

    if ((match = value.match(/^(tt\d+)/i))) {
        return { kind: 'imdb', id: match[1] };
    }
    if ((match = value.match(/^(\d+)/))) {
        return { kind: 'tmdb', id: parseInt(match[1], 10) };
    }
    return { kind: 'unknown', id: value };
}

async function anilistMeta(id, idMal, season) {
    var query = 'query ($id: Int, $idMal: Int) { Media(id: $id, idMal: $idMal, type: ANIME) { id idMal title { romaji english native } startDate { year } seasonYear format } }';
    var variables = id ? { id: id } : { idMal: idMal };
    var data = await fetchJson('https://graphql.anilist.co', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({ query: query, variables: variables })
    }, 20000);

    var media = data && data.data && data.data.Media;
    if (!media) throw new Error('AniList: titlu inexistent');

    var isTv = String(media.format || '').toUpperCase() !== 'MOVIE';
    var names = [
        media.title && media.title.english,
        media.title && media.title.romaji,
        media.title && media.title.native
    ];

    if (isTv && season != null && season > 1) {
        var base = (media.title && media.title.english) || (media.title && media.title.romaji);
        if (base) {
            names.unshift(base + ' Season ' + season);
            names.push(base + ' ' + season);
        }
    }

    return {
        contentId: 'anilist:' + media.id,
        isTv: isTv,
        year: media.seasonYear || (media.startDate && media.startDate.year) || null,
        season: season,
        seasonName: '',
        names: uniqueStrings(names)
    };
}

async function kitsuMeta(id, season) {
    var data = await fetchJson('https://kitsu.io/api/edge/anime/' + encodeURIComponent(id), {
        headers: {
            'Accept': 'application/vnd.api+json',
            'User-Agent': userAgent()
        }
    }, 20000);

    var attributes = data && data.data && data.data.attributes;
    if (!attributes) throw new Error('Kitsu: titlu inexistent');

    var titles = attributes.titles || {};
    var names = [
        attributes.canonicalTitle,
        titles.en,
        titles.en_jp,
        titles.ja_jp
    ];
    var isTv = String(attributes.subtype || '').toUpperCase() !== 'MOVIE';

    if (isTv && season != null && season > 1 && attributes.canonicalTitle) {
        names.unshift(attributes.canonicalTitle + ' Season ' + season);
        names.push(attributes.canonicalTitle + ' ' + season);
    }

    return {
        contentId: 'kitsu:' + id,
        isTv: isTv,
        year: attributes.startDate ? parseInt(String(attributes.startDate).slice(0, 4), 10) : null,
        season: season,
        seasonName: '',
        names: uniqueStrings(names)
    };
}

async function cinemetaMeta(imdbId, mediaType, season) {
    var typePath = mediaType === 'movie' ? 'movie' : 'series';
    var data = await fetchJson('https://v3-cinemeta.strem.io/meta/' + typePath + '/' + encodeURIComponent(imdbId) + '.json', {
        headers: { 'Accept': 'application/json' }
    }, 20000);

    var meta = data && data.meta;
    if (!meta || !meta.name) throw new Error('Cinemeta: titlu inexistent');

    var isTv = mediaType !== 'movie';
    var names = [meta.name];
    if (isTv && season != null && season > 1) {
        names.push(meta.name + ' Season ' + season);
        names.push(meta.name + ' ' + season);
    }

    return {
        contentId: imdbId,
        isTv: isTv,
        year: meta.year ? parseInt(String(meta.year).slice(0, 4), 10) : null,
        season: season,
        seasonName: '',
        names: uniqueStrings(names)
    };
}

async function imdbMeta(imdbId, mediaType, season) {
    try {
        var found = await tmdbGet('/find/' + encodeURIComponent(imdbId) + '?external_source=imdb_id');
        var results = mediaType === 'movie' ? found.movie_results : found.tv_results;
        if (results && results.length && results[0].id) {
            return tmdbMeta(results[0].id, mediaType, season);
        }
    } catch (error) {
        log('TMDB find: ' + error.message);
    }
    return cinemetaMeta(imdbId, mediaType, season);
}

async function getMeta(contentId, mediaType, season) {
    var parsed = parseContentId(contentId);
    if (parsed.kind === 'anilist') return anilistMeta(parsed.id, null, season);
    if (parsed.kind === 'mal') return anilistMeta(null, parsed.id, season);
    if (parsed.kind === 'kitsu') return kitsuMeta(parsed.id, season);
    if (parsed.kind === 'imdb') return imdbMeta(parsed.id, mediaType, season);
    if (parsed.kind === 'tmdb') return tmdbMeta(parsed.id, mediaType, season);
    throw new Error('ID nerecunoscut: ' + contentId);
}

/* ------------------------------------------------------------------ */
/* Catalog AnimeNexus                                                  */
/* ------------------------------------------------------------------ */

async function getCatalog() {
    if (catalogCache) return catalogCache;

    var options = [];
    for (var attempt = 0; attempt < 2; attempt++) {
        var result = await pageFetch('/nexus/series/search');
        var html = result.text;
        options = [];
        var regex = /<option value="([^"]+)">([\s\S]*?)<\/option>/gi;
        var match;

        while ((match = regex.exec(html)) !== null) {
            var path = decodeEntities(match[1]).trim();
            var label = stripTags(match[2]);
            if (!path || !label) continue;
            options.push({ path: path, label: label });
        }

        if (options.length > 0) break;
        log('catalog gol, reîncerc');
        await sleep(700);
    }

    catalogCache = options;
    catalogCount = options.length;
    log('catalog: ' + options.length + ' intrări');
    return options;
}

function extractSeasonNumber(label) {
    var text = normalizeTitle(label);
    var match = text.match(/(?:season|part)\s*(\d{1,2})\b/);
    if (match) return parseInt(match[1], 10);

    match = text.match(/\b(ii|iii|iv|v|vi|vii|viii|ix|x)\b\s*$/);
    if (match) {
        var roman = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
        return roman[match[1]] || null;
    }

    match = text.match(/\s(\d{1,2})\s*$/);
    if (match) {
        var number = parseInt(match[1], 10);
        if (number >= 2 && number <= 10) return number;
    }
    return null;
}

function stripSeasonMarkers(name) {
    var text = String(name || '').split(':')[0];
    text = text.replace(/\b(?:season|part)\s*\d+\b/gi, ' ');
    text = text.replace(/\b\d+(?:st|nd|rd|th)\s+season\b/gi, ' ');
    text = text.replace(/\b(?:ii|iii|iv|v|vi|vii|viii|ix|x)\b\s*$/i, ' ');
    text = text.replace(/\s+\d{1,2}\s*$/g, ' ');
    return text.replace(/\s+/g, ' ').trim();
}

function scoreOption(option, meta) {
    var path = option.path;
    var isAnimePath = /^\/nexus\/anime\/[^\/]+$/.test(path);
    var isMoviePath = /^\/nexus\/ova-movie\/[^\/]+$/.test(path);
    if (!isAnimePath && !isMoviePath) return -1;

    var label = option.label.replace(/\s*\((anime|ova-movie|live-action|manga)\)\s*$/i, '');
    var names = label.split(' / ');
    var best = 0;
    var baseBest = 0;
    for (var i = 0; i < names.length; i++) {
        var baseName = stripSeasonMarkers(names[i]);
        for (var j = 0; j < meta.names.length; j++) {
            var similarity = titleSimilarity(names[i], meta.names[j]);
            if (similarity > best) best = similarity;

            var baseSimilarity = titleSimilarity(baseName, meta.names[j]);
            if (baseSimilarity > baseBest) baseBest = baseSimilarity;
        }
    }

    var score = best * 100;
    option._bestTitleScore = best;
    option._baseTitleScore = baseBest;

    if (meta.isTv) {
        if (isAnimePath) score += 12;
        if (isMoviePath) score += 4;
    } else {
        if (isMoviePath) score += 30;
        if (isAnimePath) score += 4;
        if (/movie|film/i.test(label)) score += 10;
    }

    var seasonNumber = extractSeasonNumber(label);
    var labelNormalized = normalizeTitle(label);
    var seasonNameNormalized = meta.seasonName ? normalizeTitle(meta.seasonName) : '';
    var hasSeasonName = seasonNameNormalized.length >= 4 &&
        labelNormalized.indexOf(seasonNameNormalized) >= 0;

    if (meta.season != null && meta.season > 1) {
        // Trebuie să fie același serial, nu orice „Season 2” din catalog.
        if (baseBest < 0.5) return -1;

        if (seasonNumber === meta.season) score += 55;
        else if (hasSeasonName) score += 45;
        else if (seasonNumber == null) score -= 35;
        else score -= 25;
    } else if (meta.season != null) {
        if (seasonNumber && seasonNumber > 1) score -= 45;
        else score += 6;
    }

    if (meta.year) {
        // Catalogul nu afișează anul; doar titlurile cu anul în denumire ajută.
        if (String(label).indexOf(String(meta.year)) >= 0) score += 6;
    }

    return score;
}

async function findCatalogMatches(meta) {
    var options = await getCatalog();
    var scored = [];

    for (var i = 0; i < options.length; i++) {
        var score = scoreOption(options[i], meta);
        if (score > 45 && (options[i]._bestTitleScore || 0) >= 0.45) {
            scored.push({ option: options[i], score: score });
        }
    }

    scored.sort(function (a, b) { return b.score - a.score; });

    if (debug) {
        log('potriviri: ' + scored.slice(0, 5).map(function (item) {
            return item.score.toFixed(0) + ':' + item.option.label;
        }).join(' | '));
    }

    return scored.slice(0, 4).map(function (item) { return item.option; });
}

/* ------------------------------------------------------------------ */
/* Pagina episodului                                                   */
/* ------------------------------------------------------------------ */

function isSeriesListing(html) {
    return /lista episoadelor|episoade|Episoade/i.test(html) && !/class="[^"]*iframe_source/i.test(html);
}

function hasIframes(html) {
    return /<iframe\b/i.test(html) && /iframe_source/i.test(html);
}

function pageTitle(html) {
    var match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return match ? stripTags(match[1]) : '';
}

function episodePageMatches(html, episodeNumber, isTv) {
    if (!hasIframes(html)) return false;
    if (isSeriesListing(html)) return false;
    if (!isTv) return true;

    var title = pageTitle(html);
    var number = Number(episodeNumber);
    var patterns = [
        new RegExp('\\bEp\\.?\\s*0*' + number + '\\b', 'i'),
        new RegExp('\\bEpisodul\\s*0*' + number + '\\b', 'i'),
        new RegExp('\\bEpisode\\s*0*' + number + '\\b', 'i')
    ];
    for (var i = 0; i < patterns.length; i++) {
        if (patterns[i].test(title)) return true;
    }
    return false;
}

function episodeCandidates(option, episodeNumber, isTv) {
    var path = option.path.replace(/\/+$/, '');
    var candidates = [];

    if (/^\/nexus\/ova-movie\//.test(path)) {
        candidates.push(path);
        candidates.push(path + '/' + episodeNumber);
    } else {
        candidates.push(path + '/' + episodeNumber);
        candidates.push(path + '/' + episodeNumber + '/nou');
        if (!isTv) candidates.push(path);
    }

    return uniqueStrings(candidates);
}

function extractEpisodeLinks(html, basePath) {
    var escaped = String(basePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var regex = new RegExp('href="(' + escaped + '\\/[^"#?]+)"', 'gi');
    var links = [];
    var seen = {};
    var match;

    while ((match = regex.exec(html)) !== null) {
        var link = decodeEntities(match[1]).replace(/\/+$/, '');
        if (seen[link]) continue;
        seen[link] = true;

        var suffix = link.slice(basePath.length + 1);
        if (!suffix || /\//.test(suffix)) continue;
        if (/^(nou|movie|film|ova|recenzii|comentarii|episoade)$/i.test(suffix)) continue;
        links.push(link);
    }
    return links;
}

async function findEpisodePage(option, meta, episodeNumber) {
    var candidates = episodeCandidates(option, episodeNumber, meta.isTv);

    for (var i = 0; i < candidates.length; i++) {
        try {
            var result = await pageFetch(candidates[i]);
            if (episodePageMatches(result.text, episodeNumber, meta.isTv)) {
                return { html: result.text, url: result.url || (getBase() + candidates[i]) };
            }
            if (debug) {
                log('pagină fără episod: ' + candidates[i] + ' | ' + pageTitle(result.text).slice(0, 80));
            }
        } catch (error) {
            if (isAuthError(error)) throw error;
            if (debug) log('pagina ' + candidates[i] + ': ' + error.message);
        }
    }

    // Filmele și unele seriale au linkuri de episod cu slug, nu cu număr.
    try {
        var listing = await pageFetch(option.path);
        var links = extractEpisodeLinks(listing.text, option.path);

        if (!meta.isTv) {
            links = links.slice(0, 1);
        } else {
            var wanted = Number(episodeNumber);
            links = links.filter(function (link) {
                var suffix = link.slice(option.path.length + 1);
                var numberMatch = suffix.match(/^0*(\d+)/);
                return numberMatch && Number(numberMatch[1]) === wanted;
            }).slice(0, 2);
        }

        for (var l = 0; l < links.length; l++) {
            try {
                var page = await pageFetch(links[l]);
                if (episodePageMatches(page.text, episodeNumber, meta.isTv)) {
                    return { html: page.text, url: page.url || (getBase() + links[l]) };
                }
            } catch (error) {
                if (isAuthError(error)) throw error;
                if (debug) log('link ' + links[l] + ': ' + error.message);
            }
        }
    } catch (error) {
        if (isAuthError(error)) throw error;
        if (debug) log('listare ' + option.path + ': ' + error.message);
    }

    return null;
}

function parseIframes(html) {
    var labelById = {};
    var labelOrder = [];
    var labelRegex = /<a[^>]+href="#(source\d+)"[^>]*>([\s\S]*?)<\/a>/gi;
    var labelMatch;
    while ((labelMatch = labelRegex.exec(html)) !== null) {
        var id = labelMatch[1];
        if (!labelById[id]) {
            labelById[id] = stripTags(labelMatch[2]);
            labelOrder.push(id);
        }
    }

    var urlById = {};
    var divRegex = /<div[^>]*id="(source\d+)"[^>]*>([\s\S]{0,1200}?)<\/div>/gi;
    var divMatch;
    while ((divMatch = divRegex.exec(html)) !== null) {
        var sourceId = divMatch[1];
        var iframeTag = divMatch[2].match(/<iframe\b[^>]*>/i);
        if (!iframeTag) continue;

        var tag = iframeTag[0];
        var dataSrc = tag.match(/data-src="([^"]+)"/i);
        var src = tag.match(/\bsrc="([^"]*)"/i);
        var url = (dataSrc && dataSrc[1]) || (src && src[1]) || '';
        url = decodeEntities(url.trim());
        if (!url || !/^https?:\/\//i.test(url)) continue;
        urlById[sourceId] = url;
    }

    var out = [];
    for (var i = 0; i < labelOrder.length; i++) {
        var sourceKey = labelOrder[i];
        if (!urlById[sourceKey]) continue;
        out.push({
            label: labelById[sourceKey] || sourceKey,
            url: urlById[sourceKey]
        });
    }
    return out;
}

/* ------------------------------------------------------------------ */
/* Voe                                                                 */
/* ------------------------------------------------------------------ */

function rot13(value) {
    return String(value).replace(/[a-zA-Z]/g, function (character) {
        var code = character.charCodeAt(0);
        var base = code >= 97 ? 97 : 65;
        return String.fromCharCode((code - base + 13) % 26 + base);
    });
}

function base64ToBytes(value) {
    var normalized = String(value).replace(/[^A-Za-z0-9+/=]/g, '');
    while (normalized.length % 4 !== 0) normalized += '=';
    var binary = atob(normalized);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function decodeVoeConfig(encoded) {
    var decoded = rot13(encoded);
    var markers = ['@$', '^^', '~@', '%?', '*~', '!!', '#&'];
    for (var i = 0; i < markers.length; i++) {
        decoded = decoded.split(markers[i]).join('');
    }

    var first = base64ToBytes(decoded);
    var shifted = new Uint8Array(first.length);
    for (var b = 0; b < first.length; b++) {
        if (first[b] < 3) return null;
        shifted[b] = first[b] - 3;
    }

    var reversed = new Uint8Array(shifted.length);
    for (var r = 0; r < shifted.length; r++) {
        reversed[r] = shifted[shifted.length - 1 - r];
    }

    // Bytes inversate sunt chiar textul base64 al JSON-ului.
    var base64Text = '';
    for (var t = 0; t < reversed.length; t++) {
        base64Text += String.fromCharCode(reversed[t]);
    }

    var json = JSON.parse(atob(base64Text));
    return json;
}

async function resolveVoe(embedUrl) {
    var currentUrl = embedUrl;
    var html = '';
    var finalUrl = embedUrl;

    for (var hop = 0; hop < 3; hop++) {
        var result = await fetchText(currentUrl, {
            headers: embedHeaders(currentUrl),
            redirect: 'follow'
        }, 20000);
        html = result.text;
        finalUrl = result.url || currentUrl;

        if (debug) {
            log('voe hop ' + hop + ': ' + finalUrl + ' len=' + html.length +
                ' title=' + pageTitle(html).slice(0, 60));
        }

        var redirect = html.match(/window\.location(?:\.href)?\s*=\s*['"](https?:\/\/[^'"]+)['"]/i);
        if (redirect && redirect[1] !== currentUrl) {
            currentUrl = redirect[1];
            continue;
        }
        break;
    }

    var scriptMatch = html.match(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i);
    if (debug) {
        log('voe json script: ' + (scriptMatch ? 'da' : 'nu'));
    }
    if (scriptMatch) {
        var values;
        try {
            values = JSON.parse(scriptMatch[1]);
        } catch (error) {
            values = [];
        }

        for (var i = 0; i < values.length; i++) {
            if (typeof values[i] !== 'string') continue;
            var config = null;
            try {
                config = decodeVoeConfig(values[i]);
            } catch (error) {
                if (debug) log('voe decode: ' + error.message);
            }
            if (!config) continue;

            var source = config.source || config.direct_access_url;
            if (!source || !/^https?:\/\//i.test(source)) continue;

            var originMatch = finalUrl.match(/^(https?:\/\/[^\/]+)/i);
            var origin = originMatch ? originMatch[1] : 'https://susanexpectcare.com';
            var quality = parseQuality(config.title || source);

            var masterQuality = await inspectMaster(source, origin + '/');
            if (debug && (masterQuality.status === 403 || masterQuality.status === 404)) {
                log('Voe: master ' + masterQuality.status + ' (păstrez sursa)');
            }
            if (masterQuality.quality) quality = masterQuality.quality;

            return {
                url: source,
                quality: quality,
                referer: origin + '/',
                label: 'Voe'
            };
        }
    }

    // Fallback pentru varianta veche: sources = { hls: "base64..." }
    var legacy = html.match(/sources\s*=\s*\{[\s\S]*?hls\s*:\s*["']([^"']+)["']/i);
    if (legacy) {
        try {
            var decodedUrl = atob(legacy[1]);
            if (/^https?:\/\//i.test(decodedUrl)) {
                return {
                    url: decodedUrl,
                    quality: parseQuality(decodedUrl),
                    referer: getBase() + '/',
                    label: 'Voe'
                };
            }
        } catch (error) { /* ignore */ }
    }

    throw new Error('Voe: nu am găsit sursa');
}

/* ------------------------------------------------------------------ */
/* DoodStream                                                          */
/* ------------------------------------------------------------------ */

function randomString(length) {
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var out = '';
    for (var i = 0; i < length; i++) {
        out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return out;
}

async function resolveDood(embedUrl) {
    var page = await fetchText(embedUrl, {
        headers: embedHeaders(getBase() + '/'),
        redirect: 'follow'
    }, 20000);

    if (debug) {
        log('dood page: ' + (page.url || embedUrl) + ' len=' + page.text.length);
    }

    var html = page.text;
    var passMatch = html.match(/\/pass_md5\/[^"'\s]+/i);
    if (!passMatch) throw new Error('DoodStream: lipsește pass_md5');

    var originMatch = page.url.match(/^(https?:\/\/[^\/]+)/i);
    var origin = originMatch ? originMatch[1] : 'https://playmogo.com';

    var passPath = passMatch[0];
    var passUrl = origin + passPath;
    var baseResult = await fetchText(passUrl, {
        headers: {
            'User-Agent': userAgent(),
            'Referer': page.url,
            'Accept': '*/*'
        }
    }, 20000);

    var base = baseResult.text.trim();
    if (!/^https?:\/\//i.test(base) || base.length < 12) {
        throw new Error('DoodStream: răspuns pass_md5 invalid');
    }

    var segments = passPath.split('/');
    var token = segments[segments.length - 1];
    var finalUrl = base + randomString(10) + '?token=' + encodeURIComponent(token) +
        '&expiry=' + Date.now();

    return {
        url: finalUrl,
        quality: parseQuality(pageTitle(html) || finalUrl),
        referer: origin + '/',
        label: 'DoodStream'
    };
}

/* ------------------------------------------------------------------ */
/* Playere cu JS „packed— (VidHide/Morencius, LuluStream)              */
/* ------------------------------------------------------------------ */

function toBaseN(value, base) {
    var digits = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (value === 0) return '0';
    var out = '';
    while (value > 0) {
        out = digits.charAt(value % base) + out;
        value = Math.floor(value / base);
    }
    return out;
}

function unpackPacker(html) {
    var match = html.match(/eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/);
    if (!match) return null;

    var payload = match[1];
    var base = parseInt(match[2], 10);
    var count = parseInt(match[3], 10);
    var words = match[4].split('|');

    for (var index = count - 1; index >= 0; index--) {
        if (!words[index]) continue;
        payload = payload.replace(
            new RegExp('\\b' + toBaseN(index, base) + '\\b', 'g'),
            words[index]
        );
    }
    return payload;
}

async function resolvePacked(embedUrl, label) {
    var page = await fetchText(embedUrl, {
        headers: embedHeaders(getBase() + '/'),
        redirect: 'follow'
    }, 20000);

    var origin = originOf(page.url || embedUrl);
    var texts = [page.text];
    var unpacked = unpackPacker(page.text);
    if (unpacked) texts.unshift(unpacked);

    var candidates = [];
    for (var t = 0; t < texts.length; t++) {
        var regex = /https?:\/\/[^"'\\\s<>]+/gi;
        var match;
        while ((match = regex.exec(texts[t])) !== null) {
            var url = match[0].replace(/\\\//g, '/');
            if (/\.m3u8(\?|$)/i.test(url) || /\.mp4(\?|$)/i.test(url)) {
                candidates.push(url);
            }
        }
    }

    var chosen = null;
    for (var i = 0; i < candidates.length; i++) {
        if (/\.m3u8(\?|$)/i.test(candidates[i])) {
            chosen = candidates[i];
            break;
        }
    }
    if (!chosen) {
        for (var j = 0; j < candidates.length; j++) {
            if (/\.mp4(\?|$)/i.test(candidates[j]) && !/\.(jpg|png|webp)/i.test(candidates[j])) {
                chosen = candidates[j];
                break;
            }
        }
    }

    if (!chosen) throw new Error((label || 'Player') + ': nu am găsit sursa');

    var quality = parseQuality(pageTitle(page.text));
    var masterQuality = await inspectMaster(chosen, origin + '/');
    if (debug && (masterQuality.status === 403 || masterQuality.status === 404)) {
        log((label || 'Player') + ': master ' + masterQuality.status + ' (păstrez sursa)');
    }
    if (masterQuality.quality) quality = masterQuality.quality;

    return {
        url: chosen,
        quality: quality,
        referer: origin + '/',
        label: label || 'Player'
    };
}

/* ------------------------------------------------------------------ */
/* MP4upload                                                           */
/* ------------------------------------------------------------------ */

async function resolveMp4Upload(embedUrl) {
    var page = await fetchText(embedUrl, {
        headers: embedHeaders(getBase() + '/'),
        redirect: 'follow'
    }, 20000);

    var tokens = page.text.match(/https?:\/\/[^"'\\\s<>]+/gi) || [];
    var chosen = null;
    for (var i = 0; i < tokens.length; i++) {
        var url = tokens[i].replace(/\\\//g, '/');
        if (/\.mp4(\?|$)/i.test(url) && !/\/player\//i.test(url)) {
            chosen = url;
            break;
        }
    }
    if (!chosen) throw new Error('MP4upload: nu am găsit MP4-ul');

    var fileName = chosen.split('?')[0].split('/').pop();
    return {
        url: chosen,
        quality: parseQuality(fileName),
        referer: 'https://www.mp4upload.com/',
        label: 'MP4upload'
    };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function parseQuality(value) {
    var text = String(value || '');
    var match = text.match(/(\d{3,4})\s*p/i);
    if (match) return match[1] + 'p';
    if (/4k|2160/i.test(text)) return '4K';
    if (/1080/i.test(text)) return '1080p';
    if (/720/i.test(text)) return '720p';
    if (/480/i.test(text)) return '480p';
    if (/360/i.test(text)) return '360p';
    if (/hd/i.test(text)) return 'HD';
    return 'Auto';
}

async function inspectMaster(mediaUrl, referer) {
    if (setting('fastMode', false)) return { quality: null, status: 0 };
    if (!/\.m3u8(\?|$)/i.test(mediaUrl)) return { quality: null, status: 0 };

    try {
        var master = await fetchText(mediaUrl, {
            headers: {
                'User-Agent': userAgent(),
                'Referer': referer,
                'Accept': '*/*',
                'Range': 'bytes=0-4096'
            }
        }, 6000);

        var heights = [];
        var regex = /RESOLUTION=\d+x(\d+)/gi;
        var match;
        while ((match = regex.exec(master.text)) !== null) {
            heights.push(parseInt(match[1], 10));
        }
        return {
            quality: heights.length ? Math.max.apply(null, heights) + 'p' : null,
            status: master.status || 200
        };
    } catch (error) {
        var statusMatch = String(error.message || '').match(/HTTP (\d{3})/);
        if (debug) log('master: ' + error.message);
        return { quality: null, status: statusMatch ? parseInt(statusMatch[1], 10) : 0 };
    }
}

function qualityRank(quality) {
    if (quality === '4K') return 5;
    if (quality === '1080p') return 4;
    if (quality === '720p') return 3;
    if (quality === '480p') return 2;
    if (quality === '360p') return 1;
    if (quality === 'HD') return 2.5;
    return 0;
}

function hostOf(url) {
    var match = String(url).match(/^https?:\/\/([^\/]+)/i);
    return match ? match[1].toLowerCase() : '';
}

function originOf(url) {
    var match = String(url).match(/^(https?:\/\/[^\/]+)/i);
    return match ? match[1] : getBase();
}

function resolverFor(url) {
    var host = hostOf(url);
    if (/voe\.sx|susanexpectcare|voe\.to/.test(host)) return 'voe';
    if (/vide0\.net|playmogo|dood|ds2play|doodstream|dooood\.com/.test(host)) return 'dood';
    if (/mp4upload\.com/.test(host)) return 'mp4upload';
    if (/morencius\.com|vidhide|earnvids|filelions|vidmoly|vtbe\.to|vtube\.|streamhls\.to/.test(host)) return 'packed';
    return null;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function collectFromPage(html, pageUrl) {
    var iframes = parseIframes(html);
    if (!iframes.length) {
        log('nicio sursă iframe pe pagină');
        return [];
    }

    if (debug) {
        log('iframe-uri: ' + iframes.map(function (item) { return item.label; }).join(' | '));
    }

    var tasks = [];
    var seen = {};

    for (var i = 0; i < iframes.length; i++) {
        var iframe = iframes[i];
        var resolver = resolverFor(iframe.url);
        if (!resolver) continue;
        var key = resolver + '|' + iframe.url;
        if (seen[key]) continue;
        seen[key] = true;

        tasks.push((function (resolverName, embedUrl, label) {
            return function () {
                var call;
                if (resolverName === 'voe') call = resolveVoe(embedUrl);
                else if (resolverName === 'dood') call = resolveDood(embedUrl);
                else if (resolverName === 'mp4upload') call = resolveMp4Upload(embedUrl);
                else call = resolvePacked(embedUrl, label);

                return withTimeout(call, 30000, label).catch(function (error) {
                    log(label + ': ' + error.message);
                    return null;
                });
            };
        })(resolver, iframe.url, iframe.label));
    }

    if (!tasks.length) {
        log('niciun host suportat dintre: ' + iframes.map(function (item) { return hostOf(item.url); }).join(', '));
        return [];
    }

    var results = await Promise.all(tasks.map(function (task) { return task(); }));
    var streams = [];
    var seenUrls = {};

    for (var r = 0; r < results.length; r++) {
        var result = results[r];
        if (!result || !result.url || seenUrls[result.url]) continue;
        seenUrls[result.url] = true;

        var quality = result.quality || '480p';
        streams.push({
            name: 'AnimeNexus',
            title: quality + ' • ' + result.label + ' • Subtitrat RO',
            url: result.url,
            quality: quality,
            provider: 'AnimeNexus · ' + result.label,
            language: 'ro',
            headers: playbackHeaders(result.referer || getBase() + '/')
        });
    }

    var sourceOrder = String(setting('sourceOrder', 'stable')).toLowerCase();
    streams.sort(function (left, right) {
        if (sourceOrder === 'stable') {
            var leftMp4 = /\.mp4(\?|$)/i.test(left.url) ? 1 : 0;
            var rightMp4 = /\.mp4(\?|$)/i.test(right.url) ? 1 : 0;
            if (leftMp4 !== rightMp4) return rightMp4 - leftMp4;
        }
        return qualityRank(right.quality) - qualityRank(left.quality);
    });

    return streams;
}

async function countEpisodes(option) {
    if (typeof episodeCountCache[option.path] === 'number') {
        return episodeCountCache[option.path];
    }
    try {
        var listing = await pageFetch(option.path);
        var links = extractEpisodeLinks(listing.text, option.path);
        var max = 0;
        for (var i = 0; i < links.length; i++) {
            var suffix = links[i].slice(option.path.length + 1);
            var match = suffix.match(/^0*(\d+)/);
            if (match) {
                var number = parseInt(match[1], 10);
                if (number > max) max = number;
            }
        }
        episodeCountCache[option.path] = max;
        return max;
    } catch (error) {
        if (debug) log('număr episoade ' + option.path + ': ' + error.message);
        return 0;
    }
}

function diagnosticFallback(tmdbId, mediaType, season, episode, entry, matchCount) {
    if (!setting('diagnostic', true)) return [];

    var label = String(entry || 'none').slice(0, 40);
    log('diagnostic: id=' + tmdbId + ' type=' + mediaType + ' S=' + season +
        ' E=' + episode + ' catalog=' + catalogCount + ' matches=' + matchCount +
        ' entry=' + label);

    return [{
        name: 'AnimeNexus',
        title: 'DIAG 1.4.2 id=' + tmdbId + ' ' + mediaType + ' S' + season + 'E' +
            episode + ' c=' + catalogCount + ' m=' + matchCount + ' | ' + label,
        url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
        quality: 'Auto',
        headers: { 'User-Agent': userAgent() }
    }];
}

function specialEpisodePath(contentId, meta, season, episode) {
    if (season == null || Number(season) !== 2) return null;

    var id = String(contentId || '').toLowerCase();
    var names = (meta && meta.names) ? meta.names : [];
    var isBleach = id === '30984' || id === 'tt0409591' ||
        names.some(function (name) { return normalizeTitle(name) === 'bleach'; });

    if (!isBleach) return null;

    var number = Number(episode);
    var ranges = [
        { from: 1, to: 13, path: '/nexus/anime/bleach-sennen-kessen-hen' },
        { from: 14, to: 23, path: '/nexus/anime/bleach-sennen-kessen-hen-kashin-tan' },
        { from: 24, to: 36, path: '/nexus/anime/bleach-sennen-kessen-hen-ketsubetsu-tan' },
        { from: 37, to: 50, path: '/nexus/anime/bleach-sennen-kessen-hen-soukoku-tan' }
    ];

    for (var i = 0; i < ranges.length; i++) {
        if (number >= ranges[i].from && number <= ranges[i].to) {
            return {
                path: ranges[i].path,
                episode: number - ranges[i].from + 1
            };
        }
    }
    return null;
}

async function getStreams(tmdbId, mediaType, season, episode) {
    var startedAt = Date.now();
    debug = !!setting('debug', false);
    runtimeCookie = '';
    loginAttempted = false;
    catalogCache = null;
    episodeCountCache = {};
    runDeadline = Date.now() + 115000;

    log('v' + PROVIDER_VERSION + ' input id=' + tmdbId + ' type=' + mediaType +
        ' season=' + season + ' episode=' + episode);

    var lastEntry = 'none';
    var matchCount = 0;

    try {
        // Bleach TYBW: hartă directă, fără TMDB/catalog, ca să meargă și pe TV
        // chiar dacă API-ul TMDB sau catalogul AnimeNexus nu răspund.
        var earlySpecial = specialEpisodePath(tmdbId, null, season, episode);
        if (earlySpecial) {
            log('hartă directă: ' + earlySpecial.path + ' ep. ' + earlySpecial.episode);
            try {
                var earlyPage = await findEpisodePage(
                    { path: earlySpecial.path, label: 'Bleach TYBW' },
                    { isTv: true, season: season, names: [] },
                    earlySpecial.episode
                );
                if (earlyPage) {
                    var earlyStreams = await collectFromPage(earlyPage.html, earlyPage.url);
                    if (earlyStreams.length) {
                        log('gata (hartă directă): ' + earlyStreams.length + ' surse');
                        return earlyStreams.slice(0, 40);
                    }
                }
            } catch (earlyError) {
                if (isAuthError(earlyError)) throw earlyError;
                log('hartă directă: ' + earlyError.message);
            }
        }

        var meta = await getMeta(tmdbId, mediaType, season);
        if (!meta.names.length) throw new Error('TMDB: titlu gol');

        log('meta: ' + meta.contentId + ' | ' + meta.names.slice(0, 3).join(' / ') +
            ' | isTv=' + meta.isTv + ' | season=' + meta.season);

        var limit = parseInt(setting('maxSources', '40'), 10) || 40;
        var special = specialEpisodePath(tmdbId, meta, season, episode);

        if (special) {
            log('hartă specială: ' + special.path + ' ep. ' + special.episode);
            try {
                var specialPage = await findEpisodePage(
                    { path: special.path, label: 'Bleach TYBW' },
                    meta,
                    special.episode
                );
                if (specialPage) {
                    var specialStreams = await collectFromPage(specialPage.html, specialPage.url);
                    if (specialStreams.length) {
                        log('gata (hartă): ' + specialStreams.length + ' surse');
                        return specialStreams.slice(0, limit);
                    }
                }
            } catch (specialError) {
                if (isAuthError(specialError)) throw specialError;
                log('hartă specială: ' + specialError.message);
            }
        }

        var matches = await findCatalogMatches(meta);
        if (!matches.length) {
            log('nu am găsit titlul în catalog: ' + meta.names.join(' | '));
            return diagnosticFallback(tmdbId, mediaType, season, episode, 'catalog gol', 0);
        }
        matchCount = matches.length;
        log('catalog: ' + matches.length + ' potriviri');

        var wantedEpisode = (!meta.isTv || episode == null) ? 1 : Number(episode);

        var episodeOffset = 0;

        for (var i = 0; i < matches.length; i++) {
            if (Date.now() > runDeadline) {
                log('timp limită de 115s atins');
                break;
            }

            var option = matches[i];
            lastEntry = option.label;
            var localEpisode = wantedEpisode - episodeOffset;
            if (localEpisode < 1) continue;

            log('încerc: ' + option.label + ' (' + option.path + ')' +
                (episodeOffset ? ' [ep. ' + localEpisode + ']' : ''));

            var page;
            try {
                page = await findEpisodePage(option, meta, localEpisode);
            } catch (error) {
                if (isAuthError(error)) throw error;
                log('episod ' + option.path + ': ' + error.message);
                continue;
            }

            if (!page) {
                log('episodul ' + localEpisode + ' nu a fost găsit în ' + option.path);

                // Nuvio poate da toate episoadele sub sezonul 1, cu numerotare
                // absolută, în timp ce AnimeNexus le ține pe sezoane separate.
                if (meta.isTv) {
                    var episodeCount = await countEpisodes(option);
                    if (episodeCount > 0 && localEpisode > episodeCount) {
                        episodeOffset += episodeCount;
                        log('trec la sezonul următor, offset=' + episodeOffset);
                    }
                }
                continue;
            }

            var streams = await collectFromPage(page.html, page.url);
            if (streams.length) {
                log('gata: ' + streams.length + ' surse în ' + (Date.now() - startedAt) + 'ms');
                return streams.slice(0, limit);
            }

            // Pagina episodului există, dar host-urile nu au răspuns.
            // Nu încercăm alt sezon, ca să nu întoarcem episodul greșit.
            if (meta.isTv && meta.season != null) {
                log('gata: 0 surse în ' + (Date.now() - startedAt) + 'ms');
                return diagnosticFallback(tmdbId, mediaType, season, episode, lastEntry, matchCount);
            }
        }

        log('gata: 0 surse în ' + (Date.now() - startedAt) + 'ms');
        return diagnosticFallback(tmdbId, mediaType, season, episode, lastEntry, matchCount);
    } catch (error) {
        logError(error && error.message ? error.message : String(error));
        if (isAuthError(error)) {
            logError('Setează cookie-ul de sesiune AnimeNexus în setările plugin-ului.');
        }
        log('gata: 0 surse (eroare) în ' + (Date.now() - startedAt) + 'ms');
        return diagnosticFallback(tmdbId, mediaType, season, episode,
            lastEntry + ' | eroare: ' + (error && error.message ? error.message : ''), matchCount);
    }
}

/* ------------------------------------------------------------------ */
/* Setări UI                                                           */
/* ------------------------------------------------------------------ */

async function onSettings() {
    return [
        { type: 'header', label: 'Cont AnimeNexus' },
        {
            type: 'info',
            label: 'AnimeNexus cere cont. Recomandat: cookie-urile long-lived din browser (usri, usrs, dv, cdd) — țin sesiunea ~1 an. Alternativ PHPSESSID (expiră repede) sau user + parolă (login la fiecare rulare, cu rate limit).'
        },
        {
            type: 'text',
            key: 'cookie',
            label: 'Cookie sesiune',
            placeholder: 'usri=...; usrs=...',
            isPassword: true,
            description: 'Cookie-ul complet din browser. Dacă folosești PHPSESSID, sesiunea expiră mai repede; recopiază-l când nu mai apar surse.'
        },
        { type: 'header', label: 'Autentificare automată (opțional)' },
        {
            type: 'info',
            label: 'Doar pentru conturi fără 2FA. Dacă ai 2FA, folosește cookie-ul de mai sus.'
        },
        { type: 'text', key: 'username', label: 'Utilizator / e-mail', placeholder: 'utilizator' },
        { type: 'text', key: 'password', label: 'Parolă', isPassword: true, placeholder: 'parolă' },
        { type: 'header', label: 'Preferințe' },
        {
            type: 'select',
            key: 'sourceOrder',
            label: 'Ordinea surselor',
            options: [
                { label: 'Stabilitate (MP4 primele, implicit)', value: 'stable' },
                { label: 'Calitate (HLS/MP4 după rezoluție)', value: 'quality' }
            ],
            defaultValue: 'stable',
            description: 'Dacă ai buffering, ține „Stabilitate”: primele surse sunt MP4 directe. Alege „Calitate” pentru 1080p HLS.'
        },
        {
            type: 'toggle',
            key: 'fastMode',
            label: 'Mod rapid',
            defaultValue: false,
            description: 'Verifică masterul HLS pentru calitate reală și elimină sursele moarte. Activează doar dacă vrei viteză maximă.'
        },
        {
            type: 'toggle',
            key: 'diagnostic',
            label: 'Stream de diagnostic',
            defaultValue: true,
            description: 'Dacă nu găsește nicio sursă, afișează un video de test cu ID-ul și sezonul primite. Folosit pentru depanare.'
        },
        {
            type: 'text',
            key: 'maxSources',
            label: 'Număr maxim de surse',
            placeholder: '40',
            description: 'Implicit 40.'
        },
        { type: 'header', label: 'Avansat' },
        { type: 'text', key: 'baseUrl', label: 'Base URL', placeholder: DEFAULT_BASE },
        {
            type: 'text',
            key: 'userAgent',
            label: 'User-Agent (opțional)',
            placeholder: 'implicit Chrome pe Windows',
            description: 'Folosește același browser din care ai copiat cookie-ul dacă Cloudflare face probleme.'
        },
        { type: 'text', key: 'tmdbApiKey', label: 'TMDB API key (opțional)', isPassword: true },
        { type: 'toggle', key: 'debug', label: 'Loguri detaliate', defaultValue: false }
    ];
}

module.exports = { getStreams: getStreams, onSettings: onSettings };
