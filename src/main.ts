import { Actor } from 'apify';

interface Input {
    searchQuery?: string;
    apiKeys: string[];
    minSubscribers?: number;
    maxSubscribers?: number;
    maxChannels?: number;
}

interface StateShape {
    nextPageToken: string | null;
    seenChannelIds: string[];
    savedCount: number;
    exhaustedKeys: string[];
}

const STATE_KEY = 'YT_SCRAPER_STATE';

function extractLinksAndEmails(text: string): { links: string[]; possibleEmail: string | null } {
    const linkPattern = /(https?:\/\/[^\s)]+)/gi;
    const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    const links = Array.from(new Set((text.match(linkPattern) || []).map((l) => l.replace(/[.,;]+$/, ''))));
    const emailMatch = text.match(emailPattern);
    return { links, possibleEmail: emailMatch ? emailMatch[0] : null };
}

async function callYoutubeApi(
    url: string,
    apiKeys: string[],
    exhaustedKeys: Set<string>,
): Promise<{ data: any; usedKey: string } | null> {
    for (const key of apiKeys) {
        if (exhaustedKeys.has(key)) continue;

        const fullUrl = `${url}&key=${key}`;
        const response = await fetch(fullUrl);

        if (response.status === 403) {
            const body = await response.json().catch(() => null);
            const reason = body?.error?.errors?.[0]?.reason || '';
            if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
                console.log(`API key ending in ...${key.slice(-6)} has run out of quota for today. Moving to the next key.`);
                exhaustedKeys.add(key);
                continue;
            }
            console.log(`API key ending in ...${key.slice(-6)} was rejected: ${reason || 'unknown reason'}.`);
            exhaustedKeys.add(key);
            continue;
        }

        if (!response.ok) {
            console.log(`YouTube API call failed with status ${response.status}. Trying next key if any.`);
            continue;
        }

        const data = await response.json();
        return { data, usedKey: key };
    }

    return null;
}

await Actor.init();

const input = (await Actor.getInput<Input>()) ?? ({} as Input);
const searchQuery = input.searchQuery || 'AI tools and automation';
const apiKeys = (input.apiKeys || []).filter(Boolean);
const minSubscribers = input.minSubscribers ?? 1;
const maxSubscribers = input.maxSubscribers ?? 600;
const maxChannels = input.maxChannels ?? 0;

if (apiKeys.length === 0) {
    console.log('No API keys were provided. Nothing to do.');
    await Actor.exit();
}

console.log('==============================');
console.log('YOUTUBE AI TOOLS CHANNEL SCRAPER');
console.log('==============================');
console.log(`Search query: ${searchQuery}`);
console.log(`Subscriber range: ${minSubscribers} to ${maxSubscribers}`);
console.log(`API keys provided: ${apiKeys.length}`);
console.log(`Maximum channels this run: ${maxChannels === 0 ? 'UNLIMITED' : maxChannels}`);

const store = await Actor.openKeyValueStore('YOUTUBE-AI-TOOLS-STATE', { forceCloud: true });
const savedState = (await store.getValue<StateShape>(STATE_KEY)) || {
    nextPageToken: null,
    seenChannelIds: [],
    savedCount: 0,
    exhaustedKeys: [],
};

let nextPageToken = savedState.nextPageToken;
const seenChannelIds = new Set(savedState.seenChannelIds);
let savedCount = savedState.savedCount;
const exhaustedKeys = new Set(savedState.exhaustedKeys.filter((k) => apiKeys.includes(k)));

if (nextPageToken) {
    console.log(`Resuming search from a saved page token. Already saved so far: ${savedCount}.`);
} else {
    console.log('Starting a fresh search, no earlier progress found.');
}

async function persistState(): Promise<void> {
    await store.setValue(STATE_KEY, {
        nextPageToken,
        seenChannelIds: Array.from(seenChannelIds),
        savedCount,
        exhaustedKeys: Array.from(exhaustedKeys),
    });
}

let keepGoing = true;

while (keepGoing) {
    if (exhaustedKeys.size >= apiKeys.length) {
        console.log('Every provided API key has run out of quota for today. Stopping here, your progress is saved.');
        break;
    }

    const searchUrl =
        `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=50` +
        `&q=${encodeURIComponent(searchQuery)}` +
        (nextPageToken ? `&pageToken=${nextPageToken}` : '');

    const searchResult = await callYoutubeApi(searchUrl, apiKeys, exhaustedKeys);

    if (!searchResult) {
        console.log('No working API key left for the search step. Stopping here.');
        break;
    }

    const items = searchResult.data.items || [];
    nextPageToken = searchResult.data.nextPageToken || null;

    console.log(`Search page returned ${items.length} channel results.`);

    const freshIds: string[] = [];
    for (const item of items) {
        const channelId = item.snippet?.channelId || item.id?.channelId;
        if (channelId && !seenChannelIds.has(channelId)) {
            freshIds.push(channelId);
            seenChannelIds.add(channelId);
        }
    }

    console.log(`${freshIds.length} of those are new, not seen in an earlier run.`);

    for (let i = 0; i < freshIds.length; i += 50) {
        const batch = freshIds.slice(i, i + 50);
        const detailsUrl =
            `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${batch.join(',')}`;

        const detailsResult = await callYoutubeApi(detailsUrl, apiKeys, exhaustedKeys);
        if (!detailsResult) {
            console.log('No working API key left for the channel details step. Stopping here.');
            keepGoing = false;
            break;
        }

        for (const channel of detailsResult.data.items || []) {
            const subscriberCount = Number(channel.statistics?.subscriberCount ?? -1);
            const hidden = channel.statistics?.hiddenSubscriberCount === true;

            if (hidden || subscriberCount < 0) {
                console.log(`SKIPPED (hidden subscriber count): ${channel.snippet?.title}`);
                continue;
            }

            if (subscriberCount < minSubscribers || subscriberCount > maxSubscribers) {
                console.log(`SKIPPED (outside subscriber range, has ${subscriberCount}): ${channel.snippet?.title}`);
                continue;
            }

            const description = channel.snippet?.description || '';
            const { links, possibleEmail } = extractLinksAndEmails(description);

            await Actor.pushData({
                channelName: channel.snippet?.title || null,
                channelUrl: `https://www.youtube.com/channel/${channel.id}`,
                subscriberCount,
                aboutDescription: description,
                linksFoundInDescription: links,
                possibleEmailInDescription: possibleEmail,
                emailNote:
                    'YouTube does not expose a channel business email through the API or the public page without manual sign in and a captcha. This field is only ever filled when the channel owner typed an email directly into their own description text.',
            });

            savedCount += 1;
            console.log(`SAVED (${subscriberCount} subscribers): ${channel.snippet?.title}`);

            if (maxChannels > 0 && savedCount >= maxChannels) {
                console.log(`Reached the requested maximum of ${maxChannels} saved channels. Stopping here.`);
                keepGoing = false;
                break;
            }
        }

        await persistState();
        if (!keepGoing) break;
    }

    await persistState();

    if (!nextPageToken) {
        console.log('Reached the end of YouTube search results for this query. Nothing left to walk forward through.');
        break;
    }
}

console.log(`Finished. Total channels saved across all runs so far: ${savedCount}.`);
await Actor.exit();
