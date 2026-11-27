// Extract router input (across systemInstruction + turns) and model/routing metadata from Vertex AI Gemini request (ES5/Rhino)
var pathSuffix = String(context.getVariable("proxy.pathsuffix") || "");
var altParam = String(context.getVariable("request.queryparam.alt") || "").toLowerCase();
var isStreaming = /:streamGenerateContent$/i.test(pathSuffix) || (altParam === "sse" && /^\/auto$/i.test(pathSuffix));

context.setVariable("flow.is_streaming", isStreaming ? "true" : "false");
context.setVariable("flow.gemini_method", isStreaming ? "streamGenerateContent?alt=sse" : "generateContent");
context.setVariable("flow.autoRouted", "false");
context.setVariable("flow.is_auto_route", "false");
context.setVariable("flow.is_valid_gemini_path", "false");

var isShortAuto = /^\/auto(:(generateContent|streamGenerateContent))?$/i.test(pathSuffix);
var isModelsAction = /\/models\/[^\/:]+:(generateContent|streamGenerateContent)$/i.test(pathSuffix);

var extractedModel = context.getVariable("flow.model");
if (isShortAuto) {
  extractedModel = "auto";
}

var reqContent = context.getVariable("request.content") || "";
if (reqContent) {
  try {
    var payload = JSON.parse(reqContent);
    var promptChunks = [];

    if (payload.systemInstruction && payload.systemInstruction.parts && Array.isArray(payload.systemInstruction.parts)) {
      for (var s = 0; s < payload.systemInstruction.parts.length; s++) {
        if (payload.systemInstruction.parts[s] && payload.systemInstruction.parts[s].text) {
          promptChunks.push(payload.systemInstruction.parts[s].text);
        }
      }
    }

    if (payload.contents && Array.isArray(payload.contents)) {
      for (var c = 0; c < payload.contents.length; c++) {
        var turn = payload.contents[c];
        if (turn && turn.parts && Array.isArray(turn.parts)) {
          for (var p = 0; p < turn.parts.length; p++) {
            var part = turn.parts[p];
            if (part && part.text && !part.thought) {
              promptChunks.push(part.text);
            }
          }
        }
      }
    } else if (payload.prompt) {
      promptChunks.push((typeof payload.prompt === "string") ? payload.prompt : JSON.stringify(payload.prompt));
    } else if (payload.input && typeof payload.input === "string") {
      promptChunks.push(payload.input);
    }

    var prompt = promptChunks.join("\n").trim();
    if (prompt) {
      var routerInput = prompt;
      if (routerInput.length > 8000) {
        routerInput = routerInput.substring(0, 2000) + "\n...\n" + routerInput.substring(routerInput.length - 6000);
      }
      context.setVariable("flow.routerInput", routerInput);
    }

    if (!extractedModel && payload.model) {
      extractedModel = String(payload.model);
    }
  } catch (e) {
    // Non-JSON or parsing error; continue flow
  }
}

if (extractedModel) {
  var modelName = String(extractedModel)
    .replace(/^(publishers\/google\/)?models\//i, "")
    .split(":")[0]
    .trim();

  if (modelName.toLowerCase() === "auto") {
    context.setVariable("flow.model", "auto");
    context.setVariable("flow.quota_model", "auto");
    context.setVariable("flow.target_model", "");
    context.setVariable("flow.autoRouted", "true");
    if (isShortAuto || isModelsAction) {
      context.setVariable("flow.is_auto_route", "true");
      context.setVariable("flow.is_valid_gemini_path", "true");
    }
  } else if (modelName) {
    context.setVariable("flow.model", modelName);
    context.setVariable("flow.quota_model", modelName.split("@")[0]);
    context.setVariable("flow.target_model", modelName);
    if (isModelsAction) {
      context.setVariable("flow.is_valid_gemini_path", "true");
    }
  }
}
