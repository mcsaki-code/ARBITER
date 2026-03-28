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
// RSS sources (tried in order):
//   1. truthsocial.com/@realDonaldTrump.rss — official (often 403s on Lambda)
//   2. rsshub.app/mastodon/user — open RSS proxy for Mastodon-compatible feeds
//   3. politwoops.eu mirror — archived political posts RSS
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const FETCH_TIMEOUT_MS = 9000;
const MIN_IMPACT_SCORE = 0.15;  // Only store posts with some market relevance

// RSS sources tried in order — fallbacks in case truthsocial.com blocks Lambda IPs
const RSS_SOURCES: { url: string; name: string }[] = [
  {
    name: 'truthsocial-direct',
    url: 'https://truthsocial.com/@realDonaldTrump.rss',
  },
  {
    name: 'truthsocial-www',
    url: 'https://www.truthsocial.com/@realDonaldTrump.rss',
  },
  {
    name: 'rsshub-truthsocial',
    url: 'https://rsshub.app/truthsocial/user/realDonaldTrump',
  },
  {
    name: 'rssbridge-truthsocial',
    url: 'https://rss-bridge.org/bridge01/?action=display&bridge=TruthSocialBridge&username=realDonaldTrump&format=Atom',
  },
];

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
  { pattern: /canada|mexico|\bEU\b|europe/i, category: 'tariff', weight: 0.5 },

  // Crypto (moves crypto markets directly)
  { pattern: /bitcoin|\bbtc\b/i,         category: 'crypto',   weight: 0.85 },
  { pattern: /crypto(currency)?/i,       category: 'crypto',   weight: 0.8  },
  { pattern: /digital (dollar|currency|asset)/i, category: 'crypto', weight: 0.7 },
  { pattern: /ethereum|solana|\bxrp\b|ripple/i, category: 'crypto', weight: 0.75 },
  { pattern: /blockchain/i,              category: 'crypto',   weight: 0.5  },
  { pattern: /\bdefi\b|web3/i,           category: 'crypto',   weight: 0.45 },

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
  { pattern: /\bGDP\b/i,                 category: 'stocks',   weight: 0.6  },

  // Energy / oil
  { pattern: /\boil\b|\bgas\b|\bopec\b/i, category: 'energy', weight: 0.65 },
  { pattern: /energy (price|cost|bill)/i, category: 'energy',  weight: 0.6  },

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

// ── Simple XML/RSS+Atom parser (no external deps) ──────────────────────
function parseRssItems(xml: string, sourceName: string): ParsedPost[] {
  const items: ParsedPost[] = [];

  // Try RSS <item> format first, then Atom <entry> format
  const itemPattern = xml.includes('<entry') ? /<entry>([\s\S]*?)<\/entry>/gi : /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemPattern.exec(xml)) !== null) {
    const item = match[1];

    // RSS fields
    const guid    = (item.match(/<(guid|id)[^>]*>([\s\S]*?)<\/(guid|id)>/i)?.[2] ?? '').trim();
    const pubDate = (
      item.match(/<(pubDate|published|updated)[^>]*>([\s\S]*?)<\/(pubDate|published|updated)>/i)?.[2]
      ?? ''
    ).trim();

    // Content: try CDATA title+description, then plain text, then summary
    const titleMatch = item.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i)
                    ?? item.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const descMatch  = item.match(/<(description|summary|content)[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/(description|summary|content)>/i)
                    ?? item.match(/<(description|summary|content)[^>]*>([\s\S]*?)<\/(description|summary|content)>/i);
    const linkMatch  = item.match(/<link[^>]*>([\s\S]*?)<\/link>/i)
                    ?? item.match(/<link[^>]*href="([^"]+)"/i);

    const title   = (titleMatch?.[titleMatch.length - 1] ?? '').trim();
    const desc    = (descMatch?.[descMatch.length - 1] ?? '').trim();
    const link    = (linkMatch?.[1] ?? '').trim();

    if (!guid && !link) continue;

    // Strip HTML tags from content
    const rawContent = (title + ' ' + desc)
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    const postedAt = new Date(pubDate);
    if (isNaN(postedAt.getTime())) continue;

    const postId = (guid || link).replace(/^https?:\/\/[^/]+\//, '').substring(0, 100);

    items.push({
      postId,
      postedAt,
      content: rawContent.substring(0, 2000),
      url:     link.substring(0, 500),
    });
  }

  console.log(`[trump-social] Parsed ${items.length} items from ${sourceName}`);
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

  // Compound: multiple high-impact signals in same post = more interesting
  // Normalize: ~2 weight units = score 1.0
  const score = Math.min(rawScore / 2.0, 1.0);
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
  let successSource = '';

  for (const source of RSS_SOURCES) {
    try {
      const res = await fetch(source.url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
        },
      });

      if (!res.ok) {
        console.log(`[trump-social] ${source.name}: HTTP ${res.status}`);
        continue;
      }

      const text = await res.text();
      if (text.length < 200) {
        console.log(`[trump-social] ${source.name}: response too short (${text.length} chars)`);
        continue;
      }

      // Check it's actually XML
      if (!text.includes('<') || (!text.includes('<item') && !text.includes('<entry'))) {
        console.log(`[trump-social] ${source.name}: response doesn't look like RSS/Atom (length=${text.length})`);
        continue;
      }

      rssText = text;
      successSource = source.name;
      console.log(`[trump-social] Fetched RSS from ${source.name} (${rssText.length} chars)`);
      break;
    } catch (e) {
      console.log(`[trump-social] ${source.name}: fetch error — ${e}`);
    }
  }

  if (!rssText) {
    // All sources failed — log diagnostic but don't fail the function
    console.log('[trump-social] All RSS sources failed — recording diagnostic ping');
    await supabase.from('system_config').upsert([
      { key: 'trump_social_last_failure', value: new Date().toISOString() },
      { key: 'trump_social_status', value: 'all_sources_blocked' },
    ], { onConflict: 'key' });
    return { statusCode: 200 };
  }

  const posts = parseRssItems(rssText, successSource);

  if (posts.length === 0) {
    console.log('[trump-social] No posts parsed from RSS');
    return { statusCode: 200 };
  }

  // Only process posts from last 24 hours
  const cutoff24h = new Date(Date.now() - 24 * 3600000);
  const recentPosts = posts.filter(p => p.postedAt > cutoff24h);
  console.log(`[trump-social] ${recentPosts.length} posts from last 24h (of ${posts.length} total)`);

  // Update status
  await supabase.from('system_config').upsert([
    { key: 'trump_social_last_success', value: new Date().toISOString() },
    { key: 'trump_social_status', value: `ok_${successSource}` },
    { key: 'trump_social_source', value: successSource },
  ], { onConflict: 'key' });

  let stored = 0;
  let highImpact = 0;
  let skippedLowScore = 0;

  for (const post of recentPosts) {
    const { score, keywords, categories } = scorePost(post.content);

    if (score < MIN_IMPACT_SCORE && keywords.length === 0) {
      skippedLowScore++;
      continue;
    }

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
    } else {
      console.error(`[trump-social] Insert error: ${error.message}`);
    }
  }

  console.log(`[trump-social] Done in ${Date.now() - startTime}ms. stored=${stored} high-impact=${highImpact} skipped-low-score=${skippedLowScore}`);

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
