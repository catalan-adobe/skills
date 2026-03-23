# Report Specification

Design system, layout, and formatting for the AI Fluency HTML report.

## Design System

- Font: Inter (Google Fonts import) with system fallback
- Background: `#FAFAF9`, Surface: `#FFFFFF`, Border: `#E7E5E4`
- Competency colors:
  - Delegation: `#2563EB` (blue), light: `#EFF6FF`
  - Description: `#7C3AED` (purple), light: `#F5F3FF`
  - Discernment: `#0891B2` (cyan), light: `#ECFEFF`
  - Diligence: `#059669` (green), light: `#ECFDF5`
- Score colors: 1=`#EF4444`, 2=`#F97316`, 3=`#EAB308`, 4=`#22C55E`, 5=`#10B981`

## Report Structure

1. **Header**: Title, date, overall score (large number with level label)

2. **Overall Score Card**: Large score with Novice/Emerging/Developing/Proficient/Expert label. Compute as average of 4 competency scores.

3. **Key Takeaways**: Profile summary ("Your Profile: [type]") with two columns — "What You Do Well" (4 strengths with evidence) and "Where You Can Level Up" (4 growth areas with actionable advice). Include a callout box with one concrete habit to try.

4. **4 Competency Summary Cards**: Each shows competency name, color-coded score, progress bar, and sub-competency breakdown. Score = average of sub-competency scores. Sub-competency score = average of behavior scores within it.

5. **Strengths & Growth Areas**: Side-by-side cards showing top 3 strengths (highest-scored behaviors) and top 3 growth areas (lowest-scored behaviors with specific recommendations).

6. **Behavior Heatmap**: Horizontal bar chart ranking all 18 classified behaviors by LLM match count. Scale bars *relative to the highest behavior* (highest = 100% width). Show absolute message counts. Color bars by competency color.

7. **Top Projects Breakdown**: Horizontal bar chart showing message volume per project (top 10), scaled relative to the busiest project.

8. **Footer**: Framework attribution, generation date, classification method

## Heuristic Bar Formatting

- Label: "Detected in" (NOT "Detection rate")
- Value: "N messages" (NOT "N (X%)")
- Bar width: Scale relative to the max behavior count
- Projects: Label as "Strongest in" with just project names (NO percentages)
