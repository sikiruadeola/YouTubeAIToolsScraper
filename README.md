# YouTube Creator Contact Finder

Finds publicly published business contact addresses for YouTube creators.

## The idea in one paragraph

The email reveal button on a YouTube About page sits behind a challenge. That
challenge exists for exactly one reason, which is to stop bulk collection of
creator addresses. This actor does not touch it. Instead it reaches the same
addresses through three doors that have no gate on them at all: the channel
description text, the outbound links pinned to the channel, and the creator
own website. A large share of creators publish the same address in all four
places, so going around the gate is unnecessary.

## Why this keeps working when challenge solving does not

Challenge solving breaks for three reasons. The defender changes the challenge
and your solver goes stale. The account or IP doing the solving gets flagged
and banned. The address you collect that way arrives with no context, so the
message you send reads as bulk mail and lands in spam.

The approach here has none of those failure modes. The YouTube Data API is
Google's own front door and it is free up to ten thousand quota units a day
per key. Creator websites are ordinary public pages that want to be found.
Nothing here degrades when a challenge provider ships an update.

## Expected result

Between thirty and sixty percent of channels yield a usable address. The rate
depends entirely on the niche. Software, business and finance channels sit at
the top because those creators want sponsors to reach them. Entertainment and
gaming channels sit at the bottom.

At one hundred to two hundred channels a day, expect roughly forty to one
hundred and twenty addresses.

## Quota arithmetic, which is the thing people get wrong

The free daily budget is ten thousand units per key and it resets at midnight
Pacific time. The costs are not evenly spread.

Fetching full details for channels costs one unit per call, and one call
covers fifty channels. Two hundred channels therefore costs four units. That
is nothing.

Resolving an at handle into a channel id costs one unit per handle. Two
hundred handles costs two hundred units. Still nothing.

Keyword search costs one hundred units per call. One hundred searches empties
a single key's entire daily budget on its own. If you already know your
targets, supply handles or ids and never touch search.

Practical rule: supply channel ids where you have them, handles where you do
not, and use search sparingly for discovery only. List more than one key in
`apiKeys` if you need more search headroom than one key gives you.

## Setup

1. Go to console.cloud.google.com and create a project.
2. In the library, enable YouTube Data API v3.
3. Under Credentials, create an API key.
4. Paste that key into the `apiKeys` field. You can list more than one.
5. Deploy this folder to Apify, either by pushing with the Apify CLI or by
   creating a new actor and pasting the files in.

No billing card is needed for the free tier.

## Input

Supply targets in any combination of these fields.

`channelIds` takes raw ids starting with UC. Cheapest option.
`channelHandles` takes handles with or without the at sign.
`channelUrls` takes full channel URLs in either form.
`searchQueries` discovers new channels by keyword. Expensive. See the quota
section above.

Useful switches:

`minimumScore` filters the output. Set it to fifty five to keep only medium
and high confidence addresses, or seventy five for high confidence only.
`maxPagesPerSite` controls how deep the website crawl goes. Six is plenty.
`crawlCreatorSites` can be turned off if you only want what is in the
description, which makes the run much faster and much thinner.
`apiKeys` takes a list rather than a single key. Once one key runs out of its
daily ten thousand units the actor moves to the next one automatically,
stretching a single run across more than one key's daily quota.
`minSubscribers` and `maxSubscribers` drop any channel outside that range
right after fetching its details, before any website crawling happens, so no
budget is spent on a channel you never wanted in the first place.

## Output

Every row carries the channel details, a single `bestEmail` pick, and an
`allEmails` array with everything that was found. Each address comes with a
score, a confidence band, the exact page it was found on, and a plain language
list of the reasons behind the score. That last field is there so you can
audit a bad pick instead of guessing.

## How the scoring works

Every candidate starts at forty points out of one hundred and moves from
there.

Source matters most. An address written into the channel description gains
twenty five points, because the creator typed it there themselves. A mailto
link gains twenty. An address on a contact or about page gains fifteen. An
address in ordinary page body text gains five.

Context matters next. If the address sits within about one hundred and twenty
characters of wording like business inquiries, sponsorship or press, it gains
fifteen.

Ownership matters. If the address domain matches one of the creator own linked
websites, it gains fifteen.

Inbox name matters a little. Names like business, partnerships, press and
hello gain eight. Names like noreply and postmaster lose forty five, because
nobody reads those.

Reassembly is penalised. An address that was written in a disguised form, such
as name at site dot com, loses ten, because reassembling it is guesswork and
can produce a wrong address.

Seventy five and above reads as high confidence. Fifty five to seventy four
reads as medium. Below that reads as low.

## What gets thrown away before scoring

The extractor filters out a long list of things that look like emails but are
not. Image filenames with the two times suffix. Error tracking addresses from
Sentry. Placeholder addresses on template domains such as example.com and
yourdomain.com. Long hexadecimal strings that are really tracking ids.
Anything ending in an image or font extension. Anything on the platform's own
domains.

Without that filter roughly half the output on a typical website crawl is
noise. This is the part most people skip and then wonder why their list is
useless.

## File map

`src/main.js` is the flow. Read this first.
`src/youtube.js` is everything that talks to YouTube, both the API and the
public About page.
`src/emailFinder.js` is pure text processing with no network calls, so it can
be tested on its own.

## Before you send anything

Two things worth knowing rather than finding out later.

Unsolicited commercial mail to people in Europe falls under GDPR, and in
Nigeria under the NDPA. Both expect you to have a lawful basis and to say
clearly where you got the address.

Separately from the law, sending volume to addresses you scraped is the
fastest way to burn a sending domain. Creators mark that kind of mail as spam
almost reflexively. Warm the domain, keep volume low, make every message
obviously specific to the person, and give a real way to opt out. A list of
forty addresses mailed carefully beats four thousand mailed in bulk.
