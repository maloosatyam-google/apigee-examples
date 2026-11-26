// Processes Server-Sent Event (SSE) chunks inside TargetEndpoint EventFlow (ES5/Rhino).
// Reset flow.stream_done on line 1 so trailing SSE frames never fire quota/analytics twice.
context.setVariable("flow.stream_done", "false");

try {
  var rawContent = context.getVariable("response.event.current.content") || "";
  if (rawContent) {
    var lines = String(rawContent).split(/\r?\n/);
    var isFinished = false;

    for (var l = 0; l < lines.length; l++) {
      var trimmed = lines[l].trim();
      if (trimmed.indexOf("data:") !== 0) {
        continue;
      }
      var payloadStr = trimmed.substring(5).trim();
      if (!payloadStr || payloadStr === "[DONE]") {
        continue;
      }

      var parsed = null;
      try {
        parsed = JSON.parse(payloadStr);
      } catch (e) {
        continue;
      }
      if (!parsed || typeof parsed !== "object") {
        continue;
      }

      if (parsed.candidates && Array.isArray(parsed.candidates) && parsed.candidates.length > 0) {
        var cand = parsed.candidates[0];
        if (cand && cand.finishReason) {
          isFinished = true;
        }
      }

      if (parsed.usageMetadata) {
        var pTok = parsed.usageMetadata.promptTokenCount || 0;
        var cTok = parsed.usageMetadata.candidatesTokenCount || 0;
        var thTok = parsed.usageMetadata.thoughtsTokenCount || 0;
        var tTok = parsed.usageMetadata.totalTokenCount || (pTok + cTok + thTok);
        if (tTok > 0) {
          context.setVariable("flow.promptTokenCount", String(pTok));
          context.setVariable("flow.candidatesTokenCount", String(cTok));
          context.setVariable("flow.thoughtsTokenCount", String(thTok));
          context.setVariable("flow.totalTokenCount", String(tTok));
        }
      }
    }

    if (isFinished && context.getVariable("flow.totalTokenCount")) {
      context.setVariable("flow.stream_done", "true");
    }
  }
} catch (err) {
  // Never break SSE streaming on telemetry parsing errors
}
