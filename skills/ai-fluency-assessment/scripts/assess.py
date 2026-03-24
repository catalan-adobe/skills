#!/usr/bin/env python3
"""AI Fluency Assessment: evidence collection and behavior classification.

Scans Claude Code JSONL session files, extracts user messages, and
classifies them against 18 behaviors from Anthropic's 4D AI Fluency
Framework (Dakan, Feller & Anthropic, 2025).

Default mode uses LLM classification (requires anthropic SDK).
Use --regex-only for a fast, free approximation (stdlib only, 11 behaviors).
"""

import argparse
import json
import re
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

# ── Behavior definitions ────────────────────────────────────────────

BEHAVIORS = {
    "B1": {
        "name": "Clarifies goal before asking for help",
        "competency": "Delegation",
        "regex_early_only": True,
        "patterns": [
            r"\bi want to\b", r"\bi need to\b", r"\bmy goal is\b",
            r"\bi[''']m trying to\b", r"\bwhat i want to achieve\b",
            r"\bthe objective is\b", r"\bi[''']m looking to\b",
            r"\bthe purpose is\b", r"\bi[''']d like to\b",
            r"\bwhat i need is\b",
        ],
    },
    "B2": {
        "name": "Understands problem scope and nature",
        "competency": "Delegation",
    },
    "B5": {
        "name": "Consults AI on approach before execution",
        "competency": "Delegation",
        "patterns": [
            r"\bhow should i\b", r"\bwhat approach\b",
            r"\bwhat would you recommend\b", r"\bwhat[''']s the best way\b",
            r"\bbefore i start\b", r"\bhow would you tackle\b",
            r"\bwhat do you think about\b", r"\bshould i use\b",
            r"\bwhat strategy\b", r"\bhelp me think through\b",
        ],
    },
    "B6": {
        "name": "Distributes work strategically between self and AI",
        "competency": "Delegation",
    },
    "B7": {
        "name": "Specifies format and structure needed",
        "competency": "Description",
        "patterns": [
            r"\bformat as\b", r"\buse bullet\b", r"\bas a table\b",
            r"\bin json\b", r"\bas markdown\b", r"\bnumbered list\b",
            r"\bgive me a summary\b", r"\boutput as\b",
            r"\bstructured as\b", r"\bwrite it as a\b",
            r"\bin the format\b", r"\bas csv\b",
        ],
    },
    "B8": {
        "name": "Defines audience for the output",
        "competency": "Description",
        "patterns": [
            r"\bthis is for\b", r"\bthe audience is\b", r"\bwritten for\b",
            r"\btargeted at\b", r"\bthe reader will be\b",
            r"\bnon-technical\b", r"\bfor my manager\b",
            r"\bfor developers\b", r"\bfor the team\b",
            r"\bstakeholders will\b",
        ],
    },
    "B9": {
        "name": "Provides examples of what good looks like",
        "competency": "Description",
        "patterns": [
            r"\bhere[''']s an example\b", r"\blike this:",
            r"\bsimilar to\b", r"\bhere[''']s a template\b",
            r"\bfor reference\b", r"\bsomething like\b",
            r"\bmodeled after\b", r"\bbased on this example\b",
            r"\bhere[''']s what i mean\b",
        ],
    },
    "B10": {
        "name": "Iterates and refines",
        "competency": "Description",
        "patterns": [
            r"\bcan you revise\b", r"\bchange it to\b",
            r"\bmake it more\b", r"\bthat[''']s close but\b",
            r"\bnow adjust\b", r"\bkeep the same but\b",
            r"\btry again\b", r"\bactually,? let[''']s\b",
            r"\binstead of that\b", r"\bone more change\b",
            r"\bnot quite\b", r"\balmost but\b",
            r"\btweak the\b", r"\brework the\b",
        ],
    },
    "B11": {
        "name": "Sets interaction mode",
        "competency": "Description",
        "patterns": [
            r"\bact as\b", r"\bplay devil[''']s advocate\b",
            r"\bdon[''']t give me the answer\b", r"\bjust do it\b",
            r"\bwalk me through\b", r"\bchallenge my\b",
            r"\bthink step by step\b", r"\bbrainstorm with me\b",
            r"\bdon[''']t explain,? just\b", r"\byou are a\b",
            r"\byour role is\b",
        ],
    },
    "B12": {
        "name": "Communicates tone and style preferences",
        "competency": "Description",
        "patterns": [
            r"\bkeep it concise\b", r"\buse formal\b",
            r"\bcasual tone\b", r"\bavoid jargon\b", r"\bbe direct\b",
            r"\bfriendly tone\b", r"\bprofessional tone\b",
            r"\bsimple language\b", r"\bin the style of\b",
            r"\btone should be\b", r"\bkeep it short\b",
        ],
    },
    "B13": {
        "name": "Checks facts and claims that matter",
        "competency": "Discernment",
        "patterns": [
            r"\bis this accurate\b", r"\bcan you verify\b",
            r"\bwhat[''']s the source\b", r"\bdouble[- ]check\b",
            r"\bare you sure\b", r"\bthat doesn[''']t seem right\b",
            r"\bsource for that\b", r"\bis that correct\b",
            r"\bverify this\b", r"\bfact[- ]check\b",
        ],
    },
    "B14": {
        "name": "Identifies when AI might be missing context",
        "competency": "Discernment",
        "patterns": [
            r"\byou might not know\b", r"\blet me add context\b",
            r"\bi should mention\b", r"\byou[''']re missing\b",
            r"\bfor context\b", r"\bwhat you don[''']t know is\b",
            r"\bimportant background\b", r"\byou need to know that\b",
            r"\badditional context\b", r"\bare you aware that\b",
        ],
    },
    "B15": {
        "name": "Questions when AI reasoning doesn't hold up",
        "competency": "Discernment",
        "patterns": [
            r"\bwhy do you think\b", r"\bthat doesn[''']t follow\b",
            r"\bi disagree because\b", r"\bexplain your reasoning\b",
            r"\bthat logic doesn[''']t\b",
            r"\bi don[''']t think that[''']s right\b",
            r"\bwhat makes you say\b",
            r"\bthat conclusion doesn[''']t\b",
            r"\bhow did you arrive at\b", r"\bthat[''']s not correct\b",
            r"\byou[''']re wrong about\b", r"\bthat contradicts\b",
        ],
    },
    "B16": {
        "name": "Detects when AI generates incorrect information",
        "competency": "Discernment",
    },
    "B17": {
        "name": "Evaluates and adjusts AI communication style",
        "competency": "Discernment",
    },
    "B21": {
        "name": "Discloses AI involvement to stakeholders",
        "competency": "Diligence",
    },
    "B22": {
        "name": "Represents AI contribution accurately",
        "competency": "Diligence",
    },
    "B23": {
        "name": "Verifies and tests AI outputs before sharing",
        "competency": "Diligence",
    },
}

# Behaviors that have regex patterns (used by --regex-only)
REGEX_BEHAVIORS = {bid: b for bid, b in BEHAVIORS.items() if "patterns" in b}

# Compile regex patterns
COMPILED = {
    bid: [re.compile(p, re.IGNORECASE) for p in bdef["patterns"]]
    for bid, bdef in REGEX_BEHAVIORS.items()
}

VALID_BIDS = set(BEHAVIORS.keys())
MAX_SAMPLES = 10

# ── Project name cleaning ───────────────────────────────────────────

_SKIP_PREFIXES = [
    "users-catalan-repos-", "users-catalan-documents-",
    "users-paolo-playground-", "home-azureuser-repos-",
    "home-azureuser-", "applications-", "private-",
    "users-", "home-",
]


def clean_project_name(dirname: str) -> str:
    """Turn '-Users-catalan-repos-ai-foo-bar' into 'ai-foo-bar'."""
    raw = dirname.lstrip("-")
    lower = raw.lower()
    for prefix in _SKIP_PREFIXES:
        if lower.startswith(prefix):
            raw = raw[len(prefix):]
            break
    if len(raw) > 60:
        short = raw[-60:]
        idx = short.find("-")
        if idx > 0:
            short = short[idx + 1:]
        raw = short
    return raw.strip("-") or dirname.strip("-")


# ── JSONL parsing ───────────────────────────────────────────────────

def parse_sessions(sessions_dir: Path, max_sessions: int):
    """Walk sessions_dir, parse JSONL files, return messages and stats."""
    jsonl_files = sorted(sessions_dir.rglob("*.jsonl"))
    total_scanned = 0
    sessions_with_messages = set()
    messages = []
    project_stats = defaultdict(
        lambda: {"full_path": "", "messages": 0, "sessions": set()}
    )

    for fpath in jsonl_files:
        if total_scanned >= max_sessions:
            break
        if "/subagents/" in str(fpath):
            continue
        total_scanned += 1

        parts = fpath.relative_to(sessions_dir).parts
        raw_project = parts[0] if parts else "unknown"
        project = clean_project_name(raw_project)
        session_id = fpath.stem
        project_stats[project]["full_path"] = str(sessions_dir / raw_project)

        user_msg_index = 0
        try:
            f = open(fpath, encoding="utf-8", errors="replace")
        except OSError as exc:
            print(
                f"Warning: skipping {fpath}: {exc}", file=sys.stderr
            )
            continue
        with f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if record.get("type") != "user":
                    continue
                content = record.get("message", {}).get("content")
                if not isinstance(content, str) or not content.strip():
                    continue
                user_msg_index += 1
                messages.append({
                    "project": project,
                    "session_id": session_id,
                    "timestamp": record.get("timestamp", ""),
                    "content": content,
                    "session_msg_index": user_msg_index,
                })
                sessions_with_messages.add(session_id)
                project_stats[project]["messages"] += 1
                project_stats[project]["sessions"].add(session_id)

    projects_out = {
        name: {
            "full_path": data["full_path"],
            "message_count": data["messages"],
            "session_count": len(data["sessions"]),
        }
        for name, data in project_stats.items()
    }
    return {
        "total_scanned": total_scanned,
        "sessions_with_messages": len(sessions_with_messages),
        "messages": messages,
        "projects": projects_out,
    }


# ── Regex analysis (--regex-only) ───────────────────────────────────

def run_regex(messages: list) -> dict:
    """Match messages against regex patterns for 11 observable behaviors."""
    results = _empty_results(REGEX_BEHAVIORS)
    for msg in messages:
        content = msg["content"]
        for bid, patterns in COMPILED.items():
            if BEHAVIORS[bid].get("regex_early_only"):
                if msg["session_msg_index"] > 2:
                    continue
            if any(p.search(content) for p in patterns):
                _record_match(results[bid], msg)
    return results


# ── LLM classification (default) ───────────────────────────────────

CLASSIFY_SYSTEM = """\
You classify user messages from human-AI coding conversations.
For each message, determine which behaviors are demonstrated.

Behaviors:
- B1: Clarifies goal before asking for help
- B2: Understands problem scope and nature (breaks down, analyzes, scopes)
- B5: Consults AI on approach before execution
- B6: Distributes work strategically (delegates to AI, uses subagents, divides tasks)
- B7: Specifies format and structure needed
- B8: Defines audience for the output
- B9: Provides examples of what good looks like
- B10: Iterates and refines
- B11: Sets interaction mode
- B12: Communicates tone and style preferences
- B13: Checks facts and claims that matter
- B14: Identifies when AI might be missing context
- B15: Questions when AI reasoning doesn't hold up
- B16: Detects when AI generates incorrect information (catches errors, says "that's wrong")
- B17: Evaluates and adjusts AI communication style ("be more concise", "too verbose")
- B21: Discloses AI involvement to stakeholders (attribution, Co-Authored-By)
- B22: Represents AI contribution accurately (discusses extent of AI help)
- B23: Verifies and tests AI outputs before sharing (runs tests, checks results)

Rules:
- A message can match zero, one, or multiple behaviors.
- Only mark a behavior if there is clear evidence in the message text.
- B1 is about stating a goal/objective, not just making a request.
- B5 is about asking for strategic advice BEFORE doing work.
- B9 is about providing reference examples, not just mentioning something.
- B10 is about refining a PREVIOUS output, not just asking for something new.
- B15 is about pushing back on AI reasoning, not just asking questions.
- B16 is about catching AI errors — pointing out something is wrong or doesn't work.
- B23 is about verification — running tests, checking output, validating results.

Return valid JSON only — no other text."""


def _create_client(args):
    """Create an Anthropic API client with auto-detection."""
    import anthropic
    import os

    if args.base_url or args.api_key:
        kwargs = {}
        if args.base_url:
            kwargs["base_url"] = args.base_url
        if args.api_key:
            kwargs["api_key"] = args.api_key
        return anthropic.Anthropic(**kwargs)
    if os.environ.get("ANTHROPIC_FOUNDRY_API_KEY"):
        print("Using Anthropic Foundry credentials from environment")
        return anthropic.AnthropicFoundry()
    return anthropic.Anthropic()


def _parse_llm_response(text: str) -> list | None:
    """Extract JSON results from LLM response, handling code fences."""
    if "```json" in text:
        text = text.split("```json", 1)[1]
    if "```" in text:
        text = text.split("```", 1)[0]
    text = text.strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return None
    items = (
        parsed.get("results", parsed)
        if isinstance(parsed, dict) else parsed
    )
    return items if isinstance(items, list) else None


def classify_batch(
    client, model: str, messages: list[dict]
) -> list[list[str]]:
    """Send a batch of messages to Claude for behavior classification."""
    numbered = "\n\n".join(
        f"[{i + 1}] {m['content'][:800]}"
        for i, m in enumerate(messages)
    )
    user_prompt = (
        f"Classify these {len(messages)} messages. For each, list "
        f"behavior IDs that apply (e.g. B1, B7, B23). "
        f"Return JSON: {{\"results\": [{{\"index\": 1, \"behaviors\": "
        f'["B1"]}}, ...]}}\n\n{numbered}'
    )
    response = client.messages.create(
        model=model,
        max_tokens=4096,
        system=CLASSIFY_SYSTEM,
        messages=[{"role": "user", "content": user_prompt}],
    )
    text = next(
        (b.text for b in response.content if b.type == "text"), "{}"
    )
    items = _parse_llm_response(text)
    if items is None:
        print(
            f"  Warning: failed to parse response: {text[:80]}",
            file=sys.stderr,
        )
        return [[] for _ in messages]

    out = [[] for _ in messages]
    for item in items:
        if not isinstance(item, dict):
            continue
        idx = item.get("index", 0) - 1
        if 0 <= idx < len(messages):
            out[idx] = [
                b for b in item.get("behaviors", []) if b in VALID_BIDS
            ]
    return out


def run_llm(messages: list, args) -> dict:
    """Run LLM-based behavior classification on all messages."""
    try:
        import anthropic  # noqa: F401
    except ImportError:
        print(
            "Error: LLM classification requires the anthropic SDK.\n"
            "Install: uv pip install anthropic\n"
            "Or use --regex-only for a free approximation.",
            file=sys.stderr,
        )
        sys.exit(1)

    client = _create_client(args)
    batch_size = args.batch_size
    total = len(messages)
    total_batches = (total + batch_size - 1) // batch_size
    print(f"\nLLM classification: {total} messages in {total_batches} batches")
    print(f"Model: {args.model}")

    results = _empty_results(BEHAVIORS)

    for start in range(0, total, batch_size):
        batch = messages[start: start + batch_size]
        batch_num = start // batch_size + 1
        print(
            f"  Batch {batch_num}/{total_batches} "
            f"(messages {start + 1}-{start + len(batch)})",
            end="", flush=True,
        )
        try:
            classifications = classify_batch(client, args.model, batch)
        except Exception as exc:
            print(f" ERROR: {exc}", file=sys.stderr)
            continue
        batch_matches = sum(len(c) for c in classifications)
        print(f" — {batch_matches} matches")

        for i, behaviors in enumerate(classifications):
            for bid in behaviors:
                _record_match(results[bid], batch[i])

    return results


# ── Shared helpers ──────────────────────────────────────────────────

def _empty_results(behavior_set: dict) -> dict:
    """Create empty results dict for a set of behaviors."""
    return {
        bid: {
            "name": bdef["name"],
            "competency": bdef["competency"],
            "match_count": 0,
            "sample_messages": [],
            "project_counts": defaultdict(int),
        }
        for bid, bdef in behavior_set.items()
    }


def _record_match(bucket: dict, msg: dict):
    """Record a behavior match for a message."""
    bucket["match_count"] += 1
    bucket["project_counts"][msg["project"]] += 1
    if len(bucket["sample_messages"]) < MAX_SAMPLES:
        bucket["sample_messages"].append({
            "content": msg["content"][:500],
            "project": msg["project"],
            "session_id": msg["session_id"],
        })


def write_evidence(output_dir: Path, sessions_dir: Path, parsed: dict):
    """Write evidence.json with all extracted user messages."""
    output_dir.mkdir(parents=True, exist_ok=True)
    evidence = {
        "collection_date": str(date.today()),
        "sessions_dir": str(sessions_dir),
        "total_sessions_scanned": parsed["total_scanned"],
        "sessions_with_user_messages": parsed["sessions_with_messages"],
        "total_user_messages": len(parsed["messages"]),
        "projects": parsed["projects"],
        "messages": [
            {
                "project": m["project"],
                "session_id": m["session_id"],
                "timestamp": m["timestamp"],
                "content": m["content"],
            }
            for m in parsed["messages"]
        ],
    }
    path = output_dir / "evidence.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(evidence, f, indent=2, ensure_ascii=False)
    return path


def write_analysis(output_dir: Path, messages: list, results: dict,
                   method: str):
    """Write analysis.json with behavior classification results."""
    output_dir.mkdir(parents=True, exist_ok=True)
    behaviors_out = {}
    for bid, data in results.items():
        top_projects = sorted(
            data["project_counts"].items(),
            key=lambda x: x[1], reverse=True,
        )[:10]
        behaviors_out[bid] = {
            "name": data["name"],
            "competency": data["competency"],
            "match_count": data["match_count"],
            "sample_messages": data["sample_messages"],
            "top_projects": [
                {"project": p, "count": c} for p, c in top_projects
            ],
        }
    analysis = {
        "analysis_date": str(date.today()),
        "total_messages_analyzed": len(messages),
        "method": method,
        "behaviors": behaviors_out,
    }
    path = output_dir / "analysis.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(analysis, f, indent=2, ensure_ascii=False)
    return path


def print_results(results: dict):
    """Print behavior match counts to stdout."""
    for bid in sorted(results, key=lambda b: int(b[1:])):
        data = results[bid]
        print(f"  {bid}: {data['match_count']:>5}  {data['name']}")


# ── CLI ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description=(
            "AI Fluency Assessment: collect evidence and classify "
            "behaviors from Claude Code sessions."
        ),
    )
    parser.add_argument(
        "--sessions-dir", type=Path,
        default=Path.home() / ".claude" / "projects",
        help="Directory containing JSONL session files "
        "(default: ~/.claude/projects).",
    )
    parser.add_argument(
        "--output-dir", type=Path, default=Path(".ai-fluency"),
        help="Output directory (default: .ai-fluency/).",
    )
    parser.add_argument(
        "--max-sessions", type=int, default=2000,
        help="Max session files to scan (default: 2000).",
    )
    parser.add_argument(
        "--regex-only", action="store_true",
        help="Use regex heuristics instead of LLM classification "
        "(fast/free but less accurate, 11 behaviors only).",
    )
    parser.add_argument(
        "--model", default="claude-haiku-4-5",
        help="Model for LLM classification (default: claude-haiku-4-5).",
    )
    parser.add_argument(
        "--base-url", default=None,
        help="API base URL (or set ANTHROPIC_BASE_URL).",
    )
    parser.add_argument(
        "--api-key", default=None,
        help="API key (or set ANTHROPIC_API_KEY).",
    )
    parser.add_argument(
        "--batch-size", type=int, default=20,
        help="Messages per LLM batch (default: 20).",
    )
    args = parser.parse_args()

    sessions_dir = args.sessions_dir.expanduser().resolve()
    output_dir = args.output_dir.expanduser().resolve()

    if not sessions_dir.is_dir():
        print(
            f"Error: sessions directory not found: {sessions_dir}",
            file=sys.stderr,
        )
        sys.exit(1)
    try:
        output_dir.relative_to(sessions_dir)
    except ValueError:
        pass
    else:
        print(
            "Error: output-dir must not be inside sessions-dir.",
            file=sys.stderr,
        )
        sys.exit(1)

    print(f"Scanning sessions in: {sessions_dir}")
    print(f"Output directory:     {output_dir}")
    print(f"Max sessions:         {args.max_sessions}")

    parsed = parse_sessions(sessions_dir, args.max_sessions)
    print(f"\nScanned {parsed['total_scanned']} session files")
    print(f"Sessions with user messages: {parsed['sessions_with_messages']}")
    print(f"Total user messages: {len(parsed['messages'])}")
    print(f"Projects: {len(parsed['projects'])}")

    ev_path = write_evidence(output_dir, sessions_dir, parsed)
    print(f"\nEvidence written to: {ev_path}")

    if args.regex_only:
        print("\nMode: regex heuristics (11 behaviors, approximate)")
        results = run_regex(parsed["messages"])
        method = "regex-heuristic"
    else:
        print("\nMode: LLM classification (18 behaviors)")
        results = run_llm(parsed["messages"], args)
        method = "llm-binary-classifier"

    path = write_analysis(output_dir, parsed["messages"], results, method)
    print(f"\nAnalysis written to: {path}")
    print(f"\nBehavior matches ({method}):")
    print_results(results)


if __name__ == "__main__":
    main()
