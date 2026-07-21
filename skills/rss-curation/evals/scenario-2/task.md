# Post-Digest Session Workflow

## Problem/Feature Description

You've built an RSS curation system that delivers a daily digest of articles scored and ranked for your interests. The system is driven by a set of Node.js scripts (`rss-feed.mjs`) located in the rss-curation scripts directory. Over the past few weeks you've been reading digests, but you realize you've never closed the feedback loop: you haven't been marking which articles you liked or disliked, bookmarking ones you want to revisit, or letting the system update your interest profile based on your reactions.

Your colleague has set up a similar system and showed you that after a productive reading session you should run through a sequence of actions: search for articles on a topic you care about, give feedback on what you find, bookmark the ones worth saving, and periodically trigger a profile-learning step so the scoring algorithm adapts. She mentioned the data lives in a directory (call it `$DATA_DIR`) with a SQLite database at `$DATA_DIR/feeds.db` and a profile at `$DATA_DIR/profile.yaml`.

## Output Specification

Write a shell script called `user_actions.sh` that demonstrates a complete post-digest user session. The script should:

1. Search for articles on a topic (use a placeholder search query, e.g. "machine learning")
2. Give positive feedback on one of the results
3. Bookmark that same article so you can return to it later
4. Give negative feedback on a different result
5. Run the profile-learning command to incorporate all accumulated feedback signals into the profile

Use placeholder values for all paths (e.g. `DATA_DIR="/path/to/data"`) and the scripts directory. Include inline comments in the script explaining what each step does and why. The script does not need to be runnable in this environment — it should serve as a documented workflow template.

Save the script as `user_actions.sh` in the current directory.
