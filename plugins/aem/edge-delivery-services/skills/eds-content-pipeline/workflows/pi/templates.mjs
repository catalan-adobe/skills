export const meta = { name: 'eds_templates', description: 'Runs many templates via eds-stage.' }

// args: { templates: string[], skill: string, repo: string }
// Requires the saved workflow `eds-stage` (see README.md: "Save stage.mjs as eds-stage").

const { templates, skill, repo } = args;

phase('Templates');
const outcomes = await parallel(templates.map((template) => () => workflow('eds-stage', {
  stage: 'template', params: { template }, skill, repo,
})));

return { templates, outcomes };
