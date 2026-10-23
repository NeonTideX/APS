# Contributing

APS is maintained as a standalone userscript. Keep changes focused, preserve deliberate user pauses, and avoid adding runtime dependencies unless a concrete playback requirement needs them.

## Development

Use Node.js 22 or newer. Edit `APS.user.js` directly; no package installation or build step is needed. Keep code, comments, documentation, and commit messages in English.

Run `npm run validate` for JavaScript changes. Add regression coverage for fixes to runtime behavior, using the existing Node.js test runner and source-section harnesses in `test/`. Do not add tests that merely duplicate the implementation.

For browser-facing changes, test the affected behavior with a userscript manager on a reproducible page. Include deliberate pause/resume, unexpected pause recovery, and background/foreground transitions when relevant. Report the browser and manager versions and any untested cases. Automated tests do not certify site compatibility.

CI runs syntax checks and regression tests on Node.js 22 and 24 for code, test, package, and CI workflow changes. Documentation-only changes do not trigger it. GitHub Actions dependencies are pinned and checked monthly by Dependabot.

## Pull requests and reports

Use the issue forms for bugs and feature requests. Include reproduction steps rather than only screenshots. Remove private media URLs, credentials, and unrelated page data from diagnostics.

Explain the problem, the resulting behavior, and relevant validation in a pull request. Preserve the console API and storage keys unless the change includes an explicit migration. Document user-visible behavior changes in `CHANGELOG.md`.

Report vulnerabilities using the private channel described in [SECURITY.md](./SECURITY.md).

## Releases

The current release is V1 (`1.0.0`), tagged `v1.0.0`. Repository maintenance can continue on `main` without changing the published userscript version.

For a future runtime release:

1. Update the userscript metadata, runtime version, and `package.json` together.
2. Add one dated changelog entry summarizing the release and update version references in the README.
3. Run `npm run validate`, complete relevant browser checks, and wait for CI on the release commit.
4. Create an annotated `vX.Y.Z` tag on that commit and push it.
5. Publish a GitHub Release for that tag with English notes and attach the exact `APS.user.js` and `LICENSE` files from the tagged commit.
6. Update the README installation link to the published asset.

Keep published tags and assets immutable. Use a new version for subsequent runtime changes rather than silently replacing an existing download. GitHub automatically provides source archives; no npm publication is required.

Contributions are distributed under the project's GPL-3.0-or-later license.
