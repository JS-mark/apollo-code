# 安装

Apollo Code 需要 Node.js 20.19 或更高版本。稳定 npm 版本尚未发布；正式发布获批前，请从源码构建：

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
node apps/cli/dist/apollo.js --help
```

工作区中的 `0.0.0` 是开发版本，不代表已发布。首次正式发布通过人工审批后，本文档会更新对应的 npm 版本与 Git tag。
