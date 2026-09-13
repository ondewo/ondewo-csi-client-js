# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working Principles

Behavioral guidelines to reduce common mistakes. They bias toward caution over speed; for trivial tasks, use judgment.

### Think before coding

Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### Simplicity first

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### Surgical changes

Touch only what you must. Clean up only your own mess.

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that _your_ changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the user's request.

### Goal-driven execution

Define success criteria. Loop until verified.

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```text
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

These guidelines are working if: fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and
clarifying questions come before implementation rather than after mistakes.

## Git Commits

- **Never include Claude as author or co-author** in commit messages, PR descriptions, or any other text. Do not add
  `Co-Authored-By: Claude…` trailers, "Generated with Claude Code" footers, or any similar attribution.
- The user's own git author identity (already configured in git) is the only identity that should appear on commits.
- This rule overrides the default Claude Code commit-template guidance.
- **Never prepend the JIRA ticket ID** (e.g. `[OND211-2386]`) to the commit subject yourself. The `giticket` pre-commit
  hook reads the ticket from the branch name (`(feature|bugfix|support|hotfix)/<TICKET>-…`) and prepends `[<ticket>]`
  (with a trailing space) automatically. Writing the prefix manually produces a duplicate like
  `[OND211-2386] [OND211-2386] feat: …`. Write the subject as plain Conventional Commits (`feat: …`, `fix(scope): …`,
  `docs(types): …`) and let the hook add the prefix on commit.

## General Principles

- Follow existing patterns before introducing new abstractions.
- Keep changes minimal and consistent with surrounding code.
- Validate inputs early with descriptive, context-rich error messages.
- Use context managers for files, sockets, and thread pools.
- Prefer region comments for grouping methods in files that already use them.
- End edited Markdown and YAML files with a trailing newline.

## Release gotchas (hard-won this session)

These bit us during the 6.14.0 release. Keep them in mind when releasing.

- **Trust the registry, not the log.** `make release_all_clients` wraps each client in `|| echo "Already released …"`, so a _failed_ release is reported as "done". After any release, verify the GitHub release **and** the published package (PyPI / npm) directly.
- **`npm install failed after 5 attempts` in a release log is usually a red herring** — that text is the echo _inside_ the docker `RUN for i in 1..5; do npm install …` retry loop, not a real failure (`npm install` succeeds → `#10 DONE`). Look further down for the real error (a TTY error, an eslint failure, a `setup.py` error).
- **Codegen must run TTY-free.** The `docker run` that invokes the proto-compiler must not pass `-it` — non-interactively it fails with `cannot attach stdin to a TTY-enabled container because stdin is not a terminal`. Fix the script (drop `-it`), or run the whole release under a pseudo-TTY: `script -qc 'make …' /dev/null`.
- **Release Makefiles print secrets.** Some `docker run … -e <TOKEN>=…` recipe lines lack a leading `@`, so `make` echoes the expanded token. Rotate any token printed during a release; fix by prefixing the recipe line with `@`.
- The release auto-pulls the **latest** `ondewo-proto-compiler` tag.
- **npm package names are inconsistent** — e.g. the JS client publishes as `@ondewo/ondewo-nlu-client-js` (double `ondewo`), not `@ondewo/nlu-client-js`. Check `src/package.json`'s `name` before querying npm.
- **`generate` must not use `docker run -it`** — it fails in the non-interactive release (`cannot attach stdin to a TTY`). Use plain `docker run`; keep `-it` only on interactive `--entrypoint /bin/bash` debug commands.

## The release regenerates root package.json — CI test scripts are preserved via `.ci-package.json`

The proto-compiler codegen (`cd src && npm run build`, whose output-volume is the **repo root**) regenerates the ROOT `package.json` on every release, overwriting the CI test scripts with codegen scripts and stripping test devDeps. This silently broke CI after every release. The durable fix, present in this repo:

- **`.ci-package.json`** holds the CI test scripts + test-only devDeps (immune to the codegen).
- **`make restore_ci_test_setup`** runs inside `build` _before_ `create_npm_package` and merges `.ci-package.json` back into the regenerated root `package.json`. It is an **inline `node -e`** on purpose — a helper `.js` file gets caught by the release's type-checked eslint (`no-require-imports`/`typedef`) and fails the release.
- **`remove_npm_script`** strips scripts from the `npm/` _copy_ (never the repo root) and is guarded against a missing `npm/` dir + empty scripts block (previously crashed with Error 255 when `create_npm_package` had not run yet).
- **Runtime deps the shipped auth helper needs (e.g. `undici`) must be declared in `src/package.json`** (the codegen source of truth) — otherwise the codegen strips them from root and the published package is missing them.
- The `generate` script uses `docker run` **without `-it`** (a TTY-enabled container breaks the non-interactive release).

## Pre-commit (chained into husky) + the release gotchas

This repo now runs the pre-commit framework (markdownlint-cli2, pre-commit-hooks, giticket, conventional-commit) **alongside** husky's eslint/prettier. Hard-won rules:

- **`.husky/pre-commit` must skip `pre-commit run` when `.pre-commit-config.yaml` is unstaged.** The release's `make run_precommit_hooks` invokes `.husky/pre-commit` **directly** (not via a git commit), and the codegen leaves the config unstaged → `pre-commit run` aborts with _"Your pre-commit configuration is unstaged"_ → the entire release fails. The guard (present in `.husky/pre-commit`): `if command -v pre-commit && git diff --quiet -- .pre-commit-config.yaml; then pre-commit run; fi` — still enforced on normal dev commits (config clean there).
- **The release `git commit` uses `--no-verify`** so husky can't reformat the freshly-generated RELEASE.md / package.json mid-commit and break the release.
- **markdownlint MD053 is disabled** in `.markdownlint-cli2.yaml`. Its auto-fix DELETES the `[comment]: <> (START/END OF GITHUB README)` reference-definition markers that the release Makefile slices the published README with (`perl … /START OF GITHUB README/../END OF GITHUB README/`). **Never re-enable MD053 here** — it silently breaks the README slice.
- **RELEASE.md is the authoritative changelog and the release tag holds the complete history.** A markdownlint/`--all-files` pass (or a careless manual "dedup") can drop `## Release … X.Y.Z` headings; if that happens, restore `RELEASE.md` + `src/RELEASE.md` from the latest release tag.

## Releasing: preflight and the traps that have actually bitten

Written after a release program across every ONDEWO client in one session. Each item below
cost real time or a broken artefact; every statement is derived from THIS repo's Makefile.

### Before you touch the version, check the released tag is in `master`

Releases here are cut from a `release/<version>` branch and are **not always merged back**, so
`master` can be missing work that is already published — and because a later version number
sorts above the unmerged one, a consumer upgrading silently loses it. The ondewo-nlu-client-python
7.1.0 release was exactly this: it shipped from a `master` that had never seen 7.0.5's
offline-token hand-off, so PyPI's newest release was a regression against its predecessor.

```bash
latest=$(git tag --sort=-v:refname | head -1)
git merge-base --is-ancestor "$latest" master && echo "in master" || echo "NOT in master -- merge first"
```

A fast-forward (`git merge --ff-only <tag>`) is the common case. A true merge needs care: resolve
metadata toward `master` and keep BOTH release-note sections, newest first — a reader upgrading
from the older line still needs the older entry.

### `git add` on a dirty submodule stages the WRONG commit

This repo has submodules (`ondewo-proto-compiler`, `src/ondewo-csi-api`). If a submodule's working
tree is dirty, `git add <submodule>` stages **its current HEAD**, not the pointer you resolved
during a merge — silently regressing it to an older commit. `git checkout master -- <submodule>`
fixes the index but the next `git add` re-breaks it. Move the working tree instead:

```bash
want=$(git ls-tree master <submodule> | awk '{print $3}')
git -C <submodule> checkout -q "$want" && git add <submodule>
```

### The release notes are sliced by an EXACTLY-CASED heading

`CURRENT_RELEASE_NOTES` slices `RELEASE.md` with a perl range. In THIS repo the opening
pattern is, verbatim:

```text
Release ONDEWO CSI Js Client ${ONDEWO_CSI_VERSION}
```

So the heading of a new entry must read exactly `## Release ONDEWO CSI Js Client <version>`. **This wording is
not consistent across the ONDEWO repos** — some say `... <Name> Client`, some `... Client
<Name>` with the words reversed, the API repos say `... API` with no `Client` at all, and the
casing varies (`Js`, `Nodejs`, `Typescript`, `Survey`). Do not carry a heading over from a
sibling repo. Copy the PREVIOUS entry in this file and change only the version, or read the
pattern above out of the Makefile.

A heading that does not match yields an **empty slice**, and the GitHub release is then
created with empty notes or fails outright. Verify before releasing:

```bash
grep -c '^## Release ONDEWO CSI Js Client ' RELEASE.md     # must be >= 1 for your new version
```

### `src/RELEASE.md` is the source of truth; the root file is GENERATED

The build runs `cp src/RELEASE.md .`, so an edit to the root `RELEASE.md` is **discarded by
the next build**. Write the entry in `src/RELEASE.md` (and copy it to the root if you want to
read it before building). This is silent: the release completes and the notes are simply gone.

### Publish order decides how a partial failure is recovered

`make release` in this repo runs:

1. `publish_npm_via_docker`
2. `create_release_branch`
3. `create_release_tag`
4. `release_to_github_via_docker_image`

The **npm publish happens FIRST**. So a failure in a later step (tag, GitHub release)
leaves the package already published. Do **not** re-run `make ondewo_release` to recover: the
`spc` guard refuses when the branch or tag already exists, and re-publishing the same version
is rejected by the registry. Re-run only the step that failed, passing the credential it needs.

### Verify against the registry, with the REAL package name

This package publishes as **`@ondewo/ondewo-csi-client-js`**, which is not always the repository name — the JS client
publishes as `@ondewo/ondewo-nlu-client-js` (doubled `ondewo`), so a lookup by repo name returns
a 404 that reads like a failed release. Check the name in the manifest first, then:

```bash
npm view @ondewo/ondewo-csi-client-js versions --json
```

**An npm publish can be STAGED but not yet served.** Immediately after a publish the registry may
answer 404 for the new version while refusing a re-publish with
`409 Cannot publish over previously staged version`. That is not a failure and the version is
not burned — wait and re-check before bumping to a new number.

### The release prints credentials — read the log BEFORE you scrub it

`make ondewo_release` clones `ondewo-devops-accounts` and passes the registry and GitHub tokens on
the make command line, so they are echoed into the console and into any transcript capturing it.
This is a known and accepted property of the shared release path: do **not** re-plumb the recipe.
Redirect the run to a file, read it through a filter, and shred the file afterwards — and read it
**before** shredding, or a genuine failure is lost with the secrets:

```bash
umask 077; make ondewo_release > /tmp/rel.log 2>&1; echo "RC=$?"
grep -avE 'TOKEN|PASSWORD|USERNAME|_authToken' /tmp/rel.log | tail -20   # read FIRST
shred -u /tmp/rel.log; rm -rf ondewo-devops-accounts                     # then scrub
```

### Run the release from `master`, and check with `git branch --show-current`

A release ends by checking out `release/<version>`, and **nothing checks you out back**. Start the
next release from that leftover checkout and `git commit` + `git push` land on the OLD release
branch: the new `release/<version>` is cut from it, the tag points into it, and `master` never sees
the release at all. Measured on ondewo-csi-client-typescript 5.5.1 -- npm had it, the tag had it,
and `origin/master` was still at 5.5.0. Recovery was a fast-forward (`git merge --ff-only
release/5.5.1`), which worked only because nothing else had moved; a diverged `master` needs a real
merge.

```bash
git branch --show-current            # must print master BEFORE `make ondewo_release`
```

### The release `git add` list is an ALLOW-LIST, so anything outside it ships but is never committed

`make build` writes files the release target then stages from a fixed list of paths. Anything the
build touches that is not on that list reaches the registry and is **absent from the tag of that
same version** -- two different things under one name, with nothing anywhere reporting it.

- **`auth/`** -- the hand-written Keycloak provider and its spec. It is top-level, so `git add src`
  does not cover it. csi-client-js and csi-client-typescript 5.5.1 went to npm carrying the refresh
  fix and tagged a commit without it; 5.5.2 exists only to make the two agree.

- **`README.md`**, which is a BUILD OUTPUT -- `make build` runs `cp src/README.md .`. Anything
  written only in the root copy is destroyed by the next build. The typescript NLU client's
  "Authentication" section lived in git history and nowhere else for exactly that reason; it belongs
  in `src/README.md`, which is the source of truth.

The general check costs nothing:

```bash
git status --porcelain    # MUST be empty after a release; anything left is published-but-uncommitted
```

### `git commit` exits 1 on a clean tree and takes the whole target down with it

If the release content was already committed by hand, `git commit` finds nothing to commit, returns
1, and make abandons the target -- **before** the publish, the branch, the tag and the GitHub
release -- while printing only `nothing to commit, working tree clean`. Read as a build failure it
sends you hunting a compile error that is not there. The line is prefixed with `-` so the step is
advisory; `spc` still refuses an existing branch or tag, so the guard cannot mask a double release.

### Write the RELEASE.md section BEFORE releasing, or the release body is silently empty

`CURRENT_RELEASE_NOTES` slices RELEASE.md between the heading naming this exact version and the next
`*****` separator. No heading means an EMPTY slice, `gh release create -n ""` succeeds, and you get a
release with no notes and no error anywhere. ondewo-nlu-client-js and -typescript 7.1.1 shipped that
way and had to be repaired after the fact.

```bash
cat RELEASE.md | perl -ne 'print if /<the exact heading> <version>/../^\*{5}/' | wc -l   # must be > 0
```

### Verify the three artefacts separately -- they fail independently

GitHub's release API returned 500 twice in one session, leaving the registry and the tag correct and
**no release object at all** (nlu-client-js and -angular 7.1.1); `gh release create` after the fact
repairs it without touching the artefact.
And npm answering `409 Cannot publish over previously staged
version` is NOT a failure -- the publish SUCCEEDED and the registry has not served it yet, so a 404
from `npm view` in the same minute is the same fact from the other side. Do not burn a version
number over it; wait and re-check.

```bash
npm view <pkg> version ; git tag --list <version> ; gh release view <version> --json body --jq '.body|length'
```
