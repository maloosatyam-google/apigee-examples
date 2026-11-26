# Apigee X & AI Gateway Examples (`apigee-examples`)

Production-ready, self-contained examples for **Google Cloud Apigee X** — covering **AI Gateways**, **intelligent LLM model routing**, **SSE streaming**, **MCP tool governance**, and **enterprise API patterns**.

Every example in this repository targets an **existing Apigee X organization** and ships with:
- A strictly validated `apiproxy/` bundle (`make validate`)
- Matching Apigee API Product JSON definitions (`products/`)
- Fast, zero-dependency offline unit tests (`make test`)
- Lightweight `deploy.sh`, `verify.sh`, and `cleanup.sh` scripts (`gcloud` + `curl` + `python3`)

---

## Examples Catalog

| Category | Example | Description |
|---|---|---|
| **AI Gateway** | [`ai-gateway/vertex-gemini-decision-router`](ai-gateway/vertex-gemini-decision-router) | Built on the **`vertex-ai-v1`** base (API Key, Spike Arrest, `LLMTokenQuota` across buffered & SSE streams, `DataCapture`, Cloud Logging) with **zero-output-token auto-routing** powered by **Google Gemini Decision 1 (`gemini-decision-1`)** and persona-driven API Product attributes across the **Gemini 4** lineup (`gemini-4-carbon`, `gemini-4-argon`, `gemini-4-hydrogen`, `gemini-3.5-flash-lite`). |

---

## Quick Verification (Offline)

Validate every Apigee bundle + API Product schema and run all unit tests locally without GCP credentials:

```bash
make all
```

Or run individual checks:

```bash
# 1. Strict Apigee X bundle & API Product validation
make validate

# 2. Offline JavaScript policy & routing unit tests (Node.js built-in test runner)
make test
```

---

## Repository Layout

```text
apigee-examples/
├── Makefile                                     # Root validator & unit test runner
├── scripts/
│   └── validate_bundle.py                       # Standalone Apigee X bundle & API Product linter (--strict)
└── ai-gateway/
    └── vertex-gemini-decision-router/           # Vertex AI Gemini + Gemini Decision 1 Auto-Router
        ├── apiproxy/                            # Deployable Apigee X proxy bundle
        ├── products/                            # Persona-tiered API Products (Engineering vs Support)
        ├── client/                              # Python SDK & rubric-tuning examples (google-genai >= 3.5.0)
        ├── scripts/                             # deploy.sh, verify.sh, cleanup.sh
        └── tests/                               # Offline Node.js unit test suite
```

---

## Prerequisites for Live Deployment

- An existing **Apigee X** organization and environment (with northbound HTTPS access)
- `gcloud` CLI authenticated (`gcloud auth login`), `curl`, `zip`, `python3`, and `node >= 20` (for offline tests)
- Permissions on the target GCP project to enable `aiplatform.googleapis.com` and `generativelanguage.googleapis.com` and deploy Apigee proxies with a runtime Service Account

---

## License

Apache License 2.0 — see [LICENSE](LICENSE).
