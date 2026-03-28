// ============================================================
// Netlify Scheduled Function: Trump / Executive Social Monitor
// Runs every 5 minutes
//
// STRATEGY: Trump Truth Social posts frequently precede Polymarket
// movements on tariff, crypto, trade, and macro markets. We monitor
// the RSS feed, score each post for market relevance, and store
// high-impact posts so analyze-sentiment-edge can correlate them
// with options flow anomalies.
//
// RSS: https://truthsocial.com/@realDonaldTrump.rss (public, no auth)
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const RSS_URLS = [
  'https://truthsocial.com/@realDonaldTrump.rss',
  // Fallback mirror — some IPs can't reach Truth Social directly
  'https://rss.app/feeds/trump-truth-social.xml',
];

const FETCH_TIMEOUT_MS = 8000;
const MIN_IMPACT_SCORE = 0.15;  // Only store posts with some market relevance

// ── Keyword scoring matrix ─────────────────────────────────────────────
// Each keyword contributes to a category and impact score (0-1).
// Multiple high-impact keywords compound the score.
const KEYWORD_MAP: {
  pattern: RegExp;
  category: string;
  weight: number;
}[] = [
  // Tariff / trade (highest impact — directly moves prediction markets)
  { pattern: /tariff/i,                  category: 'tariff',   weight: 0.9 },
  { pattern: /trade (war|deal|deficit)/i,category: 'tariff',   weight: 0.85 },
  { pattern: /china|beijing|xi jinping/i,category: 'tariff',   weight: 0.7 },
  { pattern: /import.{0,15}(tax|duty)/i, category: 'tariff',   weight: 0.8 },
  { pattern: /reciprocal/i,              category: 'tariff',   weight: 0.75 },
  { pattern: /\bWTO\b/i,                 category: 'tariff',   weight: 0.6 },
  { pattern: /canada|mexico|EU|europe/i, category: 'tariff',   weight: 0.5 },

  // Crypto (moves crypto markets directly)
  { pattern: /bitcoin|btc/i,             category: 'crypto',   weight: 0.85 },
  { pattern: /crypto(currency)?/i,       category: 'crypto',   weight: 0.8  },
  { pattern: /digital (dollar|currency|asset)/i, category: 'crypto', weight: 0.7 },
  { pattern: /ethereum|solana|xrp|ripple/i, category: 'crypto', weight: 0.75 },
  { pattern: /blockchain/i,              category: 'crypto',   weight: 0.5  },
  { pattern: /defi|web3/i,               category: 'crypto',   weight: 0.45 },

  // Federal Reserve / interest rates
  { pattern: /\bFed\b|federal reserve/i, category: 'fed',      weight: 0.8  },
  { pattern: /interest rate/i,           category: 'fed',      weight: 0.75 },
  { pattern: /(cut|raise|lower).{0,10}rate/i, category: 'fed', weight: 0.8  },
  { pattern: /\bJerome Powell\b/i,       category: 'fed',      weight: 0.85 },
  { pattern: /inflation/i,               category: 'fed',      weight: 0.6  },
  { pattern: /quantitative/i,            category: 'fed',      weight: 0.55 },

  // Stock market
  { pattern: /\bstock market\b|\bwall street\b/i, category: 'stocks', weight: 0.7 },
  { pattern: /\bDow\b|S&P|nasdaq/i,      category: 'stocks',   weight: 0.65 },
  { pattern: /market (crash|rally|boom)/i, category: 'stocks', weight: 0.8  },
  { pattern: /recession/i,               category: 'stocks',   weight: 0.75 },
  { pattern: /GDP/i,                     category: 'stocks',   weight: 0.6  },

  // Energy / oil
  { pattern: /\boil\b|\bgas\b|opec/i,    category: 'energy',   weight: 0.65 },
  { pattern: /energy (price|cost|bill)/i,category: 'energy',   weight: 0.6  },

  // Ukraine / geopolitics (affects markets)
  { pattern: /ukraine|russia|putin/i,    category: 'geo',      weight: 0.55 },
  { pattern: /\bNATO\b/i,                category: 'geo',      weight: 0.4  },
  { pattern: /sanctions/i,               category: 'geo',      weight: 0.6  },

  // Election / political (prediction market specific)
  { pattern: /election|ballot|vote/i,    category: 'politics', weight: 0.4  },
  { pattern: /democrat|republican/i,     category: 'politics', weight: 0.3  },
  { pattern: /congress|senate|house/i,   category: 'politics', weight: 0.35 },
];

interface ParsedPost {
  postId: string;
  postedAt: Date;
  content: string;
  url: string;
}

// ── Simple XML/RSS parser (no external deps) ──────────────────────────
function parseRssItems(xml: string): ParsedPost[] {
  const items: ParsedPost[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    const guid    = (item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i)?.[1] ?? '').trim();
    const pubDate = (item.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] ?? '').trim();
    const title   = (item.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i)?.[1]
                  ?? item.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
    const desc    = (item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i)?.[1]
                  ?? item.match(/<description>([\s\S]*?)<\/description>/i)?.[1] ?? '').trim();
    const link    = (item.match(/<link>([\s\S]*?)<\/link>/i)?.[1] ?? '').trim();

    if (!guid || !pubDate) continue;

    // Strip HTML tags from content
    const rawContent = (title + ' ' + desc).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const postedAt = new Date(pubDate);
    if (isNaN(postedAt.getTime())) continue;

    items.push({
      postId:   guid.replace(/^https?:\/\/[^/]+\//, '').substring(0, 100),
      postedAt,
      content:  rawContent.substring(0, 2000),
      url:      link,
    });
  }

  return items;
}

function scorePost(content: string): {
  score: number;
  keywords: string[];
  categories: string[];
} {
  const matchedKeywords: string[] = [];
  const matchedCategories: Set<string> = new Set();
  let rawScore = 0;

  for (const { pattern, category, weight } of KEYWORD_MAP) {
    if (pattern.test(content)) {
      const keyword = pattern.source.replace(/[\\/^$.*+?()[\]{}|]/g, '').toLowerCase().substring(0, 20);
      matchedKeywords.push(keyword);
      matchedCategories.add(category);
      rawScore += weight;
    }
  }

  // Compound: multiple high-impact signals in same post = exponentially more interesting
  // But cap at 1.0
  const score = Math.min(rawScore / 2.0, 1.0); // normalize: ~2 weight units = 1.0 score
  return {
    score,
    keywords: [...new Set(matchedKeywords)],
    categories: [...matchedCategories],
  };
}

export const handler = schedule('*/5 * * * *', async () => {
  console.log('[trump-social] Checking Truth Social RSS');
  const startTime = Date.now();

  let rssText: string | null = null;

  for (const url of RSS_URLS) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ARBITER/1.0; +https://arbit3r.netlify.app)',
          'Accept': 'application/rss+xml, application/xml, text/xml',
        },
      });
      if (res.ok) {
        rssText = await res.text();
        console.log(`[trump-social] Fetched RSS from ${url} (${rssText.length} chars)`);
        break;
      }
    } catch (e) {
      console.log(`[trump-social] Failed to fetch ${url}: ${e}`);
    }
  }

  if (!rssText || rssText.length < 100) {
    console.log('[trump-social] No RSS data available — all sources failed');
    return { statusCode: 200 };
  }

  const posts = parseRssItems(rssText);
  console.log(`[trump-social] Parsed ${posts.length} RSS items`);

  if (posts.length === 0) {
    console.log('[trump-social] No posts parsed from RSS');
    return { statusCode: 200 };
  }

  // Only process posts from last 24 hours
  const cutoff24h = new Date(Date.now() - 24 * 3600000);
  const recentPosts = posts.filter(p => p.postedAt > cutoff24h);
  console.log(`[trump-social] ${recentPosts.length} posts from last 24h`);

  let stored = 0;
  let highImpact = 0;

  for (const post of recentPosts) {
    const { score, keywords, categories } = scorePost(post.content);

    if (score < MIN_IMPACT_SCORE && keywords.length === 0) continue;

    // Upsert to avoid duplicates (post_id is UNIQUE)
    const { error } = await supabase.from('trump_posts').upsert({
      post_id:             post.postId,
      posted_at:           post.postedAt.toISOString(),
      content:             post.content,
      url:                 post.url,
      keywords,
      market_impact_score: score,
      categories,
    }, { onConflict: 'post_id', ignoreDuplicates: true });

    if (!error) {
      stored++;
      if (score >= 0.4) highImpact++;
    }
  }

  console.log(`[trump-social] Done in ${Date.now() - startTime}ms. Stored=${stored} high-impact=${highImpact}`);

  // Log any high-impact posts for visibility
  const { data: recent } = await supabase
    .from('trump_posts')
    .select('posted_at, market_impact_score, categories, content')
    .gte('market_impact_score', 0.4)
    .gte('posted_at', new Date(Date.now() - 30 * 60000).toISOString())
    .order('market_impact_score', { ascending: false })
    .limit(3);

  if (recent?.length) {
    for (const p of recent) {
      console.log(`[trump-social] 🔴 HIGH IMPACT (${p.market_impact_score.toFixed(2)}) [${(p.categories ?? []).join(',')}]: "${p.content.substring(0, 100)}..."`);
    }
  }

  return { statusCode: 200 };
});
