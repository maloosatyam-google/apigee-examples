#!/usr/bin/env bash
# Customer-friendly sample test runner for vertex-two-step-router-v1.
# Executes all sample cases in tests/sample_prompts.json against the deployed Apigee 2-step
# gateway and displays Step 1 confidence, Step 1 vs Step 2 execution, and routed Gemini 4 models.
#
# Usage:
#   ./scripts/test_samples.sh [--cases tests/sample_prompts.json]
#   (Reads .env automatically, or auto-discovers APIGEE_HOST & app keys when APIGEE_ORG is set)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CASES_FILE="${EXAMPLE_DIR}/tests/sample_prompts.json"

if [[ -f "${EXAMPLE_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${EXAMPLE_DIR}/.env"
  set +a
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cases) CASES_FILE="$2"; shift ;;
    --host) APIGEE_HOST="$2"; shift ;;
    --org) APIGEE_ORG="$2"; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

DEV_EMAIL="${DEVELOPER_EMAIL:-router-demo@example.com}"

# Auto-discover host & sample app keys from Apigee when APIGEE_ORG is set and keys aren't provided
if [[ -n "${APIGEE_ORG:-}" ]] && { [[ -z "${APIGEE_HOST:-}" ]] || [[ -z "${ENG_API_KEY:-}" ]]; }; then
  TOKEN="${GOOGLE_OAUTH_ACCESS_TOKEN:-$(gcloud auth print-access-token 2>/dev/null || gcloud auth application-default print-access-token)}"
  APIGEE_API="https://apigee.googleapis.com/v1/organizations/${APIGEE_ORG}"
  if [[ -z "${APIGEE_HOST:-}" ]]; then
    APIGEE_HOST=$(curl -4 -sf -H "Authorization: Bearer ${TOKEN}" "${APIGEE_API}/envgroups" \
      | python3 -c 'import sys,json; d=json.load(sys.stdin); print(next((h for eg in d.get("environmentGroups",[]) for h in eg.get("hostnames",[])), ""))')
  fi
  if [[ -z "${ENG_API_KEY:-}" ]]; then
    ENG_API_KEY=$(curl -4 -sf -H "Authorization: Bearer ${TOKEN}" "${APIGEE_API}/developers/${DEV_EMAIL}/apps/vertex-two-step-engineering-app" \
      | python3 -c 'import sys,json; print(json.load(sys.stdin)["credentials"][0]["consumerKey"])')
  fi
  if [[ -z "${SUP_API_KEY:-}" ]]; then
    SUP_API_KEY=$(curl -4 -sf -H "Authorization: Bearer ${TOKEN}" "${APIGEE_API}/developers/${DEV_EMAIL}/apps/vertex-two-step-support-app" \
      | python3 -c 'import sys,json; print(json.load(sys.stdin)["credentials"][0]["consumerKey"])' || true)
  fi
fi

HOST="${APIGEE_HOST:?Error: Set APIGEE_HOST (or APIGEE_ORG in .env)}"
ENG_KEY="${ENG_API_KEY:?Error: Set ENG_API_KEY (or APIGEE_ORG in .env)}"
SUP_KEY="${SUP_API_KEY:-${ENG_KEY}}"

python3 - "${CASES_FILE}" "${HOST}" "${ENG_KEY}" "${SUP_KEY}" <<'PY'
import json, sys, time, urllib.request, urllib.error

cases_path, host, eng_key, sup_key = sys.argv[1:5]
cases = json.load(open(cases_path, encoding="utf-8"))
base_url = f"https://{host}/vertex-two-step/v1"

print(f"\nGateway: {base_url}")
print("=" * 128)
print(
    f"{'#':<3} {'Scenario':<38} {'Step1 (Conf)':<21} {'Step Used':<18} "
    f"{'Final Cat':<15} {'Routed Model':<20} {'Status'}"
)
print("-" * 128)

passed = 0
failed = 0

for idx, tc in enumerate(cases, 1):
    persona = tc.get("persona", "engineering")
    key = sup_key if persona == "support" else eng_key
    is_stream = bool(tc.get("stream"))
    suffix = "/models/auto:streamGenerateContent?alt=sse" if is_stream else "/models/auto:generateContent"
    body = json.dumps({
        "contents": [{"role": "user", "parts": [{"text": tc["prompt"]}]}],
        "generationConfig": {"maxOutputTokens": 96},
    }).encode("utf-8")

    headers = {"Content-Type": "application/json", "x-apikey": key}
    headers.update(tc.get("headers") or {})
    req = urllib.request.Request(base_url + suffix, data=body, headers=headers, method="POST")

    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            hdrs = {k.lower(): v for k, v in resp.headers.items()}
            code = resp.status
    except urllib.error.HTTPError as e:
        code = e.code
        raw = e.read().decode("utf-8", errors="replace")
        hdrs = {k.lower(): v for k, v in e.headers.items()}
    elapsed_ms = int((time.time() - t0) * 1000)

    s1_cat = hdrs.get("x-gateway-router-step1-category", "-")
    s1_conf = hdrs.get("x-gateway-router-step1-confidence", "-")
    try:
        s1_conf = f"{float(s1_conf):.2f}"
    except Exception:
        pass
    s1_summary = f"{s1_cat} ({s1_conf})"
    step_used = hdrs.get("x-gateway-router-step", "-")
    final_cat = hdrs.get("x-gateway-router-category", "-")
    model = hdrs.get("x-gateway-model", "-")

    ok = (code == 200)
    if tc.get("expected_step") and step_used != tc["expected_step"]:
        ok = False
    if tc.get("expected_category") and final_cat != tc["expected_category"]:
        ok = False
    if tc.get("expected_model") and model != tc["expected_model"]:
        ok = False
    if is_stream and "data:" not in raw:
        ok = False

    status_str = f"PASS ({elapsed_ms}ms)" if ok else f"FAIL HTTP {code}"
    if ok:
        passed += 1
    else:
        failed += 1

    print(
        f"{idx:<3} {tc['title'][:37]:<38} {s1_summary:<21} {step_used:<18} "
        f"{final_cat:<15} {model:<20} {status_str}"
    )

print("=" * 128)
print(f"Summary: {passed}/{len(cases)} sample cases passed.\n")
sys.exit(0 if failed == 0 else 1)
PY
