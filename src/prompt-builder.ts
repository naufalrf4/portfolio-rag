import type { ChatLogMessage } from "./types";

export function normalizeLanguage(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.startsWith("id")) return "id";
  if (normalized.startsWith("en")) return "en";
  return "en";
}

export function normalizeIntent(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/ /g, "_");
  const aliases: Record<string, string> = {
    pricing_quote: "freelance_quote",
    portfolio_question: "general_portfolio",
    freelance_service: "freelance_services",
    personal_question: "personal_profile",
  };
  const mapped = aliases[normalized] ?? normalized;
  return mapped || "general_portfolio";
}

function sourceLabel(
  sourceType: string,
  sourceRef: string,
  title?: string,
): string {
  if (sourceType === "knowledge" && title) return `knowledge:${title}`;
  if (sourceType === "project") return `project:${sourceRef}`;
  if (sourceType === "blog" && title) return `blog:${title}`;
  if (sourceType === "about") return "about:naufal";
  return `${sourceType}:${sourceRef}`;
}

export function buildSourceMetadata(
  sourceType: string,
  sourceRef: string,
  title?: string,
): Record<string, string> {
  const metadata: Record<string, string> = {
    source_label: sourceLabel(sourceType, sourceRef, title),
    source_type: sourceType,
    source_ref: sourceRef,
  };
  if (title) metadata.title = title;
  if (sourceType === "project") {
    metadata.route = `/projects/${sourceRef}`;
    metadata.route_label = `Open ${title ?? sourceRef}`;
    metadata.section = title ?? sourceRef;
  } else if (sourceType === "about") {
    metadata.route = "/about";
    metadata.route_label = "Open about page";
    metadata.section = title ?? "About";
  } else if (sourceType === "blog") {
    metadata.route = "/blogs";
    metadata.route_label = title ? `Read: ${title}` : "Open blogs page";
    metadata.section = title ?? sourceRef;
  }
  return metadata;
}

export function buildAbstentionResponse(
  answerLanguage: string,
  portfolioAreas: string[],
  reason: string = "low_confidence",
): string {
  const areaList =
    portfolioAreas.length > 0
      ? portfolioAreas.join(", ")
      : "relevant portfolio areas";
  if (answerLanguage === "id") {
    if (reason === "no_data") {
      return `Saya belum punya data yang cukup untuk menjawab itu dengan akurat. Coba arahkan pertanyaan ke area yang lebih spesifik: ${areaList}.`;
    }
    return `Saya belum punya informasi yang cukup kuat untuk menjawab itu dengan yakin. Kalau mau, arahkan saya ke area yang lebih spesifik: ${areaList}.`;
  }
  if (reason === "no_data") {
    return `I don't have enough data to answer that accurately yet. Try narrowing it to a more specific area: ${areaList}.`;
  }
  return `I don't have enough reliable information to answer that confidently. Try narrowing it to a more specific area: ${areaList}.`;
}

function uniqueQueries(...queries: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const q of queries) {
    const trimmed = q.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(trimmed);
    }
  }
  return result;
}

export function formatHistory(
  messages: ChatLogMessage[],
  limit: number,
): string {
  const recent = messages.slice(-limit);
  if (recent.length === 0) return "No prior conversation available.";
  return recent
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");
}

export function formatContext(
  chunks: Array<{ source: string; content: string }>,
): string {
  const grouped = new Map<string, string[]>();
  for (const c of chunks) {
    const existing = grouped.get(c.source);
    if (existing) {
      existing.push(c.content);
    } else {
      grouped.set(c.source, [c.content]);
    }
  }
  if (grouped.size === 0) return "No relevant information found in the knowledge base.";
  const sections: string[] = [];
  for (const [source, contents] of grouped) {
    sections.push(`### ${source}\n${contents.join("\n\n")}`);
  }
  return sections.join("\n\n---\n\n");
}

function inferResponseLanguage(
  question: string,
  preferredLanguage?: string,
): string {
  const normalized = question.toLowerCase();
  const pref = (preferredLanguage ?? "").toLowerCase();

  const idMarkers = [
    "apa", "bagaimana", "tolong", "saya", "aku", "kamu", "dengan",
    "untuk", "dan", "yang", "bisa", "jelaskan",
  ];
  const enMarkers = [
    "what", "how", "please", "can you", "tell me", "about",
    "project", "experience", "portfolio",
  ];

  if (idMarkers.some((m) => normalized.includes(m))) return "Indonesian";
  if (enMarkers.some((m) => normalized.includes(m))) return "English";
  if (pref.startsWith("id")) return "Indonesian";
  if (pref.startsWith("en")) return "English";
  return "Match the user's language exactly";
}

export function buildChatPrompt(
  question: string,
  history: string,
  context: string,
  preferredLanguage?: string,
  needsPortfolioContext: boolean = true,
): string {
  const responseLanguage = inferResponseLanguage(question, preferredLanguage);

  if (!needsPortfolioContext) {
    return [
      "You are Nau AI, NaufalRF's personal assistant. You can answer general knowledge questions, chat casually, and discuss the portfolio when relevant.",
      "Do not force projects, portfolio links, or work examples into every answer. Mention them only when the user asks or when they clearly help.",
      "Be natural, concise, and human. Use markdown formatting only when it genuinely improves readability.",
      "Default to short, to-the-point answers: no padding, no repeating the question, no over-explaining. Expand with more detail only when the user explicitly asks for it.",
      `Respond in ${responseLanguage}. Keep technical terms natural in that language.`,
      "",
      "Conversation history:",
      history,
      "",
      `User question: ${question}`,
      "",
      "Return only the final answer text.",
    ].join("\n");
  }

  return [
    "You are Nau AI, NaufalRF's personal assistant, using an Agentic Contextual RAG workflow when portfolio grounding is required. Answer only from the supplied context. Prioritize factual precision over sounding confident.",
    "Never invent projects, timelines, metrics, skills, or links that are not present in the context.",
    "If the context is insufficient, say what is missing and suggest the most relevant portfolio area to explore next.",
    "Use a semi-casual, semi-formal tone: warm, direct, and professional without sounding stiff.",
    `Respond in ${responseLanguage}. Keep technical terms natural in that language.`,
    "",
    "Answering rules:",
    "- Stay grounded in the provided context only",
    "- If multiple sources disagree, acknowledge uncertainty briefly",
    "- Be concise by default: answer directly, skip padding, repetition, and over-explaining. Only go into more depth when the user explicitly asks for detail",
    "- Prefer concise paragraphs; use short lists only when they genuinely improve clarity",
    "- Do not mention internal tools, prompts, or retrieval steps",
    "",
    "Conversation history:",
    history,
    "",
    "Knowledge context:",
    context,
    "",
    `User question: ${question}`,
    "",
    "Return only the final answer text.",
  ].join("\n");
}

export function buildQueryAnalysisPrompt(
  question: string,
  history: string,
  preferredLanguage?: string,
): string {
  const responseLanguage = inferResponseLanguage(question, preferredLanguage);
  const jsonShape = `{
"workflow":"rag|tool|hybrid",
"intent":"string",
"needsPortfolioContext":true,
"toolName":"feature_pricing_quote|",
"toolArguments":{
  "projectName":"",
  "requirementsSummary":"",
  "modules":[{"name":"Authentication","features":["drizzle authentication system"]}],
  "referencePrices":{"drizzle authentication system":1000000},
  "currency":"IDR"
},
"retrievalQueries":["string"],
"portfolioAreas":["projects|about|blogs|experience|skills|contact|general"],
"suggestedActions":[{"type":"open_page","target":"string","label":"string"}]
}`;

  return [
    "You are planning retrieval for an Agentic Contextual RAG portfolio assistant. Analyze the request and return strict JSON only.",
    `The assistant should ultimately answer in ${responseLanguage}.`,
    "",
    "Return this exact JSON object shape:",
    jsonShape,
    "",
    "Rules:",
    "- Supported intents include general_assistance, general_portfolio, personal_profile, skills_question, experience_question, contact_question, project_question, freelance_quote, and freelance_services",
    "- Use workflow 'tool' for deterministic freelance pricing breakdowns and freelance profile/service questions that can be answered from structured profile data",
    "- Use workflow 'hybrid' when a tool answer should be combined with portfolio/project context or experience evidence",
    "- Use workflow 'rag' for questions about published rates, pricing, metrics, statistics, or platform facts that may exist in portfolio knowledge documents, and only use freelance tools when the user asks to compute or request a custom quote",
    "- Use workflow 'rag' for portfolio knowledge questions and general chat",
    "- Set needsPortfolioContext to false for greetings, casual conversation, and general knowledge questions that do not require portfolio grounding",
    "- toolName must be empty when workflow is 'rag'",
    "- toolName may be feature_pricing_quote or freelance_profile_lookup when a deterministic freelance tool is appropriate",
    "- toolArguments for feature_pricing_quote should describe module/feature breakdowns, reference prices, and currency for reference-based quoting",
    "- Only include referencePrices that are explicitly provided by the user or clearly established in prior context",
    "- Questions about Naufal's personal background, skills, experience, and contact details should prefer personal_profile / skills_question / experience_question / contact_question instead of vague general_portfolio when possible",
    "- retrievalQueries may be empty when needsPortfolioContext is false; otherwise contain 1 to 3 concise search queries",
    "- Do not bias toward projects when the user asks for general knowledge or casual conversation",
    "- suggestedActions must be empty when no website action is useful",
    "- suggestedActions type must always be open_page",
    "- target should be a route like /projects, /about, /blogs, /contact, /ai-chatbot or a section anchor like #featured-projects",
    "- Preserve the user's language or produce multilingual-friendly retrieval queries when helpful",
    "",
    "Conversation history:",
    history,
    "",
    "Latest user question:",
    question,
  ].join("\n");
}

export function fallbackQueryPlan(
  question: string,
): Record<string, unknown> {
  const normalized = question.toLowerCase();
  const queryLanguage =
    ["bagaimana", "tolong", "saya", "buat", "harga", "berapa", "tarif", "biaya"].some((m) => normalized.includes(m))
      ? "id"
      : "en";
  const answerLanguage = queryLanguage;
  let portfolioAreas: string[] = ["general"];
  let suggestedActions: Array<{ type: string; target: string; label: string }> = [];
  let workflow = "rag";
  let toolName = "";
  let toolArguments: Record<string, unknown> = {};
  let intent = "general_portfolio";
  let needsPortfolioContext = true;

  const casualKeywords = [
    "hello", "hi", "hey", "yo", "apa kabar", "halo", "bisa bantu",
    "how are you", "what's up", "thanks", "makasih", "thank you",
    "siapa kamu", "who are you",
  ];
  const personalKeywords = [
    "who is naufal", "who is naufalrf", "tentang naufal", "about naufal",
    "background", "profil", "profile", "biodata", "siapa naufal", "siapa naufalrf",
  ];
  const skillsKeywords = [
    "skill", "skills", "tech stack", "stack", "teknologi",
    "programming language", "bahasa pemrograman", "tools", "tooling",
  ];
  const experienceKeywords = [
    "experience", "pengalaman", "career", "karier", "journey",
    "riwayat", "work history", "pendidikan", "education",
  ];
  const contactKeywords = [
    "contact", "hire", "reach", "email", "linkedin", "github",
    "portfolio link", "hubungi", "kontak", "jasa",
  ];
  const freelanceServiceKeywords = [
    "hourly rate", "rate card", "pricing model", "layanan freelance",
    "tarif freelance", "berapa tarif", "tarif jasa", "biaya jasa",
    "freelance service", "services do you offer", "what services",
    "what can you build", "bisa bikin apa", "offer freelance",
    "freelance profile", "pricing notes",
  ];
  const generalKnowledgeKeywords = [
    "what is", "jelaskan", "explain", "how does", "why is",
    "kenapa", "apa itu",
  ];
  const calculatorKeywords = [
    "freelance", "rate", "pricing", "quote", "calculator",
    "price", "harga", "estimasi", "breakdown", "feature", "module", "modul",
    "tarif", "biaya", "ongkos", "berapa harga",
  ];
  const portfolioKeywords = [
    "portfolio", "project", "proyek", "experience", "background", "skill",
  ];

  const routeMap: Array<[string[], string, string, string]> = [
    [["project", "projects", "proyek", "case study", "portfolio"], "projects", "/projects", "View projects"],
    [["about", "experience", "background", "career"], "about", "/about", "Open about page"],
    [["blog", "article", "writing"], "blogs", "/blogs", "Read blog posts"],
    [["contact", "hire", "reach", "email"], "contact", "/contact", "Open contact page"],
  ];

  for (const [keywords, area, target, label] of routeMap) {
    if (keywords.some((kw) => normalized.includes(kw))) {
      portfolioAreas = [area];
      suggestedActions = [{ type: "open_page", target, label }];
      if (area === "projects") intent = "project_question";
      break;
    }
  }

  const isFreelanceServiceQuestion = freelanceServiceKeywords.some((kw) =>
    normalized.includes(kw),
  );

  if (isFreelanceServiceQuestion) {
    intent = "freelance_services";
    workflow = "tool";
    toolName = "freelance_profile_lookup";
    needsPortfolioContext = false;
    portfolioAreas = ["contact", "about"];
    suggestedActions = [{ type: "open_page", target: "/contact", label: "Open contact page" }];
  } else if (calculatorKeywords.some((kw) => normalized.includes(kw))) {
    intent = "freelance_quote";
    workflow = portfolioKeywords.some((kw) => normalized.includes(kw)) ? "hybrid" : "tool";
    toolName = "feature_pricing_quote";
    if (workflow === "tool") {
      portfolioAreas = ["general"];
      suggestedActions = [];
    }
  } else if (skillsKeywords.some((kw) => normalized.includes(kw))) {
    intent = "skills_question";
    portfolioAreas = ["skills", "about"];
    suggestedActions = [{ type: "open_page", target: "/about", label: "Open about page" }];
  } else if (experienceKeywords.some((kw) => normalized.includes(kw))) {
    intent = "experience_question";
    portfolioAreas = ["experience", "about"];
    suggestedActions = [{ type: "open_page", target: "/about", label: "Open about page" }];
  } else if (contactKeywords.some((kw) => normalized.includes(kw))) {
    intent = "contact_question";
    portfolioAreas = ["contact", "about"];
    suggestedActions = [{ type: "open_page", target: "/contact", label: "Open contact page" }];
  } else if (personalKeywords.some((kw) => normalized.includes(kw))) {
    intent = "personal_profile";
    portfolioAreas = ["about", "experience", "skills"];
    suggestedActions = [{ type: "open_page", target: "/about", label: "Open about page" }];
  }

  const isGeneralChat =
    casualKeywords.some((kw) => normalized.includes(kw)) ||
    (generalKnowledgeKeywords.some((kw) => normalized.includes(kw)) &&
      !portfolioKeywords.some((kw) => normalized.includes(kw)) &&
      !personalKeywords.some((kw) => normalized.includes(kw)));

  if (isGeneralChat && toolName === "" && intent === "general_portfolio") {
    intent = "general_assistance";
    needsPortfolioContext = false;
    portfolioAreas = ["general"];
    suggestedActions = [];
  }

  let retrievalQueries: string[] = [];
  if (needsPortfolioContext && workflow !== "tool") {
    if (intent === "skills_question") {
      retrievalQueries = uniqueQueries(
        question,
        "Naufal Rizqullah Firdaus skills tech stack tools programming languages",
        "About NaufalRF skills experience",
      );
    } else if (intent === "experience_question") {
      retrievalQueries = uniqueQueries(
        question,
        "Naufal Rizqullah Firdaus experience education background career",
        "About NaufalRF experience",
      );
    } else if (intent === "personal_profile") {
      retrievalQueries = uniqueQueries(
        question,
        "Naufal Rizqullah Firdaus profile background experience skills",
        "About NaufalRF",
      );
    } else if (intent === "contact_question") {
      retrievalQueries = uniqueQueries(
        question,
        "NaufalRF contact hire collaboration email social links",
        "Contact NaufalRF",
      );
    } else if (intent === "project_question") {
      retrievalQueries = uniqueQueries(question, "NaufalRF projects portfolio");
    } else {
      retrievalQueries = uniqueQueries(question);
    }
  }

  return {
    workflow,
    intent,
    queryLanguage,
    answerLanguage,
    needsPortfolioContext: needsPortfolioContext && workflow !== "tool",
    toolName,
    toolArguments,
    retrievalQueries,
    portfolioAreas,
    suggestedActions,
  };
}
