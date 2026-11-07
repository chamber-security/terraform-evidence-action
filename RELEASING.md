# Release process

Releases go through the **Promote release** workflow (`.github/workflows/promote.yml`)
on `main`. It is the only way to create a `v1.x.y` tag or move `v1`. The workflow
checks the commit; repository settings decide who may write tags:

- `main` accepts changes only through squash-merged pull requests that pass CI, with
  signed, linear history and no force-push, deletion or bypass.
- Tag rulesets let only the `chamber-action-release` GitHub App create tags or move
  `v1`. Nobody, the App included, can update or delete a `v1.x.y` tag, and GitHub's
  immutable releases lock each release published from now on.
- The App's private key is a secret in the `release` environment, which only `main`
  can use. Its only permissions are Contents read and write (plus the Metadata read
  every App has) on this repository.
- A branch ruleset with no bypass stops anyone creating a branch named `v1` or
  `v1.x.y`, which a workflow's `uses: …@v1` could otherwise run instead of the tag.

The App creates plain tags, not signed annotated ones: the rulesets and immutable
releases replace tag signatures. `Release check` runs again after every `v1.x.y` tag
or `v1` move, as a detection layer.

## Steps

1. In a pull request, bump the version in `package.json` and `package-lock.json`
   (`npm version 1.x.y --no-git-tag-version`) and in `src/constants.ts`, then rebuild
   `dist/` with `npm run build` on Node 24. Squash-merge it once CI passes.
2. Wait for CI to pass on the push to `main`, then note the squash commit's full SHA
   (`main`'s new head).
3. Create the release. A dry run checks everything and changes nothing, and is the
   default:

   ```sh
   gh workflow run promote.yml -R chamber-security/terraform-evidence-action \
     -f operation=create-release -f version=1.x.y -f commit=<full-sha>
   ```

   Then run it for real with `-f dry_run=false`. The workflow checks that the commit is
   on `main`, that CI passed for it on a push to `main`, that all three version fields
   match, and that `dist/` rebuilds clean from a clean install. Then the App creates
   `v1.x.y` and publishes its release. If a run stops after creating the tag, run it
   again: it finishes the release on the same commit.

4. Run the Chamber transport acceptance against the release's full commit SHA:
   chowder's `Opt-in Terraform evidence OIDC proof` workflow, with its `uses:` lines
   pinned to that SHA.
5. Move `v1` only after the acceptance passes. The workflow also requires
   `Release check` to have passed for the tag:

   ```sh
   gh workflow run promote.yml -R chamber-security/terraform-evidence-action \
     -f operation=move-major -f version=1.x.y -f dry_run=false
   ```

   Then confirm `Release check` passed for `v1`. Its failure notifies nobody, because
   the App made the push. To roll back, move `v1` to an earlier release the same way.

Never build `dist/` in a release workflow and attach a different artifact: the code
GitHub Actions runs is the committed bundle reviewed with the source. The promotion
workflow rebuilds `dist/` only to check it. Customers with strict supply-chain controls
should pin the full immutable commit SHA rather than `v1`.
