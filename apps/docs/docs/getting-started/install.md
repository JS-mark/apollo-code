# Install

Apollo Code requires Node.js 20.19 or newer. The stable npm release is not published yet; until release approval, build from the repository:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
node apps/cli/dist/apollo.js --help
```

Do not treat the draft `0.0.0` workspace version as a released package. Official install instructions will name the first published version and tag after human approval.
