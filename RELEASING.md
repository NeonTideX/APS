# Release checklist

APS is distributed through GitHub Releases. The installable userscript is also its complete runtime source.

1. Use AntiPause Suite as the project name and V1 as the release designation. Synchronize the machine-readable version, currently 1.0.0, in userscript metadata, runtime code, and package.json.
2. Consolidate the current V1 changes into its dated CHANGELOG.md entry and keep the README installation link pointed at the release asset.
3. Run npm run validate and relevant manual browser checks. Wait for CI on the exact release commit.
4. Create an annotated v1.0.0 tag on the exact release commit. When explicitly refreshing the existing V1 release, update the tag using a lease against its previously observed remote object so concurrent changes are not overwritten.
5. The Prepare release artifacts workflow validates the tag and packages APS.user.js, LICENSE, README.md, CHANGELOG.md, and SHA256SUMS.
6. Publish or refresh the AntiPause Suite V1 GitHub Release with English notes and all five assets. Replace prior attachments when refreshing; do not retain assets from the previous build. GitHub supplies the corresponding source archives automatically.
7. Download the uploaded files and compare them with SHA256SUMS.

Refreshing an existing release requires an explicit maintainer decision. Its tag, release notes, script, documentation assets, and checksums must describe the same commit. If the machine-readable version is unchanged, tell users to import the refreshed userscript manually because version-based update checks may not detect it.

Automated tests cover controlled regression cases. Record manual browser coverage separately instead of treating the test suite as proof of universal site compatibility.
