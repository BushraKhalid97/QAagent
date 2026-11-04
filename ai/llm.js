"use strict";
/**
 * Thin wrapper around the Anthropic SDK used by the planner and the executor.
 * - Streams every request (planning output can be long) and returns the final message.
 * - Prompt-caches the stable prefix (system prompt + tool definitions).
 * - Server-side refusal fallbacks are on by default (QA_AI_FALLBACKS=0 turns them off).
 * - Tracks token usage so the report can show what the run cost.
 */
const { Anthropic } = require("@anthropic-ai/sdk");

const PRICES = { // USD per 1M tokens: input, output, cache read, cache write (5-min)
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};

class Claude {
  constructor({ model = "claude-opus-5-5", effort = "medium", fallbacks = process.env.QA_AI_FALLBACKS !== "0" } = {}) {
    this.model = model;
    this.effort = effort;
    this.fallbacks = fallbacks;
    this.client = new Anthropic(); // reads ANTHROPIC_API_KEY (or an `ant auth login` profile)
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
  }

  /** params: { system, messages, tools?, max_tokens?, output_config?, effort? } → final Message */
  async create(params) {
    const { effort, ...rest } = params;
    const body = {
      model: this.model,
      max_tokens: 32000,
      cache_control: { type: "ephemeral" },
      ...rest,
      output_config: { ...(rest.output_config || {}), effort: effort || this.effort },
    };
    let msg;
    for (let attempt = 0; ; attempt++) {
      try {
        const stream = this.fallbacks
          ? this.client.beta.messages.stream({ ...body, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
          : this.client.messages.stream(body);
        msg = await stream.finalMessage();
        break;
      } catch (e) {
        // SDK already retried 429/5xx twice; give long rate-limit waits one more chance.
        if (e instanceof Anthropic.RateLimitError && attempt < 2) { await new Promise((r) => setTimeout(r, 30000)); continue; }
        if (e instanceof Anthropic.AuthenticationError) throw new Error("Claude API key missing or invalid. Set ANTHROPIC_API_KEY.");
        throw e;
      }
    }
    const u = msg.usage || {};
    this.usage.input += u.input_tokens || 0;
    this.usage.output += u.output_tokens || 0;
    this.usage.cacheRead += u.cache_read_input_tokens || 0;
    this.usage.cacheWrite += u.cache_creation_input_tokens || 0;
    this.usage.requests++;
    if (msg.stop_reason === "refusal") throw new Error(`Claude declined this request (${(msg.stop_details || {}).category || "policy"})`);
    return msg;
  }

  costUsd() {
    const p = PRICES[this.model];
    if (!p) return null;
    const u = this.usage;
    return (u.input * p[0] + u.output * p[1] + u.cacheRead * p[2] + u.cacheWrite * p[3]) / 1e6;
  }
}

/** First text block of a message. */
function textOf(msg) {
  const b = (msg.content || []).find((x) => x.type === "text");
  return b ? b.text : "";
}

module.exports = { Claude, textOf };
