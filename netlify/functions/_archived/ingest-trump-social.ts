// V3 DISABLED: Weather-only rebuild. This function is not part of the active pipeline.
// ============================================================
// Netlify Scheduled Function: Macro News Signal Ingestor
// Runs every 5 minutes
//
// STRATEGY: High-impact macro news (tariffs, Fed, crypto regs)
// frequently precedes Polymarket movements. We monitor Google News
// RSS feeds across 6 financial categories, score articles for
// market relevance, and store them in trump_posts so
// analyze-sentiment-edge can correlate with options flow anomalies.
//
// Primary:  Google News RSS search (free, no auth, not Lambda-blocked)
// Fallback: Reuters RSS, AP News RSS
// Legacy:   Truth Social (still attempted — works if not blocked)
//
// Table: trump_posts (unchanged schema — no downstream changes needed)
// ============================================================

// import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const FETCH_TIMEOUT_MS  = 8000;
const MIN_IMPACT_SCORE  = 0.15;

// ── Google News RSS category feeds ────────────────────────────────────
// Each feed targets a specific financial category. Results are fresh
// (updated every ~15 min) and reliably accessible from Lambda.
const GNEWS_FEEDS: { name: string; url: string; category: string }[] = [
  {
    name: 'gnews-tariff',
    category: 'tariff',
    url: 'https://news.google.com/rss/search?q=tariff+trade+war+import+tax&hl=en-US&gl=US&ceid=US:en',
  },
  {
    name: 'gnews-fed',
    category: 'fed',
    url: 'https://news.google.com/rss/search?q=federal+reserve+interest+rate+powell+inflation&hl=en-US&gl=US&ceid=US:en',
  },
  {
    name: 'gnews-crypto',
    category: 'crypto',
    url: 'https://news.google.com/rss/search?q=bitcoin+crypto+regulation+BTC+SEC&hl=en-US&gl=US&ceid=US:en',
  },
  {
    name: 'gnews-stocks',
    category: 'stocks',
    url: 'https://news.google.com/rss/search?q=stock+market+recession+S%26P+500+Dow+Jones&hl=en-US&gl=US&ceid=US:en',
  },
  {
    name: 'gnews-energy',
    category: 'energy',
    url: 'https://news.google.com/rss/search?q=oil+price+OPEC+energy+gas+price&hl=en-US&gl=US&ceid=US:en',
  },
  {
    name: 'gnews-geopolitics',
    category: 'geo',
    url: 'https://news.google.com/rss/search?q=ukraine+russia+sanctions+NATO+geopolitics&hl=en-US&gl=US&ceid=US:en',
  },
];

// ── Fallback RSS feeds (not Lambda-blocked) ───────────────────────────
const FALLBACK_FEEDS: { name: string; url: string }[] = [
  {
    name: 'reuters-markets',
    url: 'https://feeds.reuters.com/reuters/businessNews',
  },
  {
    name: 'ap-business',
    url: 'https://rsshub.app/apnews/topics/business',
  },
];

// ── Legacy Truth Social (still tried — works if not blocked) ─────────
const TRUTH_SOCIAL_FEEDS: { name: string; url: string }[] = [
  { name: 'truthsocial-direct', url: 'https://truthsocial.com/@realDonaldTrump.rss' },
  { name: 'truthsocial-www',    url: 'https://www.truthsocial.com/@realDonaldTrump.rss' },
  { name: 'rsshub-truthsocial', url: 'https://rsshub.app/truthsocial/user/realDonaldTrump' },
];

// ── Keyword scoring matrix ─────────────────────────────────────────────
const KEYWORD_MAP: { pattern: RegExp; category: string; weight: number }[] = [
  // Tariff / trade (highest impact — directly moves prediction markets)
  { pattern: /tariff/i,                   category: 'tariff',  weight: 0.9  },
  { pattern: /trade (war|deal|deficit)/i, category: 'tariff',  weight: 0.85 },
  { pattern: /china|beijing|xi jinping/i, category: 'tariff',  weight: 0.7  },
  { pattern: /import.{0,15}(tax|duty)/i,  category: 'tariff',  weight: 0.8  },
  { pattern: /reciprocal/i,               category: 'tariff',  weight: 0.75 },
  { pattern: /\bWTO\b/i,                  category: 'tariff',  weight: 0.6  },
  { pattern: /canada|mexico|\bEU\b|europe/i, category: 'tariff', weight: 0.5 },

  // Crypto (moves crypto markets directly)
  { pattern: /bitcoin|\bbtc\b/i,          category: 'crypto',  weight: 0.85 },
  { pattern: /crypto(currency)?/i,        category: 'crypto',  weight: 0.8  },
  { pattern: /digital (dollar|currency|asset)/i, category: 'crypto', weight: 0.7 },
  { pattern: /ethereum|solana|\bxrp\b|ripple/i,  category: 'crypto', weight: 0.75 },
  { pattern: /blockchain/i,               category: 'crypto',  weight: 0.5  },
  { pattern: /\bdefi\b|web3/i,            category: 'crypto',  weight: 0.45 },
  { pattern: /\bSEC\b.{0,30}crypto/i,     category: 'crypto',  weight: 0.8  },
  { pattern: /crypto.{0,30}regulat/i,     category: 'crypto',  weight: 0.75 },

  // Federal Reserve / interest rates
  { pattern: /\bFed\b|federal reserve/i,  category: 'fed',     weight: 0.8  },
  { pattern: /interest rate/i,            category: 'fed',     weight: 0.75 },
  { pattern: /(cut|raise|lower).{0,10}rate/i, category: 'fed', weight: 0.8  },
  { pattern: /\bJerome Powell\b/i,        category: 'fed',     weight: 0.85 },
  { pattern: /inflation/i,                category: 'fed',     weight: 0.6  },
  { pattern: /quantitative/i,             category: 'fed',     weight: 0.55 },
  { pattern: /\bFOMC\b|\bCPI\b|\bPCE\b/i, category: 'fed',    weight: 0.7  },

  // Stock market
  { pattern: /\bstock market\b|\bwall street\b/i, category: 'stocks', weight: 0.7 },
  { pattern: /\bDow\b|S&P|nasdaq/i,       category: 'stocks',  weight: 0.65 },
  { pattern: /market (crash|rally|boom|rout)/i,   category: 'stocks', weight: 0.8 },
  { pattern: /recession/i,                category: 'stocks',  weight: 0.75 },
  { pattern: /\bGDP\b/i,                  category: 'stocks',  weight: 0.6  },

  // Energy / oil
  { pattern: /\boil\b|\bgas\b|\bopec\b/i, category: 'energy',  weight: 0.65 },
  { pattern: /energy (price|cost|bill)/i,  category: 'energy',  weight: 0.6  },

  // Ukraine / geopolitics (affects markets)
  { pattern: /ukraine|russia|putin/i,      category: 'geo',    weight: 0.55 },
  { pattern: /\bNATO\b/i,                  category: 'geo',    weight: 0.4  },
  { pattern: /sanctions/i,                 category: 'geo',    weight: 0.6  },
  { pattern: /ceasefire|peace.{0,15}deal/i, category: 'geo',   weight: 0.65 },

  // Election / political (prediction market specific)
  { pattern: /election|ballot|vote/i,      category: 'politics', weight: 0.4  },
  { pattern: /democrat|republican/i,       category: 'politics', weight: 0.3  },
  { pattern: /congress|senate|house/i,     category: 'politics', weight: 0.35 },
];

interface ParsedArticle {
  postId:   string;
  postedAt: Date;
  content:  string;
  url:      string;
}

// ── Simple RSS/Atom parser (no external deps) ─────────────────────────
function parseRssItems(xml: string, sourceName: string): ParsedArticle[] {
  const items: ParsedArticle[] = [];
  const itemPattern = xml.includes('<entry')
    ? /<entry>([\s\S]*?)<\/entry>/gi
    : /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemPattern.exec(xml)) !== null) {
    const item = match[1];

    const guid    = (item.match(/<(guid|id)[^>]*>([\s\S]*?)<\/(guid|id)>/i)?.[2] ?? '').trim();
    const pubDate = (
      item.match(/<(pubDate|published|updated)[^>]*>([\s\S]*?)<\/(pubDate|published|updated)>/i)?.[2]
      ?? ''
    ).trim();

    const titleMatch = item.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i)
                    ?? item.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const descMatch  = item.match(/<(description|summary|content)[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/(description|summary|content)>/i)
                    ?? item.match(/<(description|summary|content)[^>]*>([\s\S]*?)<\/(description|summary|content)>/i);
    const linkMatch  = item.match(/<link[^>]*>([\s\S]*?)<\/link>/i)
                    ?? item.match(/<link[^>]*href="([^"]+)"/i);

    const title = (titleMatch?.[titleMatch.length - 1] ?? '').trim();
    const desc  = (descMatch?.[descMatch.length - 1] ?? '').trim();
    const link  = (linkMatch?.[1] ?? '').trim();

    if (!guid && !link) continue;

    // Strip HTML tags, decode entities
    const rawContent = (title + ' ' + desc)
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ').trim();

    const postedAt = new Date(pubDate);
    if (isNaN(postedAt.getTime())) continue;

    // Prefix postId with source to guarantee uniqueness across feeds
    const raw = (guid || link).replace(/^https?:\/\/[^/]+\//, '').substring(0, 80);
    const postId = `${sourceName.substring(0, 15)}_${raw}`;

    items.push({
      postId,
      postedAt,
      content: rawContent.substring(0, 2000),
      url:     link.substring(0, 500),
    });
  }

  console.log(`[macro-news] Parsed ${items.length} items from ${sourceName}`);
  return items;
}

// ── Keyword scoring ────────────────────────────────────────────────────
function scoreContent(content: string): {
  score: number; keywords: string[]; categories: string[];
} {
  const matchedKeywords: string[]   = [];
  const matchedCategories: Set<string> = new Set();
  let rawScore = 0;

  for (const { pattern, category, weight } of KEYWORD_MAP) {
    if (pattern.test(content)) {
      matchedKeywords.push(pattern.source.replace(/[\\\/^$.*+?()\[\]{}|]/g, '').toLowerCase().substring(0, 20));
      matchedCategories.add(category);
      rawScore += weight;
    }
  }

  return {
    score:      Math.min(rawScore / 2.0, 1.0),
    keywords:   [...new Set(matchedKeywords)],
    categories: [...matchedCategories],
  };
}

// ── Fetch one RSS feed ─────────────────────────────────────────────────
async function fetchFeed(
  url: string,
  name: string,
): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) { console.log(`[macro-news] ${name}: HTTP ${res.status}`); return null; }
    const text = await res.text();
    if (text.length < 100 || (!text.includes('<item') && !text.includes('<entry'))) {
      console.log(`[macro-news] ${name}: no RSS/Atom items (len=${text.length})`);
      return null;
    }
    return text;
  } catch (e) {
    console.log(`[macro-news] ${name}: fetch error — ${e}`);
    return null;
  }
}

// ── Upsert articles to trump_posts (shared sentiment table) ──────────
async function upsertArticles(
  articles: ParsedArticle[],
): Promise<{ stored: number; highImpact: number }> {
  let stored = 0, highImpact = 0;
  const cutoff24h = new Date(Date.now() - 24 * 3600000);
  const recent = articles.filter(a => a.postedAt > cutoff24h);

  for (const article of recent) {
    const { score, keywords, categories } = scoreContent(article.content);
    if (score < MIN_IMPACT_SCORE && keywords.length === 0) continue;

    const { error } = await supabase.from('trump_posts').upsert({
      post_id:             article.postId,
      posted_at:           article.postedAt.toISOString(),
      content:             article.content,
      url:                 article.url,
      keywords,
      market_impact_score: score,
      categories,
    }, { onConflict: 'post_id', ignoreDuplicates: true });

    if (!error) {
      stored++;
      if (score >= 0.4) highImpact++;
    } else {
      console.error(`[macro-news] Insert error: ${error.message}`);
    }
  }
  return { stored, highImpact };
}

export const handler = async () => {
  console.log('[ingest-trump-social] V3 DISABLED — weather-only mode'); return { statusCode: 200 };
  console.log('[macro-news] Starting macro news ingest');
  const startTime = Date.now();
  let totalStored = 0, totalHighImpact = 0;

  // ── 1. Google News RSS feeds (primary — parallel fetch) ──────────
  const gnewsResults = await Promise.allSettled(
    GNEWS_FEEDS.map(feed => fetchFeed(feed.url, feed.name))
  );

  let gnewsSucceeded = 0;
  for (let i = 0; i < GNEWS_FEEDS.length; i++) {
    const result = gnewsResults[i];
    if (result.status !== 'fulfilled' || !result.value) continue;
    gnewsSucceeded++;
    const articles = parseRssItems(result.value, GNEWS_FEEDS[i].name);
    const { stored, highImpact } = await upsertArticles(articles);
    totalStored += stored; totalHighImpact += highImpact;
  }
  console.log(`[macro-news] Google News: ${gnewsSucceeded}/${GNEWS_FEEDS.length} feeds OK, stored ${totalStored}`);

  // ── 2. Fallback feeds (if Google News got nothing useful) ────────
  if (totalStored < 3) {
    console.log('[macro-news] Low yield from Google News — trying fallback feeds');
    for (const feed of FALLBACK_FEEDS) {
      const xml = await fetchFeed(feed.url, feed.name);
      if (!xml) continue;
      const articles = parseRssItems(xml, feed.name);
      const { stored, highImpact } = await upsertArticles(articles);
      totalStored += stored; totalHighImpact += highImpact;
      if (stored > 0) console.log(`[macro-news] ${feed.name}: stored ${stored}`);
    }
  }

  // ── 3. Truth Social (legacy — try quietly, don't fail if blocked) ─
  for (const feed of TRUTH_SOCIAL_FEEDS) {
    const xml = await fetchFeed(feed.url, feed.name);
    if (!xml) continue;
    const articles = parseRssItems(xml, feed.name);
    const { stored, highImpact } = await upsertArticles(articles);
    if (stored > 0) {
      totalStored += stored; totalHighImpact += highImpact;
      console.log(`[macro-news] Truth Social (${feed.name}): stored ${stored}`);
    }
    break; // Only need one Truth Social source
  }

  // ── 4. Write status ───────────────────────────────────────────────
  const status = totalStored > 0 ? `ok_gnews_${totalStored}` : 'no_new_articles';
  await supabase.from('system_config').upsert([
    { key: 'trump_social_last_success', value: new Date().toISOString() },
    { key: 'trump_social_status',       value: status },
    { key: 'trump_social_source',       value: gnewsSucceeded > 0 ? 'gnews' : 'fallback' },
  ], { onConflict: 'key' });

  // ── 5. Log high-impact articles ───────────────────────────────────
  const { data: recent } = await supabase
    .from('trump_posts')
    .select('posted_at, market_impact_score, categories, content')
    .gte('market_impact_score', 0.4)
    .gte('posted_at', new Date(Date.now() - 30 * 60000).toISOString())
    .order('market_impact_score', { ascending: false })
    .limit(3);

  if (recent?.length) {
    for (const p of recent) {
      console.log(`[macro-news] 🔴 HIGH IMPACT (${p.market_impact_score.toFixed(2)}) [${(p.categories ?? []).join(',')}]: "${p.content.substring(0, 100)}..."`);
    }
  }

  console.log(`[macro-news] Done in ${Date.now() - startTime}ms. stored=${totalStored} high-impact=${totalHighImpact}`);
  return { statusCode: 200 };
});
