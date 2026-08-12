# Chamber Terraform evidence Action

This public JavaScript Action streams documented `terraform show -json` plan or
post-apply state evidence from your GitHub runner to Chamber. GitHub Actions OIDC
authenticates the installed repository, so there is no Chamber secret, organization
ID, Source ID, binding ID, backend credential, or second Chamber-console setup step.

The Action requires Terraform and a checked-out Git repository. It runs natively on
GitHub-hosted or self-hosted runners using GitHub's Node 24 Action runtime; there is no
Node setup step. It does not install Terraform.

## Plan evidence

Save the binary plan and invoke Chamber immediately afterwards. The Action never
uploads the binary file; it runs `terraform show -json <plan-file>` and streams its
stdout.

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - uses: actions/checkout@v6
  - uses: hashicorp/setup-terraform@v4

  - id: plan
    working-directory: terraform/${{ matrix.environment }}
    run: terraform plan -out=tfplan

  - name: Send Terraform plan evidence to Chamber
    if: ${{ always() && steps.plan.outcome == 'success' }}
    uses: chamber-security/terraform-evidence-action@v1
    with:
      evidence: plan
      working-directory: terraform/${{ matrix.environment }}
      plan-file: tfplan
```

Plan evidence is candidate-only. It can make the matching exact-commit PR analysis
more precise, including known cardinality, values, deletes, and replacements, but it
never becomes canonical state and never proves an apply happened.

## Post-apply state evidence

Invoke the same Action after apply with `always()` so a failed or partial apply can
still report the complete state observable at capture time. A failed `terraform show`
records only a safe failed-capture receipt; it cannot change currentness.

```yaml
- id: apply
  working-directory: terraform/${{ matrix.environment }}
  run: terraform apply -auto-approve tfplan

- name: Send post-apply state evidence to Chamber
  if: ${{ always() && steps.apply.outcome != 'skipped' }}
  uses: chamber-security/terraform-evidence-action@v1
  with:
    evidence: state
    working-directory: terraform/${{ matrix.environment }}
    apply-outcome: ${{ steps.apply.outcome }}
```

State is applied-presence and provider-identity evidence for one binding. Active
Source HCL remains intended configuration and cloud observation remains observed
reality. Chamber records the reported apply outcome honestly.

## Directories, workspaces, and `instance`

`working-directory` is repository-relative and defaults to `.`. GitHub expands
expressions before the Action receives them. Absolute paths, `..` escapes, symlinked
path components, a symlinked plan file, and any path resolving outside
`GITHUB_WORKSPACE` are rejected.

Different Terraform roots need no instance:

```yaml
working-directory: terraform/${{ matrix.environment }}
```

If one root is independently applied to multiple states, pass a stable instance:

```yaml
working-directory: terraform
instance: ${{ matrix.environment }}
```

Without an explicit instance, a non-default Terraform workspace becomes the
instance; the default workspace uses Chamber's implicit default selector. If
workspace discovery fails, state capture ends safely without guessing. Plan evidence
may be retained with an unknown target but will not be selected for an instance.

Two opaque backends using the same repository directory and default workspace are
indistinguishable in documented `terraform show -json`. Chamber cannot always warn
about this case. Supply `instance`; the Action deliberately does not inspect backend
metadata or run `terraform state pull`.

Use `source-ref` only when the same directory has multiple active long-lived Chamber
Sources and the actual workflow ref cannot select the intended track. It accepts the
Source's ref, never a Chamber Source ID, and cannot make an unverified checkout ref
authoritative.

## Branch behavior

Plans from pull request branches remain proposed evidence and do not create an
off-source execution finding. Post-apply state is admissible from any branch or tag.
Chamber compares verified execution provenance with all currently active Sources:
registered alternate Sources are intended, while current off-source instances or
attributable changes can warn. A no-op off-source apply records history without
marking every resource changed. When active Source facts catch up, current warnings
resolve and execution history remains.

Do not combine `pull_request_target` with checkout of untrusted pull-request code.

## Inputs and outputs

| Input               | Required | Default     | Meaning                                                                      |
| ------------------- | -------- | ----------- | ---------------------------------------------------------------------------- |
| `evidence`          | yes      | —           | `plan` or `state`                                                            |
| `working-directory` | no       | `.`         | Repository-relative Terraform root                                           |
| `plan-file`         | plan     | —           | Saved binary plan path relative to the root                                  |
| `instance`          | no       | inferred    | Stable multiple-state discriminator                                          |
| `source-ref`        | no       | automatic   | Active Source ref for rare ambiguity                                         |
| `apply-outcome`     | state    | —           | `success`, `failure`, or `cancelled`; `skipped` is rejected                  |
| `failure-mode`      | no       | `warn`      | `warn` preserves Terraform's outcome; `error` fails this step too            |
| `endpoint`          | no       | Chamber API | Advanced HTTPS tunnel/integration-test override; OIDC audience never changes |

Outputs are `status`, `invocation-id`, optional `revision-id`, optional
`assessment-id`, and `analysis-status`. Chamber diagnostics become safe GitHub
notice/warning/error annotations. They never contain Terraform values or raw stderr.

## Minimisation and transport

The Action gets a fresh GitHub OIDC token for the exact fixed Chamber audience on
each transport attempt. Headers, including repository admission, are checked before
the body when the route honors HTTP `100 Continue`; a bounded fallback supports
intermediaries that do not relay the interim response. Retries are allowed only
before streaming starts. Once any body byte may have been consumed, a disconnect is
reported as ambiguous and a new Action execution must create a fresh submission.

Terraform stdout is streamed through gzip into the ordered
`start`/`evidence`/`completion` multipart protocol. Raw JSON, OIDC tokens, plan files,
variables, outputs, Terraform values, and stderr are never logged or stored by this
Action. Chamber synchronously validates and reduces the document and does not retain
the raw payload. The transport proves GitHub issued a token to the admitted
repository; checkout/outcome/evidence association remains client-attested rather than
cryptographic proof of a local command.

## Pinning

`@v1` follows compatible v1 releases. For strict supply-chain controls, pin the full
immutable commit SHA and use release notes or Dependabot to update it deliberately:

```yaml
uses: chamber-security/terraform-evidence-action@<full-commit-sha>
```

Release integrity and the committed bundle procedure are documented in
[RELEASING.md](RELEASING.md); vulnerability reporting is in
[SECURITY.md](SECURITY.md).
