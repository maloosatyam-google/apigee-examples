#!/usr/bin/env python3
"""Client examples for Gemini Decision 1 (`gemini-decision-1`) & the Apigee Auto-Routing Gateway.

Prerequisites:
  pip install -U "google-genai>=3.5.0"

Modes:
  1. Direct Decisions API rubric playground (requires GEMINI_API_KEY):
       python3 client/python_example.py --local-decisions

  2. Apigee Auto-Routing Gateway calls (requires APIGEE_HOST and ENG_API_KEY):
       APIGEE_HOST="api.example.com" ENG_API_KEY="..." SUP_API_KEY="..." \
         python3 client/python_example.py --gateway
"""
import argparse
import json
import os
import urllib.request

SAMPLE_PROMPTS = [
    ("Simple lookup", "Hi! What is the boiling point of water at sea level in Celsius?"),
    ("General drafting", "Draft a concise 3-bullet status update email for our weekly API platform sync."),
    ("Software coding", "Write a thread-safe LRU cache in Python using collections.OrderedDict and threading.Lock."),
    (
        "Deep reasoning",
        "Compare Paxos, Raft, and Google Spanner TrueTime under asymmetric WAN partitions and derive "
        "when bounded clock uncertainty eliminates read-lease round trips.",
    ),
]

ROUTING_QUESTIONS = {
    "category": {
        "type": "choice",
        "instructions": (
            "Which single LLM routing category best fits this user request: "
            "coding, deep_reasoning, simple, or general?"
        ),
        "criteria": {
            "coding": (
                "Programming, software engineering, writing, debugging, reviewing, or refactoring code, "
                "SQL queries, regular expressions, shell scripts, or API implementations."
            ),
            "deep_reasoning": (
                "Complex multi-step analysis, system architecture trade-offs, formal proofs, security auditing, "
                "mathematical derivation, root-cause diagnosis, or strategic planning."
            ),
            "simple": (
                "Short greetings, factual trivia, brief definitions, single-sentence translations, "
                "or straightforward lookups."
            ),
            "general": (
                "Everyday writing, drafting emails or memos, summarization, brainstorming, and general "
                "conversation not requiring code or deep multi-step reasoning."
            ),
        },
    },
    "complexity": {
        "type": "score",
        "instructions": "Rate the reasoning depth and technical difficulty required to answer this user request.",
        "criteria": [
            "Trivial: greeting, simple fact, or single-step lookup.",
            "Routine: standard explanation, summarization, or everyday drafting.",
            "Substantial: multi-step problem solving, non-trivial code implementation, or structured analysis.",
            "Frontier: deep architectural design, formal proof, security audit, or complex multi-constraint reasoning.",
        ],
    },
}


def run_local_decisions() -> None:
    """Evaluate the exact routing questions locally with google-genai >= 3.5.0 (`v1beta`)."""
    from google import genai

    client = genai.Client(http_options={"api_version": "v1beta"})
    print(f"{'Label':<18} {'Choice':<16} {'Conf':<7} {'Score':<7} {'InTok':<7} {'OutTok'}")
    print("-" * 70)

    for label, prompt in SAMPLE_PROMPTS:
        result = client.decisions.create(
            model="gemini-decision-1",
            input=prompt,
            questions=ROUTING_QUESTIONS,
        )
        cat = result.answers["category"]
        comp = result.answers["complexity"]
        in_tok = result.usage.total_input_tokens
        out_tok = result.usage.total_output_tokens
        print(f"{label:<18} {cat.choice:<16} {cat.confidence:<7.2f} {comp.score:<7.2f} {in_tok:<7} {out_tok}")


def call_gateway(url: str, api_key: str, prompt: str) -> dict:
    body = json.dumps({
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"maxOutputTokens": 128},
    }).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "x-apikey": api_key},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        headers = {k.lower(): v for k, v in resp.headers.items()}
        payload = json.loads(resp.read().decode("utf-8"))
    return {"headers": headers, "payload": payload}


def run_gateway_demo() -> None:
    host = os.environ["APIGEE_HOST"]
    eng_key = os.environ["ENG_API_KEY"]
    sup_key = os.environ.get("SUP_API_KEY")
    url = f"https://{host}/vertex-router/v1/models/auto:generateContent"

    personas = [("Engineering", eng_key)] + ([("Support", sup_key)] if sup_key else [])
    print(f"{'Persona':<13} {'Prompt Type':<18} {'Category':<16} {'Conf':<6} {'Score':<6} {'Routed Model'}")
    print("-" * 92)

    for persona_name, key in personas:
        for label, prompt in SAMPLE_PROMPTS:
            res = call_gateway(url, key, prompt)
            h = res["headers"]
            print(
                f"{persona_name:<13} {label:<18} "
                f"{h.get('x-gateway-router-category', '-'):<16} "
                f"{h.get('x-gateway-router-confidence', '-'):<6} "
                f"{h.get('x-gateway-router-complexity', '-'):<6} "
                f"{h.get('x-gateway-model', '-')}"
            )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--local-decisions", action="store_true", help="Test Gemini Decision 1 rubric directly")
    group.add_argument("--gateway", action="store_true", help="Call deployed Apigee auto-routing gateway")
    args = parser.parse_args()

    if args.local_decisions:
        run_local_decisions()
    else:
        run_gateway_demo()


if __name__ == "__main__":
    main()
