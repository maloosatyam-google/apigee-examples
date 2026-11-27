#!/usr/bin/env bash
# Remove sample apps, API Products, and undeploy/delete vertex-two-step-router-v1 from Apigee X.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -f "${EXAMPLE_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${EXAMPLE_DIR}/.env"
  set +a
fi

ORG="${APIGEE_ORG:-}"
ENV="${APIGEE_ENV:-dev}"
DEV_EMAIL="${DEVELOPER_EMAIL:-router-demo@example.com}"
PROXY_NAME="vertex-two-step-router-v1"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --org) ORG="$2"; shift ;;
    --env) ENV="$2"; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

[[ -n "${ORG}" ]] || { echo "Error: --org or APIGEE_ORG is required." >&2; exit 1; }
TOKEN="${GOOGLE_OAUTH_ACCESS_TOKEN:-$(gcloud auth print-access-token 2>/dev/null || gcloud auth application-default print-access-token)}"
APIGEE_API="https://apigee.googleapis.com/v1/organizations/${ORG}"

echo "==> Cleaning up sample apps, products, and proxy '${PROXY_NAME}' in '${ORG}' (${ENV})..."

for app in "vertex-two-step-engineering-app" "vertex-two-step-support-app"; do
  curl -4 -s -X DELETE -H "Authorization: Bearer ${TOKEN}" \
    "${APIGEE_API}/developers/${DEV_EMAIL}/apps/${app}" >/dev/null || true
done

for prod in "vertex-two-step-engineering" "vertex-two-step-support"; do
  curl -4 -s -X DELETE -H "Authorization: Bearer ${TOKEN}" \
    "${APIGEE_API}/apiproducts/${prod}" >/dev/null || true
done

REVS=$(curl -4 -s -H "Authorization: Bearer ${TOKEN}" \
  "${APIGEE_API}/environments/${ENV}/apis/${PROXY_NAME}/deployments" \
  | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  for dep in d.get("deployments",[]): print(dep.get("revision",""))
except Exception: pass' || true)

for rev in ${REVS}; do
  [[ -n "${rev}" ]] && curl -4 -s -X DELETE -H "Authorization: Bearer ${TOKEN}" \
    "${APIGEE_API}/environments/${ENV}/apis/${PROXY_NAME}/revisions/${rev}/deployments" >/dev/null || true
done

curl -4 -s -X DELETE -H "Authorization: Bearer ${TOKEN}" \
  "${APIGEE_API}/apis/${PROXY_NAME}" >/dev/null || true

echo "Cleanup complete."
