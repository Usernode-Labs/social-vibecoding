export const isProductionReadOnlyReview = import.meta.env.VITE_PRODUCTION_READONLY === true || import.meta.env.VITE_PRODUCTION_READONLY === "true"
export const productionWriteAppSlug = typeof import.meta.env.VITE_PRODUCTION_WRITE_APP_SLUG === "string" && import.meta.env.VITE_PRODUCTION_WRITE_APP_SLUG.trim()
  ? import.meta.env.VITE_PRODUCTION_WRITE_APP_SLUG.trim()
  : null
