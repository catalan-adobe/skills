# RSS Curation Onboarding Guide

## Problem/Feature Description

A small engineering team has adopted an AI-powered RSS curation skill to keep their members up to date with relevant technical news. A new team member, Jordan, has just joined and wants to start using the system from scratch. Jordan has no existing data directory, no feeds configured, and no interest profile filled in.

The team lead wants a reusable onboarding package: a clear, step-by-step setup guide that walks any new user through the entire first-time configuration process, and a sample interest profile file they can copy and customize. The guide should cover everything a new user needs to know to go from zero to a fully configured curation system — including where data lives, what files need to be edited, and what optional enrichment steps are available to pre-populate the profile automatically.

Jordan is technically comfortable but has never used this system before. The guide needs to be thorough enough that they can follow it independently, covering all the key setup steps in the right order. The sample profile should be realistic and illustrate all the structural sections with example entries so Jordan knows exactly what to fill in.

## Output Specification

Produce two files in your working directory:

1. **`setup_guide.md`** — A step-by-step onboarding checklist/guide for a brand-new user setting up the RSS curation system for the first time. It should walk through the complete first-run process in the correct order, mentioning the relevant commands and configuration files at each step. Where applicable, note which feed formats are supported when describing how to add feeds.

2. **`sample_profile.yaml`** — A sample interest profile YAML file with all structural sections filled with realistic example entries. Each section should be clearly labeled and contain enough examples that a new user understands what kind of content belongs there.
