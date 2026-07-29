/**
 * Keep registration separate from the React tree: the worker is a deployment
 * concern and must not change a route's loading/error semantics.
 */
export function registerReactServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return

  const register = () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}react-sw.js`, {
      scope: import.meta.env.BASE_URL,
    }).catch(() => {
      // Offline recovery is progressive enhancement. The host's visible
      // network/error UI remains authoritative if registration is unavailable.
    })
  }

  if (document.readyState === "complete") register()
  else window.addEventListener("load", register, { once: true })
}
