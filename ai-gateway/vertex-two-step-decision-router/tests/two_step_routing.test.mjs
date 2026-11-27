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
const evaluateStep1Code = fs.readFileSync(path.join(jscDir, "EvaluateStep1.js"), "utf8");
const resolveFinalCode = fs.readFileSync(path.join(jscDir, "ResolveFinalRoute.js"), "utf8");
const streamCode = fs.readFileSync(path.join(jscDir, "ProcessStreamEvent.js"), "utf8");
const amStep1Xml = fs.readFileSync(path.join(policiesDir, "AM-PrepStep1Decision.xml"), "utf8");
const scStep1Xml = fs.readFileSync(path.join(policiesDir, "SC-Step1DecisionRouter.xml"), "utf8");
const scStep2Xml = fs.readFileSync(path.join(policiesDir, "SC-Step2FlashLiteRouter.xml"), "utf8");
const proxyXml = fs.readFileSync(path.join(apiproxyDir, "proxies/default.xml"), "utf8");

const resolveExecutable = resolveFinalCode
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const PRODUCT_SPECS = {
  "engineering_tier.json": {
    name: "vertex-two-step-engineering",
    threshold: "0.70",
    routing: {
      coding: "gemini-4-argon",
      deep_reasoning: "gemini-4-carbon",
      general: "gemini-4-hydrogen",
      simple: "gemini-3.5-flash-lite",
    },
  },
  "support_tier.json": {
    name: "vertex-two-step-support",
    threshold: "0.70",
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

function step1DecisionJson({
  category = "coding",
  confidence = 0.92,
  probabilities = undefined,
  complexityScore = 2.1,
  inputTokens = 180,
} = {}) {
  const probs = probabilities || {
    coding: category === "coding" ? confidence : (1 - confidence) / 3,
    deep_reasoning: category === "deep_reasoning" ? confidence : (1 - confidence) / 3,
    general: category === "general" ? confidence : (1 - confidence) / 3,
    simple: category === "simple" ? confidence : (1 - confidence) / 3,
  };
  return JSON.stringify({
    answers: {
      category: {
        type: "choice",
        choice: category,
        confidence,
        probabilities: probs,
      },
      complexity: {
        type: "score",
        score: complexityScore,
        confidence: 0.85,
        probabilities: { "0": 0, "1": 0.1, "2": 0.7, "3": 0.2 },
      },
    },
    usage: {
      total_input_tokens: inputTokens,
      total_output_tokens: 0,
      total_tokens: inputTokens,
    },
  });
}

function step2FlashLiteJson({
  category = "deep_reasoning",
  includeThoughtPart = false,
  totalTokens = 96,
  modelVersion = "gemini-3.5-flash-lite",
} = {}) {
  const parts = [];
  if (includeThoughtPart) {
    parts.push({ text: "Let me weigh coding vs deep_reasoning...", thought: true });
  }
  parts.push({ text: JSON.stringify({ category }) });
  return JSON.stringify({
    candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 88, candidatesTokenCount: 8, totalTokenCount: totalTokens },
    modelVersion,
  });
}

function runTwoStepPipeline({
  prompt = "Write a Python function",
  step1ResponseContent = undefined,
  step2ResponseContent = undefined,
  productFile = "engineering_tier.json",
  customAttributes = undefined,
  headerThreshold = undefined,
} = {}) {
  const init = {
    "proxy.pathsuffix": "/models/auto:generateContent",
    "flow.model": "auto",
    "request.content": prompt ? JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }) : "{}",
  };
  if (headerThreshold !== undefined) {
    init["request.header.x-router-confidence-threshold"] = String(headerThreshold);
  }
  if (customAttributes !== undefined) {
    init["verifyapikey.VA-VerifyAPIKey.apiproduct.name"] = "custom-product";
    for (const [k, v] of Object.entries(customAttributes)) {
      init[`verifyapikey.VA-VerifyAPIKey.apiproduct.${k}`] = v;
    }
  } else {
    const spec = PRODUCT_SPECS[productFile];
    init["verifyapikey.VA-VerifyAPIKey.apiproduct.name"] = spec.name;
    init["verifyapikey.VA-VerifyAPIKey.apiproduct.routing.confidence.threshold"] = spec.threshold;
    for (const [cat, mod] of Object.entries(spec.routing)) {
      init[`verifyapikey.VA-VerifyAPIKey.apiproduct.routing.model.${cat}`] = mod;
    }
  }

  const { vars, context } = makeContext(init);
  vm.runInNewContext(extractCode, { context });

  if (vars["flow.routerInput"] && step1ResponseContent !== undefined) {
    vars["routerStep1Response.content"] = step1ResponseContent;
  }
  vm.runInNewContext(evaluateStep1Code, { context });

  const step2Triggered = Boolean(vars["flow.routerInput"]) && vars["flow.need_step2_router"] === "true";
  if (step2Triggered && step2ResponseContent !== undefined) {
    vars["routerStep2Response.content"] = step2ResponseContent;
  }
  vm.runInNewContext(resolveFinalCode, { context });

  return { vars, step2Triggered };
}

describe("1. Step 1 Fast-Path (>= 70% confidence -> Gemini Decision 1, Step 2 skipped)", () => {
  it("accepts Step 1 immediately when confidence >= 0.70 (including exact 0.70 boundary)", () => {
    for (const conf of [0.70, 0.85, 0.98]) {
      const { vars, step2Triggered } = runTwoStepPipeline({
        prompt: "Implement merge sort in Go",
        step1ResponseContent: step1DecisionJson({ category: "coding", confidence: conf, inputTokens: 175 }),
        step2ResponseContent: step2FlashLiteJson({ category: "simple" }), // must be ignored!
      });
      assert.strictEqual(step2Triggered, false, `Step 2 must not run at confidence=${conf}`);
      assert.strictEqual(vars["flow.need_step2_router"], "false");
      assert.strictEqual(vars["flow.routerStep"], "step1-decision-1");
      assert.strictEqual(vars["flow.routerEngine"], "gemini-decision-1");
      assert.strictEqual(vars["flow.routerCategory"], "coding");
      assert.strictEqual(vars["flow.target_model"], "gemini-4-argon");
      assert.strictEqual(vars["flow.quota_model"], "auto");
      assert.strictEqual(vars["flow.step1InputTokens"], "175");
      assert.strictEqual(vars["flow.step2Tokens"], "0");
    }
  });
});

describe("2. Step 2 Ambiguous Escalation (< 70% confidence -> Gemini 3.5 Flash-Lite)", () => {
  it("escalates to Step 2 when confidence is 0.69 (< 0.70) and passes Step 1 probabilities as context", () => {
    const probs = { coding: 0.44, deep_reasoning: 0.69 > 1 ? 0 : 0.46, general: 0.06, simple: 0.04 };
    const { vars, step2Triggered } = runTwoStepPipeline({
      prompt: "Compare B-tree vs LSM-tree write amplification and show a pseudocode compaction loop.",
      step1ResponseContent: step1DecisionJson({
        category: "coding",
        confidence: 0.69,
        probabilities: probs,
        inputTokens: 210,
      }),
      step2ResponseContent: step2FlashLiteJson({
        category: "deep_reasoning",
        includeThoughtPart: true,
        totalTokens: 112,
      }),
    });

    assert.strictEqual(step2Triggered, true);
    assert.strictEqual(vars["flow.need_step2_router"], "true");

    // Verify Step 2 request payload embeds Step 1 probabilities and structured JSON schema
    const step2Req = JSON.parse(vars["flow.step2RequestBody"]);
    assert.ok(step2Req.contents[0].parts[0].text.includes(JSON.stringify(probs)));
    assert.strictEqual(step2Req.generationConfig.responseMimeType, "application/json");
    assert.deepStrictEqual(step2Req.generationConfig.responseSchema.properties.category.enum, [
      "coding",
      "deep_reasoning",
      "simple",
      "general",
    ]);

    // Verify Step 2 overrode ambiguous Step 1 "coding" with "deep_reasoning" -> gemini-4-carbon
    assert.strictEqual(vars["flow.step1Category"], "coding");
    assert.strictEqual(vars["flow.step1Confidence"], "0.69");
    assert.strictEqual(vars["flow.routerStep"], "step2-flash-lite");
    assert.strictEqual(vars["flow.routerEngine"], "gemini-3.5-flash-lite");
    assert.strictEqual(vars["flow.routerCategory"], "deep_reasoning");
    assert.strictEqual(vars["flow.target_model"], "gemini-4-carbon");
    assert.strictEqual(vars["flow.step1InputTokens"], "210");
    assert.strictEqual(vars["flow.step2Tokens"], "112");
    assert.strictEqual(vars["flow.quota_model"], "auto");
  });

  it("allows x-router-confidence-threshold header to raise strictness, never lower below 0.70", () => {
    // Attempt to lower threshold to 0.30 via header -> ignored, stays 0.70, so 0.55 still triggers Step 2
    const lowered = runTwoStepPipeline({
      prompt: "Ambiguous prompt",
      headerThreshold: 0.30,
      step1ResponseContent: step1DecisionJson({ category: "simple", confidence: 0.55 }),
      step2ResponseContent: step2FlashLiteJson({ category: "general" }),
    });
    assert.strictEqual(lowered.vars["flow.routerThreshold"], "0.70");
    assert.strictEqual(lowered.step2Triggered, true);
    assert.strictEqual(lowered.vars["flow.routerCategory"], "general");

    // Raise threshold to 0.95 via header -> 0.88 escalates to Step 2
    const raised = runTwoStepPipeline({
      prompt: "High-stakes prompt",
      headerThreshold: 0.95,
      step1ResponseContent: step1DecisionJson({ category: "coding", confidence: 0.88 }),
      step2ResponseContent: step2FlashLiteJson({ category: "deep_reasoning" }),
    });
    assert.strictEqual(raised.vars["flow.routerThreshold"], "0.95");
    assert.strictEqual(raised.step2Triggered, true);
    assert.strictEqual(raised.vars["flow.target_model"], "gemini-4-carbon");
  });
});

describe("3. Multi-Stage Resilience & Persona Entitlement", () => {
  it("uses Step 2 Flash-Lite as automatic HA failover when Step 1 Decision API fails or times out", () => {
    const { vars, step2Triggered } = runTwoStepPipeline({
      prompt: "Write a SQL window function",
      step1ResponseContent: '{"error":{"code":503,"message":"unavailable"}}',
      step2ResponseContent: step2FlashLiteJson({ category: "coding" }),
    });
    assert.strictEqual(step2Triggered, true);
    assert.strictEqual(vars["flow.routerStep"], "step2-flash-lite");
    assert.strictEqual(vars["flow.target_model"], "gemini-4-argon");
  });

  it("falls back to routing.model.general when both Step 1 (< 70%) and Step 2 fail", () => {
    const { vars } = runTwoStepPipeline({
      prompt: "Ambiguous prompt",
      step1ResponseContent: step1DecisionJson({ category: "coding", confidence: 0.45 }),
      step2ResponseContent: '{"error":{"code":429,"message":"quota"}}',
    });
    assert.strictEqual(vars["flow.routerStep"], "fallback-general");
    assert.strictEqual(vars["flow.routerCategory"], "general");
    assert.strictEqual(vars["flow.target_model"], "gemini-4-hydrogen");
  });

  it("maps the same Step 2 decision to different models for Engineering vs Support personas", () => {
    const s1 = step1DecisionJson({ category: "general", confidence: 0.51 });
    const s2 = step2FlashLiteJson({ category: "deep_reasoning" });

    const eng = runTwoStepPipeline({ prompt: "Root cause analysis", step1ResponseContent: s1, step2ResponseContent: s2, productFile: "engineering_tier.json" });
    const sup = runTwoStepPipeline({ prompt: "Root cause analysis", step1ResponseContent: s1, step2ResponseContent: s2, productFile: "support_tier.json" });

    assert.strictEqual(eng.vars["flow.target_model"], "gemini-4-carbon");
    assert.strictEqual(sup.vars["flow.target_model"], "gemini-4-argon");
  });

  it("fails closed (target_model = null) when product carries no routing.model.* attributes", () => {
    const { vars } = runTwoStepPipeline({
      prompt: "Hello",
      step1ResponseContent: step1DecisionJson({ category: "simple", confidence: 0.95 }),
      customAttributes: {},
    });
    assert.strictEqual(vars["flow.target_model"], null);
    assert.match(proxyXml, /<Name>RF-MissingRoutingConfig<\/Name>/);
  });

  it("contains zero hardcoded target Gemini 4 model names in ResolveFinalRoute.js", () => {
    for (const forbidden of ["gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen"]) {
      assert.ok(!resolveExecutable.includes(forbidden), `Must not hardcode ${forbidden}`);
    }
  });
});

describe("4. Policy XML Wiring & SSE Accounting", () => {
  it("wires Step 1 to generativelanguage.googleapis.com/v1beta/decisions and Step 2 to Vertex gemini-3.5-flash-lite", () => {
    assert.match(amStep1Xml, /"model":\s*"gemini-decision-1"/);
    assert.match(scStep1Xml, /https:\/\/generativelanguage\.googleapis\.com\/v1beta\/decisions/);
    assert.match(scStep2Xml, /publishers\/google\/models\/gemini-3\.5-flash-lite:generateContent/);
    assert.match(proxyXml, /flow\.need_step2_router == "true"/);
  });

  it("resets flow.stream_done per SSE chunk and triggers only on finishReason", () => {
    const { vars, context } = makeContext({ "flow.stream_done": "true" });
    vars["response.event.current.content"] = 'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n';
    vm.runInNewContext(streamCode, { context });
    assert.strictEqual(vars["flow.stream_done"], "false");

    vars["response.event.current.content"] =
      'data: {"candidates":[{"content":{"parts":[{"text":"!"}]},"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":12}}\n\n';
    vm.runInNewContext(streamCode, { context });
    assert.strictEqual(vars["flow.stream_done"], "true");
  });

  it("validates API Product 0.70 threshold and model entitlements", () => {
    for (const [fileName, spec] of Object.entries(PRODUCT_SPECS)) {
      const prod = JSON.parse(fs.readFileSync(path.join(productsDir, fileName), "utf8"));
      const attrs = Object.fromEntries(prod.attributes.map((a) => [a.name, a.value]));
      assert.strictEqual(attrs["routing.confidence.threshold"], "0.70");

      const entitled = new Set(
        prod.llmOperationGroup.operationConfigs.flatMap((oc) => oc.llmOperations.map((op) => op.model))
      );
      assert.ok(entitled.has("auto"));
      for (const m of Object.values(spec.routing)) {
        assert.ok(entitled.has(m));
      }
    }
  });
});
