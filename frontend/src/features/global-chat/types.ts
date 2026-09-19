export interface GlobalChatSuggestion {
  id: string;
  label: string;
  prompt: string;
  capabilityHint: string | null;
  actionId?: string | null;
  parameters?: Record<string, string>;
  targetLabel?: string | null;
  relatedSuggestions?: GlobalChatSuggestion[];
}
export interface GlobalChatPresentation {
  message: string;
  resultRefs: string[];
  suggestions: GlobalChatSuggestion[];
  suggestionContext?: string;
}

export interface GlobalChatMessage {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  text: string;
  payload: {
    kind?: string;
    presentation?: GlobalChatPresentation;
    [key: string]: unknown;
  };
  promptVersion?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  createdAt?: string | null;
  pending?: boolean;
}

export interface GlobalChatResult {
  id: string;
  capabilityId: string;
  modelResult?: unknown;
  authoritativeResult: unknown;
  renderer: string;
  classicPath: string | null;
  status: string;
  createdAt?: string | null;
  completedAt?: string | null;
}

export interface GlobalChatThread {
  id: string;
  title: string;
  busy: boolean;
  summary?: string | null;
  summaryCursor?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface GlobalChatProfile {
  backend: string;
  enabled: boolean;
  model: string;
  reasoningEffort: string;
  spendCapUsd: string | null;
  saved?: boolean;
  updatedAt?: string | null;
}

export interface GlobalChatUsage {
  period?: string;
  periodStart?: string;
  resetAt?: string;
  spentUsd: string;
  capUsd: string | null;
  remainingUsd?: string | null;
  capReached?: boolean;
  turns?: string;
  inputTokens?: string;
  outputTokens?: string;
  reasoningTokens?: string;
}

export interface GlobalChatBootstrap {
  experimental: true;
  label: string;
  startupMode: 'classic';
  parityReady: boolean;
  available: boolean;
  unavailableReason: string | null;
  capabilityRegistryVersion: string;
  capabilityCount: number;
  thread: GlobalChatThread | null;
  threads: GlobalChatThread[];
  firstUse: GlobalChatPresentation;
  profiles: {
    globalChat: GlobalChatProfile;
    development: {
      backend: string;
      model: string | null;
      reasoningEffort: string | null;
    };
  };
  usage: GlobalChatUsage;
}

export interface GlobalChatMessagePage {
  messages: GlobalChatMessage[];
  results: GlobalChatResult[];
  hasMore: boolean;
  before: string | null;
}

export interface GlobalChatTurnEvent {
  type: string;
  [key: string]: unknown;
}

export interface GlobalChatProgressOperation {
  toolCallId: string;
  capabilityId: string;
  title: string;
  risk?: string;
  status: 'planned' | 'running' | 'completed' | 'failed';
  durationMs?: number;
}

export interface GlobalChatProgressStep {
  phase: string;
  message: string;
  elapsedMs: number;
}

export interface GlobalChatProgress {
  phase: string;
  message: string;
  model: string | null;
  reasoningEffort?: string | null;
  elapsedMs: number;
  startedAt: number;
  attempt?: number;
  steps: GlobalChatProgressStep[];
  operations: GlobalChatProgressOperation[];
}

export interface GlobalChatModel {
  id: string;
  name?: string;
  provider?: string;
  averagePricePerMillion?: number | null;
  inputPricePerMillion?: number | null;
  outputPricePerMillion?: number | null;
  reasoningEfforts?: string[];
  isGlobalChatRecommended?: boolean;
}

export interface GlobalChatModelCatalog {
  configured: boolean;
  recommendedModelId: string | null;
  totalModels: number;
  refreshedAt?: string | null;
  models: GlobalChatModel[];
}
