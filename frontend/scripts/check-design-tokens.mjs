import { checkDesignTokens } from "./design-token-tools.mjs"

try {
  checkDesignTokens()
  console.log("Design-token check passed: canonical DTCG tokens and generated CSS agree.")
} catch (error) {
  console.error(`Design-token check failed:\n\n- ${error.message}`)
  process.exit(1)
}
