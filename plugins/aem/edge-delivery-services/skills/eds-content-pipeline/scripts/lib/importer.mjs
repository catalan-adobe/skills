/**
 * Stub for Task 10. Provides minimal Blocks.createBlock for testing
 * transformers in Task 8.
 */
export const Blocks = {
  createBlock(doc, { name, cells }) {
    const div = doc.createElement('div');
    div.setAttribute('data-block', name);
    return div;
  },
};
