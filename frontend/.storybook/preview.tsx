import React from "react"
import type { Preview } from '@storybook/react-vite'
import { MemoryRouter } from "react-router-dom"

import "../src/index.css"
import { ThemeFrame } from "./theme-frame"

const preview: Preview = {
  initialGlobals: {
    theme: 'light',
  },
  globalTypes: {
    theme: {
      description: 'Global light or dark design-system mode',
      toolbar: {
        icon: 'circlehollow',
        items: [
          { value: 'light', icon: 'sun', title: 'Light' },
          { value: 'dark', icon: 'moon', title: 'Dark' },
        ],
        dynamicTitle: true,
      },
    },
  },
  decorators: [
    (Story, context) => (
      <MemoryRouter>
        <ThemeFrame theme={context.globals.theme === 'dark' ? 'dark' : 'light'}>
          <Story />
        </ThemeFrame>
      </MemoryRouter>
    ),
  ],
  parameters: {
    controls: {
      matchers: {
       color: /(background|color)$/i,
       date: /Date$/i,
      },
    },

    a11y: {
      test: 'error'
    }
  },
}

export default preview
