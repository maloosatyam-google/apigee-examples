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
const amPrepRouterXml = fs.readFileSync(path.join(policiesDir, "AM-PrepRouterRequest.xml"), "utf8");
const scRouterXml = fs.readFileSync(path.join(policiesDir, "SC-ModelRouter.xml"), "utf8");
const proxyXml = fs.readFileSync(path.join(apiproxyDir, "proxies/default.xml"), "utf8");
const manifestXml = fs.readFileSync(path.join(apiproxyDir, "vertex-ai-router-v1.xml"), "utf8");

const readPolicy = (name) => fs.readFileSync(path.join(policiesDir, `${name}.xml`), "utf8");

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

function evalJsonPath(expr, jsonStr) {
  if (!jsonStr) return null;
  let cur = JSON.parse(jsonStr);
  for (const tok of expr.replace(/^\$\.?/, "").split(".").filter(Boolean)) {
    if (cur === null || cur === undefined) return null;
    cur = cur[tok];
  }
  return cur === undefined || cur === null ? null : String(cur);
}

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
    if (val !== null) vars[prefix ? `${prefix}.${m[1]}` : m[1]] = val;
  }
}

function execAssignMessage(policyName, vars) {
  const xml = readPolicy(policyName);
  for (const m of xml.matchAll(/<AssignVariable>([\s\S]*?)<\/AssignVariable>/g)) {
    const block = m[1];
    const name = (block.match(/<Name>([^<]+)<\/Name>/) || [])[1];
    const ref = (block.match(/<Ref>([^<]+)<\/Ref>/) || [])[1];
    const val = (block.match(/<Value>([^<]*)<\/Value>/) || [])[1];
    if (ref !== undefined) {
      if (vars[ref] !== undefined && vars[ref] !== null && vars[ref] !== "") vars[name] = vars[ref];
      else if (val !== undefined) vars[name] = val;
    } else if (val !== undefined) {
      vars[name] = val;
    }
  }
}

function decisionResponse({ category = "coding", confidence = 0.97, complexityScore = 2.15, inputTokens = 184 } = {}) {
  return JSON.stringify({
    answers: {
      category: { type: "choice", choice: category, confidence },
      complexity: { type: "score", score: complexityScore, confidence: 0.88 },
    },
    usage: { total_input_tokens: inputTokens, total_output_tokens: 0, total_tokens: inputTokens },
  });
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

function runNativeSingleStepRouting({
  routerStatus = 200,
  routerContent = undefined,
  productFile = "engineering_tier.json",
  customAttributes = undefined,
} = {}) {
  const vars = { "flow.quota_model": "auto", "flow.target_model": "" };
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

  execAssignMessage("AM-InitAutoRouting", vars);

  if (routerContent !== undefined) {
    vars["routerResponse.status.code"] = routerStatus;
    vars["routerResponse.content"] = routerContent;
  }
  if (vars["routerResponse.status.code"] === 200) {
    execExtractVariables("EV-ParseDecisionResponse", vars);
  }
  if (
    vars["flow.decisionCategory"] != null &&
    vars["flow.routerConfidence"] != null &&
    Number(vars["flow.routerConfidence"]) >= 0.55
  ) {
    execAssignMessage("AM-AcceptDecision", vars);
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

  return vars;
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
    assert.strictEqual(v["flow.quota_model"], "auto");
    assert.strictEqual(v["flow.target_model"], "");
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
    assert.ok(!v["flow.routerInput"].includes("secret chain of thought"));
    assert.ok(v["flow.routerInput"].length <= 8010);
    assert.ok(v["flow.routerInput"].startsWith("SYSTEM_CONTEXT_START"));
    assert.ok(v["flow.routerInput"].endsWith("FINAL_CODING_QUESTION: implement quicksort in Rust."));
  });
});

describe("2. Zero-JavaScript Native AutoRoutingFlow & Gemini Decision 1 Contract", () => {
  it("uses 100% native XML policies inside AutoRoutingFlow (zero Javascript policies)", () => {
    const autoFlow = proxyXml.match(/<Flow name="AutoRoutingFlow">([\s\S]*?)<\/Flow>/)[1];
    for (const stepMatch of autoFlow.matchAll(/<Name>([^<]+)<\/Name>/g)) {
      const stepName = stepMatch[1].trim();
      assert.ok(!stepName.startsWith("JS-"), `AutoRoutingFlow must not use JS policy (found ${stepName})`);
    }
    assert.ok(!fs.existsSync(path.join(jscDir, "AutoRouting.js")));
    assert.ok(!manifestXml.includes("JS-AutoRouting"));
  });

  it("builds valid JSON for POST /v1beta/decisions and authenticates via GoogleAccessToken", () => {
    const match = amPrepRouterXml.match(/<Payload[^>]*variablePrefix="@"[^>]*variableSuffix="#"[^>]*>([\s\S]*?)<\/Payload>/);
    assert.ok(match, "AM-PrepRouterRequest must use custom variablePrefix/variableSuffix to avoid JSON brace collisions");
    const samplePrompt = 'Fix "TypeError" in line 12\nand add tests';
    const rendered = match[1].trim().replace("@escapeJSON(flow.routerInput)#", JSON.stringify(samplePrompt).slice(1, -1));
    const parsed = JSON.parse(rendered);

    assert.strictEqual(parsed.model, "gemini-decision-1");
    assert.strictEqual(parsed.input, samplePrompt);
    assert.strictEqual(parsed.questions.category.type, "choice");
    assert.strictEqual(parsed.questions.complexity.type, "score");
    assert.match(scRouterXml, /<URL>https:\/\/generativelanguage\.googleapis\.com\/v1beta\/decisions<\/URL>/);
    assert.match(scRouterXml, /<GoogleAccessToken>/);
  });
});

describe("3. Native XML Routing — Calibrated categories, persona tiers & resilience", () => {
  it("routes all 4 categories to the Engineering Gemini 4 lineup and records 0 output tokens", () => {
    const expected = PRODUCT_SPECS["engineering_tier.json"].routing;
    for (const [category, expectedModel] of Object.entries(expected)) {
      const v = runNativeSingleStepRouting({
        routerContent: decisionResponse({ category, confidence: 0.94, complexityScore: 2.4, inputTokens: 192 }),
        productFile: "engineering_tier.json",
      });
      assert.strictEqual(v["flow.routerCategory"], category);
      assert.strictEqual(v["flow.target_model"], expectedModel);
      assert.strictEqual(v["flow.quota_model"], "auto");
      assert.strictEqual(v["flow.routerEngine"], "gemini-decision-1");
      assert.strictEqual(v["flow.routerInputTokens"], "192");
      assert.strictEqual(v["flow.routerOutputTokens"], "0");
    }
  });

  it("routes the exact same classification to different models per API Product persona", () => {
    const body = decisionResponse({ category: "deep_reasoning", confidence: 0.91 });
    const eng = runNativeSingleStepRouting({ routerContent: body, productFile: "engineering_tier.json" });
    const sup = runNativeSingleStepRouting({ routerContent: body, productFile: "support_tier.json" });

    assert.strictEqual(eng["flow.target_model"], "gemini-4-carbon");
    assert.strictEqual(sup["flow.target_model"], "gemini-4-argon");
  });

  it("falls back to routing.model.general when confidence < 0.55 or callout fails", () => {
    const lowConf = runNativeSingleStepRouting({
      routerContent: decisionResponse({ category: "deep_reasoning", confidence: 0.41 }),
    });
    assert.strictEqual(lowConf["flow.routerCategory"], "general");
    assert.strictEqual(lowConf["flow.target_model"], "gemini-4-hydrogen");

    const timeout = runNativeSingleStepRouting({ routerStatus: 504, routerContent: "" });
    assert.strictEqual(timeout["flow.target_model"], "gemini-4-hydrogen");
  });

  it("leaves target_model empty when product has no routing.model.* attributes (triggering RF-MissingRoutingConfig)", () => {
    const v = runNativeSingleStepRouting({
      routerContent: decisionResponse({ category: "coding" }),
      customAttributes: {},
    });
    assert.strictEqual(v["flow.target_model"], "");
  });
});

describe("4. ProcessStreamEvent.js & API Product Entitlements", () => {
  it("resets flow.stream_done on every chunk and sets 'true' only on finishReason", () => {
    const { vars, context } = makeContext({ "flow.stream_done": "true" });
    vars["response.event.current.content"] = 'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n';
    vm.runInNewContext(streamCode, { context });
    assert.strictEqual(vars["flow.stream_done"], "false");

    vars["response.event.current.content"] =
      'data: {"candidates":[{"content":{"parts":[{"text":"!"}]},"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":18}}\n\n';
    vm.runInNewContext(streamCode, { context });
    assert.strictEqual(vars["flow.stream_done"], "true");
  });

  it("declares all 4 routing attributes and entitles every mapped model + 'auto'", () => {
    for (const [fileName, spec] of Object.entries(PRODUCT_SPECS)) {
      const prod = JSON.parse(fs.readFileSync(path.join(productsDir, fileName), "utf8"));
      const entitled = new Set(
        prod.llmOperationGroup.operationConfigs.flatMap((oc) => oc.llmOperations.map((op) => op.model))
      );
      assert.ok(entitled.has("auto"));
      for (const m of Object.values(spec.routing)) assert.ok(entitled.has(m));
    }
  });
});
