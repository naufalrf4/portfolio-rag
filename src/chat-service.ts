import { logger } from "./lib/logger";
import * as adminClient from "./admin-client";
import { config } from "./config";
import { embedTexts, generateText } from "./embedding";
import { RagServiceError } from "./errors";
import {
  buildAbstentionResponse,
  buildChatPrompt,
  buildQueryAnalysisPrompt,
  fallbackQueryPlan,
  formatContext,
  formatHistory,
  normalizeIntent,
  normalizeLanguage,
} from "./prompt-builder";
import * as repository from "./repository";
import {
  stageAction,
  findActiveAction,
  updateStagedAction,
  type StagedAction,
} from "./staged-action-repository";
import { executeTool } from "./tool-service";
import type {
  BookingSlotOption,
  ChatLogMessage,
  ChatRequest,
  ChatResponse,
  Citation,
  PendingAction,
  QueryPlan,
  RetrievedChunk,
  StagedPendingAction,
  SuggestedAction,
} from "./types";
import {
  stageSubmitGuestbook,
  stageSendMessage,
  stageCreateBooking,
  fetchAvailableBookingSlots,
  isPlaceholderValue,
} from "./agentic-tools";

function stringOrNone(value: unknown): string | undefined {
  if (value == null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function resolveToolName(
  intent: string,
  workflow: string,
  toolName: string | null,
): string | null {
  if (toolName) return toolName;
  if (intent === "freelance_quote" && (workflow === "tool" || workflow === "hybrid")) {
    return "feature_pricing_quote";
  }
  if (intent === "freelance_services" && (workflow === "tool" || workflow === "hybrid")) {
    return "freelance_profile_lookup";
  }
  return null;
}

async function buildToolArguments(
  toolName: string | null,
  toolArguments: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (
    toolName !== "feature_pricing_quote" &&
    toolName !== "freelance_profile_lookup"
  ) {
    return { ...toolArguments };
  }

  const enriched = { ...toolArguments };
  const context = await adminClient.getFreelanceIntentContext();
  if (context.freelanceProfile !== null) {
    enriched.freelanceProfile = context.freelanceProfile;
  }
  return enriched;
}

function buildCitations(
  retrievedChunks: RetrievedChunk[],
): Citation[] {
  const citations: Citation[] = [];
  const seen = new Set<string>();
  for (const chunk of retrievedChunks) {
    const metadata = chunk.metadata as Record<string, unknown>;
    const route = stringOrNone(metadata.route);
    const key = `${chunk.source}::${route ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const citation: Citation = { source: chunk.source };
    const title = stringOrNone(metadata.title);
    if (title !== undefined) citation.title = title;
    if (route !== undefined) citation.route = route;
    const routeLabel = stringOrNone(metadata.route_label);
    if (routeLabel !== undefined) citation.routeLabel = routeLabel;
    const sourceType = stringOrNone(metadata.source_type);
    if (sourceType !== undefined) citation.sourceType = sourceType;
    const sourceRef = stringOrNone(metadata.source_ref);
    if (sourceRef !== undefined) citation.sourceRef = sourceRef;
    const section = stringOrNone(metadata.section);
    if (section !== undefined) citation.section = section;
    citations.push(citation);
  }
  return citations;
}

interface RankedSuggestedAction extends SuggestedAction {
  relevanceScore: number;
}

const MIN_ACTION_CHUNK_RELEVANCE = 0.3;
const FALLBACK_ACTION_RELEVANCE_SCORE = 0.3;
const TOOL_PROJECT_ACTION_RELEVANCE_SCORE = 0.5;
const MAX_SUGGESTED_ACTIONS = 2;
const TEXT_RELEVANCE_MENTION_BONUS = 0.15;
const TEXT_RELEVANCE_ABSENCE_PENALTY = 0.05;

function buildCitationActionCandidates(
  retrievedChunks: RetrievedChunk[],
): RankedSuggestedAction[] {
  const candidates = new Map<string, RankedSuggestedAction>();
  for (const chunk of retrievedChunks) {
    if (chunk.score < MIN_ACTION_CHUNK_RELEVANCE) continue;
    const metadata = chunk.metadata as Record<string, unknown>;
    const route = stringOrNone(metadata.route);
    if (!route) continue;
    const existing = candidates.get(route);
    if (existing && existing.relevanceScore >= chunk.score) continue;
    const title = stringOrNone(metadata.title);
    const routeLabel = stringOrNone(metadata.route_label);
    candidates.set(route, {
      type: "open_page",
      target: route,
      label: routeLabel ?? `Open ${title ?? chunk.source}`,
      relevanceScore: chunk.score,
    });
  }
  return [...candidates.values()];
}

function buildSuggestedActions(
  citationActionCandidates: RankedSuggestedAction[],
  fallbackActions: Array<{ type: string; target: string; label: string }>,
): RankedSuggestedAction[] {
  if (citationActionCandidates.length > 0) return citationActionCandidates;
  return fallbackActions.map((a) => ({
    type: "open_page",
    target: a.target,
    label: a.label,
    relevanceScore: FALLBACK_ACTION_RELEVANCE_SCORE,
  }));
}

function buildToolProjectActions(
  toolResult:
    | { metadata: Record<string, unknown> }
    | undefined,
  existingActions: SuggestedAction[],
): RankedSuggestedAction[] {
  if (!toolResult) return [];
  const refs = toolResult.metadata.referencedProjects;
  if (!Array.isArray(refs)) return [];
  const actions: RankedSuggestedAction[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") continue;
    const typed = ref as Record<string, unknown>;
    const slug = stringOrNone(typed.slug);
    const title = stringOrNone(typed.title);
    if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) continue;
    const target = `/projects/${slug}`;
    if (seen.has(target)) continue;
    if (existingActions.some((a) => a.target === target)) continue;
    seen.add(target);
    actions.push({
      type: "open_page",
      target,
      label: title ? `Open ${title}` : "Open referenced project",
      relevanceScore: TOOL_PROJECT_ACTION_RELEVANCE_SCORE,
    });
    if (actions.length >= 3) break;
  }
  return actions;
}

function normalizeMatchFragment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function answerMentionsAction(answerText: string, action: RankedSuggestedAction): boolean {
  const normalizedAnswer = normalizeMatchFragment(answerText);
  if (!normalizedAnswer) return false;
  const fragments = [action.label, ...action.target.split("/")]
    .map(normalizeMatchFragment)
    .filter((fragment) => fragment.length >= 3);
  return fragments.some((fragment) => normalizedAnswer.includes(fragment));
}

function rankSuggestedActions(
  candidates: RankedSuggestedAction[],
  answerText: string,
): SuggestedAction[] {
  const deduped = new Map<string, RankedSuggestedAction>();
  for (const candidate of candidates) {
    const mentioned = answerMentionsAction(answerText, candidate);
    const adjustedScore =
      candidate.relevanceScore +
      (mentioned ? TEXT_RELEVANCE_MENTION_BONUS : -TEXT_RELEVANCE_ABSENCE_PENALTY);
    const existing = deduped.get(candidate.target);
    if (existing && existing.relevanceScore >= adjustedScore) continue;
    deduped.set(candidate.target, { ...candidate, relevanceScore: adjustedScore });
  }
  return [...deduped.values()]
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, MAX_SUGGESTED_ACTIONS)
    .map(({ relevanceScore, ...action }) => action);
}

function minimumRetrievalConfidence(intent: string): number {
  if (
    [
      "skills_question",
      "experience_question",
      "personal_profile",
      "contact_question",
    ].includes(intent)
  ) {
    return 0.22;
  }
  if (intent === "general_portfolio") return 0.3;
  if (intent === "project_question") return 0.3;
  if (intent === "freelance_services") return 0.3;
  if (intent === "freelance_quote") return 0.3;
  return 0.45;
}

const ABOUT_FALLBACK_ACTION: SuggestedAction = {
  type: "open_page",
  target: "/about",
  label: "Open about page",
};

function buildAbstentionActions(
  portfolioAreas: string[],
): SuggestedAction[] {
  if (portfolioAreas.includes("contact")) {
    return [{ type: "open_page", target: "/contact", label: "Open contact page" }];
  }
  if (portfolioAreas.includes("projects")) {
    return [{ type: "open_page", target: "/projects", label: "View projects" }];
  }
  return [ABOUT_FALLBACK_ACTION];
}

function messageToPayload(msg: ChatLogMessage): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: msg.id ?? `legacy-${crypto.randomUUID()}`,
    role: msg.role,
    content: msg.content,
    timestamp: msg.timestamp,
  };
  if (msg.metadata) {
    payload.metadata = msg.metadata;
  }
  return payload;
}

const BOOKING_TRIGGER_REGEX = /\b(book|schedule|reserve|pesan|jadwalkan)\s+(a\s+)?(slot|booking|appointment|call|meeting|consultation|consult|chat)\b/i;

const AGENTIC_PATTERNS: Array<{
  regex: RegExp;
  handler: (msg: string) => PendingAction | null;
}> = [
  {
    regex: /\b(post|write|add|make)\s+(to\s+)?(the\s+)?guestbook\b|\bguestbook entry\b|\btulis\s+guestbook\b/i,
    handler: (msg) => {
      const match = msg.match(/[""]([^""]{1,500})[""]|'([^']{1,500})'/);
      const content = match ? (match[1] ?? match[2]) : msg.replace(/\b(post|write|add|make)\s+(to\s+)?(the\s+)?guestbook\b|\bguestbook entry\b|\btulis\s+guestbook\b/gi, '').trim();
      if (!content || content.length < 3) return null;
      const result = stageSubmitGuestbook(content).pendingAction;
      return result;
    },
  },
  {
    regex: /\b(send|kirim)\s+(an?\s+)?(anonymous\s+)?(message|pesan)\b/i,
    handler: (msg) => {
      const match = msg.match(/[""]([^""]{1,500})[""]|'([^']{1,500})'/);
      const content = match ? (match[1] ?? match[2]) : msg.replace(/\b(send|kirim)\s+(an?\s+)?(anonymous\s+)?(message|pesan)\b/gi, '').trim();
      if (!content || content.length < 3) return null;
      const result = stageSendMessage(content).pendingAction;
      return result;
    },
  },
  {
    regex: BOOKING_TRIGGER_REGEX,
    handler: () => {
      const result = stageCreateBooking("", "", "").pendingAction;
      return result;
    },
  },
];

function detectAgenticIntent(message: string): PendingAction | null {
  for (const pattern of AGENTIC_PATTERNS) {
    if (pattern.regex.test(message)) {
      return pattern.handler(message);
    }
  }
  return null;
}

const BOOKING_LOOKAHEAD_DAYS = 14;
const MAX_SLOT_OPTIONS = 20;

interface ExtractedBookingFields {
  slotId: string;
  email: string;
  phone: string | undefined;
  notes: string | undefined;
  name: string;
}

function extractEmailFromMessage(message: string): string {
  const match = message.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  return match ? match[0] : "";
}

function extractPhoneFromMessage(message: string): string | undefined {
  const match = message.match(/\+?\d[\d\-\s]{7,14}\d/);
  return match ? match[0].replace(/[\s-]+/g, "") : undefined;
}

function extractNotesFromMessage(message: string): string | undefined {
  const match = message.match(/(?:notes?|catatan)\s*:\s*(.{1,1000})/i);
  return match ? match[1]!.trim() : undefined;
}

function extractExplicitNameFromMessage(message: string): string {
  const match = message.match(
    /\b(?:my name is|name is|nama saya|saya bernama)\s+([a-zA-Z][a-zA-Z .'-]{1,79})/i,
  );
  return match ? match[1]!.trim() : "";
}

function extractSlotIdFromMessage(message: string, slotOptions: BookingSlotOption[]): string {
  const trimmed = message.trim();
  const direct = slotOptions.find((option) => option.slotId === trimmed);
  if (direct) return direct.slotId;
  const indexMatch = trimmed.match(/^(?:slot\s*#?|option\s*#?|#)?(\d{1,2})$/i);
  if (indexMatch) {
    const index = Number.parseInt(indexMatch[1]!, 10) - 1;
    if (index >= 0 && index < slotOptions.length) return slotOptions[index]!.slotId;
  }
  return "";
}

function extractBookingFieldsFromMessage(
  message: string,
  slotOptions: BookingSlotOption[],
): ExtractedBookingFields {
  const email = extractEmailFromMessage(message);
  const phone = extractPhoneFromMessage(message);
  const slotId = extractSlotIdFromMessage(message, slotOptions);
  const notes = extractNotesFromMessage(message);
  const explicitName = extractExplicitNameFromMessage(message);
  const hasOtherSignal = Boolean(email || phone || slotId || notes);
  const looksLikeBareName =
    !explicitName &&
    !hasOtherSignal &&
    !BOOKING_TRIGGER_REGEX.test(message) &&
    /^[a-zA-Z][a-zA-Z .'-]{1,79}$/.test(message.trim());
  const name = explicitName || (looksLikeBareName ? message.trim() : "");
  return { slotId, email, phone, notes, name };
}

async function handleBookingTurn(
  sessionId: string,
  message: string,
  existingDraft: StagedAction | null,
): Promise<ChatResponse> {
  const priorPayload = existingDraft?.payload ?? {};
  const priorSlotId = stringOrNone(priorPayload.slotId) ?? "";
  const priorName = stringOrNone(priorPayload.name) ?? "";
  const priorEmail = stringOrNone(priorPayload.email) ?? "";
  const priorNotes = stringOrNone(priorPayload.notes);
  const priorPhone = stringOrNone(priorPayload.phone);

  const slotStillUnresolved = !priorSlotId || isPlaceholderValue(priorSlotId);
  const slotOptions = slotStillUnresolved
    ? await fetchAvailableBookingSlots(config.adminApiUrl, BOOKING_LOOKAHEAD_DAYS)
    : [];

  const extracted = extractBookingFieldsFromMessage(message, slotOptions);

  const slotId = extracted.slotId || priorSlotId;
  const name = extracted.name || priorName;
  const email = extracted.email || priorEmail;
  const notes = extracted.notes ?? priorNotes;
  const phone = extracted.phone ?? priorPhone;

  const staged = stageCreateBooking(slotId, name, email, notes, phone);
  const pendingAction = staged.pendingAction;

  const actionId = existingDraft
    ? ((await updateStagedAction(existingDraft.id, sessionId, pendingAction)) ??
      (await stageAction(sessionId, pendingAction)))
    : await stageAction(sessionId, pendingAction);

  const stagedPendingAction: StagedPendingAction = {
    actionId,
    tool: "create_booking",
    description: pendingAction.description,
    missingFields: pendingAction.missingFields,
  };
  if (pendingAction.missingFields.includes("slotId")) {
    stagedPendingAction.slotOptions = slotOptions.slice(0, MAX_SLOT_OPTIONS);
  }

  return {
    sessionId,
    message: staged.message,
    sources: [],
    citations: [],
    suggestedActions: [],
    metadata: {
      workflow: "agentic",
      intent: "create_booking",
      queryLanguage: "en",
      answerLanguage: "en",
      retrievalConfidence: 0,
      abstained: false,
    },
    pendingAction: stagedPendingAction,
  };
}

export async function chat(
  request: ChatRequest,
  preferredLanguage?: string,
): Promise<ChatResponse> {
  const startedAt = performance.now();
  const sessionId = request.sessionId ?? crypto.randomUUID();

  const activeBookingDraft = await findActiveAction(sessionId, "create_booking");
  if (activeBookingDraft !== null) {
    return handleBookingTurn(sessionId, request.message, activeBookingDraft);
  }

  const detected = detectAgenticIntent(request.message);
  if (detected !== null) {
    if (detected.tool === "create_booking") {
      return handleBookingTurn(sessionId, request.message, null);
    }

    const response: ChatResponse = {
      sessionId,
      message: detected.missingFields.length > 0
        ? `I can help with that, but I need more information: ${detected.missingFields.join(', ')}`
        : `Ready to proceed: ${detected.description}. Would you like me to confirm?`,
      sources: [],
      citations: [],
      suggestedActions: [],
      metadata: {
        workflow: "agentic",
        intent: detected.tool,
        queryLanguage: "en",
        answerLanguage: "en",
        retrievalConfidence: 0,
        abstained: false,
      },
    };

    if (detected.missingFields.length === 0) {
      const actionId = await stageAction(sessionId, detected);
      response.pendingAction = {
        actionId,
        tool: detected.tool,
        description: detected.description,
        missingFields: [],
      };
    }

    return response;
  }

  let history: ChatLogMessage[] = [];
  try {
    history = await adminClient.getChatLog(sessionId);
  } catch {
    logger.warn("Failed to load chat history from admin API");
  }

  const historyText = formatHistory(history, config.chatHistoryLimit);

  let queryPlan: QueryPlan;
  try {
    const prompt = buildQueryAnalysisPrompt(request.message, historyText, preferredLanguage);
    const generated = await generateText(prompt, config.chatModel, 0.1);
    const payload = JSON.parse(generated.text) as Record<string, unknown>;

    const retrievalQueries = (
      Array.isArray(payload.retrievalQueries)
        ? (payload.retrievalQueries as string[]).filter((s) => typeof s === "string")
        : []
    ).slice(0, 3);
    const portfolioAreas = (
      Array.isArray(payload.portfolioAreas)
        ? (payload.portfolioAreas as string[]).filter((s) => typeof s === "string")
        : ["general"]
    );
    const suggestedActions: Array<{ type: string; target: string; label: string }> = [];
    if (Array.isArray(payload.suggestedActions)) {
      for (const a of payload.suggestedActions as Array<Record<string, string>>) {
        const t = a.type;
        const tg = a.target;
        const l = a.label;
        if (t === "open_page" && tg && l) {
          suggestedActions.push({ type: t, target: tg, label: l });
        }
      }
    }

    let workflow = String(payload.workflow ?? "rag").trim().toLowerCase();
    if (!["rag", "tool", "hybrid"].includes(workflow)) {
      const fb = fallbackQueryPlan(request.message);
      workflow = String(fb.workflow);
    }

    let toolName: string | null =
      payload.toolName != null ? String(payload.toolName).trim() || null : null;
    let toolArguments: Record<string, unknown> =
      payload.toolArguments != null && typeof payload.toolArguments === "object"
        ? (payload.toolArguments as Record<string, unknown>)
        : {};
    if (Object.keys(toolArguments).length === 0) {
      const fb = fallbackQueryPlan(request.message);
      toolArguments = (fb.toolArguments as Record<string, unknown>) ?? {};
    }

    queryPlan = {
      workflow,
      intent: normalizeIntent(String(payload.intent ?? "general_portfolio")),
      queryLanguage: normalizeLanguage(String(payload.queryLanguage ?? "en")),
      answerLanguage: normalizeLanguage(String(payload.answerLanguage ?? "en")),
      needsPortfolioContext: Boolean(payload.needsPortfolioContext ?? true),
      toolName,
      toolArguments,
      retrievalQueries,
      portfolioAreas,
      suggestedActions,
      promptTokens: generated.promptTokens,
      completionTokens: generated.completionTokens,
    };
  } catch {
    const fb = fallbackQueryPlan(request.message);
    queryPlan = {
      workflow: String(fb.workflow),
      intent: normalizeIntent(String(fb.intent)),
      queryLanguage: normalizeLanguage(String(fb.queryLanguage)),
      answerLanguage: normalizeLanguage(String(fb.answerLanguage)),
      needsPortfolioContext: Boolean(fb.needsPortfolioContext),
      toolName: (fb.toolName as string) || null,
      toolArguments: (fb.toolArguments as Record<string, unknown>) ?? {},
      retrievalQueries: (fb.retrievalQueries as string[]) ?? [],
      portfolioAreas: (fb.portfolioAreas as string[]) ?? ["general"],
      suggestedActions: (fb.suggestedActions as Array<{
        type: string;
        target: string;
        label: string;
      }>) ?? [],
      promptTokens: 0,
      completionTokens: 0,
    };
  }

  const resolvedToolName = resolveToolName(
    queryPlan.intent,
    queryPlan.workflow,
    queryPlan.toolName,
  );
  const enrichedToolArgs = await buildToolArguments(resolvedToolName, queryPlan.toolArguments);

  let toolResult:
    | {
        toolName: string;
        text: string;
        context: string;
        metadata: Record<string, unknown>;
      }
    | undefined;
  if (
    (queryPlan.workflow === "tool" || queryPlan.workflow === "hybrid") &&
    resolvedToolName
  ) {
    toolResult = executeTool(
      resolvedToolName,
      enrichedToolArgs,
      request.message,
      queryPlan.answerLanguage,
    );
  }

  if (toolResult?.metadata?.status === "unavailable") {
    toolResult = undefined;
    if (queryPlan.workflow === "tool") queryPlan.workflow = "hybrid";
    queryPlan.needsPortfolioContext = true;
  }

  let retrievedChunks: RetrievedChunk[] = [];
  if (queryPlan.workflow !== "tool" && queryPlan.needsPortfolioContext) {
    const retrievalQueries = queryPlan.retrievalQueries.slice(0, 2);
    if (!retrievalQueries.includes(request.message)) {
      retrievalQueries.push(request.message);
    }
    let queryEmbeddings: Array<number[] | undefined>;
    try {
      queryEmbeddings = await embedTexts(retrievalQueries);
    } catch (err) {
      if (err instanceof RagServiceError) throw err;
      throw new RagServiceError(
        "The embedding provider is currently unavailable.",
        "RAG_EMBEDDING_UNAVAILABLE",
        503,
      );
    }
    const seenChunks = new Set<string>();
    const searchResults = await Promise.all(
      queryEmbeddings.map((queryEmbedding, index) =>
        queryEmbedding
          ? repository.searchChunksHybrid(
              queryEmbedding,
              retrievalQueries[index]!,
              config.retrievalLimit,
              ["public"],
            )
          : Promise.resolve([]),
      ),
    );
    for (const results of searchResults) {
      for (const chunk of results) {
        const fingerprint = `${chunk.source}::${chunk.content}`;
        if (seenChunks.has(fingerprint)) continue;
        seenChunks.add(fingerprint);
        retrievedChunks.push(chunk);
      }
    }
  }

  retrievedChunks = retrievedChunks.slice(0, config.retrievalLimit);
  const sources = [...new Set(retrievedChunks.map((c) => c.source))];
  const citations = buildCitations(retrievedChunks);
  const citationActionCandidates = buildCitationActionCandidates(retrievedChunks);
  const primaryActionCandidates = buildSuggestedActions(
    citationActionCandidates,
    queryPlan.suggestedActions,
  );
  const toolProjectActionCandidates = buildToolProjectActions(
    toolResult,
    primaryActionCandidates,
  );
  const suggestedActionCandidates = [
    ...primaryActionCandidates,
    ...toolProjectActionCandidates,
  ];
  let finalSuggestedActions: SuggestedAction[] = [];
  const retrievalConfidence = retrievedChunks.reduce(
    (max, c) => Math.max(max, c.score),
    0,
  );

  let finalText: string;
  let tokens = {
    analysisPrompt: queryPlan.promptTokens,
    analysisCompletion: queryPlan.completionTokens,
    prompt: 0,
    completion: 0,
  };
  let abstained = false;

  const minimumConf = minimumRetrievalConfidence(queryPlan.intent);

  if (
    toolResult !== undefined &&
    (queryPlan.workflow === "tool" ||
      (queryPlan.workflow === "hybrid" && retrievedChunks.length === 0))
  ) {
    finalText = toolResult.text;
  } else if (
    queryPlan.needsPortfolioContext &&
    retrievalConfidence < minimumConf
  ) {
    abstained = true;
    finalText = buildAbstentionResponse(
      queryPlan.answerLanguage,
      queryPlan.portfolioAreas,
      retrievedChunks.length === 0 ? "no_data" : "low_confidence",
    );
    finalSuggestedActions = buildAbstentionActions(queryPlan.portfolioAreas);
  } else {
    const contextSections: Array<{ source: string; content: string }> = [];
    if (toolResult) {
      contextSections.push({
        source: `tool:${toolResult.toolName}`,
        content: toolResult.context,
      });
    }
    for (const chunk of retrievedChunks) {
      contextSections.push({
        source: chunk.source,
        content: chunk.content,
      });
    }
    const context = formatContext(contextSections);
    const prompt = buildChatPrompt(
      request.message,
      historyText,
      context,
      preferredLanguage,
      queryPlan.needsPortfolioContext,
    );
    const generated = await generateText(prompt, config.chatModel, 0.2);
    finalText = generated.text;
    tokens = {
      analysisPrompt: queryPlan.promptTokens,
      analysisCompletion: queryPlan.completionTokens,
      prompt: generated.promptTokens,
      completion: generated.completionTokens,
    };
  }

  if (!abstained) {
    finalSuggestedActions = rankSuggestedActions(suggestedActionCandidates, finalText);
  }

  const durationMs = Math.round(performance.now() - startedAt);
  const turnEpochMs = Date.now();
  const now = new Date(turnEpochMs).toISOString();
  const newMessages: Array<Record<string, unknown>> = [
    {
      id: `${sessionId}-user-${turnEpochMs}`,
      role: "user",
      content: request.message,
      timestamp: now,
    },
    {
      id: `${sessionId}-assistant-${turnEpochMs}`,
      role: "assistant",
      content: finalText,
      timestamp: now,
      metadata: {
        model: config.chatModel,
        provider: "google",
        tokens: tokens.prompt + tokens.completion,
        duration: durationMs,
      },
    },
  ];

  const persistedMessages = history.map(messageToPayload);
  persistedMessages.push(...newMessages);
  try {
    await adminClient.saveChatLog(sessionId, persistedMessages, "append");
  } catch {
    logger.warn("Failed to persist chat log to admin API");
  }

  return {
    sessionId,
    message: finalText,
    sources,
    citations,
    suggestedActions: finalSuggestedActions,
    metadata: {
      workflow: queryPlan.workflow,
      intent: queryPlan.intent,
      queryLanguage: queryPlan.queryLanguage,
      answerLanguage: queryPlan.answerLanguage,
      retrievalConfidence,
      abstained,
    },

  };
}
