#!/usr/bin/env bash
# End-to-end live verification suite for vertex-two-step-router-v1
# (Step 1: Gemini Decision 1 >= 70% confidence -> Step 2: Gemini 3.5 Flash-Lite < 70% confidence).
#
# Usage:
#   APIGEE_HOST="api.example.com" ENG_API_KEY="..." SUP_API_KEY="..." ./scripts/verify.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -f "${EXAMPLE_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${EXAMPLE_DIR}/.env"
  set +a
fi

HOST="${APIGEE_HOST:?Error: APIGEE_HOST is required}"
ENG_KEY="${ENG_API_KEY:?Error: ENG_API_KEY is required}"
SUP_KEY="${SUP_API_KEY:-}"
BASE_URL="https://${HOST}/vertex-two-step/v1"

PASS=0
FAIL=0

log()  { printf "\n\033[1;34m==>\033[0m %s\n" "$*"; }
pass() { printf "  \033[1;32m[PASS]\033[0m %s\n" "$*"; PASS=$((PASS + 1)); }
fail() { printf "  \033[1;31m[FAIL]\033[0m %s\n" "$*"; FAIL=$((FAIL + 1)); }
hdr()  { grep -i "^$1:" "$2" | head -n 1 | cut -d':' -f2- | tr -d '\r' | xargs || true; }

log "1. Missing API Key Rejection (expect HTTP 401)"
CODE=$(curl -4 -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/models/auto:generateContent" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Hello"}]}]}' || true)
[[ "${CODE}" == "401" ]] && pass "Rejected unauthenticated request with HTTP 401" || fail "Expected HTTP 401, got ${CODE}"

log "2. Direct Vertex AI Gemini Buffered Call (/models/gemini-4-hydrogen:generateContent)"
HDR_F="$(mktemp)"; BODY_F="$(mktemp)"
CODE=$(curl -4 -s -D "${HDR_F}" -o "${BODY_F}" -w "%{http_code}" -X POST \
  "${BASE_URL}/models/gemini-4-hydrogen:generateContent" \
  -H "Content-Type: application/json" \
  -H "x-apikey: ${ENG_KEY}" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Reply with: Direct OK"}]}]}' || true)
if [[ "${CODE}" == "200" ]]; then
  MODEL_HDR="$(hdr x-gateway-model "${HDR_F}")"
  AUTO_HDR="$(hdr x-auto-routed "${HDR_F}")"
  [[ "${MODEL_HDR}" == "gemini-4-hydrogen" && "${AUTO_HDR}" == "false" ]] \
    && pass "Direct call succeeded (model=${MODEL_HDR}, autoRouted=${AUTO_HDR})" \
    || fail "Unexpected direct headers: model=${MODEL_HDR}, autoRouted=${AUTO_HDR}"
else
  fail "Direct call failed with HTTP ${CODE}: $(cat "${BODY_F}")"
fi
rm -f "${HDR_F}" "${BODY_F}"

log "3. Step 1 Fast-Path (>= 70% confidence -> Gemini Decision 1, 0 Step 2 tokens)"
HDR_F="$(mktemp)"; BODY_F="$(mktemp)"
CODE=$(curl -4 -s -D "${HDR_F}" -o "${BODY_F}" -w "%{http_code}" -X POST \
  "${BASE_URL}/models/auto:generateContent" \
  -H "Content-Type: application/json" \
  -H "x-apikey: ${ENG_KEY}" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Write a Python function implementing binary search with unit tests."}]}]}' || true)
if [[ "${CODE}" == "200" ]]; then
  STEP_HDR="$(hdr x-gateway-router-step "${HDR_F}")"
  CAT_HDR="$(hdr x-gateway-router-category "${HDR_F}")"
  MOD_HDR="$(hdr x-gateway-model "${HDR_F}")"
  CONF_HDR="$(hdr x-gateway-router-step1-confidence "${HDR_F}")"
  S2_TOK="$(hdr x-gateway-router-step2-tokens "${HDR_F}")"
  if [[ "${STEP_HDR}" == "step1-decision-1" && "${CAT_HDR}" == "coding" && "${MOD_HDR}" == "gemini-4-argon" && "${S2_TOK}" == "0" ]]; then
    pass "Step 1 fast-path handled clear prompt (step=${STEP_HDR}, conf=${CONF_HDR}, model=${MOD_HDR}, step2_tokens=${S2_TOK})"
  else
    fail "Unexpected Step 1 headers: step=${STEP_HDR}, cat=${CAT_HDR}, conf=${CONF_HDR}, model=${MOD_HDR}, step2_tokens=${S2_TOK}"
  fi
else
  fail "Step 1 test failed with HTTP ${CODE}: $(head -c 300 "${BODY_F}")"
fi
rm -f "${HDR_F}" "${BODY_F}"

log "4. Step 2 Escalation Path (Ambiguous / < 70% threshold -> Gemini 3.5 Flash-Lite Tie-Breaker)"
HDR_F="$(mktemp)"; BODY_F="$(mktemp)"
# Pass x-force-step2: true so AutoRoutingFlow deterministically exercises the live Step 2 Flash-Lite callout
CODE=$(curl -4 -s -D "${HDR_F}" -o "${BODY_F}" -w "%{http_code}" -X POST \
  "${BASE_URL}/models/auto:generateContent" \
  -H "Content-Type: application/json" \
  -H "x-apikey: ${ENG_KEY}" \
  -H "x-force-step2: true" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Draft a short team note explaining why our SQL index slowed down writes and include a 3-line CREATE INDEX snippet."}]}]}' || true)
if [[ "${CODE}" == "200" ]]; then
  STEP_HDR="$(hdr x-gateway-router-step "${HDR_F}")"
  ENG_HDR="$(hdr x-gateway-router-engine "${HDR_F}")"
  CAT_HDR="$(hdr x-gateway-router-category "${HDR_F}")"
  MOD_HDR="$(hdr x-gateway-model "${HDR_F}")"
  S2_TOK="$(hdr x-gateway-router-step2-tokens "${HDR_F}")"
  if [[ "${STEP_HDR}" == "step2-flash-lite" && "${S2_TOK:-0}" -gt 0 && -n "${MOD_HDR}" ]]; then
    pass "Step 2 Flash-Lite resolved ambiguous prompt (step=${STEP_HDR}, engine=${ENG_HDR}, category=${CAT_HDR}, model=${MOD_HDR}, step2_tokens=${S2_TOK})"
  else
    fail "Expected step2-flash-lite with step2_tokens > 0, got step=${STEP_HDR}, engine=${ENG_HDR}, model=${MOD_HDR}, step2_tokens=${S2_TOK}"
  fi
else
  fail "Step 2 escalation failed with HTTP ${CODE}: $(head -c 300 "${BODY_F}")"
fi
rm -f "${HDR_F}" "${BODY_F}"

log "5. Auto-Routing over Server-Sent Events (/models/auto:streamGenerateContent?alt=sse)"
STREAM_HDR="$(mktemp)"; STREAM_BODY="$(mktemp)"
SCODE=$(curl -4 -sN -D "${STREAM_HDR}" -o "${STREAM_BODY}" -w "%{http_code}" -X POST \
  "${BASE_URL}/models/auto:streamGenerateContent?alt=sse" \
  -H "Content-Type: application/json" \
  -H "x-apikey: ${ENG_KEY}" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Count from 1 to 4."}]}]}' || true)
if [[ "${SCODE}" == "200" ]] && grep -q "^data:" "${STREAM_BODY}"; then
  S_STEP="$(hdr x-gateway-router-step "${STREAM_HDR}")"
  S_MOD="$(hdr x-gateway-model "${STREAM_HDR}")"
  pass "SSE auto-routed stream succeeded (step=${S_STEP}, model=${S_MOD})"
else
  fail "SSE auto-routed stream failed (HTTP ${SCODE}): $(head -c 300 "${STREAM_BODY}")"
fi
rm -f "${STREAM_HDR}" "${STREAM_BODY}"

if [[ -n "${SUP_KEY}" ]]; then
  log "6. Persona Entitlement Check (Engineering vs Support)"
  SUP_HDR="$(mktemp)"; SUP_BODY="$(mktemp)"
  PCODE=$(curl -4 -s -D "${SUP_HDR}" -o "${SUP_BODY}" -w "%{http_code}" -X POST \
    "${BASE_URL}/models/auto:generateContent" \
    -H "Content-Type: application/json" \
    -H "x-apikey: ${SUP_KEY}" \
    -d '{"contents":[{"role":"user","parts":[{"text":"Write a Python function to parse CSV rows."}]}]}' || true)
  if [[ "${PCODE}" == "200" ]]; then
    SUP_MOD="$(hdr x-gateway-model "${SUP_HDR}")"
    [[ "${SUP_MOD}" == "gemini-4-hydrogen" ]] \
      && pass "Support persona routed coding to '${SUP_MOD}' (vs 'gemini-4-argon' on Engineering)" \
      || fail "Expected gemini-4-hydrogen for Support coding, got ${SUP_MOD}"
  else
    fail "Support persona call failed with HTTP ${PCODE}: $(head -c 300 "${SUP_BODY}")"
  fi
  rm -f "${SUP_HDR}" "${SUP_BODY}"
fi

log "Verification Summary: ${PASS} passed, ${FAIL} failed"
[[ "${FAIL}" -eq 0 ]]
