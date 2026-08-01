import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Apollo Code',
  description: 'The open, model-agnostic AI coding CLI',
  cleanUrls: true,
  sitemap: { hostname: 'https://apollo-code.dev' },
  head: [
    ['meta', { property: 'og:title', content: 'Apollo Code' }],
    ['meta', { property: 'og:description', content: 'Own your terminal. Choose your model.' }],
  ],
  themeConfig: {
    nav: [
      { text: 'Docs', link: '/docs/getting-started/install' },
      { text: 'Security', link: '/docs/concepts/security-model' },
      { text: 'GitHub', link: 'https://github.com/JS-mark/apollo-code' },
    ],
    sidebar: {
      '/docs/': [
        {
          text: 'Getting started',
          items: [
            { text: 'Install', link: '/docs/getting-started/install' },
            { text: 'First run', link: '/docs/getting-started/first-run' },
            { text: '5-minute tutorial', link: '/docs/getting-started/5min-tutorial' },
          ],
        },
        {
          text: 'Concepts',
          items: [
            { text: 'Agent loop', link: '/docs/concepts/agent-loop' },
            { text: 'Security model', link: '/docs/concepts/security-model' },
          ],
        },
        { text: 'CLI reference', link: '/docs/reference/cli' },
        {
          text: 'Troubleshooting',
          items: [
            { text: 'Authentication', link: '/docs/troubleshooting/auth' },
            { text: 'Sandbox', link: '/docs/troubleshooting/sandbox' },
            { text: 'Common errors', link: '/docs/troubleshooting/common-errors' },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/JS-mark/apollo-code' }],
    search: { provider: 'local' },
  },
})
