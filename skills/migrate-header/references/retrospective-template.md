# Retrospective Template

After reporting results (step 6.1), analyze the full migration run to
extract learnings that could improve the skill for future migrations.

## Data Sources

Read all of these before analyzing:

1. `$PROJECT_ROOT/results.tsv` — iteration scores and keep/revert decisions
2. `$PROJECT_ROOT/autoresearch/results/latest-evaluation.json` — detailed score breakdown
3. `$PROJECT_ROOT/autoresearch/results/judge-history.jsonl` — per-iteration judge diagnosis log (JSONL: iteration, composite, desktop, nav, judge score, status, diagnosis array)
4. `$PROJECT_ROOT/autoresearch/extraction/layout.json` — extracted layout structure
5. `$PROJECT_ROOT/autoresearch/extraction/styles.json` — CDP-extracted CSS values
6. `$PROJECT_ROOT/autoresearch/overlay-recipe.json` — overlays detected
7. Source screenshots in `$PROJECT_ROOT/autoresearch/source/` — visual reference
8. `git log --oneline` — changes made during polish

## Analysis Dimensions

| Dimension | Evidence | What it reveals |
|-----------|----------|-----------------|
| Extraction accuracy | Compare styles.json values against final CSS custom properties in header.css | Whether extraction scripts need calibration |
| Scaffold quality | First iteration score in results.tsv | How good the initial code generation was |
| Convergence pattern | Score trajectory and revert rate across iterations | Whether the polish loop guidance is effective |
| Judge effectiveness | judge-history.jsonl: were diagnoses for kept iterations actionable? Did reverted iterations try to fix a diagnosed item but fail? | Whether judge guidance is helping or misleading |
| Desktop fidelity | Desktop visual score in evaluation | Whether scaffold and polish loop guidance are effective |
| Nav completeness | Nav score in evaluation vs layout.json navItems count | Whether content mapping missed items |
| Overlay handling | Overlay recipe contents vs capture quality | Whether overlay detection was sufficient |
| Bot protection | probe-report.json vs firstSuccess config | Whether probe correctly identified protection and recipe worked |

## Output Format

Save to `$PROJECT_ROOT/autoresearch/results/retrospective.md`:

```markdown
# Migration Retrospective: <domain>

## Summary
- Source: <URL>
- Final composite: <score>% | Desktop: <d>%
- Iterations: <kept>/<total> kept (<revert_rate>% revert rate)
- Header type: <single-row|multi-row|mega-menu|etc.>

## What Worked (Reinforcements)
<!-- Concrete patterns the pipeline handled well. Include evidence:
     "Brand color extraction (#1a2b3c) matched source exactly — zero
     iterations spent fixing colors." -->

- <finding with evidence>

## What Struggled (Improvement Opportunities)
<!-- Areas where the pipeline underperformed. Include evidence:
     "Mobile hamburger menu took 8 iterations to converge, 4 reverted
     — the scaffold default for slide-in mode didn't match the source
     fullscreen overlay pattern." -->

- <finding with evidence>

## Pattern Notes
<!-- Header-type observations useful for future migrations of similar
     headers. E.g., "Mega menu with icon grid: extraction captured
     grid dimensions but not icon placement — needed manual column
     template in polish loop." -->

- <observation>

## Recommendations for Skill Improvement
<!-- Actionable suggestions: script changes, new reference patterns,
     CSS defaults, extraction improvements. Be specific enough that
     someone could file an issue or write a patch. -->

- <suggestion>
```

## User Report Appendix

After the step 6.1 results, append:

```
### Retrospective

Learnings from this migration saved to:
<PROJECT_ROOT>/autoresearch/results/retrospective.md

**Reinforcements:** <1-2 sentence summary of what worked>
**Improvements:** <1-2 sentence summary of what struggled>

Review the full retrospective for detailed findings and skill
improvement recommendations.
```
