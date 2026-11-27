// Final Route Resolver (ES5 / Rhino):
// Selects the winning category from Step 1 (Gemini Decision 1) or Step 2 (Gemini 3.5 Flash-Lite)
// and resolves the target Vertex AI model exclusively from API Product custom attributes:
//   verifyapikey.VA-VerifyAPIKey.apiproduct.routing.model.<category>

var VALID_CATEGORIES = { coding: true, deep_reasoning: true, simple: true, general: true };

function parseStep2Category(rawText) {
  if (!rawText) return null;
  var cleaned = String(rawText).replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    var obj = JSON.parse(cleaned);
    if (obj && obj.category) {
      var c = String(obj.category).toLowerCase().trim();
      return VALID_CATEGORIES[c] ? c : null;
    }
  } catch (e) {
    var m = cleaned.match(/"category"\s*:\s*"([^"]+)"/i);
    if (m && m[1]) {
      var mc = m[1].toLowerCase().trim();
      return VALID_CATEGORIES[mc] ? mc : null;
    }
  }
  return null;
}

var needStep2 = context.getVariable("flow.need_step2_router") === "true";
var step1Category = context.getVariable("flow.step1Category");
var step1Confidence = context.getVariable("flow.step1Confidence");

var finalCategory = null;
var routerStep = "fallback-general";
var routerEngine = "none";

if (!needStep2 && step1Category && VALID_CATEGORIES[step1Category]) {
  // Fast path: Step 1 (Gemini Decision 1) met >= 70% confidence threshold
  finalCategory = step1Category;
  routerStep = "step1-decision-1";
  routerEngine = "gemini-decision-1";
  context.setVariable("flow.routerConfidence", String(step1Confidence || ""));
} else if (needStep2) {
  // Ambiguous path: Parse Step 2 (Gemini 3.5 Flash-Lite) disambiguation response
  try {
    var rawStep2 = context.getVariable("routerStep2Response.content");
    if (rawStep2) {
      var parsed2 = JSON.parse(rawStep2);
      if (parsed2 && parsed2.candidates && parsed2.candidates.length > 0) {
        var cand = parsed2.candidates[0];
        if (cand && cand.content && Array.isArray(cand.content.parts)) {
          for (var i = 0; i < cand.content.parts.length; i++) {
            var pt = cand.content.parts[i];
            if (pt && pt.text && !pt.thought) {
              var extracted = parseStep2Category(pt.text);
              if (extracted) {
                finalCategory = extracted;
                break;
              }
            }
          }
        }
      }
      if (parsed2 && parsed2.usageMetadata && parsed2.usageMetadata.totalTokenCount !== undefined) {
        context.setVariable("flow.step2Tokens", String(parsed2.usageMetadata.totalTokenCount));
      }
      if (finalCategory) {
        routerStep = "step2-flash-lite";
        routerEngine = String((parsed2 && parsed2.modelVersion) || "gemini-3.5-flash-lite");
        context.setVariable("flow.routerConfidence", String(step1Confidence || "ambiguous"));
      }
    }
  } catch (e) {
    // Step 2 failed or timed out; fall back cleanly below
  }

  // If Step 2 callout failed, fall back to routing.model.general
  if (!finalCategory) {
    routerStep = "fallback-general";
    routerEngine = step1Category ? "gemini-decision-1-degraded" : "none";
  }
}

// Resolve target model strictly from API Product custom attributes (zero hardcoded target models)
var targetModel = null;
if (finalCategory) {
  targetModel = context.getVariable("verifyapikey.VA-VerifyAPIKey.apiproduct.routing.model." + finalCategory);
}
if (!targetModel) {
  targetModel = context.getVariable("verifyapikey.VA-VerifyAPIKey.apiproduct.routing.model.general");
}

var productName = context.getVariable("verifyapikey.VA-VerifyAPIKey.apiproduct.name") || "";
context.setVariable("flow.routingTier", productName || "unknown");
context.setVariable("flow.routerStep", routerStep);
context.setVariable("flow.routerEngine", routerEngine);
context.setVariable("flow.routerCategory", finalCategory || "general");
context.setVariable("flow.target_model", targetModel);
context.setVariable("flow.model", targetModel);
context.setVariable("flow.autoRouted", "true");
