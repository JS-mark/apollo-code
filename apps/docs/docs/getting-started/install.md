# Install

Apollo Code requires Node.js 20.19 or newer. The stable npm release is not published yet; until release approval, build from the repository:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
node apps/cli/dist/apollo.js --help
```

Do not treat the draft `0.0.0` workspace version as a released package. Official install instructions will name the first published version and tag after human approval.

The JavaScript package does not bundle every native target. On first use, Apollo downloads the exact-version `sandbox`, `search`, and `fs` binaries from the matching GitHub Release, verifies them against `checksums.sha256`, and caches them under the version and target triple. It never resolves native binaries from a moving `latest` release.
