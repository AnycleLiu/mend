# mend

One patch tool for every AI edit format. mend reads a patch in any of the four formats AI models write —
unified diffs (with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and text-editor tool calls as
JSON — finds the lines each edit names even when the model drifted their whitespace or indentation, and
changes every file or none.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- Four formats, auto-detected or forced with `--format`; `--check` reports without writing; `--strict`
  matches lines exactly.
- Three matching tiers: exact, trailing-whitespace-insensitive, then trim-insensitive, with re-indentation
  of new lines at the loosest tier.
- Atomic: if any edit fails, nothing is written and every failure is reported.
- Node 22, standard library only. MIT licensed.

Built to the specification in the hidden-spec-cli-01 bounty kit (SPEC.md v1): practice set 100/100.

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/AnycleLiu/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/AnycleLiu/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
