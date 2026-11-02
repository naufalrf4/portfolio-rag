interface ChatRequest {
  sessionId?: string;
  message: string;
}

interface Citation {
  source: string;
  title?: string;
  route?: string;
  routeLabel?: string;
  sourceType?: string;
  sourceRef?: string;
  section?: string;
}

type SuggestedActionType = "open_page";

interface SuggestedAction {
  type: SuggestedActionType;
  target: string;
  label: string;
}

interface ChatMetadata {
  workflow: string;
  intent: string;
  queryLanguage: string;
  answerLanguage: string;
  retrievalConfidence: number;
  abstained: boolean;
}

interface PendingAction {
  tool: string;
  payload: Record<string, unknown>;
  description: string;
  missingFields: string[];
}

interface BookingSlotOption {
  slotId: string;
  label: string;
  dateTimeIso: string;
}

interface StagedPendingAction {
  actionId: string;
  tool: string;
  description: string;
  missingFields: string[];
  slotOptions?: BookingSlotOption[];
}

interface ChatResponse {
  sessionId: string;
  message: string;
  sources: string[];
  citations: Citation[];
  suggestedActions: SuggestedAction[];
  metadata: ChatMetadata;
  pendingAction?: StagedPendingAction;
}

interface ConfirmRequest {
  sessionId: string;
  actionId: string;
  confirm: boolean;
}

interface ConfirmResponse {
  success: boolean;
  message: string;
}

interface IngestRequest {
  type: "knowledge" | "project" | "about" | "blog" | "all",
  documentId?: string;
}

interface IngestResponse {
  success: boolean;
  chunksIngested: number;
  source: string;
}

interface RetrievedChunk {
  source: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
  denseScore: number;
  lexicalScore: number;
  matchReasons: string[];
}

interface ChunkWritePayload {
  chunkIndex: number;
  content: string;
  tokenCount: number;
  checksum: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  visibility: string;
  sourceType: string;
  sourceRef: string;
}

interface QueryPlan {
  workflow: string;
  intent: string;
  queryLanguage: string;
  answerLanguage: string;
  needsPortfolioContext: boolean;
  toolName: string | null;
  toolArguments: Record<string, unknown>;
  retrievalQueries: string[];
  portfolioAreas: string[];
  suggestedActions: Array<{ type: string; target: string; label: string }>;
  promptTokens: number;
  completionTokens: number;
}

interface FreelanceProfile {
  hourlyRate: number | null;
  currency: string;
  completedProjects: number | null;
  pricingNotes: string;
  featurePricing: Array<{
    feature: string;
    price: number | null;
    notes: string;
    relatedProjectSlugs: string[];
  }>;
  projectReferences: Array<{ slug: string; title: string; notes: string }>;
}

interface ChatLogMessage {
  id: string | null;
  role: string;
  content: string;
  timestamp: string;
  metadata?: {
    model?: string;
    provider?: string;
    tokens?: number;
    duration?: number;
  } | null;
}

interface ContentExport {
  aboutMe: {
    bio: string;
    skills: Array<string | { name: string; level: number; category: string }>;
    experience: Array<{
      type: string;
      title: string;
      organization: string;
      startDate: string;
      endDate: string | null;
      location: string | null;
      description: string | null;
      logoUrl: string | null;
    }>;
    freelanceProfile?: FreelanceProfile;
  };
  projects: Array<{
    title: string;
    slug: string;
    summary: string;
    description: string;
    content: string;
    techStack: string[];
    contexts?: Array<{ title: string; content: string }>;
  }>;
  knowledgeDocs: Array<{ id: string; filename: string; content: string; indexed: boolean }>;
  blogs: Array<{
    id: string;
    url: string;
    title: string;
    description: string | null;
    category: string | null;
    tags: string[];
    publishedAt: string;
    visible: boolean;
  }>;
}

export type {
  ChatRequest,
  Citation,
  SuggestedAction,
  SuggestedActionType,
  ChatMetadata,
  PendingAction,
  ChatResponse,
  StagedPendingAction,
  BookingSlotOption,
  ConfirmRequest,
  ConfirmResponse,
  IngestRequest,
  IngestResponse,
  RetrievedChunk,
  ChunkWritePayload,
  QueryPlan,
  FreelanceProfile,
  ChatLogMessage,
  ContentExport,
};
