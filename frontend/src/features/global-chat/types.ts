export interface GlobalChatSuggestion {
  id: string;
  label: string;
  prompt: string;
  capabilityHint: string | null;
}
export interface GlobalChatPresentation {
  message: string;
  resultRefs: string[];
  suggestions: GlobalChatSuggestion[];
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
