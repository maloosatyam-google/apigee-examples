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
const streamCode = fs.readFileSync(path.join(jscDir, "ProcessStreamEvent.js"), "utf8");
const proxyXml = fs.readFileSync(path.join(apiproxyDir, "proxies/default.xml"), "utf8");
const manifestXml = fs.readFileSync(path.join(apiproxyDir, "vertex-two-step-router-v1.xml"), "utf8");

const readPolicy = (name) => fs.readFileSync(path.join(policiesDir, `${name}.xml`), "utf8");

const PRODUCT_SPECS = {
  "engineering_tier.json": {
    name: "vertex-two-step-engineering",
    routing: {
      coding: "gemini-4-argon",
      deep_reasoning: "gemini-4-carbon",
      general: "gemini-4-hydrogen",
      simple: "gemini-3.5-flash-lite",
    },
  },
  "support_tier.json": {
    name: "vertex-two-step-support",
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

/** Minimal JSONPath evaluator for $.a.b[0].c[-1] paths used in ExtractVariables & jsonPath() templates. */
function evalJsonPath(expr, jsonStr) {
  if (!jsonStr) return null;
  let cur = JSON.parse(jsonStr);
  const tokens = expr
    .replace(/^\$\.?/, "")
    .split(".")
    .filter(Boolean);
  for (const tok of tokens) {
    if (cur === null || cur === undefined) return null;
    const idxMatch = tok.match(/^([^\[]+)\[(-?\d+)\]$/);
    if (idxMatch) {
      cur = cur[idxMatch[1]];
      if (!Array.isArray(cur)) return null;
      const i = Number(idxMatch[2]);
      cur = cur[i < 0 ? cur.length + i : i];
    } else {
      cur = cur[tok];
    }
  }
  return cur === undefined || cur === null ? null : String(cur);
}

/** Executes an Apigee <ExtractVariables> XML policy against `vars`. */
function execExtractVariables(policyName, vars) {
  const xml = readPolicy(policyName);
  const source = (xml.match(/<Source[^>]*>([^<]+)<\/Source>/) || [])[1];
  const prefix = (xml.match(/<VariablePrefix>([^<]+)<\/VariablePrefix>/) || [])[1] || "";
  const content = vars[`${source}.content`];
  if (!content) return;
  try {
    JSON.parse(content);
  } catch {
    return;
  }
  for (const m of xml.matchAll(/<Variable name="([^"]+)">\s*<JSONPath>([^<]+)<\/JSONPath>\s*<\/Variable>/g)) {
    const val = evalJsonPath(m[2].trim(), content);
    if (val !== null) {
      vars[prefix ? `${prefix}.${m[1]}` : m[1]] = val;
    }
  }
}

/** Renders an Apigee message template with configurable delimiters ({...} or @...#). */
function renderTemplate(tpl, vars, open = "{", close = "}") {
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(`${escRe(open)}([^${escRe(open)}${escRe(close)}]+)${escRe(close)}`, "g");
  return tpl.replace(rx, (full, expr) => {
    const esc = expr.match(/^escapeJSON\(([^)]+)\)$/);
    if (esc) {
      const v = vars[esc[1].trim()];
      return v !== undefined && v !== null ? JSON.stringify(String(v)).slice(1, -1) : "";
    }
    const jp = expr.match(/^jsonPath\('([^']+)',([^)]+)\)$/);
    if (jp) {
      try {
        return evalJsonPath(jp[1], vars[jp[2].trim()]) || "";
      } catch {
        return "";
      }
    }
    const colon = expr.indexOf(":");
    if (colon !== -1) {
      const name = expr.slice(0, colon).trim();
      const def = expr.slice(colon + 1);
      const v = vars[name];
      return v !== undefined && v !== null && v !== "" ? String(v) : def;
    }
    const v = vars[expr.trim()];
    return v !== undefined && v !== null ? String(v) : full;
  });
}

/** Executes an Apigee <AssignMessage> XML policy against `vars`. */
function execAssignMessage(policyName, vars) {
  const xml = readPolicy(policyName);
  for (const m of xml.matchAll(/<AssignVariable>([\s\S]*?)<\/AssignVariable>/g)) {
    const block = m[1];
    const name = (block.match(/<Name>([^<]+)<\/Name>/) || [])[1];
    const tpl = (block.match(/<Template>([^<]+)<\/Template>/) || [])[1];
    const ref = (block.match(/<Ref>([^<]+)<\/Ref>/) || [])[1];
    const val = (block.match(/<Value>([^<]*)<\/Value>/) || [])[1];

    if (tpl !== undefined) {
      const rendered = renderTemplate(tpl, vars);
      if (rendered !== "") vars[name] = rendered;
      else if (val !== undefined) vars[name] = val;
    } else if (ref !== undefined) {
      if (vars[ref] !== undefined && vars[ref] !== null && vars[ref] !== "") {
        vars[name] = vars[ref];
      } else if (val !== undefined) {
        vars[name] = val;
      }
    } else if (val !== undefined) {
      vars[name] = val;
    }
  }

  const assignNew = xml.match(/<AssignTo[^>]*createNew="true"[^>]*>([^<]+)<\/AssignTo>/);
  const payload = xml.match(/<Payload([^>]*)>([\s\S]*?)<\/Payload>/);
  if (assignNew && payload) {
    const attrs = payload[1];
    const open = (attrs.match(/variablePrefix="([^"]+)"/) || [])[1] || "{";
    const close = (attrs.match(/variableSuffix="([^"]+)"/) || [])[1] || "}";
    vars[`${assignNew[1].trim()}.content`] = renderTemplate(payload[2].trim(), vars, open, close);
  }
}

function step1DecisionJson({
  category = "coding",
  confidence = 0.92,
  probabilities = undefined,
  complexityScore = 2.1,
  inputTokens = 180,
} = {}) {
  const probs = probabilities || {
    coding: category === "coding" ? confidence : 0.02,
    deep_reasoning: category === "deep_reasoning" ? confidence : 0.02,
    general: category === "general" ? confidence : 0.02,
    simple: category === "simple" ? confidence : 0.02,
  };
  return JSON.stringify({
    answers: {
      category: { type: "choice", choice: category, confidence, probabilities: probs },
      complexity: { type: "score", score: complexityScore, confidence: 0.85 },
    },
    usage: { total_input_tokens: inputTokens, total_output_tokens: 0, total_tokens: inputTokens },
  });
}

function step2FlashLiteJson({
  category = "deep_reasoning",
  includeThoughtPart = false,
  totalTokens = 96,
  modelVersion = "gemini-3.5-flash-lite",
} = {}) {
  const parts = [];
  if (includeThoughtPart) parts.push({ text: "weighing intent...", thought: true });
  parts.push({ text: JSON.stringify({ category }) });
  return JSON.stringify({
    candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 88, candidatesTokenCount: 8, totalTokenCount: totalTokens },
    modelVersion,
  });
}

/** Simulates the exact native XML AutoRoutingFlow in proxies/default.xml. */
function runNativeAutoRoutingFlow({
  prompt = "Write a Python function",
  step1Status = 200,
  step1Body = undefined,
  step2Status = 200,
  step2Body = undefined,
  productFile = "engineering_tier.json",
  customAttributes = undefined,
  forceStep2 = false,
} = {}) {
  const init = {
    "proxy.pathsuffix": "/models/auto:generateContent",
    "flow.model": "auto",
    "request.content": prompt ? JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }) : "{}",
  };
  if (forceStep2) init["request.header.x-force-step2"] = "true";

  if (customAttributes !== undefined) {
    init["verifyapikey.VA-VerifyAPIKey.apiproduct.name"] = "custom-product";
    for (const [k, v] of Object.entries(customAttributes)) {
      init[`verifyapikey.VA-VerifyAPIKey.apiproduct.${k}`] = v;
    }
  } else {
    const spec = PRODUCT_SPECS[productFile];
    init["verifyapikey.VA-VerifyAPIKey.apiproduct.name"] = spec.name;
    for (const [cat, mod] of Object.entries(spec.routing)) {
      init[`verifyapikey.VA-VerifyAPIKey.apiproduct.routing.model.${cat}`] = mod;
    }
  }

  const { vars, context } = makeContext(init);
  vm.runInNewContext(extractCode, { context });

  // AutoRoutingFlow native XML steps:
  execAssignMessage("AM-InitAutoRouting", vars);

  const hasInput = vars["flow.routerInput"] != null && vars["flow.routerInput"] !== "";
  let step1Called = false;
  let step2Called = false;

  if (hasInput) {
    execAssignMessage("AM-PrepStep1Decision", vars);
    step1Called = true;
    if (step1Body !== undefined) {
      vars["routerStep1Response.status.code"] = step1Status;
      vars["routerStep1Response.content"] = step1Body;
    }
  }

  if (vars["routerStep1Response.status.code"] === 200) {
    execExtractVariables("EV-ParseStep1Decision", vars);
  }

  if (
    vars["flow.step1Category"] != null &&
    vars["flow.step1Confidence"] != null &&
    Number(vars["flow.step1Confidence"]) >= 0.70 &&
    vars["request.header.x-force-step2"] !== "true"
  ) {
    execAssignMessage("AM-AcceptStep1Decision", vars);
  }

  if (hasInput && vars["flow.step1Accepted"] !== "true") {
    execAssignMessage("AM-PrepStep2FlashLite", vars);
    step2Called = true;
    if (step2Body !== undefined) {
      vars["routerStep2Response.status.code"] = step2Status;
      vars["routerStep2Response.content"] = step2Body;
    }
  }

  if (vars["flow.step1Accepted"] !== "true" && vars["routerStep2Response.status.code"] === 200) {
    execExtractVariables("EV-ParseStep2FlashLite", vars);
  }

  if (
    vars["flow.step1Accepted"] !== "true" &&
    vars["flow.step2RawJson"] != null &&
    vars["flow.step2RawJson"] !== ""
  ) {
    execAssignMessage("AM-AcceptStep2Decision", vars);
  }

  const cat = String(vars["flow.routerCategory"] || "").toLowerCase();
  if (cat === "coding" && vars["verifyapikey.VA-VerifyAPIKey.apiproduct.routing.model.coding"] != null) {
    execAssignMessage("AM-RouteCoding", vars);
  }
  if (cat === "deep_reasoning" && vars["verifyapikey.VA-VerifyAPIKey.apiproduct.routing.model.deep_reasoning"] != null) {
    execAssignMessage("AM-RouteDeepReasoning", vars);
  }
  if (cat === "simple" && vars["verifyapikey.VA-VerifyAPIKey.apiproduct.routing.model.simple"] != null) {
    execAssignMessage("AM-RouteSimple", vars);
  }

  const faulted = vars["flow.target_model"] == null || vars["flow.target_model"] === "";
  return { vars, step1Called, step2Called, faulted };
}

describe("1. Zero-JavaScript Native AutoRoutingFlow Verification", () => {
  it("uses 100% native XML policies inside AutoRoutingFlow (zero Javascript steps)", () => {
    const autoFlow = proxyXml.match(/<Flow name="AutoRoutingFlow">([\s\S]*?)<\/Flow>/)[1];
    for (const stepMatch of autoFlow.matchAll(/<Name>([^<]+)<\/Name>/g)) {
      const stepName = stepMatch[1].trim();
      assert.ok(!stepName.startsWith("JS-"), `AutoRoutingFlow must not use JS policy (found ${stepName})`);
    }
    assert.ok(!fs.existsSync(path.join(jscDir, "EvaluateStep1.js")));
    assert.ok(!fs.existsSync(path.join(jscDir, "ResolveFinalRoute.js")));
    assert.ok(!manifestXml.includes("EvaluateStep1"));
    assert.ok(!manifestXml.includes("ResolveFinalRoute"));
  });
});

describe("2. Step 1 Native Fast-Path (>= 0.70 confidence -> Gemini Decision 1, Step 2 skipped)", () => {
  it("accepts Step 1 immediately at >= 0.70 (including 0.70 boundary) and skips Step 2", () => {
    for (const conf of [0.70, 0.86, 0.99]) {
      const { vars, step1Called, step2Called, faulted } = runNativeAutoRoutingFlow({
        prompt: "Implement merge sort in Go",
        step1Body: step1DecisionJson({ category: "coding", confidence: conf, inputTokens: 175 }),
        step2Body: step2FlashLiteJson({ category: "simple" }),
      });
      assert.strictEqual(step1Called, true);
      assert.strictEqual(step2Called, false, `Step 2 must not run at confidence=${conf}`);
      assert.strictEqual(faulted, false);
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

describe("3. Step 2 Native Escalation (< 0.70 confidence -> Gemini 3.5 Flash-Lite)", () => {
  it("escalates at 0.69 (< 0.70), builds valid Step 2 JSON with Step 1 probabilities, and extracts category via jsonPath()", () => {
    const probs = { coding: 0.44, deep_reasoning: 0.46, general: 0.06, simple: 0.04 };
    const { vars, step2Called } = runNativeAutoRoutingFlow({
      prompt: 'Compare B-tree vs LSM-tree write amplification\nand show "compaction" pseudocode.',
      step1Body: step1DecisionJson({
        category: "coding",
        confidence: 0.69,
        probabilities: probs,
        inputTokens: 210,
      }),
      step2Body: step2FlashLiteJson({
        category: "deep_reasoning",
        includeThoughtPart: true,
        totalTokens: 112,
      }),
    });

    assert.strictEqual(step2Called, true);
    const step2Payload = JSON.parse(vars["routerStep2Request.content"]);
    assert.ok(step2Payload.contents[0].parts[0].text.includes("coding=0.44"));
    assert.ok(step2Payload.contents[0].parts[0].text.includes("deep_reasoning=0.46"));
    assert.strictEqual(step2Payload.generationConfig.thinkingConfig.thinkingBudget, 0);

    assert.strictEqual(vars["flow.routerStep"], "step2-flash-lite");
    assert.strictEqual(vars["flow.routerEngine"], "gemini-3.5-flash-lite");
    assert.strictEqual(vars["flow.routerCategory"], "deep_reasoning");
    assert.strictEqual(vars["flow.target_model"], "gemini-4-carbon");
    assert.strictEqual(vars["flow.step2Tokens"], "112");
  });

  it("supports x-force-step2: true header for deterministic live integration testing", () => {
    const { vars, step2Called } = runNativeAutoRoutingFlow({
      prompt: "Write a Python function",
      forceStep2: true,
      step1Body: step1DecisionJson({ category: "coding", confidence: 0.98 }),
      step2Body: step2FlashLiteJson({ category: "coding", totalTokens: 90 }),
    });
    assert.strictEqual(step2Called, true);
    assert.strictEqual(vars["flow.routerStep"], "step2-flash-lite");
    assert.strictEqual(vars["flow.target_model"], "gemini-4-argon");
  });
});

describe("4. Multi-Stage Resilience, Persona Mapping & SSE Accounting", () => {
  it("uses Step 2 Flash-Lite as automatic HA failover when Step 1 returns 503", () => {
    const { vars, step2Called } = runNativeAutoRoutingFlow({
      prompt: "Write a SQL window function",
      step1Status: 503,
      step1Body: '{"error":{"code":503}}',
      step2Body: step2FlashLiteJson({ category: "coding" }),
    });
    assert.strictEqual(step2Called, true);
    assert.strictEqual(vars["flow.routerStep"], "step2-flash-lite");
    assert.strictEqual(vars["flow.target_model"], "gemini-4-argon");
  });

  it("falls back to routing.model.general when both Step 1 (< 0.70) and Step 2 fail", () => {
    const { vars, faulted } = runNativeAutoRoutingFlow({
      prompt: "Ambiguous prompt",
      step1Body: step1DecisionJson({ category: "coding", confidence: 0.45 }),
      step2Status: 429,
      step2Body: '{"error":{"code":429}}',
    });
    assert.strictEqual(faulted, false);
    assert.strictEqual(vars["flow.routerStep"], "fallback-general");
    assert.strictEqual(vars["flow.target_model"], "gemini-4-hydrogen");
  });

  it("maps the same Step 2 decision differently per API Product persona", () => {
    const s1 = step1DecisionJson({ category: "general", confidence: 0.51 });
    const s2 = step2FlashLiteJson({ category: "deep_reasoning" });

    const eng = runNativeAutoRoutingFlow({ prompt: "Analyze", step1Body: s1, step2Body: s2, productFile: "engineering_tier.json" });
    const sup = runNativeAutoRoutingFlow({ prompt: "Analyze", step1Body: s1, step2Body: s2, productFile: "support_tier.json" });

    assert.strictEqual(eng.vars["flow.target_model"], "gemini-4-carbon");
    assert.strictEqual(sup.vars["flow.target_model"], "gemini-4-argon");
  });

  it("triggers RF-MissingRoutingConfig when product lacks routing.model.* attributes", () => {
    const { faulted } = runNativeAutoRoutingFlow({
      prompt: "Hello",
      step1Body: step1DecisionJson({ category: "simple", confidence: 0.95 }),
      customAttributes: {},
    });
    assert.strictEqual(faulted, true);
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

  it("validates API Product model entitlements", () => {
    for (const [fileName, spec] of Object.entries(PRODUCT_SPECS)) {
      const prod = JSON.parse(fs.readFileSync(path.join(productsDir, fileName), "utf8"));
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
