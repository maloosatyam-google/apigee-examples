// Step 1 Evaluator (ES5 / Rhino):
// Inspects the calibrated Gemini Decision 1 (POST /v1beta/decisions) response.
// - If confidence >= threshold (default 0.70 / 70%), accepts Step 1 immediately (0 output tokens).
// - If ambiguous (confidence < 0.70) or Step 1 failed, sets flow.need_step2_router = "true" and
//   builds the Step 2 Gemini 3.5 Flash-Lite disambiguation payload enriched with Step 1 probabilities.

var DEFAULT_THRESHOLD = 0.70;
var VALID_CATEGORIES = { coding: true, deep_reasoning: true, simple: true, general: true };

// Resolve threshold from API Product (default 0.70); allow x-router-confidence-threshold only to raise strictness
var threshold = DEFAULT_THRESHOLD;
var prodThreshStr = context.getVariable("verifyapikey.VA-VerifyAPIKey.apiproduct.routing.confidence.threshold");
if (prodThreshStr !== null && prodThreshStr !== undefined && String(prodThreshStr).trim() !== "") {
  var parsedProd = parseFloat(String(prodThreshStr));
  if (!isNaN(parsedProd) && parsedProd >= 0 && parsedProd <= 1) {
    threshold = parsedProd;
  }
}
var hdrThreshStr = context.getVariable("request.header.x-router-confidence-threshold");
if (hdrThreshStr !== null && hdrThreshStr !== undefined && String(hdrThreshStr).trim() !== "") {
  var parsedHdr = parseFloat(String(hdrThreshStr));
  if (!isNaN(parsedHdr) && parsedHdr > threshold && parsedHdr <= 1) {
    threshold = parsedHdr;
  }
}
context.setVariable("flow.routerThreshold", threshold.toFixed(2));
context.setVariable("flow.step1InputTokens", "0");
context.setVariable("flow.step2Tokens", "0");

var step1Category = null;
var step1Confidence = null;
var step1Probabilities = null;

try {
  var rawStep1 = context.getVariable("routerStep1Response.content");
  if (rawStep1) {
    var parsed = JSON.parse(rawStep1);
    if (parsed && parsed.answers) {
      var catAns = parsed.answers.category;
      if (catAns) {
        if (catAns.choice) {
          var cand = String(catAns.choice).toLowerCase().trim();
          if (VALID_CATEGORIES[cand]) {
            step1Category = cand;
            context.setVariable("flow.step1Category", step1Category);
          }
        }
        if (catAns.confidence !== undefined && catAns.confidence !== null) {
          var confNum = Number(catAns.confidence);
          if (!isNaN(confNum)) {
            step1Confidence = confNum;
            context.setVariable("flow.step1Confidence", confNum.toFixed(2));
          }
        }
        if (catAns.probabilities && typeof catAns.probabilities === "object") {
          step1Probabilities = catAns.probabilities;
          context.setVariable("flow.step1Probabilities", JSON.stringify(step1Probabilities));
        }
      }

      var compAns = parsed.answers.complexity;
      if (compAns && compAns.score !== undefined && compAns.score !== null) {
        var scoreNum = Number(compAns.score);
        if (!isNaN(scoreNum)) {
          context.setVariable("flow.routerComplexity", scoreNum.toFixed(2));
        }
      }
    }

    if (parsed && parsed.usage && parsed.usage.total_input_tokens !== undefined) {
      context.setVariable("flow.step1InputTokens", String(parsed.usage.total_input_tokens));
    }
  }
} catch (e) {
  // Step 1 callout failed or timed out; escalate to Step 2
}

var routerInput = String(context.getVariable("flow.routerInput") || "");
var isConfident = (
  step1Category !== null &&
  step1Confidence !== null &&
  step1Confidence >= threshold
);

if (!routerInput) {
  // Empty/non-text prompt: skip Step 2 and let ResolveFinalRoute use routing.model.general
  context.setVariable("flow.need_step2_router", "false");
} else if (isConfident) {
  context.setVariable("flow.need_step2_router", "false");
} else {
  context.setVariable("flow.need_step2_router", "true");

  var priorContext = "";
  if (step1Probabilities) {
    priorContext =
      "\n\nStep 1 Gemini Decision 1 calibrated probabilities (ambiguous, below " +
      threshold.toFixed(2) +
      " confidence threshold): " +
      JSON.stringify(step1Probabilities);
  }

  var step2Prompt =
    "You are the Step 2 tie-breaker router for an enterprise AI Gateway. " +
    "Step 1 classification was ambiguous. Analyze the user's primary intent and pick the single best routing category:\n" +
    "- coding: Writing, debugging, reviewing, or refactoring code, SQL, regex, scripts, or API implementations.\n" +
    "- deep_reasoning: Complex multi-step analysis, architecture trade-offs, formal proofs, math derivations, root-cause diagnosis, or strategic planning.\n" +
    "- simple: Short greetings, factual trivia, brief definitions, single-sentence translations, or quick lookups.\n" +
    "- general: Everyday writing, drafting emails/memos, summarization, brainstorming, and general conversation." +
    priorContext +
    "\n\nUser request:\n" +
    routerInput;

  var step2Payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: step2Prompt }]
      }
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 256,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          category: {
            type: "STRING",
            "enum": ["coding", "deep_reasoning", "simple", "general"]
          }
        },
        required: ["category"]
      }
    }
  };

  context.setVariable("flow.step2RequestBody", JSON.stringify(step2Payload));
}
