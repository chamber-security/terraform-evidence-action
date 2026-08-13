# Chamber Terraform evidence Action

Add this Action to an existing Terraform workflow to send plan and post-apply
evidence to Chamber. Plan evidence makes Chamber's pull-request analysis more
precise; state evidence lets Chamber reconcile what Terraform reports after an
apply.

The Action authenticates with GitHub Actions OIDC. You do not need a Chamber API
token, a Chamber ID, another webhook, or a Marketplace installation.

## Before you start

Make sure that:

- normal GitHub onboarding is complete in Chamber: the GitHub App installation is
  connected to the correct Chamber organization, the repository is selected and
  active, and the Terraform root appears as an active Source;
- the workflow checks out the repository and makes `terraform` available in
  `PATH`; and
- the workflow or job grants `contents: read` and `id-token: write`.

```yaml
permissions:
  contents: read
  id-token: write
```

If your organization restricts which Actions may run, allow
`chamber-security/terraform-evidence-action` in the organization or repository's
GitHub Actions policy.

The Action runs on GitHub-hosted and self-hosted runners using GitHub's native
JavaScript Action runtime. It does not install Terraform or check out the
repository for you. GitHub Enterprise Server is not supported in v1.

## Send plan evidence

Save a Terraform plan, then run the Action immediately after the successful plan
step. `plan-file` is relative to `working-directory`.

```yaml
steps:
  - uses: actions/checkout@v6

  - uses: hashicorp/setup-terraform@v4

  - name: Terraform init
    working-directory: terraform
    run: terraform init -input=false

  - id: plan
    name: Terraform plan
    working-directory: terraform
    run: terraform plan -input=false -out=tfplan

  - name: Send Terraform plan evidence to Chamber
    if: ${{ always() && steps.plan.outcome == 'success' }}
    uses: chamber-security/terraform-evidence-action@v1
    with:
      evidence: plan
      working-directory: terraform
      plan-file: tfplan
```

Plan evidence improves analysis for the matching commit. It does not tell Chamber
that the plan was applied.

## Send post-apply state evidence

Run the Action after `terraform apply`. Keep `always()` in the condition so Chamber
can receive the state visible after a failed or partial apply as well as after a
successful apply.

```yaml
- id: apply
  name: Terraform apply
  working-directory: terraform
  run: terraform apply -input=false -auto-approve tfplan

- name: Send post-apply state evidence to Chamber
  if: ${{ always() && steps.apply.outcome != 'skipped' }}
  uses: chamber-security/terraform-evidence-action@v1
  with:
    evidence: state
    working-directory: terraform
    apply-outcome: ${{ steps.apply.outcome }}
```

The Action reports the apply outcome alongside the state evidence. It never changes
a failed Terraform apply into a successful one.

You can add either evidence step or both. For the most precise post-apply analysis,
keep the plan, plan evidence, apply, and state evidence in the same workflow run,
using the same `working-directory` and `instance`. Chamber accepts evidence from
separate workflow runs independently, but cannot associate the later apply with the
earlier plan.

## Terraform roots and instances

Set `working-directory` to the repository-relative Terraform root. For repositories
with one root per environment, the directory already distinguishes them:

```yaml
with:
  evidence: plan
  working-directory: terraform/${{ matrix.environment }}
  plan-file: tfplan
```

If the same directory is independently applied to multiple states, provide a stable
`instance` such as `dev`, `staging`, or `prod`:

```yaml
with:
  evidence: state
  working-directory: terraform
  instance: ${{ matrix.environment }}
  apply-outcome: ${{ steps.apply.outcome }}
```

When `instance` is omitted, the Action uses a non-default Terraform workspace when
one is active. The default workspace is treated as the default instance. Set
`instance` explicitly when multiple backends use the same directory and default
workspace, because those states cannot otherwise be distinguished reliably.

Use `source-ref` only when Chamber reports that the same directory matches multiple
active Source refs and the workflow ref does not identify the intended one. Supply
the ref shown in Chamber, not a Chamber Source ID.

## Inputs

| Input               | Required  | Default     | Description                                                                                          |
| ------------------- | --------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| `evidence`          | yes       | —           | Evidence to send: `plan` or `state`.                                                                 |
| `working-directory` | no        | `.`         | Terraform root, relative to the repository workspace.                                                |
| `plan-file`         | for plans | —           | Saved plan path, relative to `working-directory`.                                                    |
| `instance`          | no        | inferred    | Stable name when one root is applied to multiple independent states.                                 |
| `source-ref`        | no        | automatic   | Active Source ref used only to resolve a reported ambiguity.                                         |
| `apply-outcome`     | for state | —           | Outcome of the apply step: `success`, `failure`, or `cancelled`. Pass `${{ steps.<id>.outcome }}`.   |
| `failure-mode`      | no        | `warn`      | `warn` reports an evidence error without adding another failing step; `error` fails the Action step. |
| `endpoint`          | no        | Chamber API | Chamber-provided endpoint override. Leave unset for normal use.                                      |

`working-directory` and `plan-file` must remain inside `GITHUB_WORKSPACE`. Absolute
paths, paths that escape with `..`, and paths containing symlinks are rejected.

## Failure behavior

The default `failure-mode: warn` keeps an evidence problem from obscuring the
Terraform result. Use `failure-mode: error` if evidence ingestion must succeed for
the workflow to pass:

```yaml
with:
  evidence: plan
  working-directory: terraform
  plan-file: tfplan
  failure-mode: error
```

Chamber reports safe notices, warnings, and errors in the workflow log. If a network
failure leaves the upload result unclear, rerun the job rather than retrying the
upload in a shell loop.

## Outputs

Most workflows do not need to consume Action outputs. They are available for step
summaries and support diagnostics:

| Output            | Description                                                    |
| ----------------- | -------------------------------------------------------------- |
| `status`          | Safe ingestion result.                                         |
| `invocation-id`   | Receipt identifier to include when contacting Chamber support. |
| `revision-id`     | Accepted evidence receipt, when one was created.               |
| `assessment-id`   | Post-apply assessment receipt, when available.                 |
| `analysis-status` | Current Chamber analysis status.                               |

For example, with `id: chamber_plan`, read the status as
`${{ steps.chamber_plan.outputs.status }}`.

## Security and privacy

- Authentication uses short-lived GitHub Actions OIDC credentials; do not create or
  store a Chamber secret in GitHub.
- The Action sends Terraform's documented JSON representation to Chamber over
  HTTPS. It does not upload the binary plan or request Terraform backend or provider
  credentials.
- The Action does not log the Terraform JSON, Terraform values, OIDC credentials, or
  raw Terraform stderr. Chamber reduces the evidence during the request and does not
  retain the raw document.
- Diagnostics and Action outputs do not contain Terraform values.
- Do not use `pull_request_target` to check out and execute untrusted pull-request
  code.

## Version pinning

Marketplace publication is not required. Reference the public repository directly:

```yaml
uses: chamber-security/terraform-evidence-action@v1
```

`@v1` follows compatible v1 releases. If your supply-chain policy requires immutable
dependencies, pin the complete commit SHA and update it deliberately:

```yaml
uses: chamber-security/terraform-evidence-action@<full-commit-sha>
```

Security issues should be reported as described in [SECURITY.md](SECURITY.md).

## Troubleshooting

| Problem                                          | What to check                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub cannot request an OIDC token              | The workflow or job has `id-token: write`.                                                                                            |
| Chamber rejects the repository                   | The Chamber GitHub App is active and the repository remains selected in its installation.                                             |
| GitHub says the Action is not allowed            | Add `chamber-security/terraform-evidence-action` to the organization's Actions allow-list.                                            |
| `terraform` cannot be found                      | Run `hashicorp/setup-terraform` or install Terraform before this Action.                                                              |
| A path is rejected                               | Use repository-relative, non-symlinked paths contained by `GITHUB_WORKSPACE`.                                                         |
| Chamber reports an ambiguous instance            | Set a stable `instance` for each independently applied state.                                                                         |
| Chamber reports an ambiguous Source              | Set `source-ref` to the intended active ref shown in Chamber.                                                                         |
| An upload result is ambiguous after a disconnect | Rerun the workflow job. If the problem continues, give Chamber support the workflow run URL and any non-empty `invocation-id` output. |
