# Contributing to eclume

Thank you for considering a contribution. This file describes how a change travels from an idea to
the default branch.

## Before you start

- Search the existing issues first; open one for anything larger than a small fix, so the approach
  can be agreed before the work.
- Questions and discussion go to GitHub Issues (https://github.com/holetz/eclume/issues).

## Making a change

1. Fork the repository and create a branch from the default branch.
2. Keep each pull request focused on one change, with tests where the change has behavior.
3. Run the project's checks locally before opening the pull request.
4. Open the pull request and fill in its template. A maintainer reviews every change before it is
   merged.

## Project rules

- **English only.** Code, comments, identifiers, docs, commit messages, issues and pull requests
  are written in English.
- **Licence of contributions.** The project is GPL-3.0-or-later (`LICENSE`). By opening a pull
  request you license your contribution under GPL-3.0-or-later: inbound = outbound, with no
  sign-off or DCO. The desktop crates derived from Anarlog stay MIT, as `NOTICE.md` records.
- **Specs workflow.** Work is tracked as issues that become specs, driven by `cq specs`. Propose
  a change with the spec issue form; a maintainer turns an accepted proposal into a spec. See
  `AGENTS.md`.
- **Local proof.** Run `bash deploy/pillars.sh <pillar>` for every pillar you touched
  (`bash deploy/pillars.sh --list` shows them). Commands and layout are in `AGENTS.md` and
  `docs/standards/code/monorepo.md`. The host gate (`deploy/gate.sh`) is a maintainer tool.
- **Commits.** An English, imperative subject without a trailing period; one cohesive change per
  commit. On a spec branch `plan/<id>-<handle>` the subject is
  `plan/<id>-<handle>: <task id> <what it does>`.
- **Security.** Report vulnerabilities privately, as `SECURITY.md` describes, never in an issue.

## Code of conduct

Everyone taking part in this project is expected to follow its code of conduct
(`CODE_OF_CONDUCT.md`).
