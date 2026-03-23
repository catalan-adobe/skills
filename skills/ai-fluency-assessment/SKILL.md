---
name: ai-fluency-assessment
description: Assess your AI fluency using Anthropic's 4D framework (Dakan, Feller & Anthropic, 2025). Scans Claude Code sessions, runs LLM-based behavior classification on all messages, asks a self-assessment questionnaire for 6 unobservable behaviors, and generates a visual HTML report with scores and actionable feedback. Use when "assess fluency", "AI fluency", "fluency report", "fluency assessment", "4D framework", or "how AI fluent am I".
---

# AI Fluency Assessment

Assess a user's AI fluency based on Anthropic's 4D AI Fluency Framework (Dakan, Feller & Anthropic, 2025). The framework has 4 Competencies, 12 Sub-competencies, and 24 Behaviors. The `assess.py` script classifies 18 behaviors from conversation data using an LLM binary classifier (matching Anthropic's own methodology). The remaining 6 behaviors require a self-assessment questionnaire.

## Instructions

### Step 1: Collect Evidence and Classify Behaviors

First, ask the user:
1. "Where are your Claude Code sessions? The default is `~/.claude/projects/` — is that correct, or should I scan a different directory?"

Then run `assess.py` to scan and classify all 18 observable behaviors. The script lives next to this SKILL.md — substitute the actual path when running.

```bash
# Default: scan ~/.claude/projects/, classify with Claude Haiku
python3 /path/to/skills/ai-fluency-assessment/assess.py \
  --output-dir .ai-fluency --max-sessions 6000

# Custom sessions directory (e.g., exported sessions, another machine's data)
python3 /path/to/skills/ai-fluency-assessment/assess.py \
  --sessions-dir <PATH> --output-dir .ai-fluency --max-sessions 6000

# Fast/free fallback (regex only, 11 behaviors, less accurate)
python3 /path/to/skills/ai-fluency-assessment/assess.py \
  --output-dir .ai-fluency --max-sessions 6000 --regex-only
```

**Use `--max-sessions 6000`** to capture all sessions. Many session files are subagent files with no user messages, so even with thousands of files the scan is fast.

**LLM classification** (default) requires the `anthropic` SDK and API credentials. The script auto-detects Anthropic Foundry credentials from environment variables (`ANTHROPIC_FOUNDRY_API_KEY`), or uses `ANTHROPIC_API_KEY` for direct API access. Cost: ~$2-5 per full assessment with Claude Haiku.

**Output files:**
- `.ai-fluency/evidence.json` — all extracted user messages with project metadata
- `.ai-fluency/analysis.json` — per-behavior match counts, sample messages, top projects

### Step 2: Self-Assessment Questionnaire

Ask the user the following 6 questions for behaviors that have no observable signal in conversation data. Rate each 1-5 (1=Never, 5=Always).

Present them in conversation — don't run an interactive CLI.

**Delegation:**
- Q3: How often do you evaluate whether a specific AI tool is the right fit for your task before starting?
- Q4: How actively do you compare and choose between different AI platforms (e.g., Claude vs ChatGPT vs Gemini) based on task requirements?

**Discernment:**
- Q18: How alert are you to potential biases in AI outputs (e.g., cultural, gender, or perspective biases)?

**Diligence:**
- Q19: How carefully do you consider data privacy, security, and organizational policies before sharing information with AI systems?
- Q20: How aware are you of ethical implications throughout your AI interactions?
- Q24: How fully do you accept personal accountability for the final quality of your AI-assisted work?

After collecting responses, save them:

```bash
python3 -c "
import json
from pathlib import Path

responses = {3: R3, 4: R4, 18: R18, 19: R19, 20: R20, 24: R24}

evidence_path = Path('.ai-fluency/evidence.json')
with open(evidence_path) as f:
    evidence = json.load(f)
evidence['questionnaire'] = {str(k): v for k, v in responses.items()}
with open(evidence_path, 'w') as f:
    json.dump(evidence, f, indent=2, default=str)
print('Questionnaire saved')
"
```

Replace R3, R4, etc. with the user's actual integer ratings.

### Step 3: Score All 24 Behaviors

Read `.ai-fluency/analysis.json` for the 18 LLM-classified behaviors and `.ai-fluency/evidence.json` for the questionnaire responses. Score each behavior 1-5:

**Scoring criteria:**
- **1 - Novice**: No evidence of this behavior
- **2 - Emerging**: Occasional or inconsistent evidence
- **3 - Developing**: Regular evidence but room for improvement
- **4 - Proficient**: Consistent, effective demonstration
- **5 - Expert**: Sophisticated, nuanced mastery

**For LLM-classified behaviors (B1-B2, B5-B17, B21-B23):** Base scores on LLM match counts, quality of sample messages, consistency across projects, and range/variety within the behavior.

**Important:** High frequency alone does NOT guarantee a high score. Assess *quality and range*, not just quantity.

**For questionnaire-only behaviors (B3, B4, B18, B19, B20, B24):** Use the self-assessment rating directly.

### Step 4: Generate the Visual HTML Report

Generate a self-contained HTML report at `.ai-fluency/fluency-report.html` following `references/REPORT-SPEC.md` for design system, layout, and formatting specifications.

### Step 5: Open the Report

```bash
open .ai-fluency/fluency-report.html
```

## Framework Reference

See `references/FRAMEWORK.md` for the full 24-behavior reference table.
