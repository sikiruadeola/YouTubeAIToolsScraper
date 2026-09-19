/**
 * youtube.js
 *
 * Everything that talks to YouTube lives here.
 *
 * Two different doors are used, and it matters that you understand why.
 *
 * Door one is the official YouTube Data API. It is Google's own front door.
 * It gives you the channel title, the full description text, subscriber
 * count, video count and the handle. It never shows a captcha because you
 * are an authenticated caller with a key. This is where almost all of the
 * value comes from.
 *
 * Door two is the plain public About page HTML. The API does not return the
 * list of outbound links a creator pins to their channel, so we read that
 * list off the page itself. YouTube wraps every outbound link through a
 * redirect URL that carries the real destination in a query parameter, so we
 * simply read those out. This is public page text with no gate on it.
 *
 * What this file deliberately does not do: it does not touch the email reveal
 * button, and it does not attempt the challenge behind it.
 */

import { gotScraping } from 'crawlee';
import { log } from 'crawlee';

const API_ROOT = 'https://www.googleapis.com/youtube/v3';

/**
 * Keys that have returned quotaExceeded already this run. Shared across
 * every call so once a key is known to be spent, nothing tries it again.
 */
const exhaustedKeys = new Set();

/**
 * Small helper around the Data API.
 *
 * apiKeyOrKeys can be a single key string, kept for anyone still passing the
 * old single key input, or an array of keys, which lets one run stretch
 * across several separate daily quotas by moving to the next key the moment
 * one comes back quota exceeded.
 *
 * Throws a readable error only once every single key has been tried and
 * failed, because the raw Google error is easy to misread.
 */
async function apiGet(endpoint, params, apiKeyOrKeys) {
    const keys = Array.isArray(apiKeyOrKeys) ? apiKeyOrKeys : [apiKeyOrKeys];
    const usableKeys = keys.filter((k) => k && !exhaustedKeys.has(k));

    if (usableKeys.length === 0) {
        throw new Error('Every YouTube API key provided has run out of quota for today. It resets at midnight Pacific time.');
    }

    let lastMessage = '';

    for (const apiKey of usableKeys) {
        const url = new URL(`${API_ROOT}/${endpoint}`);
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
        }
        url.searchParams.set('key', apiKey);

        const response = await fetch(url.toString());
        const body = await response.json().catch(() => ({}));

        if (response.ok) return body;

        const reason = body?.error?.errors?.[0]?.reason || 'unknown';
        const message = body?.error?.message || response.statusText;

        if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
            log.info(`A key ending in ...${apiKey.slice(-6)} ran out of quota for today. Moving to the next one.`);
            exhaustedKeys.add(apiKey);
            lastMessage = 'quota exceeded';
            continue;
        }
        if (reason === 'keyInvalid' || response.status === 400) {
            log.warning(`A key ending in ...${apiKey.slice(-6)} was rejected: ${message}`);
            exhaustedKeys.add(apiKey);
            lastMessage = message;
            continue;
        }

        throw new Error(`YouTube API error (${response.status}, ${reason}): ${message}`);
    }

    throw new Error(`Every remaining YouTube API key failed. Last reason: ${lastMessage}`);
}

/**
 * Turn an @handle into a channel id.
 * Costs 1 quota unit per handle.
 */
export async function resolveHandle(handle, apiKey) {
    const clean = handle.trim().replace(/^@/, '');
    const data = await apiGet('channels', {
        part: 'id',
        forHandle: `@${clean}`,
    }, apiKey);

    const id = data?.items?.[0]?.id || null;
    if (!id) log.warning(`Could not resolve handle @${clean} to a channel id.`);
    return id;
}

/**
 * Fetch full details for up to 50 channel ids in one call.
 * Costs 1 quota unit per call, not per channel. This is the cheap path.
 */
export async function fetchChannels(channelIds, apiKey) {
    const out = [];

    for (let i = 0; i < channelIds.length; i += 50) {
        const batch = channelIds.slice(i, i + 50);
        const data = await apiGet('channels', {
            part: 'snippet,statistics,brandingSettings',
            id: batch.join(','),
            maxResults: 50,
        }, apiKey);

        for (const item of data.items || []) {
            out.push({
                channelId: item.id,
                title: item.snippet?.title || null,
                handle: item.snippet?.customUrl || null,
                country: item.snippet?.country || null,
                publishedAt: item.snippet?.publishedAt || null,
                description: pickLonger(
                    item.snippet?.description,
                    item.brandingSettings?.channel?.description,
                ),
                keywords: item.brandingSettings?.channel?.keywords || null,
                subscribers: toNumber(item.statistics?.subscriberCount),
                videoCount: toNumber(item.statistics?.videoCount),
                viewCount: toNumber(item.statistics?.viewCount),
                channelUrl: `https://www.youtube.com/channel/${item.id}`,
            });
        }
    }

    return out;
}

/**
 * Find channels by keyword.
 *
 * Read this carefully before you use it: search costs 100 quota units per
 * call, against a free daily budget of 10000 per key. Fetching channel
 * details costs 1 unit per batch of 50, so the details are effectively free
 * and the search is the expensive part.
 */
export async function searchChannels(query, maxResults, apiKey) {
    const ids = [];
    let pageToken;

    while (ids.length < maxResults) {
        const data = await apiGet('search', {
            part: 'snippet',
            q: query,
            type: 'channel',
            maxResults: Math.min(50, maxResults - ids.length),
            pageToken,
        }, apiKey);

        for (const item of data.items || []) {
            const id = item?.snippet?.channelId || item?.id?.channelId;
            if (id) ids.push(id);
        }

        pageToken = data.nextPageToken;
        if (!pageToken) break;
    }

    return [...new Set(ids)];
}

/**
 * Read the outbound links a creator pinned to their channel.
 *
 * YouTube routes every one of these through a redirect URL shaped like
 * https://www.youtube.com/redirect?q=<encoded real destination>
 * so we pull the q parameter out of the raw HTML. That approach survives
 * layout changes, which a CSS selector would not.
 *
 * @param {string} channelId
 * @param {object} proxyUrlOrNull  optional proxy url string
 */
export async function fetchChannelLinks(channelId, proxyUrl) {
    const url = `https://www.youtube.com/channel/${channelId}/about`;

    try {
        const response = await gotScraping({
            url,
            proxyUrl: proxyUrl || undefined,
            timeout: { request: 30000 },
            headerGeneratorOptions: {
                browsers: ['chrome'],
                devices: ['desktop'],
                locales: ['en-US'],
            },
        });

        const html = response.body || '';
        const links = new Set();

        const redirectPattern = /\/redirect\?[^"'\\]*?q=([^"'&\\]+)/gi;
        let match;
        while ((match = redirectPattern.exec(html)) !== null) {
            const decoded = safeDecode(match[1]);
            if (decoded && /^https?:\/\//i.test(decoded)) links.add(decoded);
        }

        const plainPattern = /"(https?:\/\/(?!(?:www\.)?(?:youtube|youtu|ytimg|google|gstatic)\.)[^"\\\s]{6,200})"/gi;
        while ((match = plainPattern.exec(html)) !== null) {
            links.add(match[1]);
        }

        return cleanLinks([...links]);
    } catch (error) {
        log.warning(`Could not read the About page for ${channelId}: ${error.message}`);
        return [];
    }
}

/* ------------------------- small helpers ------------------------- */

function safeDecode(value) {
    try {
        return decodeURIComponent(value.replace(/\+/g, ' ')).trim();
    } catch {
        return null;
    }
}

function toNumber(value) {
    if (value === undefined || value === null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function pickLonger(a, b) {
    const first = (a || '').trim();
    const second = (b || '').trim();
    return second.length > first.length ? second : first;
}

function cleanLinks(urls) {
    const skipHosts = [
        'youtube.com', 'youtu.be', 'google.com', 'gstatic.com', 'ytimg.com',
        'schema.org', 'w3.org', 'accounts.google.com', 'policies.google.com',
        'support.google.com', 'fonts.googleapis.com', 'play.google.com',
    ];

    const out = new Map();

    for (const raw of urls) {
        let parsed;
        try {
            parsed = new URL(raw);
        } catch {
            continue;
        }

        const host = parsed.hostname.replace(/^www\./, '');
        if (skipHosts.some((h) => host === h || host.endsWith(`.${h}`))) continue;

        parsed.hash = '';
        for (const p of [...parsed.searchParams.keys()]) {
            if (/^(utm_|fbclid|gclid|ref|si$)/i.test(p)) parsed.searchParams.delete(p);
        }

        const key = `${host}${parsed.pathname}`;
        if (!out.has(key)) out.set(key, parsed.toString());
    }

    return [...out.values()];
}

/**
 * Split discovered links into two buckets.
 *
 * ownSites are places likely to hold a contact page and are worth crawling.
 * socialProfiles are worth recording but not worth crawling for emails,
 * because those platforms hide contact details behind their own logins.
 */
export function splitLinks(urls) {
    const socialHosts = [
        'twitter.com', 'x.com', 'instagram.com', 'facebook.com', 'tiktok.com',
        'linkedin.com', 'threads.net', 'reddit.com', 'discord.gg', 'discord.com',
        'patreon.com', 'twitch.tv', 'spotify.com', 'apple.com', 'amazon.com',
        'linktr.ee', 'beacons.ai', 'bio.link', 'carrd.co', 'substack.com',
        'medium.com', 'github.com', 'pinterest.com', 'snapchat.com', 'telegram.me',
        't.me', 'whatsapp.com', 'paypal.com', 'buymeacoffee.com', 'ko-fi.com',
    ];

    const ownSites = [];
    const socialProfiles = [];

    for (const url of urls) {
        let host;
        try {
            host = new URL(url).hostname.replace(/^www\./, '');
        } catch {
            continue;
        }

        const isAggregator = ['linktr.ee', 'beacons.ai', 'bio.link', 'carrd.co'].some(
            (h) => host === h || host.endsWith(`.${h}`),
        );

        if (isAggregator) {
            ownSites.push(url);
        } else if (socialHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
            socialProfiles.push(url);
        } else {
            ownSites.push(url);
        }
    }

    return { ownSites, socialProfiles };
}
