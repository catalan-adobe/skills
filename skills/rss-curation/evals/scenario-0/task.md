# RSS Digest Pipeline Script

## Problem Description

Your team uses a local RSS curation tool called `rss-curation` that runs via Node.js scripts installed somewhere under `~/.claude`. The tool has several subcommands for fetching articles, retrieving unscored ones, writing scores back to a SQLite database, and generating daily digest files. A new team member needs a reference shell script that walks through the complete daily digest workflow so they can understand how the pieces fit together and run it reliably across different machines.

The tricky part is that the scripts directory location isn't fixed — it varies depending on how each developer has their Claude environment set up. The script needs to find the scripts folder robustly, handle first-run environments where dependencies might not be installed yet, and wire up each step of the pipeline in the correct order. The script should also include comments explaining the relevance-scoring logic so that future maintainers understand how articles get ranked.

You've been asked to produce a well-commented shell script named `digest_pipeline.sh` that:

1. Locates the `rss-curation` scripts directory
2. Ensures Node.js dependencies are available
3. Fetches new articles from configured feeds
4. Retrieves unscored articles and scores them against a user interest profile
5. Persists the scores back to the database
6. Generates the final daily digest file

The script should use `$DATA_DIR` as the variable holding the path to the data directory (e.g. `~/rss-data`), and should handle the case where the scripts directory cannot be found by printing an error and exiting. Mock/placeholder values for paths are fine — the goal is a correct, reviewable script rather than one that runs in this environment.

## Output Specification

Produce a single file: `digest_pipeline.sh`

The script should be readable as a reference implementation — include inline comments explaining each step, especially around the scoring logic. The scores your script produces (or documents inline as example output) should be a JSON array where each entry has the fields: `url`, `score`, `scoreReason`, and `tags`.
