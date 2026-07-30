import type { Meta, StoryObj } from "@storybook/react-vite"

import { NativeAppSettings } from "@/features/account/native-app-settings"

const readyState = {
  buildInfo: {
    appVersion: "1.4.2",
    buildNumber: "87",
    nodeVersion: "0.9.1",
    commitHash: "a1b2c3d",
    branch: "develop",
  },
  nodeSleepEnabled: true,
  debugMode: false,
  facematchStrict: true,
  termsAccepted: true,
  authStatus: "authenticated",
  permissions: {
    platform: "android",
    exactAlarmGranted: false,
    batteryOptDisabled: false,
    deviceManufacturer: "samsung",
    iosKeepAliveActive: null,
  },
}

function installReadyBridge() {
  let state = structuredClone(readyState)
  const snapshot = () => structuredClone(state)
  Object.defineProperty(window, "usernode", {
    configurable: true,
    value: {
      getBridgeInfo: async () => ({
        version: 3,
        capabilities: [
          "getSettingsState",
          "setNodeSleepEnabled",
          "setDebugMode",
          "setFacematchStrict",
          "requestPermissions",
          "resetZkChallenge",
          "openBatterySettings",
          "openNativeScreen",
          "logout",
        ],
      }),
      getSettingsState: async () => snapshot(),
      setNodeSleepEnabled: async (enabled: boolean) => {
        state = { ...state, nodeSleepEnabled: enabled }
        return snapshot()
      },
      setDebugMode: async (enabled: boolean) => {
        state = { ...state, debugMode: enabled }
        return snapshot()
      },
      setFacematchStrict: async (enabled: boolean) => {
        state = { ...state, facematchStrict: enabled }
        return snapshot()
      },
      requestPermissions: async () => {
        state = { ...state, permissions: { ...state.permissions, exactAlarmGranted: true } }
        return snapshot()
      },
      resetZkChallenge: async () => true,
      openBatterySettings: async () => true,
      openNativeScreen: async () => true,
      logout: async () => true,
    },
  })
}

function ReadySurface() {
  installReadyBridge()
  return <NativeAppSettings />
}

function UnavailableSurface() {
  delete (window as Window & { usernode?: unknown }).usernode
  return <NativeAppSettings />
}

const meta = {
  title: "Blocks/Account/Native app settings",
  component: NativeAppSettings,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="mx-auto max-w-3xl"><Story /></div>],
} satisfies Meta<typeof NativeAppSettings>

export default meta
type Story = StoryObj<typeof meta>

export const Ready: Story = { render: () => <ReadySurface /> }
export const OutsideUsernode: Story = { render: () => <UnavailableSurface /> }
export const ReadOnly: Story = { render: () => { installReadyBridge(); return <NativeAppSettings readOnly /> } }
