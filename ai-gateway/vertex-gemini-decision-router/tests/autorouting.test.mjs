import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const exampleDir = path.resolve(__dirname, "..");
const apiproxyDir = path.join(exampleDir, "apiproxy");
const jscDir = path.join(apiproxyDir, "resources/jsc");
const policiesDir = path.join(apiproxyDir, "policies");
const productsDir = path.join(exampleDir, "products");

const extractCode = fs.readFileSync(path.join(jscDir, "ExtractPromptAndModel.js"), "utf8");
const autoRoutingCode = fs.readFileSync(path.join(jscDir, "AutoRouting.js"), "utf8");
const streamCode = fs.readFileSync(path.join(jscDir, "ProcessStreamEvent.js"), "utf8");
const amPrepRouterXml = fs.readFileSync(path.join(policiesDir, "AM-PrepRouterRequest.xml"), "utf8");
const scRouterXml = fs.readFileSync(path.join(policiesDir, "SC-ModelRouter.xml"), "utf8");
const proxyXml = fs.readFileSync(path.join(apiproxyDir, "proxies/default.xml"), "utf8");

const autoRoutingExecutable = autoRoutingCode
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const PRODUCT_SPECS = {
  "engineering_tier.json": {
    name: "vertex-router-engineering",
    routing: {
      coding: "gemini-4-argon",
      deep_reasoning: "gemini-4-carbon",
      general: "gemini-4-hydrogen",
      simple: "gemini-3.5-flash-lite",
    },
  },
  "support_tier.json": {
    name: "vertex-router-support",
    routing: {
      coding: "gemini-4-hydrogen",
      deep_reasoning: "gemini-4-argon",
      general: "gemini-3.5-flash-lite",
      simple: "gemini-3.5-flash-lite",
    },
  },
};

function makeContext(initial = {}) {
  const vars = { ...initial };
  return {
    vars,
    context: {
      getVariable: (k) => (vars[k] !== undefined ? vars[k] : null),
      setVariable: (k, v) => {
        vars[k] = v;
      },
    },
  };
}

function decisionResponse({
  category = "coding",
  confidence = 0.97,
  complexityScore = 2.15,
  inputTokens = 184,
  model = undefined,
} = {}) {
  const body = {
    answers: {
      category: {
        type: "choice",
        choice: category,
        confidence,
        probabilities: {
          coding: category === "coding" ? confidence : 0.01,
          deep_reasoning: category === "deep_reasoning" ? confidence : 0.01,
          general: category === "general" ? confidence : 0.01,
          simple: category === "simple" ? confidence : 0.01,
        },
      },
      complexity: {
        type: "score",
        score: complexityScore,
        confidence: 0.88,
        probabilities: { "0": 0.0, "1": 0.05, "2": 0.75, "3": 0.2 },
      },
    },
    usage: {
      total_input_tokens: inputTokens,
      input_tokens_by_modality: [{ modality: "text", tokens: inputTokens }],
      total_output_tokens: 0,
      total_tokens: inputTokens,
    },
  };
  if (model !== undefined) body.model = model;
  return JSON.stringify(body);
}

function runExtract({ pathSuffix, extractedModel = undefined, alt = undefined, bodyObj = undefined }) {
  const init = { "proxy.pathsuffix": pathSuffix };
  if (extractedModel !== undefined) init["flow.model"] = extractedModel;
  if (alt !== undefined) init["request.queryparam.alt"] = alt;
  if (bodyObj !== undefined) {
    init["request.content"] = typeof bodyObj === "string" ? bodyObj : JSON.stringify(bodyObj);
  }
  const { vars, context } = makeContext(init);
  vm.runInNewContext(extractCode, { context });
  return vars;
}

function runAutoRouting({
  routerContent = undefined,
  productFile = "engineering_tier.json",
  customAttributes = undefined,
  minConfidence = undefined,
  initialQuotaModel = "auto",
} = {}) {
  const vars = { "flow.quota_model": initialQuotaModel };
  if (customAttributes !== undefined) {
    vars["verifyapikey.VA-VerifyAPIKey.apiproduct.name"] = "custom-product";
    for (const [cat, mod] of Object.entries(customAttributes)) {
      vars[`verifyapikey.VA-VerifyAPIKey.apiproduct.routing.model.${cat}`] = mod;
    }
  } else {
    const spec = PRODUCT_SPECS[productFile];
    vars["verifyapikey.VA-VerifyAPIKey.apiproduct.name"] = spec.name;
    for (const [cat, mod] of Object.entries(spec.routing)) {
      vars[`verifyapikey.VA-VerifyAPIKey.apiproduct.routing.model.${cat}`] = mod;
    }
  }
  if (minConfidence !== undefined) {
    vars["verifyapikey.VA-VerifyAPIKey.apiproduct.routing.confidence.min"] = String(minConfidence);
  }
  if (routerContent !== undefined) {
    vars["routerResponse.content"] = routerContent;
  }
  const { vars: outVars, context } = makeContext(vars);
  vm.runInNewContext(autoRoutingCode, { context });
  return outVars;
}

describe("1. ExtractPromptAndModel.js — URI detection, quota_model isolation & prompt windowing", () => {
  it("detects buffered /models/auto:generateContent and pins quota_model to 'auto'", () => {
    const v = runExtract({
      pathSuffix: "/models/auto:generateContent",
      extractedModel: "auto",
      bodyObj: { contents: [{ role: "user", parts: [{ text: "Write unit tests" }] }] },
    });
    assert.strictEqual(v["flow.is_auto_route"], "true");
    assert.strictEqual(v["flow.is_valid_gemini_path"], "true");
    assert.strictEqual(v["flow.is_streaming"], "false");
    assert.strictEqual(v["flow.gemini_method"], "generateContent");
    assert.strictEqual(v["flow.quota_model"], "auto");
    assert.strictEqual(v["flow.target_model"], "");
    assert.strictEqual(v["flow.userPrompt"], "Write unit tests");
    assert.strictEqual(v["flow.routerInput"], "Write unit tests");
  });

  it("detects SSE /models/auto:streamGenerateContent and enforces ?alt=sse upstream", () => {
    const v = runExtract({
      pathSuffix: "/models/auto:streamGenerateContent",
      extractedModel: "auto",
      bodyObj: { contents: [{ role: "user", parts: [{ text: "Stream answer" }] }] },
    });
    assert.strictEqual(v["flow.is_auto_route"], "true");
    assert.strictEqual(v["flow.is_streaming"], "true");
    assert.strictEqual(v["flow.gemini_method"], "streamGenerateContent?alt=sse");
  });

  it("supports short /auto and /auto:streamGenerateContent paths", () => {
    const buf = runExtract({ pathSuffix: "/auto", bodyObj: { prompt: "Hi" } });
    assert.strictEqual(buf["flow.is_auto_route"], "true");
    assert.strictEqual(buf["flow.is_streaming"], "false");
    assert.strictEqual(buf["flow.quota_model"], "auto");

    const sse = runExtract({ pathSuffix: "/auto:streamGenerateContent", bodyObj: { prompt: "Hi" } });
    assert.strictEqual(sse["flow.is_auto_route"], "true");
    assert.strictEqual(sse["flow.is_streaming"], "true");
  });

  it("supports direct Vertex AI Gemini calls without triggering auto-routing", () => {
    const v = runExtract({
      pathSuffix: "/models/gemini-4-hydrogen:generateContent",
      extractedModel: "gemini-4-hydrogen",
      bodyObj: { contents: [{ role: "user", parts: [{ text: "Hello" }] }] },
    });
    assert.strictEqual(v["flow.is_auto_route"], "false");
    assert.strictEqual(v["flow.is_valid_gemini_path"], "true");
    assert.strictEqual(v["flow.quota_model"], "gemini-4-hydrogen");
    assert.strictEqual(v["flow.target_model"], "gemini-4-hydrogen");
    assert.strictEqual(v["flow.autoRouted"], "false");
  });

  it("rejects bare /models/foo without :generateContent or :streamGenerateContent", () => {
    const v = runExtract({ pathSuffix: "/models/gemini-4-hydrogen", extractedModel: "gemini-4-hydrogen" });
    assert.strictEqual(v["flow.is_valid_gemini_path"], "false");
    assert.strictEqual(v["flow.is_auto_route"], "false");
  });

  it("skips thought parts and windows >8000 char prompts preserving both head and tail", () => {
    const head = "SYSTEM_CONTEXT_START " + "A".repeat(3000);
    const tail = "B".repeat(6500) + " FINAL_CODING_QUESTION: implement quicksort in Rust.";
    const v = runExtract({
      pathSuffix: "/models/auto:generateContent",
      extractedModel: "auto",
      bodyObj: {
        systemInstruction: { parts: [{ text: head }] },
        contents: [
          { role: "model", parts: [{ text: "secret chain of thought", thought: true }] },
          { role: "user", parts: [{ text: tail }] },
        ],
      },
    });
    assert.ok(!v["flow.userPrompt"].includes("secret chain of thought"));
    assert.ok(v["flow.userPrompt"].length > 9000, "Model Armor still sees full prompt");
    assert.ok(v["flow.routerInput"].length <= 8010, "Router input is capped for low latency");
    assert.ok(v["flow.routerInput"].startsWith("SYSTEM_CONTEXT_START"));
    assert.ok(v["flow.routerInput"].endsWith("FINAL_CODING_QUESTION: implement quicksort in Rust."));
  });
});

describe("2. AM-PrepRouterRequest.xml & SC-ModelRouter.xml — Gemini Decision 1 contract", () => {
  it("builds valid JSON for POST /v1beta/decisions with choice + score questions", () => {
    const match = amPrepRouterXml.match(/<Payload contentType="application\/json">([\s\S]*?)<\/Payload>/);
    assert.ok(match, "AM-PrepRouterRequest must contain JSON payload");
    const samplePrompt = 'Fix "TypeError" in line 12\nand add tests';
    const escaped = JSON.stringify(samplePrompt).slice(1, -1);
    const rendered = match[1].trim().replace("{escapeJSON(flow.routerInput)}", escaped);
    const parsed = JSON.parse(rendered);

    assert.strictEqual(parsed.model, "gemini-decision-1");
    assert.strictEqual(parsed.input, samplePrompt);
    assert.strictEqual(parsed.questions.category.type, "choice");
    assert.deepStrictEqual(Object.keys(parsed.questions.category.criteria).sort(), [
      "coding",
      "deep_reasoning",
      "general",
      "simple",
    ]);
    assert.strictEqual(parsed.questions.complexity.type, "score");
    assert.strictEqual(parsed.questions.complexity.criteria.length, 4);
  });

  it("authenticates SC-ModelRouter via GoogleAccessToken to generativelanguage.googleapis.com/v1beta/decisions", () => {
    assert.match(scRouterXml, /<URL>https:\/\/generativelanguage\.googleapis\.com\/v1beta\/decisions<\/URL>/);
    assert.match(scRouterXml, /<GoogleAccessToken>/);
    assert.match(scRouterXml, /https:\/\/www\.googleapis\.com\/auth\/generative-language/);
    assert.match(scRouterXml, /https:\/\/www\.googleapis\.com\/auth\/cloud-platform/);
    assert.match(scRouterXml, /continueOnError="true"/);
  });
});

describe("3. AutoRouting.js — Calibrated routing, persona tiers & resilience", () => {
  it("routes all 4 categories to the Engineering Gemini 4 lineup and records 0 output tokens", () => {
    const expected = PRODUCT_SPECS["engineering_tier.json"].routing;
    for (const [category, expectedModel] of Object.entries(expected)) {
      const v = runAutoRouting({
        routerContent: decisionResponse({ category, confidence: 0.94, complexityScore: 2.4, inputTokens: 192 }),
        productFile: "engineering_tier.json",
      });
      assert.strictEqual(v["flow.routerCategory"], category);
      assert.strictEqual(v["flow.target_model"], expectedModel);
      assert.strictEqual(v["flow.model"], expectedModel);
      assert.strictEqual(v["flow.quota_model"], "auto", "quota_model must stay 'auto' for LLMTokenQuota");
      assert.strictEqual(v["flow.routerEngine"], "gemini-decision-1");
      assert.strictEqual(v["flow.routerConfidence"], "0.94");
      assert.strictEqual(v["flow.routerComplexity"], "2.40");
      assert.strictEqual(v["flow.routerInputTokens"], "192");
      assert.strictEqual(v["flow.routerOutputTokens"], "0");
      assert.strictEqual(v["flow.autoRouted"], "true");
    }
  });

  it("routes the exact same classification to different models per API Product persona", () => {
    const body = decisionResponse({ category: "deep_reasoning", confidence: 0.91 });
    const eng = runAutoRouting({ routerContent: body, productFile: "engineering_tier.json" });
    const sup = runAutoRouting({ routerContent: body, productFile: "support_tier.json" });

    assert.strictEqual(eng["flow.target_model"], "gemini-4-carbon");
    assert.strictEqual(sup["flow.target_model"], "gemini-4-argon");
  });

  it("falls back to routing.model.general when confidence is below routing.confidence.min", () => {
    const v = runAutoRouting({
      routerContent: decisionResponse({ category: "deep_reasoning", confidence: 0.41 }),
      productFile: "engineering_tier.json",
      minConfidence: 0.6,
    });
    assert.strictEqual(v["flow.routerRawCategory"], "deep_reasoning");
    assert.strictEqual(v["flow.routerCategory"], "general");
    assert.strictEqual(v["flow.routerLowConfidence"], "true");
    assert.strictEqual(v["flow.target_model"], "gemini-4-hydrogen");
  });

  it("fails open to routing.model.general when SC-ModelRouter times out or returns an error", () => {
    for (const bad of [undefined, "", "not-json", '{"error":{"code":429,"message":"rate limit"}}']) {
      const v = runAutoRouting({ routerContent: bad, productFile: "engineering_tier.json" });
      assert.strictEqual(v["flow.target_model"], "gemini-4-hydrogen");
      assert.strictEqual(v["flow.autoRouted"], "true");
    }
  });

  it("fails closed (target_model = null) when a product has no routing.model.* attributes", () => {
    const v = runAutoRouting({
      routerContent: decisionResponse({ category: "coding" }),
      customAttributes: {},
    });
    assert.strictEqual(v["flow.target_model"], null);
    assert.match(proxyXml, /<Name>RF-MissingRoutingConfig<\/Name>/);
  });

  it("contains zero hardcoded model names and zero prompt regexes in executable JS", () => {
    for (const forbidden of [
      "gemini-4-carbon",
      "gemini-4-argon",
      "gemini-4-hydrogen",
      "gemini-3.5-flash-lite",
      '"flow.userPrompt"',
      '"flow.routerInput"',
    ]) {
      assert.ok(
        !autoRoutingExecutable.includes(forbidden),
        `AutoRouting.js must not contain literal ${forbidden}`
      );
    }
  });
});

describe("4. ProcessStreamEvent.js — SSE EventFlow token accounting", () => {
  it("resets flow.stream_done on every chunk and sets 'true' only on finishReason", () => {
    const { vars, context } = makeContext({ "flow.stream_done": "true" });

    // Chunk 1: intermediate text chunk with partial usageMetadata (no finishReason)
    vars["response.event.current.content"] =
      'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":1,"totalTokenCount":11}}\n\n';
    vm.runInNewContext(streamCode, { context });
    assert.strictEqual(vars["flow.stream_done"], "false");

    // Chunk 2: final chunk with finishReason
    vars["response.event.current.content"] =
      'data: {"candidates":[{"content":{"parts":[{"text":"!"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"thoughtsTokenCount":3,"totalTokenCount":18}}\n\n';
    vm.runInNewContext(streamCode, { context });
    assert.strictEqual(vars["flow.stream_done"], "true");
    assert.strictEqual(vars["flow.totalTokenCount"], "18");

    // Chunk 3: trailing [DONE] frame must reset flow.stream_done back to "false"
    vars["response.event.current.content"] = "data: [DONE]\n\n";
    vm.runInNewContext(streamCode, { context });
    assert.strictEqual(vars["flow.stream_done"], "false");
  });
});

describe("5. API Products — routing.model.* completeness & LLM operation entitlement", () => {
  for (const [fileName, spec] of Object.entries(PRODUCT_SPECS)) {
    it(`${fileName} declares all 4 routing attributes and entitles every mapped model + 'auto'`, () => {
      const prod = JSON.parse(fs.readFileSync(path.join(productsDir, fileName), "utf8"));
      const attrs = Object.fromEntries(prod.attributes.map((a) => [a.name, a.value]));

      for (const [cat, expectedModel] of Object.entries(spec.routing)) {
        assert.strictEqual(attrs[`routing.model.${cat}`], expectedModel);
      }

      const entitled = new Set(
        prod.llmOperationGroup.operationConfigs.flatMap((oc) => oc.llmOperations.map((op) => op.model))
      );
      assert.ok(entitled.has("auto"), `${fileName} must entitle model 'auto'`);
      for (const model of Object.values(spec.routing)) {
        assert.ok(entitled.has(model), `${fileName} routes to ${model} so it must entitle it`);
      }
    });
  }
});
