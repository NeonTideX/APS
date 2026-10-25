# Release checklist

APS is distributed through GitHub Releases. The installable userscript is also its complete runtime source.

1. Synchronize the version in userscript metadata, runtime code, and package.json for runtime changes. Documentation and repository maintenance do not require a runtime version bump.
2. Add a dated CHANGELOG.md entry and update the README installation link if the version changes.
3. Run npm run validate and relevant manual browser checks. Wait for CI on the exact release commit.
4. Create an annotated tag: git tag -a vX.Y.Z -m "AntiPause Suite X.Y.Z" and push that tag.
5. The Prepare release artifacts workflow validates the tag and packages APS.user.js, LICENSE, README.md, CHANGELOG.md, and SHA256SUMS.
6. Publish the GitHub Release with English notes and those assets. GitHub supplies the corresponding source archives automatically.
7. Download the uploaded files and compare them with SHA256SUMS.

Published tags and assets are immutable. Correct a published runtime artifact with a new version. An unpublished draft may be refreshed before publication.

Automated tests cover controlled regression cases. Record manual browser coverage separately instead of treating the test suite as proof of universal site compatibility.
