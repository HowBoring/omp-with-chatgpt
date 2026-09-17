---
name: omp-with-chatgpt
description: Scaffold for migrating C2C from Codex-only execution to OMP. Use when checking that the OMP package, extension, and skill were installed together.
---

# OMP with ChatGPT scaffold

This skill is intentionally minimal. It verifies the package layout for the
C2C-to-OMP migration and does not yet automate ChatGPT browser workflows.

When the user asks whether the OMP migration scaffold is installed, run the
`/c2c-status` extension command and report only its result. Do not configure a
ChatGPT connector from this scaffold skill.
