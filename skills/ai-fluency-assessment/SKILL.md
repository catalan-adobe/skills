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

Generate a self-contained HTML report at `.ai-fluency/fluency-report.html`. The report must include:

#### Design System
- Font: Inter (Google Fonts import) with system fallback
- Background: `#FAFAF9`, Surface: `#FFFFFF`, Border: `#E7E5E4`
- Competency colors:
  - Delegation: `#2563EB` (blue), light: `#EFF6FF`
  - Description: `#7C3AED` (purple), light: `#F5F3FF`
  - Discernment: `#0891B2` (cyan), light: `#ECFEFF`
  - Diligence: `#059669` (green), light: `#ECFDF5`
- Score colors: 1=`#EF4444`, 2=`#F97316`, 3=`#EAB308`, 4=`#22C55E`, 5=`#10B981`

#### Report Structure

1. **Header**: Title, date, overall score (large number with level label)

2. **Overall Score Card**: Large score with Novice/Emerging/Developing/Proficient/Expert label. Compute as average of 4 competency scores.

3. **Key Takeaways**: Profile summary ("Your Profile: [type]") with two columns — "What You Do Well" (4 strengths with evidence) and "Where You Can Level Up" (4 growth areas with actionable advice). Include a callout box with one concrete habit to try.

4. **4 Competency Summary Cards**: Each shows competency name, color-coded score, progress bar, and sub-competency breakdown. Score = average of sub-competency scores. Sub-competency score = average of behavior scores within it.

5. **Strengths & Growth Areas**: Side-by-side cards showing top 3 strengths (highest-scored behaviors) and top 3 growth areas (lowest-scored behaviors with specific recommendations).

6. **Behavior Heatmap**: Horizontal bar chart ranking all 18 classified behaviors by LLM match count. Scale bars *relative to the highest behavior* (highest = 100% width). Show absolute message counts. Color bars by competency color.

7. **Top Projects Breakdown**: Horizontal bar chart showing message volume per project (top 10), scaled relative to the busiest project.

8. **Footer**: Framework attribution, generation date, classification method

#### Heuristic Bar Formatting
- Label: "Detected in" (NOT "Detection rate")
- Value: "N messages" (NOT "N (X%)")
- Bar width: Scale relative to the max behavior count
- Projects: Label as "Strongest in" with just project names (NO percentages)

### Step 5: Open the Report

```bash
open .ai-fluency/fluency-report.html
```

## Framework Reference

| # | Behavior | Competency | Classification |
|---|----------|-----------|---------------|
| 1 | Clarifies goal before asking for help | Delegation | LLM |
| 2 | Understands problem scope and nature | Delegation | LLM |
| 3 | Assesses AI fit | Delegation | Questionnaire |
| 4 | Selects platform | Delegation | Questionnaire |
| 5 | Consults AI on approach before execution | Delegation | LLM |
| 6 | Distributes work strategically | Delegation | LLM |
| 7 | Specifies format and structure needed | Description | LLM |
| 8 | Defines audience for the output | Description | LLM |
| 9 | Provides examples of what good looks like | Description | LLM |
| 10 | Iterates and refines | Description | LLM |
| 11 | Sets interaction mode | Description | LLM |
| 12 | Communicates tone and style preferences | Description | LLM |
| 13 | Checks facts and claims that matter | Discernment | LLM |
| 14 | Identifies when AI might be missing context | Discernment | LLM |
| 15 | Questions when AI reasoning doesn't hold up | Discernment | LLM |
| 16 | Detects hallucination | Discernment | LLM |
| 17 | Evaluates tone and communication fit | Discernment | LLM |
| 18 | Recognizes bias in AI outputs | Discernment | Questionnaire |
| 19 | Chooses AI tools ethically | Diligence | Questionnaire |
| 20 | Maintains ethical awareness during interaction | Diligence | Questionnaire |
| 21 | Discloses AI involvement to stakeholders | Diligence | LLM |
| 22 | Represents AI contribution accurately | Diligence | LLM |
| 23 | Verifies and tests outputs before sharing | Diligence | LLM |
| 24 | Takes ongoing accountability | Diligence | Questionnaire |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `No module named 'anthropic'` | Install: `uv pip install anthropic`. Or use `--regex-only` for free approximation. |
| `No such file or directory: assess.py` | Use the full path to `assess.py` in the skills directory |
| 0 Claude Code messages found | Check that the sessions directory exists and has JSONL files |
| API authentication error | Set `ANTHROPIC_API_KEY` or `ANTHROPIC_FOUNDRY_API_KEY` env var |
| Questionnaire hangs | Don't run interactive mode; ask questions in chat and save programmatically |
| Bars look like bad scores | Use relative scaling (max behavior = 100% bar width) and absolute counts |
