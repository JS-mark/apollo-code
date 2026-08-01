import DefaultTheme from 'vitepress/theme-without-fonts'

import HomeLanding from './components/HomeLanding.vue'

// oxlint-disable-next-line import/no-unassigned-import -- Vite bundles global theme styles.
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('HomeLanding', HomeLanding)
  },
}
