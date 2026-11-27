#!/usr/bin/env bash
# Interactive / customer-friendly sample test runner for vertex-ai-router-v1.
# Runs all prompts from tests/sample_prompts.json (or a custom JSON file) against the deployed
# Apigee gateway and prints a formatted routing & token telemetry table.
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
    ENG_API_KEY=$(curl -4 -sf -H "Authorization: Bearer ${TOKEN}" "${APIGEE_API}/developers/${DEV_EMAIL}/apps/vertex-router-engineering-app" \
      | python3 -c 'import sys,json; print(json.load(sys.stdin)["credentials"][0]["consumerKey"])')
  fi
  if [[ -z "${SUP_API_KEY:-}" ]]; then
    SUP_API_KEY=$(curl -4 -sf -H "Authorization: Bearer ${TOKEN}" "${APIGEE_API}/developers/${DEV_EMAIL}/apps/vertex-router-support-app" \
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
base_url = f"https://{host}/vertex-router/v1"

print(f"\nGateway: {base_url}")
print("=" * 116)
print(f"{'#':<3} {'Scenario':<38} {'Persona':<12} {'Category':<15} {'Conf':<6} {'Score':<6} {'Routed Model':<22} {'Status'}")
print("-" * 116)

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

    cat = hdrs.get("x-gateway-router-category", "-")
    conf = hdrs.get("x-gateway-router-confidence", "-")
    score = hdrs.get("x-gateway-router-complexity", "-")
    try:
        conf = f"{float(conf):.2f}"
    except Exception:
        pass
    try:
        score = f"{float(score):.2f}"
    except Exception:
        pass
    model = hdrs.get("x-gateway-model", "-")

    ok = (code == 200)
    if tc.get("expected_category") and cat != tc["expected_category"]:
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

    print(f"{idx:<3} {tc['title'][:37]:<38} {persona:<12} {cat:<15} {conf:<6} {score:<6} {model:<22} {status_str}")

print("=" * 116)
print(f"Summary: {passed}/{len(cases)} sample cases passed.\n")
sys.exit(0 if failed == 0 else 1)
PY
