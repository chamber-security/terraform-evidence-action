# Contributing

This repository takes issues, not pull requests from outside Chamber. The Action runs
inside customers' Terraform jobs, which hold cloud credentials and `id-token: write`,
so Chamber's maintainers write and review every change. GitHub lets only collaborators
open pull requests here.

- **Bugs and feature requests:** open an issue with one of the templates. Don't include
  tokens, Terraform output, plan or state files, repository secrets or customer data.
- **Security vulnerabilities:** don't open an issue. Report them privately, as
  [SECURITY.md](SECURITY.md) describes.
- **Dependency updates:** Dependabot opens them, and a maintainer reviews and merges
  each one.

[RELEASING.md](RELEASING.md) describes how releases are made.
