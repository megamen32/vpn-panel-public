# Improve Loop

- Record durable observations only.
- Keep each record compact.
- Use subagents for isolated work.
- Review subagent changes before commits.
- Context-mode can break compound shell syntax through injected `NODE_OPTIONS`; use simple commands.
- Never probe an unrecognized deployment-script option such as `--help`; inspect its parser or use documented `--dry-run`.
- A deployment source/runtime split requires checking the installed config and real listener outputs, not only dry-runs or tests.
