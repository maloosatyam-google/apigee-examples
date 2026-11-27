#!/usr/bin/env python3
"""2-Step Decision Router playground (`gemini-decision-1` -> `< 0.70` -> `gemini-3.5-flash-lite`)
and live Apigee AI Gateway runner.

Prerequisites:
  pip install -U "google-genai>=3.5.0"

Modes:
  1. Local 2-step cascade against the Gemini API (requires GEMINI_API_KEY):
       python3 client/python_example.py --local-two-step [--threshold 0.70]

  2. Deployed Apigee 2-Step Gateway calls (requires APIGEE_HOST and ENG_API_KEY):
       APIGEE_HOST="api.example.com" ENG_API_KEY="..." SUP_API_KEY="..." \
         python3 client/python_example.py --gateway
"""
import argparse
import json
import os
import urllib.request

SAMPLE_PROMPTS = [
    ("Clear simple", "Hi! What is the capital of Norway?"),
    ("Clear coding", "Write a thread-safe token bucket rate limiter in Python with unit tests."),
    (
        "Ambiguous hybrid",
        "Draft a brief Slack note to the team explaining why our checkout query slowed down and "
        "include a 2-line SQL index example.",
    ),
    (
        "Deep reasoning",
        "Compare Paxos, Raft, and Spanner TrueTime under asymmetric WAN partitions and derive "
        "when bounded clock uncertainty eliminates read-lease round trips.",
    ),
]

STEP1_QUESTIONS = {
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

STEP2_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "category": {
            "type": "string",
            "enum": ["coding", "deep_reasoning", "simple", "general"],
        }
    },
    "required": ["category"],
}


def run_local_two_step(threshold: float) -> None:
    """Run Step 1 (`gemini-decision-1`) -> if confidence < threshold -> Step 2 (`gemini-3.5-flash-lite`)."""
    from google import genai

    decisions_client = genai.Client(http_options={"api_version": "v1beta"})
    interactions_client = genai.Client()

    print(f"{'Prompt Type':<18} {'Step1 Cat':<15} {'Conf':<6} {'Step Used':<18} {'Final Category'}")
    print("-" * 80)

    for label, prompt in SAMPLE_PROMPTS:
        step1 = decisions_client.decisions.create(
            model="gemini-decision-1",
            input=prompt,
            questions=STEP1_QUESTIONS,
        )
        cat_ans = step1.answers["category"]
        s1_cat = cat_ans.choice
        s1_conf = cat_ans.confidence

        if s1_conf >= threshold:
            final_cat = s1_cat
            step_used = "step1-decision-1"
        else:
            step2_prompt = (
                "You are the Step 2 tie-breaker router for an enterprise AI Gateway. "
                "Step 1 classification was ambiguous. Pick the single best category "
                "(coding, deep_reasoning, simple, or general).\n\n"
                f"Step 1 calibrated probabilities: {json.dumps(cat_ans.probabilities)}\n\n"
                f"User request:\n{prompt}"
            )
            interaction = interactions_client.interactions.create(
                model="gemini-3.5-flash-lite",
                input=step2_prompt,
                store=False,
                response_format={
                    "type": "text",
                    "mime_type": "application/json",
                    "schema": STEP2_RESPONSE_SCHEMA,
                },
            )
            final_cat = json.loads(interaction.output_text)["category"]
            step_used = "step2-flash-lite"

        print(f"{label:<18} {s1_cat:<15} {s1_conf:<6.2f} {step_used:<18} {final_cat}")


def call_gateway(url: str, api_key: str, prompt: str, extra_headers: dict | None = None) -> dict:
    body = json.dumps({
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"maxOutputTokens": 128},
    }).encode("utf-8")
    headers = {"Content-Type": "application/json", "x-apikey": api_key}
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=60) as resp:
        resp_headers = {k.lower(): v for k, v in resp.headers.items()}
        payload = json.loads(resp.read().decode("utf-8"))
    return {"headers": resp_headers, "payload": payload}


def run_gateway_demo() -> None:
    host = os.environ["APIGEE_HOST"]
    eng_key = os.environ["ENG_API_KEY"]
    sup_key = os.environ.get("SUP_API_KEY")
    url = f"https://{host}/vertex-two-step/v1/models/auto:generateContent"

    personas = [("Engineering", eng_key)] + ([("Support", sup_key)] if sup_key else [])
    print(
        f"{'Persona':<13} {'Prompt Type':<18} {'Step':<18} {'S1 Conf':<8} "
        f"{'Final Cat':<15} {'Routed Model'}"
    )
    print("-" * 98)

    for persona_name, key in personas:
        for label, prompt in SAMPLE_PROMPTS:
            res = call_gateway(url, key, prompt)
            h = res["headers"]
            print(
                f"{persona_name:<13} {label:<18} "
                f"{h.get('x-gateway-router-step', '-'):<18} "
                f"{h.get('x-gateway-router-step1-confidence', '-'):<8} "
                f"{h.get('x-gateway-router-category', '-'):<15} "
                f"{h.get('x-gateway-model', '-')}"
            )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--local-two-step", action="store_true", help="Run 2-step cascade locally")
    group.add_argument("--gateway", action="store_true", help="Call deployed Apigee 2-step gateway")
    parser.add_argument("--threshold", type=float, default=0.70, help="Step 1 confidence threshold (default 0.70)")
    args = parser.parse_args()

    if args.local_two_step:
        run_local_two_step(args.threshold)
    else:
        run_gateway_demo()


if __name__ == "__main__":
    main()
