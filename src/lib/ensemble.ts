// ============================================================
// ARBITER — Multi-Model Ensemble Analysis Library
// Runs Claude, GPT-4o, and Gemini in parallel for prediction
// market analysis, then computes weighted consensus
// ============================================================

// ── Interfaces ─────────────────────────────────────────────

export interface ModelResponse {
  model: string;
  direction: 'BUY_YES' | 'BUY_NO' | 'PASS';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  edge: number;
  reasoning: string;
  latency_ms: number;
}

export interface EnsembleResult {
  consensus_direction: 'BUY_YES' | 'BUY_NO' | 'PASS';
  consensus_confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  consensus_edge: number;
  agreement_score: number; // 0-1, how much models agree on direction
  model_responses: ModelResponse[];
  used_models: string[];
}

// ── Weights & Config ───────────────────────────────────────
const MODEL_WEIGHTS = {
  claude: 0.40,
  gpt4o: 0.35,
  gemini: 0.25,
};

const CONFIDENCE_LEVELS = {
  HIGH: 2,
  MEDIUM: 1,
  LOW: 0,
};

const CONFIDENCE_FROM_LEVEL = {
  2: 'HIGH' as const,
  1: 'MEDIUM' as const,
  0: 'LOW' as const,
};

// ── Type for internal model call result ────────────────────
interface ModelCallResult {
  direction: 'BUY_YES' | 'BUY_NO' | 'PASS' | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  edge: number | null;
  reasoning: string;
  latency_ms: number;
}

// ── Utility: Parse model response ──────────────────────────
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

// ── Utility: Normalize edge value ──────────────────────────
function normalizeEdge(raw: number | null | undefined): number | null {
  if (raw == null) return null;
  if (raw > 100) return raw / 1000; // 84.9 -> 0.849
  if (raw > 1) return raw / 100; // 8.49 -> 0.0849
  return raw;
}

// ── Utility: Extract direction from response ───────────────
function extractDirection(
  parsed: Record<string, unknown> | null
): 'BUY_YES' | 'BUY_NO' | 'PASS' | null {
  if (!parsed) return null;
  const dir = parsed.direction as string;
  if (['BUY_YES', 'BUY_NO', 'PASS'].includes(dir)) {
    return dir as 'BUY_YES' | 'BUY_NO' | 'PASS';
  }
  return null;
}

// ── Utility: Extract confidence from response ──────────────
function extractConfidence(
  parsed: Record<string, unknown> | null
): 'HIGH' | 'MEDIUM' | 'LOW' | null {
  if (!parsed) return null;
  const conf = parsed.confidence as string;
  if (['HIGH', 'MEDIUM', 'LOW'].includes(conf)) {
    return conf as 'HIGH' | 'MEDIUM' | 'LOW';
  }
  return null;
}

// ── Utility: Extract edge from response ────────────────────
function extractEdge(parsed: Record<string, unknown> | null): number | null {
  if (!parsed) return null;
  const raw = parsed.edge as number;
  return normalizeEdge(raw);
}

// ── Utility: Extract reasoning from response ───────────────
function extractReasoning(parsed: Record<string, unknown> | null): string {
  if (!parsed) return '';
  const reasoning = parsed.reasoning ?? parsed.analysis ?? '';
  return String(reasoning || '').slice(0, 500); // truncate to 500 chars
}

// ============================================================
// Model Callers
// ============================================================

// ── Claude Caller ──────────────────────────────────────────
async function callClaude(prompt: string): Promise<ModelCallResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const start = Date.now();

  if (!apiKey) {
    return {
      direction: null,
      confidence: null,
      edge: null,
      reasoning: 'ANTHROPIC_API_KEY not set',
      latency_ms: Date.now() - start,
    };
  }

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
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.error(`[ensemble] Claude API error: ${res.status}`);
      return {
        direction: null,
        confidence: null,
        edge: null,
        reasoning: `API error: ${res.status}`,
        latency_ms: Date.now() - start,
      };
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || null;
    const parsed = parseModelResponse(text);

    return {
      direction: extractDirection(parsed),
      confidence: extractConfidence(parsed),
      edge: extractEdge(parsed),
      reasoning: extractReasoning(parsed),
      latency_ms: Date.now() - start,
    };
  } catch (err) {
    console.error('[ensemble] Claude call failed:', err);
    return {
      direction: null,
      confidence: null,
      edge: null,
      reasoning: `Error: ${err instanceof Error ? err.message : 'unknown'}`,
      latency_ms: Date.now() - start,
    };
  }
}

// ── GPT-4o Caller ──────────────────────────────────────────
async function callGPT4o(prompt: string): Promise<ModelCallResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  const start = Date.now();

  if (!apiKey) {
    return {
      direction: null,
      confidence: null,
      edge: null,
      reasoning: 'OPENAI_API_KEY not set',
      latency_ms: Date.now() - start,
    };
  }

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
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: 'You are a quantitative prediction market analyst. Respond ONLY in valid JSON.',
          },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.error(`[ensemble] GPT-4o API error: ${res.status}`);
      return {
        direction: null,
        confidence: null,
        edge: null,
        reasoning: `API error: ${res.status}`,
        latency_ms: Date.now() - start,
      };
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || null;
    const parsed = parseModelResponse(text);

    return {
      direction: extractDirection(parsed),
      confidence: extractConfidence(parsed),
      edge: extractEdge(parsed),
      reasoning: extractReasoning(parsed),
      latency_ms: Date.now() - start,
    };
  } catch (err) {
    console.error('[ensemble] GPT-4o call failed:', err);
    return {
      direction: null,
      confidence: null,
      edge: null,
      reasoning: `Error: ${err instanceof Error ? err.message : 'unknown'}`,
      latency_ms: Date.now() - start,
    };
  }
}

// ── Gemini Caller ──────────────────────────────────────────
async function callGemini(prompt: string): Promise<ModelCallResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  const start = Date.now();

  if (!apiKey) {
    return {
      direction: null,
      confidence: null,
      edge: null,
      reasoning: 'GEMINI_API_KEY not set',
      latency_ms: Date.now() - start,
    };
  }

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: prompt,
                },
              ],
            },
          ],
          generationConfig: {
            maxOutputTokens: 1000,
            temperature: 0.2,
          },
          systemInstruction: {
            parts: {
              text: 'You are a quantitative prediction market analyst. Respond ONLY in valid JSON.',
            },
          },
        }),
        signal: AbortSignal.timeout(15000),
      }
    );

    if (!res.ok) {
      console.error(`[ensemble] Gemini API error: ${res.status}`);
      return {
        direction: null,
        confidence: null,
        edge: null,
        reasoning: `API error: ${res.status}`,
        latency_ms: Date.now() - start,
      };
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || null;
    const parsed = parseModelResponse(text);

    return {
      direction: extractDirection(parsed),
      confidence: extractConfidence(parsed),
      edge: extractEdge(parsed),
      reasoning: extractReasoning(parsed),
      latency_ms: Date.now() - start,
    };
  } catch (err) {
    console.error('[ensemble] Gemini call failed:', err);
    return {
      direction: null,
      confidence: null,
      edge: null,
      reasoning: `Error: ${err instanceof Error ? err.message : 'unknown'}`,
      latency_ms: Date.now() - start,
    };
  }
}

// ============================================================
// Consensus Computation
// ============================================================

function computeConsensus(
  claudeResult: ModelCallResult,
  gptResult: ModelCallResult,
  geminiResult: ModelCallResult
): { direction: 'BUY_YES' | 'BUY_NO' | 'PASS'; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; edge: number; agreement_score: number } {
  // Collect valid responses
  const responses: Array<{ model: string; result: ModelCallResult; weight: number }> = [];

  if (claudeResult.direction !== null) {
    responses.push({ model: 'claude', result: claudeResult, weight: MODEL_WEIGHTS.claude });
  }
  if (gptResult.direction !== null) {
    responses.push({ model: 'gpt4o', result: gptResult, weight: MODEL_WEIGHTS.gpt4o });
  }
  if (geminiResult.direction !== null) {
    responses.push({ model: 'gemini', result: geminiResult, weight: MODEL_WEIGHTS.gemini });
  }

  // Handle graceful degradation: no valid responses
  if (responses.length === 0) {
    return {
      direction: 'PASS',
      confidence: 'LOW',
      edge: 0,
      agreement_score: 0,
    };
  }

  // Check if all responding models agree on direction
  const directions = responses.map((r) => r.result.direction);
  const allAgree = directions.every((d) => d === directions[0]);

  // Calculate agreement score (fraction of models that agree on direction)
  const majorityDirection = directions[0];
  const agreeCount = directions.filter((d) => d === majorityDirection).length;
  const agreement_score = agreeCount / directions.length;

  // If models disagree on direction → PASS (disagreement = uncertainty)
  if (!allAgree) {
    return {
      direction: 'PASS',
      confidence: 'LOW',
      edge: 0,
      agreement_score,
    };
  }

  // All models agree on direction
  const consensusDirection = majorityDirection!;

  // Compute weighted average edge and confidence
  let totalWeight = 0;
  let weightedEdge = 0;
  let weightedConfidenceScore = 0;

  for (const { result, weight } of responses) {
    totalWeight += weight;
    if (result.edge !== null) {
      weightedEdge += result.edge * weight;
    }
    if (result.confidence !== null) {
      weightedConfidenceScore += CONFIDENCE_LEVELS[result.confidence] * weight;
    }
  }

  const avgEdge = totalWeight > 0 ? weightedEdge / totalWeight : 0;
  const avgConfidenceScore = totalWeight > 0 ? weightedConfidenceScore / totalWeight : 0;

  // Downgrade confidence by one level if only 1 model responded
  let consensusConfidence: 'HIGH' | 'MEDIUM' | 'LOW';
  if (responses.length === 1) {
    // Downgrade: HIGH→MEDIUM, MEDIUM→LOW, LOW→LOW
    const singleModelConf = responses[0].result.confidence;
    if (singleModelConf === 'HIGH') {
      consensusConfidence = 'MEDIUM';
    } else if (singleModelConf === 'MEDIUM') {
      consensusConfidence = 'LOW';
    } else {
      consensusConfidence = 'LOW';
    }
  } else {
    // Map weighted average back to confidence level (round to nearest)
    const roundedScore = Math.round(avgConfidenceScore);
    consensusConfidence = CONFIDENCE_FROM_LEVEL[roundedScore as keyof typeof CONFIDENCE_FROM_LEVEL] || 'LOW';
  }

  return {
    direction: consensusDirection,
    confidence: consensusConfidence,
    edge: avgEdge,
    agreement_score,
  };
}

// ============================================================
// Main Ensemble Function
// ============================================================

export async function ensembleAnalyze(prompt: string): Promise<EnsembleResult> {
  // Run all 3 models in parallel using Promise.allSettled
  const [claudeSettled, gptSettled, geminiSettled] = await Promise.allSettled([
    callClaude(prompt),
    callGPT4o(prompt),
    callGemini(prompt),
  ]);

  // Extract results (default to null on rejection)
  const claudeResult =
    claudeSettled.status === 'fulfilled'
      ? claudeSettled.value
      : {
          direction: null,
          confidence: null,
          edge: null,
          reasoning: 'Request rejected',
          latency_ms: 0,
        };

  const gptResult =
    gptSettled.status === 'fulfilled'
      ? gptSettled.value
      : {
          direction: null,
          confidence: null,
          edge: null,
          reasoning: 'Request rejected',
          latency_ms: 0,
        };

  const geminiResult =
    geminiSettled.status === 'fulfilled'
      ? geminiSettled.value
      : {
          direction: null,
          confidence: null,
          edge: null,
          reasoning: 'Request rejected',
          latency_ms: 0,
        };

  // Track which models responded with valid data
  const used_models: string[] = [];
  const model_responses: ModelResponse[] = [];

  if (claudeResult.direction !== null) {
    used_models.push('claude');
    model_responses.push({
      model: 'claude',
      direction: claudeResult.direction,
      confidence: claudeResult.confidence || 'LOW',
      edge: claudeResult.edge || 0,
      reasoning: claudeResult.reasoning,
      latency_ms: claudeResult.latency_ms,
    });
  }

  if (gptResult.direction !== null) {
    used_models.push('gpt4o');
    model_responses.push({
      model: 'gpt4o',
      direction: gptResult.direction,
      confidence: gptResult.confidence || 'LOW',
      edge: gptResult.edge || 0,
      reasoning: gptResult.reasoning,
      latency_ms: gptResult.latency_ms,
    });
  }

  if (geminiResult.direction !== null) {
    used_models.push('gemini');
    model_responses.push({
      model: 'gemini',
      direction: geminiResult.direction,
      confidence: geminiResult.confidence || 'LOW',
      edge: geminiResult.edge || 0,
      reasoning: geminiResult.reasoning,
      latency_ms: geminiResult.latency_ms,
    });
  }

  // Compute consensus
  const consensus = computeConsensus(claudeResult, gptResult, geminiResult);

  // Log results
  console.log(
    `[ensemble] Models responded: ${used_models.join(', ') || 'none'} | Direction: ${consensus.direction} | Confidence: ${consensus.confidence} | Agreement: ${(consensus.agreement_score * 100).toFixed(1)}%`
  );

  return {
    consensus_direction: consensus.direction,
    consensus_confidence: consensus.confidence,
    consensus_edge: consensus.edge,
    agreement_score: consensus.agreement_score,
    model_responses,
    used_models,
  };
}
