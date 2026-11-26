#!/usr/bin/env bash
# Deploy vertex-ai-router-v1, shared Data Collectors, API Products, and sample Developer Apps
# into an existing Apigee X organization.
#
# Usage:
#   ./scripts/deploy.sh [--org ORG] [--env ENV] [--host HOST] [--project PROJECT]
#                       [--region REGION] [--sa SA_EMAIL]
#                       [--enable-model-armor] [--create-armor-templates]
#                       [--package-only]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${EXAMPLE_DIR}/../.." && pwd)"

if [[ -f "${EXAMPLE_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${EXAMPLE_DIR}/.env"
  set +a
fi

ORG="${APIGEE_ORG:-}"
ENV="${APIGEE_ENV:-dev}"
HOST="${APIGEE_HOST:-}"
PROJECT="${GCP_PROJECT_ID:-${ORG}}"
REGION="${GCP_REGION:-us-central1}"
SA_EMAIL="${PROXY_SA_EMAIL:-}"
ARMOR="${MODEL_ARMOR:-off}"
CREATE_ARMOR="${CREATE_ARMOR_TEMPLATES:-false}"
PACKAGE_ONLY=false
PROXY_NAME="vertex-ai-router-v1"
BASE_PATH="/vertex-router/v1"
DEV_EMAIL="${DEVELOPER_EMAIL:-router-demo@example.com}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --org) ORG="$2"; shift ;;
    --env) ENV="$2"; shift ;;
    --host) HOST="$2"; shift ;;
    --project) PROJECT="$2"; shift ;;
    --region) REGION="$2"; shift ;;
    --sa) SA_EMAIL="$2"; shift ;;
    --enable-model-armor) ARMOR="on" ;;
    --create-armor-templates) ARMOR="on"; CREATE_ARMOR="true" ;;
    --package-only) PACKAGE_ONLY=true ;;
    -h|--help)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

PROJECT="${PROJECT:-my-gcp-project}"
BUILD_DIR="${EXAMPLE_DIR}/.build/${PROXY_NAME}"
ZIP_PATH="${EXAMPLE_DIR}/.build/${PROXY_NAME}.zip"

log()  { printf "\n\033[1;34m==>\033[0m %s\n" "$*"; }
info() { printf "  \033[0;36m[*]\033[0m %s\n" "$*"; }
ok()   { printf "  \033[1;32m[✓]\033[0m %s\n" "$*"; }

# 1. Render bundle with project/region placeholders & validate strictly
log "1. Rendering & validating Apigee bundle (${PROXY_NAME})"
rm -rf "${BUILD_DIR}" "${ZIP_PATH}"
mkdir -p "${BUILD_DIR}"
cp -R "${EXAMPLE_DIR}/apiproxy" "${BUILD_DIR}/apiproxy"

python3 - "${BUILD_DIR}/apiproxy" "${PROJECT}" "${REGION}" <<'PY'
import os, sys
root, project, region = sys.argv[1:4]
for dp, _, files in os.walk(root):
    for fn in files:
        if fn.endswith((".xml", ".js")):
            p = os.path.join(dp, fn)
            txt = open(p, encoding="utf-8").read()
            new_txt = txt.replace("__GCP_PROJECT_ID__", project).replace("__GCP_REGION__", region)
            if new_txt != txt:
                open(p, "w", encoding="utf-8").write(new_txt)
PY

python3 "${REPO_ROOT}/scripts/validate_bundle.py" "${BUILD_DIR}" \
  --product "${EXAMPLE_DIR}/products/engineering_tier.json" \
  --product "${EXAMPLE_DIR}/products/support_tier.json" \
  --strict

(cd "${BUILD_DIR}" && zip -qr "${ZIP_PATH}" apiproxy -x "*.DS_Store*")
ok "Packaged validated bundle: ${ZIP_PATH}"

if [[ "${PACKAGE_ONLY}" == "true" ]]; then
  exit 0
fi

[[ -n "${ORG}" ]] || { echo "Error: --org or APIGEE_ORG is required for live deployment." >&2; exit 1; }
PROJECT="${GCP_PROJECT_ID:-${ORG}}"
TOKEN="${GOOGLE_OAUTH_ACCESS_TOKEN:-$(gcloud auth print-access-token)}"
APIGEE_API="https://apigee.googleapis.com/v1/organizations/${ORG}"

apigee_call() {
  local method="$1" url="$2"; shift 2
  local tmp; tmp="$(mktemp)"
  local code
  code=$(curl -4 -s -o "${tmp}" -w "%{http_code}" -X "${method}" -H "Authorization: Bearer ${TOKEN}" "$@" "${url}")
  if [[ "${code}" -ge 400 ]]; then
    echo "HTTP ${code} from ${method} ${url}" >&2
    cat "${tmp}" >&2
    rm -f "${tmp}"
    return 1
  fi
  cat "${tmp}"
  rm -f "${tmp}"
}

# 2. Enable required GCP APIs & ensure runtime Service Account
log "2. Ensuring GCP APIs & Proxy Runtime Service Account on project '${PROJECT}'"
APIS=("aiplatform.googleapis.com" "generativelanguage.googleapis.com" "logging.googleapis.com" "iam.googleapis.com")
[[ "${ARMOR}" == "on" ]] && APIS+=("modelarmor.googleapis.com")
gcloud services enable "${APIS[@]}" --project="${PROJECT}" --quiet
ok "Enabled APIs: ${APIS[*]}"

if [[ -z "${SA_EMAIL}" ]]; then
  SA_NAME="apigee-vertex-router-sa"
  SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
  if ! gcloud iam service-accounts describe "${SA_EMAIL}" --project="${PROJECT}" >/dev/null 2>&1; then
    gcloud iam service-accounts create "${SA_NAME}" \
      --project="${PROJECT}" \
      --display-name="Apigee Vertex Decision Router Runtime SA"
  fi
  ROLES=("roles/aiplatform.user" "roles/logging.logWriter")
  [[ "${ARMOR}" == "on" ]] && ROLES+=("roles/modelarmor.user")
  for role in "${ROLES[@]}"; do
    gcloud projects add-iam-policy-binding "${PROJECT}" \
      --member="serviceAccount:${SA_EMAIL}" \
      --role="${role}" \
      --condition=None \
      --quiet >/dev/null
  done
  PROJECT_NUM="$(gcloud projects describe "${ORG}" --format='value(projectNumber)')"
  APIGEE_AGENT="service-${PROJECT_NUM}@gcp-sa-apigee.iam.gserviceaccount.com"
  gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
    --project="${PROJECT}" \
    --member="serviceAccount:${APIGEE_AGENT}" \
    --role="roles/iam.serviceAccountTokenCreator" \
    --quiet >/dev/null
fi
ok "Using runtime Service Account: ${SA_EMAIL}"

# Optional: Create Model Armor templates if requested
if [[ "${CREATE_ARMOR}" == "true" ]]; then
  log "2b. Ensuring Model Armor templates in ${REGION}"
  ARMOR_BASE="https://modelarmor.${REGION}.rep.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/templates"
  RAI='{"raiFilters":[{"filterType":"HATE_SPEECH","confidenceLevel":"HIGH"},{"filterType":"DANGEROUS","confidenceLevel":"HIGH"},{"filterType":"SEXUALLY_EXPLICIT","confidenceLevel":"HIGH"},{"filterType":"HARASSMENT","confidenceLevel":"HIGH"}]}'
  PROMPT_CFG="{\"filterConfig\":{\"raiSettings\":${RAI},\"piAndJailbreakFilterSettings\":{\"filterEnforcement\":\"ENABLED\",\"confidenceLevel\":\"HIGH\"},\"maliciousUriFilterSettings\":{\"filterEnforcement\":\"ENABLED\"}}}"
  RESP_CFG="{\"filterConfig\":{\"raiSettings\":${RAI},\"sdpSettings\":{\"basicConfig\":{\"filterEnforcement\":\"ENABLED\"}}}}"
  for tmpl in apigee-sanitize-user-prompt apigee-sanitize-model-response; do
    code=$(curl -4 -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${TOKEN}" "${ARMOR_BASE}/${tmpl}")
    if [[ "${code}" != "200" ]]; then
      body="${PROMPT_CFG}"
      [[ "${tmpl}" == "apigee-sanitize-model-response" ]] && body="${RESP_CFG}"
      curl -4 -sf -X POST -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
        "${ARMOR_BASE}?templateId=${tmpl}" -d "${body}" >/dev/null
      ok "Created Model Armor template: ${tmpl}"
    else
      ok "Model Armor template exists: ${tmpl}"
    fi
  done
fi

# 3. Ensure Apigee Data Collectors exist
log "3. Ensuring shared Apigee Data Collectors"
for spec in "dc_model_name:STRING" "dc_prompt_token_count:INTEGER" "dc_candidates_token_count:INTEGER" "dc_total_token_count:INTEGER"; do
  dc_name="${spec%%:*}"
  dc_type="${spec##*:}"
  code=$(curl -4 -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${TOKEN}" "${APIGEE_API}/datacollectors/${dc_name}")
  if [[ "${code}" != "200" ]]; then
    apigee_call POST "${APIGEE_API}/datacollectors" \
      -H "Content-Type: application/json" \
      -d "{\"name\":\"${dc_name}\",\"type\":\"${dc_type}\",\"description\":\"LLM telemetry collector (${dc_name})\"}" >/dev/null
    ok "Created Data Collector: ${dc_name} (${dc_type})"
  else
    ok "Data Collector exists: ${dc_name}"
  fi
done

# 4. Import & deploy proxy bundle
log "4. Importing & deploying ${PROXY_NAME} to environment '${ENV}'"
REV=$(apigee_call POST "${APIGEE_API}/apis?name=${PROXY_NAME}&action=import" -F "file=@${ZIP_PATH}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["revision"])')
info "Imported ${PROXY_NAME} revision ${REV}"

apigee_call POST "${APIGEE_API}/environments/${ENV}/apis/${PROXY_NAME}/revisions/${REV}/deployments?override=true&serviceAccount=${SA_EMAIL}" >/dev/null

for _ in $(seq 1 60); do
  DEP_JSON=$(apigee_call GET "${APIGEE_API}/environments/${ENV}/apis/${PROXY_NAME}/revisions/${REV}/deployments")
  STATE=$(echo "${DEP_JSON}" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("state",""))')
  if [[ "${STATE}" == "READY" ]]; then
    ok "Deployed ${PROXY_NAME} r${REV} in ${ENV} (READY)"
    break
  elif [[ "${STATE}" == "ERROR" ]]; then
    echo "Deployment failed:" >&2
    echo "${DEP_JSON}" >&2
    exit 1
  fi
  sleep 5
done

# 5. Apply Persona API Products (updating environments and Model Armor toggle)
log "5. Applying Persona API Products (Model Armor=${ARMOR})"
for prod_file in "${EXAMPLE_DIR}/products/engineering_tier.json" "${EXAMPLE_DIR}/products/support_tier.json"; do
  TMP_PROD="$(mktemp)"
  PROD_NAME=$(python3 - "${prod_file}" "${TMP_PROD}" "${ENV}" "${ARMOR}" <<'PY'
import json, sys
src, dst, env, armor = sys.argv[1:5]
data = json.load(open(src, encoding="utf-8"))
data["environments"] = [env]
for attr in data.get("attributes", []):
    if attr["name"] in ("guardrail.modelArmor.prompt", "guardrail.modelArmor.response"):
        attr["value"] = armor
json.dump(data, open(dst, "w", encoding="utf-8"), indent=2)
print(data["name"])
PY
)
  code=$(curl -4 -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${TOKEN}" "${APIGEE_API}/apiproducts/${PROD_NAME}")
  if [[ "${code}" == "200" ]]; then
    apigee_call PUT "${APIGEE_API}/apiproducts/${PROD_NAME}" -H "Content-Type: application/json" --data-binary @"${TMP_PROD}" >/dev/null
  else
    apigee_call POST "${APIGEE_API}/apiproducts" -H "Content-Type: application/json" --data-binary @"${TMP_PROD}" >/dev/null
  fi
  rm -f "${TMP_PROD}"
  ok "Applied API Product: ${PROD_NAME}"
done

# 6. Ensure sample Developer & two persona Developer Apps
log "6. Provisioning sample Developer & Persona Apps"
code=$(curl -4 -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${TOKEN}" "${APIGEE_API}/developers/${DEV_EMAIL}")
if [[ "${code}" != "200" ]]; then
  apigee_call POST "${APIGEE_API}/developers" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${DEV_EMAIL}\",\"firstName\":\"Router\",\"lastName\":\"Demo\",\"userName\":\"router-demo\"}" >/dev/null
fi

get_or_create_app_key() {
  local app_name="$1" product_name="$2"
  local code
  code=$(curl -4 -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${TOKEN}" "${APIGEE_API}/developers/${DEV_EMAIL}/apps/${app_name}")
  if [[ "${code}" != "200" ]]; then
    apigee_call POST "${APIGEE_API}/developers/${DEV_EMAIL}/apps" \
      -H "Content-Type: application/json" \
      -d "{\"name\":\"${app_name}\",\"apiProducts\":[\"${product_name}\"],\"callbackUrl\":\"https://example.com/callback\"}" >/dev/null
  fi
  apigee_call GET "${APIGEE_API}/developers/${DEV_EMAIL}/apps/${app_name}" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["credentials"][0]["consumerKey"])'
}

ENG_KEY="$(get_or_create_app_key "vertex-router-engineering-app" "vertex-router-engineering")"
SUP_KEY="$(get_or_create_app_key "vertex-router-support-app" "vertex-router-support")"

# Discover hostname from envgroup if APIGEE_HOST not explicitly set
if [[ -z "${HOST}" ]]; then
  HOST=$(apigee_call GET "${APIGEE_API}/envgroups" | python3 -c '
import sys, json
data = json.load(sys.stdin)
for eg in data.get("environmentGroups", []):
    hosts = eg.get("hostnames", [])
    if hosts:
        print(hosts[0])
        break
' || true)
fi
GATEWAY_URL="https://${HOST:-<APIGEE_HOST>}${BASE_PATH}"

cat <<EOF

================================================================================
  Deployment Complete!
================================================================================
  Gateway Base URL : ${GATEWAY_URL}
  Engineering Key  : ${ENG_KEY}
  Support Key      : ${SUP_KEY}
  Model Armor      : ${ARMOR}

  Try Auto-Routing via Gemini Decision 1 (0 output tokens):
  curl -si -X POST "${GATEWAY_URL}/models/auto:generateContent" \\
    -H "Content-Type: application/json" \\
    -H "x-apikey: ${ENG_KEY}" \\
    -d '{"contents":[{"role":"user","parts":[{"text":"Write a Python binary search function with type hints."}]}]}' \\
    | grep -iE "^(HTTP/|x-auto-routed|x-gateway-)"

  Run full live verification suite:
  APIGEE_HOST="${HOST:-<APIGEE_HOST>}" ENG_API_KEY="${ENG_KEY}" SUP_API_KEY="${SUP_KEY}" MODEL_ARMOR="${ARMOR}" ./scripts/verify.sh
================================================================================
EOF
