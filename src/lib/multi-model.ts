// ============================================================
// Multi-Model AI Consensus Engine
// Calls Claude + GPT-4o in parallel, returns consensus verdict
// When both agree → bet with higher confidence
// When they disagree → skip (the #1 rule of $2M+ bots)
// ============================================================

export interface ModelAnalysis {
  model: string;
  direction: 'BUY_YES' | 'BUY_NO' | 'PASS';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  edge: number;
  estimated_prob: number;
  reasoning: string;
  raw_response?: string;
}

export interface ConsensusVerdict {
  consensus: boolean;            // both models agree on direction
  direction: 'BUY_YES' | 'BUY_NO' | 'PASS';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  avg_edge: number;
  avg_prob: number;
  models: ModelAnalysis[];
  consensus_reasoning: string;
  skip_reason?: string;          // why we skipped if no consensus
}

// ── Claude API call ────────────────────────────────────────
async function callClaude(
  prompt: string,
  timeoutMs: number = 15000
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      console.error(`[multi-model] Claude API error: ${res.status}`);
      return null;
    }

    const data = await res.json();
    return data.content?.[0]?.text || null;
  } catch (err) {
    console.error('[multi-model] Claude call failed:', err);
    return null;
  }
}

// ── GPT-4o API call ────────────────────────────────────────
async function callGPT4o(
  prompt: string,
  timeoutMs: number = 15000
): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 1000,
        temperature: 0.2,  // low temp for consistent analytical output
        messages: [
          { role: 'system', content: 'You are a quantitative prediction market analyst. Respond ONLY in valid JSON.' },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      console.error(`[multi-model] GPT-4o API error: ${res.status}`);
      return null;
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error('[multi-model] GPT-4o call failed:', err);
    return null;
  }
}

// ── Parse JSON from model response ─────────────────────────
function parseModelResponse(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

// ── Normalize edge (Claude sometimes returns 84.9 instead of 0.849) ──
function normalizeEdge(raw: number | null | undefined): number {
  if (raw == null) return 0;
  if (raw > 100) return raw / 1000;
  if (raw > 1) return raw / 100;
  return raw;
}

function normalizeProb(raw: number | null | undefined): number {
  if (raw == null) return 0.5;
  if (raw > 1) return raw / 100;
  return raw;
}

// ── Extract ModelAnalysis from parsed JSON ──────────────────
function extractAnalysis(
  parsed: Record<string, unknown>,
  modelName: string
): ModelAnalysis | null {
  const direction = parsed.direction as string;
  if (!direction || !['BUY_YES', 'BUY_NO', 'PASS'].includes(direction)) return null;

  return {
    model: modelName,
    direction: direction as ModelAnalysis['direction'],
    confidence: (['HIGH', 'MEDIUM', 'LOW'].includes(parsed.confidence as string)
      ? parsed.confidence as ModelAnalysis['confidence']
      : 'LOW'),
    edge: normalizeEdge(parsed.edge as number),
    estimated_prob: normalizeProb(
      (parsed.estimated_prob ?? parsed.true_prob ?? parsed.bracket_prob) as number
    ),
    reasoning: (parsed.reasoning as string) || '',
  };
}

// ── Confidence boosting logic ──────────────────────────────
// When both models agree, confidence goes up
// When edge estimates are close, extra confidence
function deriveConsensusConfidence(a: ModelAnalysis, b: ModelAnalysis): 'HIGH' | 'MEDIUM' | 'LOW' {
  const edgeDiff = Math.abs(a.edge - b.edge);
  const bothHigh = a.confidence === 'HIGH' && b.confidence === 'HIGH';
  const bothMedOrHigh = ['HIGH', 'MEDIUM'].includes(a.confidence) && ['HIGH', 'MEDIUM'].includes(b.confidence);

  if (bothHigh && edgeDiff < 0.03) return 'HIGH';
  if (bothMedOrHigh && edgeDiff < 0.05) return 'HIGH';
  if (bothMedOrHigh) return 'MEDIUM';
  return 'MEDIUM';  // consensus alone means at least MEDIUM
}

// ============================================================
// Main: Run multi-model consensus analysis
// ============================================================
export async function getMultiModelConsensus(
  prompt: string,
  log?: string[]
): Promise<ConsensusVerdict> {
  const hasOpenAI = !!process.env.OPENAI_API_KEY;

  // Run both models in parallel (or just Claude if no OpenAI key)
  const [claudeText, gptText] = await Promise.all([
    callClaude(prompt),
    hasOpenAI ? callGPT4o(prompt) : Promise.resolve(null),
  ]);

  const claudeParsed = parseModelResponse(claudeText);
  const gptParsed = parseModelResponse(gptText);

  const claudeAnalysis = claudeParsed ? extractAnalysis(claudeParsed, 'claude-sonnet-4') : null;
  const gptAnalysis = gptParsed ? extractAnalysis(gptParsed, 'gpt-4o') : null;

  const models: ModelAnalysis[] = [];
  if (claudeAnalysis) models.push(claudeAnalysis);
  if (gptAnalysis) models.push(gptAnalysis);

  // ── Single-model fallback (no OpenAI key yet) ──────────
  if (!hasOpenAI && claudeAnalysis) {
    log?.push('[consensus] Single-model mode (no OPENAI_API_KEY) — using Claude only');
    return {
      consensus: true,
      direction: claudeAnalysis.direction,
      confidence: claudeAnalysis.confidence,
      avg_edge: claudeAnalysis.edge,
      avg_prob: claudeAnalysis.estimated_prob,
      models,
      consensus_reasoning: `Single-model (Claude): ${claudeAnalysis.reasoning}`,
    };
  }

  // ── Both models failed ─────────────────────────────────
  if (!claudeAnalysis && !gptAnalysis) {
    log?.push('[consensus] Both models failed to produce valid analysis');
    return {
      consensus: false,
      direction: 'PASS',
      confidence: 'LOW',
      avg_edge: 0,
      avg_prob: 0.5,
      models,
      consensus_reasoning: 'Both models failed',
      skip_reason: 'model_failure',
    };
  }

  // ── One model failed ───────────────────────────────────
  if (!claudeAnalysis || !gptAnalysis) {
    const working = claudeAnalysis || gptAnalysis!;
    const failed = !claudeAnalysis ? 'Claude' : 'GPT-4o';
    log?.push(`[consensus] ${failed} failed — falling back to single model`);
    return {
      consensus: true,  // proceed with reduced confidence
      direction: working.direction,
      confidence: working.confidence === 'HIGH' ? 'MEDIUM' : 'LOW', // downgrade
      avg_edge: working.edge,
      avg_prob: working.estimated_prob,
      models,
      consensus_reasoning: `Single-model fallback (${working.model}): ${working.reasoning}`,
    };
  }

  // ── Both models produced results ───────────────────────

  // Check if directions agree
  const claudeDir = claudeAnalysis.direction;
  const gptDir = gptAnalysis.direction;

  // Both PASS → PASS
  if (claudeDir === 'PASS' && gptDir === 'PASS') {
    log?.push('[consensus] Both models say PASS');
    return {
      consensus: true,
      direction: 'PASS',
      confidence: 'HIGH',
      avg_edge: 0,
      avg_prob: (claudeAnalysis.estimated_prob + gptAnalysis.estimated_prob) / 2,
      models,
      consensus_reasoning: 'Both models agree: no edge found',
    };
  }

  // One says PASS, other has a direction → no consensus, skip
  if (claudeDir === 'PASS' || gptDir === 'PASS') {
    const active = claudeDir !== 'PASS' ? claudeAnalysis : gptAnalysis;
    const passive = claudeDir === 'PASS' ? 'Claude' : 'GPT-4o';
    log?.push(`[consensus] DISAGREE — ${passive} says PASS, ${active.model} says ${active.direction}`);
    return {
      consensus: false,
      direction: 'PASS',
      confidence: 'LOW',
      avg_edge: active.edge / 2,  // halved because only one model sees it
      avg_prob: (claudeAnalysis.estimated_prob + gptAnalysis.estimated_prob) / 2,
      models,
      consensus_reasoning: `Disagreement: ${passive} sees no edge, ${active.model} sees ${(active.edge * 100).toFixed(1)}%`,
      skip_reason: 'partial_disagreement',
    };
  }

  // Both have a direction — do they agree?
  if (claudeDir === gptDir) {
    // CONSENSUS! Both models agree on direction
    const avgEdge = (claudeAnalysis.edge + gptAnalysis.edge) / 2;
    const avgProb = (claudeAnalysis.estimated_prob + gptAnalysis.estimated_prob) / 2;
    const confidence = deriveConsensusConfidence(claudeAnalysis, gptAnalysis);

    log?.push(`[consensus] AGREE — ${claudeDir} | Claude edge=${(claudeAnalysis.edge * 100).toFixed(1)}% GPT edge=${(gptAnalysis.edge * 100).toFixed(1)}% → avg=${(avgEdge * 100).toFixed(1)}% conf=${confidence}`);

    return {
      consensus: true,
      direction: claudeDir,
      confidence,
      avg_edge: avgEdge,
      avg_prob: avgProb,
      models,
      consensus_reasoning: `Both models agree: ${claudeDir}. Claude edge ${(claudeAnalysis.edge * 100).toFixed(1)}%, GPT-4o edge ${(gptAnalysis.edge * 100).toFixed(1)}%`,
    };
  }

  // Directions disagree (e.g., BUY_YES vs BUY_NO) → hard skip
  log?.push(`[consensus] DISAGREE — Claude says ${claudeDir}, GPT says ${gptDir} → SKIP`);
  return {
    consensus: false,
    direction: 'PASS',
    confidence: 'LOW',
    avg_edge: 0,
    avg_prob: (claudeAnalysis.estimated_prob + gptAnalysis.estimated_prob) / 2,
    models,
    consensus_reasoning: `Hard disagreement: Claude says ${claudeDir}, GPT-4o says ${gptDir}`,
    skip_reason: 'direction_disagreement',
  };
}

// ============================================================
// Convenience: check if multi-model is available
// ============================================================
export function isMultiModelEnabled(): boolean {
  return !!process.env.OPENAI_API_KEY;
}
