/**
 * main.js
 *
 * WHAT THIS ACTOR DOES
 *
 * It collects publicly published business contact addresses for YouTube
 * creators, using only sources that are already open to anyone with a
 * browser and no challenge in front of them:
 *
 *   1. The channel description text, read through the official YouTube Data
 *      API. A large share of creators who aim at business viewers write
 *      their address straight into that text.
 *   2. The outbound links pinned to the channel, read off the public About
 *      page HTML.
 *   3. The creator's own website, where the contact page, about page and
 *      footer usually carry the same address with no gate at all.
 *
 * WHAT IT DOES NOT DO, ON PURPOSE
 *
 * It does not press the email reveal button on the About page, and it does
 * not attempt the challenge sitting behind that button. That control exists
 * specifically to stop bulk collection, and routing around it is both the
 * fastest way to get a channel and a sending domain burned, and a direct
 * breach of the terms you agreed to. Everything below reaches the same
 * addresses through the front door instead, which is why it keeps working.
 *
 * TYPICAL RESULT
 *
 * Expect a usable address for somewhere between thirty and sixty percent of
 * channels. Business and software focused channels sit at the top of that
 * range because those creators want to be reachable. Entertainment channels
 * sit at the bottom.
 */

import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';
import { extractEmails, extractUrls, rankEmails } from './emailFinder.js';
import { resolveHandle, fetchChannels, searchChannels, fetchChannelLinks, splitLinks } from './youtube.js';

await Actor.init();

/* ================================================================== */
/* STEP 0. Read and sanity check the input.                            */
/* ================================================================== */

const input = (await Actor.getInput()) || {};

const {
    youtubeApiKey,
    apiKeys: apiKeysInput,
    channelHandles = [],
    channelIds = [],
    channelUrls = [],
    searchQueries = [],
    maxChannelsPerQuery = 25,
    readChannelLinks = true,
    crawlCreatorSites = true,
    maxPagesPerSite = 6,
    minimumScore = 0,
    minSubscribers,
    maxSubscribers,
    useApifyProxy = true,
    requestDelayMs = 1200,
} = input;

// Accept either the newer apiKeys list or the older single youtubeApiKey
// field, so nothing that already used this actor breaks.
const youtubeApiKeys = [
    ...(Array.isArray(apiKeysInput) ? apiKeysInput : []),
    ...(youtubeApiKey ? [youtubeApiKey] : []),
].filter(Boolean);

if (youtubeApiKeys.length === 0) {
    throw new Error(
        'No YouTube API key supplied. Create one for free at console.cloud.google.com, '
        + 'enable the YouTube Data API v3 on the project, then paste it into the '
        + 'apiKeys field. More than one key can be listed, the actor moves to the next '
        + 'one automatically once one runs out of quota for the day.',
    );
}

/* Free Apify proxy is a datacentre pool. That is perfectly fine here, because
   every page we touch is an ordinary public page with no bot wall on it. */
const proxyConfiguration = useApifyProxy
    ? await Actor.createProxyConfiguration()
    : undefined;

/* ================================================================== */
/* STEP 1. Work out which channels we are looking at.                  */
/* ================================================================== */

const targetIds = new Set();

for (const id of channelIds) {
    if (typeof id === 'string' && id.trim()) targetIds.add(id.trim());
}

for (const raw of channelUrls) {
    const url = typeof raw === 'string' ? raw : raw?.url;
    if (!url) continue;

    const idMatch = url.match(/youtube\.com\/channel\/(UC[\w-]{20,})/i);
    if (idMatch) {
        targetIds.add(idMatch[1]);
        continue;
    }

    const handleMatch = url.match(/youtube\.com\/@([\w.-]+)/i);
    if (handleMatch) channelHandles.push(handleMatch[1]);
}

for (const handle of channelHandles) {
    if (!handle) continue;
    const id = await resolveHandle(String(handle), youtubeApiKeys);
    if (id) targetIds.add(id);
}

for (const query of searchQueries) {
    if (!query) continue;
    log.info(`Searching YouTube for channels matching: ${query}`);
    const ids = await searchChannels(String(query), maxChannelsPerQuery, youtubeApiKeys);
    ids.forEach((id) => targetIds.add(id));
    log.info(`Search returned ${ids.length} channels.`);
}

const allIds = [...targetIds];
if (allIds.length === 0) {
    throw new Error('No channels to process. Supply channelHandles, channelIds, channelUrls or searchQueries.');
}
log.info(`Processing ${allIds.length} channels.`);

/* ================================================================== */
/* STEP 2. Pull channel details in cheap batches of fifty.             */
/* ================================================================== */

const fetchedChannels = await fetchChannels(allIds, youtubeApiKeys);
log.info(`YouTube returned full details for ${fetchedChannels.length} channels.`);

// Keep only channels inside the requested subscriber range, before any of
// the expensive website crawling happens, so that budget is never spent on
// a channel outside the range in the first place.
const channels = fetchedChannels.filter((c) => {
    if (minSubscribers !== undefined && minSubscribers !== null && c.subscribers < minSubscribers) return false;
    if (maxSubscribers !== undefined && maxSubscribers !== null && c.subscribers > maxSubscribers) return false;
    return true;
});

if (minSubscribers !== undefined || maxSubscribers !== undefined) {
    log.info(
        `${channels.length} of those fall inside the ${minSubscribers ?? 0} to ${maxSubscribers ?? 'unlimited'} `
        + `subscriber range, the rest were skipped before any crawling.`,
    );
}

/* ================================================================== */
/* STEP 3. For each channel, gather candidate emails and site links.   */
/* ================================================================== */

const results = new Map();
const siteQueue = [];

for (const channel of channels) {
    const hits = [];

    hits.push(
        ...extractEmails(channel.description || '', {
            source: 'channelDescription',
            sourceUrl: channel.channelUrl,
        }),
    );

    let links = extractUrls(channel.description || '');

    if (readChannelLinks) {
        const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : null;
        const pinned = await fetchChannelLinks(channel.channelId, proxyUrl);
        links = [...new Set([...links, ...pinned])];
        await sleep(requestDelayMs);
    }

    const { ownSites, socialProfiles } = splitLinks(links);

    results.set(channel.channelId, {
        ...channel,
        linkedSites: ownSites,
        socialProfiles,
        rawHits: hits,
        pagesChecked: [],
    });

    if (crawlCreatorSites) {
        for (const site of ownSites.slice(0, 3)) {
            siteQueue.push({
                url: site,
                userData: { channelId: channel.channelId, depth: 0 },
            });
        }
    }
}

/* ================================================================== */
/* STEP 4. Crawl the creator websites for contact details.             */
/* ================================================================== */

const CONTACT_LINK_WORDS = [
    'contact', 'about', 'team', 'press', 'media', 'work with', 'hire',
    'impressum', 'kontakt', 'connect', 'support', 'help', 'inquiries',
    'partnership', 'sponsor', 'advertise', 'collab',
];

const pagesSpent = new Map();

if (crawlCreatorSites && siteQueue.length > 0) {
    log.info(`Crawling ${siteQueue.length} creator websites for contact pages.`);

    const crawler = new CheerioCrawler({
        proxyConfiguration,
        maxConcurrency: 5,
        maxRequestRetries: 2,
        requestHandlerTimeoutSecs: 45,
        failedRequestHandler: async ({ request }) => {
            log.debug(`Gave up on ${request.url}`);
        },

        async requestHandler({ request, $, enqueueLinks, body }) {
            const { channelId, depth } = request.userData;
            const record = results.get(channelId);
            if (!record) return;

            const origin = safeOrigin(request.url);
            const spent = pagesSpent.get(origin) || 0;
            if (spent >= maxPagesPerSite) return;
            pagesSpent.set(origin, spent + 1);

            const isContactPage = /contact|about|team|press|impressum|kontakt|connect/i.test(request.url);
            const source = isContactPage ? 'contactPage' : 'siteBody';

            const text = $('body').text().replace(/\s+/g, ' ');
            record.rawHits.push(...extractEmails(text, { source, sourceUrl: request.url }));

            $('a[href^="mailto:"]').each((_, el) => {
                const href = $(el).attr('href') || '';
                const address = href.replace(/^mailto:/i, '').split('?')[0];
                record.rawHits.push(
                    ...extractEmails(address, { source: 'mailtoLink', sourceUrl: request.url }),
                );
            });

            const rawHtml = typeof body === 'string' ? body : body?.toString?.('utf8') || '';
            record.rawHits.push(
                ...extractEmails(rawHtml.slice(0, 400000), { source: 'siteBody', sourceUrl: request.url }),
            );

            record.pagesChecked.push(request.url);

            if (depth === 0) {
                const candidates = [];
                $('a[href]').each((_, el) => {
                    const href = $(el).attr('href');
                    const label = ($(el).text() || '').toLowerCase().trim();
                    if (!href) return;

                    const looksRight = CONTACT_LINK_WORDS.some(
                        (w) => label.includes(w) || href.toLowerCase().includes(w),
                    );
                    if (!looksRight) return;

                    try {
                        const abs = new URL(href, request.url);
                        if (abs.origin !== origin) return;
                        abs.hash = '';
                        candidates.push(abs.toString());
                    } catch {
                        /* ignore malformed hrefs */
                    }
                });

                const unique = [...new Set(candidates)].slice(0, maxPagesPerSite - 1);
                for (const url of unique) {
                    await crawler.addRequests([{ url, userData: { channelId, depth: 1 } }]);
                }
            }
        },
    });

    await crawler.run(siteQueue);
}

/* ================================================================== */
/* STEP 5. Score, rank and save.                                       */
/* ================================================================== */

let withEmail = 0;

for (const record of results.values()) {
    const ownDomains = record.linkedSites
        .map((u) => safeHost(u))
        .filter(Boolean);

    const { emails, bestEmail } = rankEmails(record.rawHits, ownDomains);
    const kept = emails.filter((e) => e.score >= minimumScore);

    if (kept.length) withEmail += 1;

    await Actor.pushData({
        channelId: record.channelId,
        channelTitle: record.title,
        handle: record.handle,
        channelUrl: record.channelUrl,
        subscribers: record.subscribers,
        videoCount: record.videoCount,
        totalViews: record.viewCount,
        country: record.country,

        bestEmail: kept.length ? kept[0].email : null,
        bestEmailConfidence: kept.length ? kept[0].confidence : null,
        bestEmailScore: kept.length ? kept[0].score : null,
        bestEmailFoundOn: kept.length ? kept[0].sourceUrl : null,
        whyThisEmail: kept.length ? kept[0].reasons.join('; ') : null,

        allEmails: kept.map((e) => ({
            email: e.email,
            score: e.score,
            confidence: e.confidence,
            source: e.source,
            sourceUrl: e.sourceUrl,
            reasons: e.reasons,
        })),

        linkedSites: record.linkedSites,
        socialProfiles: record.socialProfiles,
        pagesChecked: record.pagesChecked,
        description: (record.description || '').slice(0, 2000),
        scrapedAt: new Date().toISOString(),
    });
}

log.info(`Done. Found at least one address for ${withEmail} of ${results.size} channels.`);

await Actor.exit();

/* ------------------------- small helpers ------------------------- */

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeOrigin(url) {
    try {
        return new URL(url).origin;
    } catch {
        return url;
    }
}

function safeHost(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return null;
    }
}
