# Releases

Releases are automated by [release-please](https://github.com/googleapis/release-please)
in [`.github/workflows/publish.yml`](../.github/workflows/publish.yml). Every push
to `main` re-computes the next version from the conventional commit messages and
keeps a single release PR open, titled `chore(main): release X.Y.Z` and labelled
`autorelease: pending`.

Merging that PR is what releases. It tags `vX.Y.Z`, creates the GitHub release,
runs the verification suite, publishes to npm, and dispatches a version update to
the agent registry.

There is no manual release button, and versions are never typed in by hand: the
version is an output of the commit history, not an input.

## Releasing

```sh
npm run release:preflight
```

This reports the open release PR, the version it will ship, and checks that the
repository is in a state where merging is safe. Nothing has to be remembered —
if it exits non-zero, follow what it prints instead of merging.

Then merge it, using the PR number the preflight printed:

```sh
gh pr merge <pr-number> --squash
gh run watch "$(gh run list --workflow=publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

The run is looked up rather than picked interactively, so this is safe to script.
If the workflow has already finished, `gh run list --workflow=publish.yml` shows
the outcome instead.

Merging main requires no review, so a green preflight and `ci` are the only gates
before the merge. After it, the `verify` job re-runs typecheck, unit tests and the
e2e suite against the release commit, and nothing is published unless it passes.
Once the workflow finishes, confirm both outputs landed:

```sh
gh release view "v<version>"
npm view "$(node -p "require('./package.json').name")@<version>"
```

## How the version is chosen

Squash merges use the PR title as the commit subject, so the PR title decides the
next version. [`conventional-prs.yml`](../.github/workflows/conventional-prs.yml)
rejects titles release-please would not understand.

| PR title prefix                                                     | Effect                      |
| ------------------------------------------------------------------- | --------------------------- |
| `fix:`, `perf:`, `revert:`                                          | patch, e.g. 1.1.14 → 1.1.15 |
| `feat:`                                                             | minor, e.g. 1.1.14 → 1.2.0  |
| any of the above with `!`, or BREAKING CHANGE                       | major, e.g. 1.1.14 → 2.0.0  |
| `docs:`, `style:`, `chore:`, `refactor:`, `test:`, `build:`, `ci:`  | no release on their own     |

The last row is a property of release-please's default changelog sections: those
types are hidden, so when nothing else has landed since the last tag the release
notes come out empty and no release PR is opened at all. They still ride along in
the next release a `feat:` or `fix:` triggers; they just do not appear in the
changelog.

The scheduled Codex bumps opened by
[`codex-update.yml`](../.github/workflows/codex-update.yml) title themselves
`fix:` on purpose. They run close to daily, and titling them `feat:` would walk
the minor version every time a dependency moved.

The package is past 1.0.0, so a `!` really does ship a major version — unlike
pre-1.0 repositories, there is no `bump-minor-pre-major` safety net to fall back
on (setting it would have no effect above 1.0.0). Treat `!` in a PR title as an
explicit decision to release a major.

Note that `config-file` only takes effect while the workflow does **not** pass a
`release-type` input to the action — with `release-type` set, the action ignores
the config entirely. The release type is declared inside the config instead.

Because the config is what is read, it also has to say
`"include-component-in-tag": false`. Left at its default, release-please derives a
component from the package name and tags `codex-acp-vX.Y.Z` instead of `vX.Y.Z`.
That renames the tag every step here looks up, and because no tag under the new
scheme exists, it also walks the entire commit history into the changelog rather
than just what landed since the last release. The preflight checks the tag
release-please is going to use, so this cannot reach a published release.

If a specific version has to be forced, add `"release-as": "X.Y.Z"` to
`release-please-config.json` in its own PR, release, then remove it again.

## Recovering a stalled release

### The release PR merged but nothing was tagged

The preflight fails with `release-please is jammed`. While a merged release PR
still carries `autorelease: pending`, release-please refuses to open any new
release PR at all, so every later release stalls silently until this is cleared.

Take the release notes release-please already wrote into the changelog, create
the missing release, then move the label the way release-please would have:

```sh
awk '/^## \[<version>\]/{f=1;print;next} /^## \[/{f=0} f' CHANGELOG.md > notes.md
gh release create "v<version>" --target <merge-commit-sha> --notes-file notes.md
gh pr edit <pr-number> --remove-label "autorelease: pending" \
  --add-label "autorelease: tagged"
```

Then publish the tag as described below.

### The tag exists but npm or the registry is missing

npm publishes through OIDC from inside the workflow, so this cannot be done from
a laptop. Re-run the publish workflow against the existing tag:

```sh
gh workflow run publish.yml -f ref="v<version>" -f publish_npm=true
```

This re-runs `verify` against that ref before publishing, so a flaky e2e run will
block it; re-run the workflow rather than working around it.

npm versions are immutable. If the package already published and only the
registry update failed, pass `-f publish_npm=false` so the run skips verification
and publishing and only re-dispatches the registry update.

## Credentials and repository settings

| Secret                                                        | Used for                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------- |
| `RELEASE_PLZ_APP_ID`, `RELEASE_PLZ_APP_PRIVATE_KEY`           | App token for release PRs and tags, so they can trigger workflows |
| `REGISTRY_UPDATER_APP_ID`, `REGISTRY_UPDATER_APP_PRIVATE_KEY` | App token scoped to the `registry` repository                     |
| `OPENAI_API_KEY`                                              | The e2e suite in the `verify` job                                 |

Publishing to npm uses OIDC trusted publishing, so there is no npm token. The
release-please, publish and registry jobs run in the `release` environment.

Because those jobs are now triggered by pushes to `main` rather than by a `v*`
tag, the `release` environment's deployment branch policy has to allow the `main`
branch in addition to `v*` tags. Without it every release job fails before it
starts with a branch-not-allowed error.
