// Intelligent auto-routing policy powered by Google Gemini Decision 1 (POST /v1beta/decisions)
// and API Product custom attributes (routing.model.<category>). ES5 / Rhino compatible.
//
// Design invariants:
//   1. Zero hardcoded LLM names: only API Product custom attributes decide the target model.
//   2. Zero prompt regex heuristics: classification comes solely from Gemini Decision 1.
//   3. flow.quota_model stays "auto" so LLMTokenQuota EnforceOnly & CountOnly share the "auto" bucket.

var rawCategory = null;
var confidence = null;

// 1. Parse calibrated response from SC-ModelRouter (Google Gemini Decision 1 Decisions API)
try {
  var routerResponseContent = context.getVariable("routerResponse.content");
  if (routerResponseContent) {
    var parsedResp = JSON.parse(routerResponseContent);

    if (parsedResp && parsedResp.answers) {
      context.setVariable("flow.routerEngine", String(parsedResp.model || "gemini-decision-1"));

      var catAns = parsedResp.answers.category;
      if (catAns) {
        if (catAns.choice) {
          rawCategory = String(catAns.choice).toLowerCase().trim();
          context.setVariable("flow.routerRawCategory", rawCategory);
        }
        if (catAns.confidence !== undefined && catAns.confidence !== null) {
          confidence = Number(catAns.confidence);
          if (!isNaN(confidence)) {
            context.setVariable("flow.routerConfidence", String(catAns.confidence));
          }
        }
        if (catAns.probabilities && typeof catAns.probabilities === "object") {
          context.setVariable("flow.routerProbabilities", JSON.stringify(catAns.probabilities));
        }
      }

      var compAns = parsedResp.answers.complexity;
      if (compAns && compAns.score !== undefined && compAns.score !== null) {
        var scoreNum = Number(compAns.score);
        if (!isNaN(scoreNum)) {
          context.setVariable("flow.routerComplexity", scoreNum.toFixed(2));
        }
      }
    }

    if (parsedResp && parsedResp.usage) {
      var inTok = parsedResp.usage.total_input_tokens;
      var outTok = parsedResp.usage.total_output_tokens;
      if (inTok !== undefined && inTok !== null) {
        context.setVariable("flow.routerInputTokens", String(inTok));
      }
      if (outTok !== undefined && outTok !== null) {
        context.setVariable("flow.routerOutputTokens", String(outTok));
      }
    }
  }
} catch (e) {
  // ServiceCallout timed out, failed, or returned non-JSON; degrade gracefully to general
}

// 2. Apply optional calibrated confidence threshold from API Product (routing.confidence.min)
var effectiveCategory = rawCategory;
var minConfStr = context.getVariable("verifyapikey.VA-VerifyAPIKey.apiproduct.routing.confidence.min");
if (minConfStr !== null && minConfStr !== undefined && String(minConfStr).trim() !== "") {
  var minConf = parseFloat(String(minConfStr));
  if (!isNaN(minConf) && effectiveCategory && (confidence === null || isNaN(confidence) || confidence < minConf)) {
    effectiveCategory = "general";
    context.setVariable("flow.routerLowConfidence", "true");
  }
}

// 3. Resolve target Vertex AI Gemini model from API Product custom attributes:
//    verifyapikey.VA-VerifyAPIKey.apiproduct.routing.model.<category>
var targetModel = null;
if (effectiveCategory) {
  targetModel = context.getVariable("verifyapikey.VA-VerifyAPIKey.apiproduct.routing.model." + effectiveCategory);
}
if (!targetModel) {
  targetModel = context.getVariable("verifyapikey.VA-VerifyAPIKey.apiproduct.routing.model.general");
}

var productName = context.getVariable("verifyapikey.VA-VerifyAPIKey.apiproduct.name") || "";
context.setVariable("flow.routingTier", productName || "unknown");
context.setVariable("flow.routerCategory", effectiveCategory);
context.setVariable("flow.target_model", targetModel);
context.setVariable("flow.model", targetModel);
context.setVariable("flow.autoRouted", "true");
