"use strict";
/**
 * Maker Paper-Quote Simulator (v0) — the validation instrument for the
 * maker pivot described in ARBITER_OPPORTUNITIES_2026-06-12.md.
 *
 * THESIS: ARBITER can't out-predict the weather market (corpus k*=0), but
 * market-making doesn't require that — only honest quote-centering, width
 * that covers adverse selection, and pulling quotes around model-run
 * releases. Makers pay zero fees and earn 25% of the weather taker-fee
 * pool + liquidity rewards.
 *
 * v0 SIMULATION SEMANTICS (deliberately conservative):
 *   - Every cycle, for each active temp market with a fresh analysis,
 *     log the two-sided quote we WOULD post (center = model p, width =
 *     fee component + distribution uncertainty, floored at 4¢).
 *   - A prior quote is "filled" if the market mid subsequently crossed
 *     it (mid ≤ bid ⇒ our bid lifted; mid ≥ ask ⇒ our ask hit). This
 *     overstates adverse selection (mid moves without trades count as
 *     fills) — so if v0 PnL ≥ 0, the real strategy is likely better.
 *   - Filled positions are marked to resolution for PnL.
 *   - NO ORDERS ARE EVER PLACED. This writes to mm_quote_sim only.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.inRunWindow = inRunWindow;
exports.runMmQuoteSim = runMmQuoteSim;
const QUOTE_SIZE_USD = 25; // simulated size per side
const MIN_HALF_WIDTH = 0.04; // 4¢ floor
const RUN_PAUSE_BEFORE_MIN = 15; // pull quotes 15 min before expected run availability
const RUN_PAUSE_AFTER_MIN = 45; // …and 45 min after (the repricing window)
const FRESH_ANALYSIS_MIN = 45;
const MODELS = [
    { model: 'gfs_seamless', runHoursUtc: [0, 6, 12, 18], availabilityLagH: 4.5 },
    { model: 'ecmwf_ifs025', runHoursUtc: [0, 12], availabilityLagH: 8 },
];
/** Are we inside a model-run repricing window right now? */
function inRunWindow(now) {
    for (const mdl of MODELS) {
        for (let back = 0; back < 30; back++) {
            const cand = new Date(now.getTime() - back * 3600000);
            const h = cand.getUTCHours();
            if (!mdl.runHoursUtc.includes(h))
                continue;
            const runStart = Date.UTC(cand.getUTCFullYear(), cand.getUTCMonth(), cand.getUTCDate(), h);
            const availAt = runStart + mdl.availabilityLagH * 3600000;
            const delta = now.getTime() - availAt;
            if (delta >= -RUN_PAUSE_BEFORE_MIN * 60000 && delta <= RUN_PAUSE_AFTER_MIN * 60000)
                return true;
        }
    }
    return false;
}
async function runMmQuoteSim(supabase, options = {}) {
    const verbose = options.verbose ?? true;
    const log = (m) => { if (verbose)
        console.log(`[mm-sim] ${m}`); };
    let quoted = 0, fillsScored = 0, resolvedScored = 0, errors = 0;
    const now = new Date();
    const paused = inRunWindow(now);
    // Fee rate for width computation
    const { data: feeCfg } = await supabase
        .from('system_config').select('value').eq('key', 'taker_fee_rate_weather').single();
    const feeRate = parseFloat(feeCfg?.value ?? '0.05') || 0.05;
    // ── 1. Score prior unscored quotes against current mids ─────────
    const { data: unscored } = await supabase
        .from('mm_quote_sim')
        .select('id, market_id, captured_at, quote_bid, quote_ask, size_usd, filled_side, fill_price')
        .is('scored_at', null)
        .lt('captured_at', new Date(Date.now() - 25 * 60000).toISOString())
        .limit(500);
    const unscoredMarketIds = [...new Set((unscored ?? []).map((r) => String(r.market_id)))];
    const marketState = new Map();
    if (unscoredMarketIds.length > 0) {
        const { data: mkts } = await supabase
            .from('markets')
            .select('id, outcome_prices, is_resolved, resolution_val')
            .in('id', unscoredMarketIds);
        for (const m of mkts ?? []) {
            const r = m;
            marketState.set(String(r.id), {
                mid: r.outcome_prices?.[0] ?? null,
                resolved: !!r.is_resolved,
                winnerYes: r.resolution_val ? r.resolution_val.toLowerCase() === 'yes' : null,
            });
        }
    }
    for (const row of unscored ?? []) {
        const q = row;
        const st = marketState.get(String(q.market_id));
        if (!st)
            continue;
        try {
            if (!q.filled_side && st.mid != null) {
                // Fill check: did the mid cross our quote?
                if (st.mid <= q.quote_bid) {
                    await supabase.from('mm_quote_sim').update({ filled_side: 'bid', fill_price: q.quote_bid }).eq('id', q.id);
                    fillsScored++;
                    continue; // PnL once resolved
                }
                if (st.mid >= q.quote_ask) {
                    await supabase.from('mm_quote_sim').update({ filled_side: 'ask', fill_price: q.quote_ask }).eq('id', q.id);
                    fillsScored++;
                    continue;
                }
            }
            if (st.resolved && st.winnerYes != null) {
                // Mark to resolution. bid fill = long YES at bid; ask fill = short YES at ask.
                let pnl = 0;
                const side = q.filled_side;
                const px = q.fill_price;
                if (side === 'bid' && px != null && px > 0) {
                    pnl = q.size_usd * ((st.winnerYes ? 1 : 0) - px) / px;
                }
                else if (side === 'ask' && px != null && px < 1) {
                    pnl = q.size_usd * (px - (st.winnerYes ? 1 : 0)) / (1 - px);
                }
                await supabase.from('mm_quote_sim').update({
                    resolved_outcome: st.winnerYes ? 'YES' : 'NO',
                    pnl_sim: Math.round(pnl * 100) / 100,
                    scored_at: new Date().toISOString(),
                }).eq('id', q.id);
                resolvedScored++;
            }
            else if (!st.resolved && !q.filled_side && st.mid != null) {
                // Unfilled and market alive: retire the quote (it would have been
                // cancelled and re-posted) — scored with zero PnL, earns nothing in
                // v0 (rebates/liquidity rewards are upside not modeled here).
                await supabase.from('mm_quote_sim').update({ pnl_sim: 0, scored_at: new Date().toISOString() }).eq('id', q.id);
            }
        }
        catch (e) {
            errors++;
            console.warn(`[mm-sim] scoring ${q.id}: ${e instanceof Error ? e.message : e}`);
        }
    }
    // ── 2. Post new paper quotes ─────────────────────────────────────
    // Fresh analyses (prefer ens_v1) on active markets with sane prices.
    const freshCutoff = new Date(Date.now() - FRESH_ANALYSIS_MIN * 60000).toISOString();
    const { data: analyses } = await supabase
        .from('weather_analyses')
        .select('market_id, true_prob, market_price, analyzed_at, flags')
        .eq('market_type', 'temperature_statistical')
        .gte('analyzed_at', freshCutoff)
        .order('analyzed_at', { ascending: false })
        .limit(300);
    const seen = new Set();
    const quotes = [];
    for (const row of analyses ?? []) {
        const a = row;
        const mid = a.market_price;
        const p = a.true_prob;
        if (seen.has(String(a.market_id)))
            continue;
        seen.add(String(a.market_id));
        if (p == null || mid == null || mid < 0.03 || mid > 0.97)
            continue;
        const flags = a.flags ?? [];
        const isEns = flags.includes('ens_v1');
        const ensN = isEns
            ? parseInt((flags.find((f) => f.startsWith('ens_members_')) ?? 'ens_members_30').replace('ens_members_', ''), 10) || 30
            : 10;
        // Half-width: taker-fee equivalent (what an informed taker "pays" to pick
        // us off is our cushion) + binomial uncertainty of our own estimate.
        const feeComponent = 2 * feeRate * mid * (1 - mid);
        const uncertainty = Math.sqrt(Math.max(p * (1 - p), 0.01) / ensN);
        const w = Math.max(MIN_HALF_WIDTH, feeComponent + uncertainty);
        const bid = Math.max(0.01, Math.min(0.97, p - w));
        const ask = Math.max(bid + 0.01, Math.min(0.99, p + w));
        quotes.push({
            market_id: a.market_id,
            p_model: Math.round(p * 1000) / 1000,
            mkt_mid: Math.round(mid * 1000) / 1000,
            quote_bid: Math.round(bid * 1000) / 1000,
            quote_ask: Math.round(ask * 1000) / 1000,
            width_c: Math.round(w * 1000) / 1000,
            size_usd: QUOTE_SIZE_USD,
            paused_for_run: paused,
            captured_at: new Date().toISOString(),
        });
    }
    if (quotes.length > 0) {
        const { error: insErr } = await supabase.from('mm_quote_sim').insert(quotes);
        if (insErr) {
            errors++;
            console.warn(`[mm-sim] insert: ${insErr.message}`);
        }
        else
            quoted = quotes.length;
    }
    log(`Done: quoted=${quoted}${paused ? ' (RUN WINDOW — flagged paused)' : ''} fills=${fillsScored} resolved=${resolvedScored} errors=${errors}`);
    return { quoted, fillsScored, resolvedScored, errors };
}
//# sourceMappingURL=mm-sim.js.map