# AI Fluency Framework Reference

24 behaviors across 4 competencies, from Anthropic's 4D AI Fluency Framework (Dakan, Feller & Anthropic, 2025).

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
