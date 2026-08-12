# Security policy

Please report suspected vulnerabilities privately through GitHub's **Report a
vulnerability** flow for this repository. Do not open a public issue containing a
token, Terraform output, repository metadata, or a reproduction with customer data.

Supported releases are the current immutable `v1.x.y` release and the moving `v1`
major tag. Security fixes are shipped in a new immutable release; the major tag is
updated only after the release commit and bundle have passed CI.

## Trust and data boundary

The Action asks GitHub for an OIDC token with the exact Chamber evidence audience.
The token is masked immediately and is never written to a multipart field, log,
artifact, cache, or file. Each HTTP retry gets a fresh token. A retry is allowed only
before any request-body byte has begun; a disconnect after streaming starts is
reported as ambiguous and requires a new Action execution.

`terraform show -json` stdout is streamed through gzip directly to Chamber. The
Action does not buffer it as a whole, redirect it to disk, or print it. It never runs
`terraform state pull`, reads Terraform backend files, installs Terraform, or accepts
cloud/backend credentials. Stderr is counted only up to a bound and never retained or
printed.

Chamber treats the transport as GitHub-authenticated but the checkout, outcome, and
evidence association as client-attested. See the README for the documented Terraform
format and state-observability limits.
