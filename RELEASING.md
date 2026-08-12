# Release process

Releases are maintainers-only and must originate from a reviewed, green commit on the
protected default branch.

1. Update the semver in `package.json`, `package-lock.json`, and
   `src/constants.ts`.
2. Run `npm ci`, `npm run format:check`, `npm run lint`, `npm test`, and
   `npm run build` on Node 24.
3. Verify a second `npm run build` leaves `dist/` byte-for-byte clean and that
   `npm audit --audit-level=high` has no high or critical findings.
4. Review `dist/licenses.txt`, dependency licenses, and the CodeQL/Dependabot state.
5. Sign and push an immutable `v1.x.y` tag pointing at the exact reviewed commit.
6. Publish release notes referring to that commit. Run the Chamber test-org
   `workflow_dispatch` transport acceptance using the immutable full commit SHA.
7. Only after acceptance, move the `v1` tag to the same commit using the repository's
   protected release procedure.

Never build `dist/` in a release workflow and attach a different artifact: the code
executed by GitHub Actions is the committed bundle reviewed with the source. Customers
with strict supply-chain controls should pin the full immutable commit SHA rather
than `v1`.
