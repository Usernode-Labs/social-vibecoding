import {
  isExpectedReactShellWorkerStatus,
  type ReactShellWorkerStatus,
} from "@/lib/react-worker-status-contract"

export const REACT_SHELL_READY_EVENT = "usernode:react-shell-ready"
export const REACT_SHELL_ERROR_EVENT = "usernode:react-shell-error"
const EXPECTED_REACT_SHELL_REVISION = import.meta.env.VITE_REACT_SHELL_REVISION

function postWorkerMessage<T>(worker: ServiceWorker, message: unknown, timeoutMs = 5000) {
  return new Promise<T>((resolve, reject) => {
    const channel = new MessageChannel()
    const timer = window.setTimeout(() => reject(new Error("React shell worker did not respond")), timeoutMs)
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timer)
      resolve(event.data as T)
    }
    try {
      worker.postMessage(message, [channel.port2])
    } catch (error) {
      window.clearTimeout(timer)
      reject(error)
    }
  })
}

function expectedWorkerPath() {
  return new URL(`${import.meta.env.BASE_URL}react-sw.js`, window.location.origin).pathname
}

function isExpectedControllerPath(worker: ServiceWorker | null) {
  if (!worker) return false
  return new URL(worker.scriptURL, window.location.origin).pathname === expectedWorkerPath()
}

async function waitForVerifiedController(registration: ServiceWorkerRegistration, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null

  while (Date.now() < deadline) {
    const controller = navigator.serviceWorker.controller
    if (isExpectedControllerPath(controller)) {
      try {
        const status = await postWorkerMessage<ReactShellWorkerStatus>(
          controller!,
          { type: "get-react-shell-status" },
          Math.min(1000, Math.max(1, deadline - Date.now())),
        )
        if (isExpectedReactShellWorkerStatus(status, {
          buildRevision: EXPECTED_REACT_SHELL_REVISION,
          scope: registration.scope,
        })) return status
        lastError = new Error("React shell worker returned stale or incomplete status")
      } catch (error) {
        // A same-URL update can leave the old controller in place briefly.
        // Retry until the newly registered worker claims the client.
        lastError = error
      }
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100))
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("React shell worker did not take control")
}

async function registerAndVerifyReactServiceWorker() {
  const existingRegistration = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL)
  if (existingRegistration && isExpectedControllerPath(navigator.serviceWorker.controller)) {
    try {
      // An offline reload can already be controlled by the exact, completely
      // cached revision. Verify that controller before making any network-
      // dependent registration/update request.
      return await waitForVerifiedController(existingRegistration, 1000)
    } catch {
      // A stale controller is not readiness. Continue through the normal
      // registration/update path so an online client can install the build
      // revision compiled into this document.
    }
  }

  const registration = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}react-sw.js`, {
    scope: import.meta.env.BASE_URL,
    updateViaCache: "none",
  })
  // `register()` may reuse a same-URL registration without immediately
  // fetching it again. Force the deployment check so an old controller cannot
  // wait for the browser's normal update cadence before yielding readiness.
  await registration.update()
  await navigator.serviceWorker.ready
  return await waitForVerifiedController(registration)
}

function publishReactShellReadiness(status: ReactShellWorkerStatus) {
  document.documentElement.dataset.reactShellReady = "true"
  document.documentElement.dataset.reactShellRevision = status.buildRevision
  window.dispatchEvent(new CustomEvent(REACT_SHELL_READY_EVENT, { detail: status }))
}

/**
 * Keep registration separate from the React tree: the worker is a deployment
 * concern and must not change a route's loading/error semantics. The returned
 * promise and DOM event give the native host an executable readiness signal;
 * `onPageFinished` alone is not shell readiness.
 */
export function registerReactServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return Promise.resolve(null)

  return new Promise<ReactShellWorkerStatus | null>((resolve) => {
    const register = () => {
      void registerAndVerifyReactServiceWorker()
        .then((status) => {
          publishReactShellReadiness(status)
          resolve(status)
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "React shell worker failed"
          document.documentElement.dataset.reactShellReady = "error"
          window.dispatchEvent(new CustomEvent(REACT_SHELL_ERROR_EVENT, { detail: { message } }))
          resolve(null)
        })
    }

    if (document.readyState === "complete") register()
    else window.addEventListener("load", register, { once: true })
  })
}
