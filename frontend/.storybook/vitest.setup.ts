import * as a11yAddonAnnotations from "@storybook/addon-a11y/preview"
import { setProjectAnnotations } from "@storybook/react-vite"

import * as projectAnnotations from "./preview"

// Explicit annotations avoid Storybook's generated setup importing the
// CommonJS `aria-query` package through an incompatible ESM named-export path.
setProjectAnnotations([a11yAddonAnnotations, projectAnnotations])
