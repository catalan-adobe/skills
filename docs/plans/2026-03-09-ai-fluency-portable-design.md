# AI Fluency Assessment — Portable Script Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a self-contained assess.py script that replaces the external ai_fluency Python package, making the skill portable.

**Architecture:** Single Python script (stdlib only) parses Claude Code JSONL sessions, runs regex heuristics for 11 observable behaviors, and outputs evidence.json + heuristic-analysis.json. The agent handles questionnaire, scoring, and HTML report generation.

**Tech Stack:** Python 3.13, stdlib only (json, pathlib, re, argparse, collections, datetime)

---

## Task 1: Create assess.py with CLI and JSONL parser

**Files:**
- Create: `skills/ai-fluency-assessment/assess.py`

**Step 1: Write the script with argument parsing and JSONL extraction**

```python
#!/usr/bin/env python3
"""AI Fluency Assessment — Evidence collector and heuristic analyzer.

Parses Claude Code JSONL session files, extracts user messages,
and runs regex heuristics for the 11 observable behaviors from
Anthropic's 4D AI Fluency Framework (Dakan, Feller & Anthropic, 2025).
"""

import argparse
import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path


def clean_project_name(dirname: str) -> str:
    """Extract readable project name from encoded directory name.

    Encoded names look like: -Users-catalan-repos-ai-aemcoder-component-gallery-skill
    Returns last 2-3 meaningful segments: component-gallery-skill
    """
    parts = dirname.strip("-").split("-")
    # Find last path-like boundary (common prefixes to skip)
    skip = {"Users", "home", "repos", "projects", "Documents", "work"}
    last_skip = -1
    for i, part in enumerate(parts):
        if part in skip:
            last_skip = i
    meaningful = parts[last_skip + 1 :]
    if len(meaningful) > 5:
        meaningful = meaningful[-5:]
    return "-".join(meaningful) if meaningful else dirname


def parse_session(filepath: Path, project_name: str) -> list[dict]:
    """Extract user messages from a single JSONL session file."""
    messages = []
    session_id = filepath.stem
    try:
        with open(filepath, encoding="utf-8", errors="replace") as f:
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
                msg = record.get("message", {})
                if msg.get("role") != "user":
                    continue
                content = msg.get("content")
                if not isinstance(content, str) or not content.strip():
                    continue
                messages.append({
                    "project": project_name,
                    "session_id": session_id,
                    "timestamp": record.get("timestamp", ""),
                    "content": content.strip(),
                })
    except OSError as e:
        print(f"  Warning: could not read {filepath}: {e}")
    return messages


def collect_evidence(sessions_dir: Path, max_sessions: int) -> dict:
    """Scan all JSONL sessions and extract user messages."""
    sessions_dir = sessions_dir.expanduser().resolve()
    if not sessions_dir.is_dir():
        raise SystemExit(f"Sessions directory not found: {sessions_dir}")

    # Find all JSONL files, skipping subagents
    jsonl_files = sorted(
        p
        for p in sessions_dir.rglob("*.jsonl")
        if "/subagents/" not in str(p)
    )

    if max_sessions and len(jsonl_files) > max_sessions:
        jsonl_files = jsonl_files[:max_sessions]

    print(f"Scanning {len(jsonl_files)} session files in {sessions_dir}")

    all_messages = []
    project_sessions: dict[str, set] = defaultdict(set)

    for i, filepath in enumerate(jsonl_files, 1):
        # Project name from the immediate parent of the JSONL file
        # that is a child of sessions_dir
        rel = filepath.relative_to(sessions_dir)
        project_dir = rel.parts[0] if len(rel.parts) > 1 else "unknown"
        project_name = clean_project_name(project_dir)

        msgs = parse_session(filepath, project_name)
        if msgs:
            all_messages.extend(msgs)
            project_sessions[project_name].add(filepath.stem)

        if i % 500 == 0:
            print(f"  ...processed {i}/{len(jsonl_files)} files")

    # Build project summaries
    project_msg_counts = Counter(m["project"] for m in all_messages)
    projects = {}
    for name, count in project_msg_counts.most_common():
        projects[name] = {
            "full_path": name,
            "message_count": count,
            "session_count": len(project_sessions.get(name, set())),
        }

    sessions_with_messages = len(
        {m["session_id"] for m in all_messages}
    )

    evidence = {
        "collection_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "sessions_dir": str(sessions_dir),
        "total_sessions_scanned": len(jsonl_files),
        "sessions_with_user_messages": sessions_with_messages,
        "total_user_messages": len(all_messages),
        "projects": projects,
        "messages": all_messages,
    }

    print(
        f"Collected {len(all_messages)} user messages "
        f"from {sessions_with_messages} sessions "
        f"across {len(projects)} projects"
    )
    return evidence


# --- Heuristic Analysis ---

BEHAVIORS = {
    "B1": {
        "name": "Clarifies goal before asking for help",
        "competency": "Delegation",
        "patterns": [
            r"\bi want to\b",
            r"\bi need to\b",
            r"\bmy goal is\b",
            r"\bi[''']m trying to\b",
            r"\bwhat i want to achieve\b",
            r"\bthe objective is\b",
            r"\bi[''']m looking to\b",
            r"\bthe purpose is\b",
            r"\bi[''']d like to\b",
            r"\bwhat i need is\b",
        ],
        "early_only": True,
    },
    "B5": {
        "name": "Consults AI on approach before execution",
        "competency": "Delegation",
        "patterns": [
            r"\bhow should i\b",
            r"\bwhat approach\b",
            r"\bwhat would you recommend\b",
            r"\bwhat[''']s the best way\b",
            r"\bbefore i start\b",
            r"\bhow would you tackle\b",
            r"\bwhat do you think about\b",
            r"\bshould i use\b",
            r"\bwhat strategy\b",
            r"\bhelp me think through\b",
        ],
    },
    "B7": {
        "name": "Specifies format and structure needed",
        "competency": "Description",
        "patterns": [
            r"\bformat as\b",
            r"\buse bullet\b",
            r"\bas a table\b",
            r"\bin json\b",
            r"\bas markdown\b",
            r"\bnumbered list\b",
            r"\bgive me a summary\b",
            r"\boutput as\b",
            r"\bstructured as\b",
            r"\bwrite it as a\b",
            r"\bin the format\b",
            r"\bas csv\b",
        ],
    },
    "B8": {
        "name": "Defines audience for the output",
        "competency": "Description",
        "patterns": [
            r"\bthis is for\b",
            r"\bthe audience is\b",
            r"\bwritten for\b",
            r"\btargeted at\b",
            r"\bthe reader will be\b",
            r"\bnon-technical\b",
            r"\bfor my manager\b",
            r"\bfor developers\b",
            r"\bfor the team\b",
            r"\bstakeholders will\b",
        ],
    },
    "B9": {
        "name": "Provides examples of what good looks like",
        "competency": "Description",
        "patterns": [
            r"\bhere[''']s an example\b",
            r"\blike this:",
            r"\bsimilar to\b",
            r"\bhere[''']s a template\b",
            r"\bfor reference\b",
            r"\bsomething like\b",
            r"\bmodeled after\b",
            r"\bbased on this example\b",
            r"\bhere[''']s what i mean\b",
        ],
    },
    "B10": {
        "name": "Iterates and refines",
        "competency": "Description",
        "patterns": [
            r"\bcan you revise\b",
            r"\bchange it to\b",
            r"\bmake it more\b",
            r"\bthat[''']s close but\b",
            r"\bnow adjust\b",
            r"\bkeep the same but\b",
            r"\btry again\b",
            r"\bactually,? let[''']s\b",
            r"\binstead of that\b",
            r"\bone more change\b",
            r"\bnot quite\b",
            r"\balmost but\b",
            r"\btweak the\b",
            r"\brework the\b",
        ],
    },
    "B11": {
        "name": "Sets interaction mode",
        "competency": "Description",
        "patterns": [
            r"\bact as\b",
            r"\bplay devil[''']s advocate\b",
            r"\bdon[''']t give me the answer\b",
            r"\bjust do it\b",
            r"\bwalk me through\b",
            r"\bchallenge my\b",
            r"\bthink step by step\b",
            r"\bbrainstorm with me\b",
            r"\bdon[''']t explain,? just\b",
            r"\byou are a\b",
            r"\byour role is\b",
        ],
    },
    "B12": {
        "name": "Communicates tone and style preferences",
        "competency": "Description",
        "patterns": [
            r"\bkeep it concise\b",
            r"\buse formal\b",
            r"\bcasual tone\b",
            r"\bavoid jargon\b",
            r"\bbe direct\b",
            r"\bfriendly tone\b",
            r"\bprofessional tone\b",
            r"\bsimple language\b",
            r"\bin the style of\b",
            r"\btone should be\b",
            r"\bkeep it short\b",
        ],
    },
    "B13": {
        "name": "Checks facts and claims that matter",
        "competency": "Discernment",
        "patterns": [
            r"\bis this accurate\b",
            r"\bcan you verify\b",
            r"\bwhat[''']s the source\b",
            r"\bdouble[- ]check\b",
            r"\bare you sure\b",
            r"\bthat doesn[''']t seem right\b",
            r"\bsource for that\b",
            r"\bis that correct\b",
            r"\bverify this\b",
            r"\bfact[- ]check\b",
        ],
    },
    "B14": {
        "name": "Identifies when AI might be missing context",
        "competency": "Discernment",
        "patterns": [
            r"\byou might not know\b",
            r"\blet me add context\b",
            r"\bi should mention\b",
            r"\byou[''']re missing\b",
            r"\bfor context\b",
            r"\bwhat you don[''']t know is\b",
            r"\bimportant background\b",
            r"\byou need to know that\b",
            r"\badditional context\b",
            r"\bare you aware that\b",
        ],
    },
    "B15": {
        "name": "Questions when AI reasoning doesn't hold up",
        "competency": "Discernment",
        "patterns": [
            r"\bwhy do you think\b",
            r"\bthat doesn[''']t follow\b",
            r"\bi disagree because\b",
            r"\bexplain your reasoning\b",
            r"\bthat logic doesn[''']t\b",
            r"\bi don[''']t think that[''']s right\b",
            r"\bwhat makes you say\b",
            r"\bthat conclusion doesn[''']t\b",
            r"\bhow did you arrive at\b",
            r"\bthat[''']s not correct\b",
            r"\byou[''']re wrong about\b",
            r"\bthat contradicts\b",
        ],
    },
}


def build_session_message_index(messages: list[dict]) -> dict[str, list[int]]:
    """Map session_id to list of message indices, sorted by timestamp."""
    index: dict[str, list[int]] = defaultdict(list)
    for i, msg in enumerate(messages):
        index[msg["session_id"]].append(i)
    return dict(index)


def analyze_heuristics(evidence: dict) -> dict:
    """Run regex heuristics on all messages for the 11 observable behaviors."""
    messages = evidence["messages"]
    session_index = build_session_message_index(messages)

    # Precompute early-message indices (first 2 per session)
    early_indices: set[int] = set()
    for indices in session_index.values():
        for idx in indices[:2]:
            early_indices.add(idx)

    # Compile all patterns
    compiled: dict[str, list[re.Pattern]] = {}
    for behavior_id, spec in BEHAVIORS.items():
        compiled[behavior_id] = [
            re.compile(p, re.IGNORECASE) for p in spec["patterns"]
        ]

    results: dict[str, dict] = {}
    for behavior_id, spec in BEHAVIORS.items():
        matches: list[dict] = []
        project_counts: Counter = Counter()
        early_only = spec.get("early_only", False)

        for i, msg in enumerate(messages):
            if early_only and i not in early_indices:
                continue
            content = msg["content"]
            if any(p.search(content) for p in compiled[behavior_id]):
                if len(matches) < 10:
                    matches.append({
                        "content": content[:500],
                        "project": msg["project"],
                        "session_id": msg["session_id"],
                    })
                project_counts[msg["project"]] += 1

        top_projects = [
            {"project": name, "count": count}
            for name, count in project_counts.most_common(10)
        ]

        results[behavior_id] = {
            "name": spec["name"],
            "competency": spec["competency"],
            "match_count": sum(project_counts.values()),
            "sample_messages": matches,
            "top_projects": top_projects,
        }

    total_matches = sum(r["match_count"] for r in results.values())
    print(f"\nHeuristic analysis complete: {total_matches} total matches")
    for bid, r in sorted(results.items()):
        print(f"  {bid} {r['name']}: {r['match_count']} matches")

    return {
        "analysis_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "total_messages_analyzed": len(messages),
        "behaviors": results,
    }


def main():
    parser = argparse.ArgumentParser(
        description="AI Fluency Assessment: collect evidence and run heuristics"
    )
    parser.add_argument(
        "--sessions-dir",
        type=Path,
        default=Path("~/.claude/projects"),
        help="Directory containing Claude Code session JSONL files "
        "(default: ~/.claude/projects)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(".ai-fluency"),
        help="Output directory for evidence and analysis files "
        "(default: .ai-fluency/)",
    )
    parser.add_argument(
        "--max-sessions",
        type=int,
        default=2000,
        help="Maximum number of session files to process (default: 2000)",
    )
    args = parser.parse_args()

    # Collect evidence
    evidence = collect_evidence(args.sessions_dir, args.max_sessions)

    # Run heuristics
    analysis = analyze_heuristics(evidence)

    # Write outputs
    args.output_dir.mkdir(parents=True, exist_ok=True)

    evidence_path = args.output_dir / "evidence.json"
    with open(evidence_path, "w") as f:
        json.dump(evidence, f, indent=2, default=str)
    print(f"\nEvidence written to {evidence_path}")

    analysis_path = args.output_dir / "heuristic-analysis.json"
    with open(analysis_path, "w") as f:
        json.dump(analysis, f, indent=2, default=str)
    print(f"Heuristic analysis written to {analysis_path}")


if __name__ == "__main__":
    main()
```

**Step 2: Run against elias-files to verify it works**

Run:
```bash
python3 skills/ai-fluency-assessment/assess.py \
  --sessions-dir /Users/catalan/Documents/elias-files/projects \
  --output-dir /tmp/ai-fluency-test \
  --max-sessions 100
```

Expected: Script completes without errors, prints collection and heuristic summary, creates both JSON files in `/tmp/ai-fluency-test/`.

**Step 3: Verify output file structure**

Run:
```bash
python3 -c "
import json
with open('/tmp/ai-fluency-test/evidence.json') as f:
    e = json.load(f)
print(f'Messages: {e[\"total_user_messages\"]}')
print(f'Projects: {len(e[\"projects\"])}')
with open('/tmp/ai-fluency-test/heuristic-analysis.json') as f:
    h = json.load(f)
for bid, r in sorted(h['behaviors'].items()):
    print(f'{bid}: {r[\"match_count\"]} matches, {len(r[\"sample_messages\"])} samples')
"
```

Expected: Message counts > 0, all 11 behaviors present, sample_messages capped at 10.

**Step 4: Run full scan (all sessions)**

Run:
```bash
python3 skills/ai-fluency-assessment/assess.py \
  --sessions-dir /Users/catalan/Documents/elias-files/projects \
  --output-dir /tmp/ai-fluency-full \
  --max-sessions 6000
```

Expected: Processes all ~5,955 files, completes in under 60 seconds. Review match counts for sanity.

**Step 5: Commit**

```bash
git add skills/ai-fluency-assessment/assess.py
git commit -m "Add portable assess.py for AI fluency evidence collection and heuristics"
```

---

## Task 2: Update SKILL.md to use assess.py

**Files:**
- Modify: `skills/ai-fluency-assessment/SKILL.md`

**Step 1: Replace Source Code section and Steps 1-2**

Replace the `## Source Code` section and `### Step 1` and `### Step 2` with the new single-step invocation using `assess.py`. The script path should use `SKILL_DIR` — the directory containing SKILL.md itself.

Key changes:
- Remove `## Source Code` section referencing `/Users/paolo/playground/ai-fluency/`
- Merge Steps 1+2 into a single `### Step 1: Collect Evidence and Run Heuristics`
- New command: `python3 <skill-dir>/assess.py --sessions-dir <path> --output-dir .ai-fluency --max-sessions 2000`
- Remove Step 3b (top-projects flag — not implemented in assess.py)
- Replace Step 3 questionnaire save code with inline JSON manipulation (no external module)
- Update troubleshooting table

**Step 2: Verify SKILL.md has no remaining references to Paolo's paths**

Run:
```bash
grep -n "paolo\|PYTHONPATH\|ai_fluency\|playground" skills/ai-fluency-assessment/SKILL.md
```

Expected: No matches.

**Step 3: Commit**

```bash
git add skills/ai-fluency-assessment/SKILL.md
git commit -m "Update SKILL.md to use portable assess.py, remove external dependencies"
```

---

## Task 3: Validate end-to-end with elias-files

**Files:**
- None (validation only)

**Step 1: Run full collection against elias-files**

Run:
```bash
python3 skills/ai-fluency-assessment/assess.py \
  --sessions-dir /Users/catalan/Documents/elias-files/projects \
  --output-dir /tmp/ai-fluency-validation \
  --max-sessions 6000
```

Expected: Completes successfully, evidence.json and heuristic-analysis.json created.

**Step 2: Spot-check evidence quality**

Read 3-5 sample messages from evidence.json to verify they are real user messages (not tool results, not assistant messages, not empty).

**Step 3: Spot-check heuristic quality**

Read sample_messages from each behavior in heuristic-analysis.json to verify the regex patterns are matching relevant content, not false positives.

**Step 4: Verify elias-files was not modified**

Run:
```bash
ls -lt /Users/catalan/Documents/elias-files/ | head -5
```

Expected: No files modified after the test started. The script only reads, never writes to sessions-dir.

**Step 5: Clean up test outputs**

```bash
rm -rf /tmp/ai-fluency-test /tmp/ai-fluency-full /tmp/ai-fluency-validation
```
