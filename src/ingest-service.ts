import * as adminClient from "./admin-client";
import { config } from "./config";
import { embedTexts } from "./embedding";
import { RagServiceError } from "./errors";
import { buildSourceMetadata } from "./prompt-builder";
import * as repository from "./repository";
import type {
  ChunkWritePayload,
  ContentExport,
  IngestRequest,
  IngestResponse,
} from "./types";

function chunkText(
  text: string,
  targetTokens: number,
  overlapTokens: number,
): Array<{ content: string; chunkIndex: number; tokenCount: number }> {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return [];

  const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

  const rawChunks: string[] = [];
  let currentParts: string[] = [];

  for (const paragraph of paragraphs) {
    const candidate =
      currentParts.length > 0
        ? currentParts.concat(paragraph).join("\n\n")
        : paragraph;
    if (estimateTokens(candidate) <= targetTokens) {
      currentParts.push(paragraph);
      continue;
    }

    if (currentParts.length > 0) {
      rawChunks.push(currentParts.join("\n\n"));
      currentParts = [];
    }

    if (estimateTokens(paragraph) <= targetTokens) {
      currentParts = [paragraph];
      continue;
    }

    for (let pos = 0; pos < paragraph.length; ) {
      const slice = paragraph.slice(pos, pos + targetTokens * 4);
      rawChunks.push(slice.trim());
      const step = Math.max(targetTokens * 4 - overlapTokens * 4, targetTokens);
      pos += step;
    }
  }

  if (currentParts.length > 0) {
    rawChunks.push(currentParts.join("\n\n"));
  }

  const chunks: Array<{
    content: string;
    chunkIndex: number;
    tokenCount: number;
  }> = [];
  let previousTail = "";

  for (let idx = 0; idx < rawChunks.length; idx++) {
    const raw = rawChunks[idx]!;
    const content = previousTail
      ? `${previousTail}\n\n${raw}`.trim()
      : raw;
    const tokenCount = estimateTokens(content);
    chunks.push({ content, chunkIndex: idx, tokenCount });

    const tailStart = Math.max(0, raw.length - overlapTokens * 4);
    previousTail = raw.slice(tailStart).trim();
  }

  return chunks;
}

async function ingestTextDocument(params: {
  sourceType: string;
  sourceRef: string;
  title: string;
  text: string;
  visibility: string;
  sensitivity: string;
  mimeType: string;
  storageKey: string | null;
  tags: string[];
  extraMetadata: Record<string, unknown>;
}): Promise<{ chunksWritten: number; source: string }> {
  const {
    sourceType,
    sourceRef,
    title,
    text,
    visibility,
    sensitivity,
    mimeType,
    storageKey,
    tags,
    extraMetadata,
  } = params;

  if (!text.trim()) {
    throw new RagServiceError(
      `No content available for ${sourceType}:${sourceRef}.`,
      "INGEST_NO_CONTENT",
      400,
    );
  }

  const source = `${sourceType}:${sourceRef}${title ? ` (${title})` : ""}`;
  const rawChunks = chunkText(
    text,
    config.chunkTargetTokens,
    config.chunkOverlapTokens,
  );

  const contents = rawChunks.map((c) => c.content);
  const embeddings = await embedTexts(contents);

  const contentHash = await crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((hash) =>
      Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    );
  const excerpt = text.slice(0, 500).trim();

  const document = await repository.upsertDocument({
    sourceType,
    sourceRef,
    title,
    visibility,
    sensitivity,
    storageKey,
    mimeType,
    tags,
    metadata: {
      ...buildSourceMetadata(sourceType, sourceRef, title),
      ...extraMetadata,
    },
    contentHash,
    contentExcerpt: excerpt,
  });

  const chunkRows: ChunkWritePayload[] = [];
  for (let i = 0; i < rawChunks.length; i++) {
    const rawChunk = rawChunks[i]!;
    const embedding = embeddings[i]!;
    const checksum = await crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(rawChunk.content))
      .then((hash) =>
        Array.from(new Uint8Array(hash))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(""),
      );
    chunkRows.push({
      chunkIndex: rawChunk.chunkIndex,
      content: rawChunk.content,
      tokenCount: rawChunk.tokenCount,
      checksum,
      embedding,
      metadata: {
        ...buildSourceMetadata(sourceType, sourceRef, title),
        ...extraMetadata,
      },
      visibility,
      sourceType,
      sourceRef,
    });
  }

  await repository.replaceChunks(document.id, chunkRows);

  return { chunksWritten: chunkRows.length, source };
}

async function ingestKnowledgeDoc(
  doc: { id: string; filename: string; content: string; indexed: boolean },
  runId: string,
): Promise<{ chunksWritten: number; source: string }> {
  const result = await ingestTextDocument({
    sourceType: "knowledge",
    sourceRef: doc.id,
    title: doc.filename,
    text: doc.content,
    visibility: "public",
    sensitivity: "normal",
    mimeType: "text/plain",
    storageKey: null,
    tags: ["knowledge"],
    extraMetadata: { origin: "knowledge-doc", run_id: runId },
  });
  await adminClient.markKnowledgeDocIndexed(doc.id);
  return result;
}

async function ingestProject(
  project: {
    title: string;
    slug: string;
    summary: string;
    description: string;
    content: string;
    techStack: string[];
    contexts?: Array<{ title: string; content: string }>;
  },
  runId: string,
): Promise<{ chunksWritten: number; source: string }> {
  const sections: string[] = [
    `# ${project.title}`,
    project.summary ? `## Summary\n${project.summary.trim()}` : "",
    project.description
      ? `## Description\n${project.description.trim()}`
      : "",
    project.techStack.length > 0
      ? `## Technologies\n${project.techStack.join(", ")}`
      : "",
    project.content.trim().startsWith("#")
      ? project.content.trim()
      : `## Project Details\n${project.content.trim()}`,
  ];

  if (!project.content.trim()) {
    for (const ctx of project.contexts ?? []) {
      sections.push(`## ${ctx.title}\n${ctx.content.trim()}`);
    }
  }

  return ingestTextDocument({
    sourceType: "project",
    sourceRef: project.slug,
    title: project.title,
    text: sections.filter(Boolean).join("\n\n"),
    visibility: "public",
    sensitivity: "normal",
    mimeType: "text/markdown",
    storageKey: null,
    tags: ["project"],
    extraMetadata: { origin: "project-export", run_id: runId },
  });
}

async function ingestAbout(
  export_: ContentExport,
  runId: string,
): Promise<{ chunksWritten: number; source: string }> {
  const about = export_.aboutMe;
  const experienceLines = about.experience.map((item) => {
    const period = `${item.startDate} - ${item.endDate ?? "Present"}`;
    const location = item.location ? ` (${item.location})` : "";
    const summary = `${item.type}: ${item.title} at ${item.organization} - ${period}${location}`;
    return item.description ? `${summary}. ${item.description.trim()}` : summary;
  });
  const skillNames = about.skills.map((s) =>
    typeof s === "string" ? s.trim() : s.name.trim(),
  );

  const sections: string[] = [
    "# About NaufalRF",
    about.bio ? `## Bio\n${about.bio.trim()}` : "",
    skillNames.length > 0 ? `## Skills\n${skillNames.join(", ")}` : "",
    experienceLines.length > 0
      ? `## Experience\n${experienceLines.map((l) => `- ${l}`).join("\n")}`
      : "",
  ];

  return ingestTextDocument({
    sourceType: "about",
    sourceRef: "naufal",
    title: "About NaufalRF",
    text: sections.filter(Boolean).join("\n\n"),
    visibility: "public",
    sensitivity: "normal",
    mimeType: "text/markdown",
    storageKey: null,
    tags: ["about"],
    extraMetadata: { origin: "about-export", run_id: runId },
  });
}

async function ingestBlog(
  blog: {
    id: string;
    url: string;
    title: string;
    description: string | null;
    category: string | null;
    tags: string[];
    publishedAt: string;
    visible: boolean;
  },
  runId: string,
): Promise<{ chunksWritten: number; source: string }> {
  const sections: string[] = [
    `# ${blog.title}`,
    blog.category ? `Category: ${blog.category}` : "",
    blog.tags.length > 0 ? `Tags: ${blog.tags.join(", ")}` : "",
    blog.description ? `## Description
${blog.description.trim()}` : "",
    `Published: ${blog.publishedAt}`,
    `Read more: ${blog.url}`,
  ];

  return ingestTextDocument({
    sourceType: "blog",
    sourceRef: blog.id,
    title: blog.title,
    text: sections.filter(Boolean).join("\n\n"),
    visibility: "public",
    sensitivity: "normal",
    mimeType: "text/markdown",
    storageKey: null,
    tags: ["blog"],
    extraMetadata: {
      origin: "blog-export",
      run_id: runId,
      url: blog.url,
      route: blog.url,
      route_label: `Read: ${blog.title}`,
    },
  });
}

export async function ingest(request: IngestRequest): Promise<IngestResponse> {
  const run = await repository.createIngestionRun(request.type, request as unknown as Record<string, unknown>);
  const runId = run.id;

  try {
    if (request.type === "knowledge") {
      if (!request.documentId) {
        throw new RagServiceError(
          "documentId is required for knowledge ingestion.",
          "INGEST_REQUEST_INVALID",
          400,
        );
      }
      const doc = await adminClient.getKnowledgeDocById(request.documentId);
      const result = await ingestKnowledgeDoc(doc, runId);
      await repository.updateIngestionRun(runId, {
        status: "completed",
        chunksWritten: result.chunksWritten,
      });
      return { success: true, chunksIngested: result.chunksWritten, source: result.source };
    }

    if (request.type === "project") {
      if (!request.documentId) {
        throw new RagServiceError(
          "documentId is required for project ingestion.",
          "INGEST_REQUEST_INVALID",
          400,
        );
      }
      const export_ = await adminClient.getContentExport();
      const project = export_.projects.find((p) => p.slug === request.documentId);
      if (!project) {
        throw new RagServiceError(
          `Project not found for slug ${request.documentId}.`,
          "INGEST_REQUEST_INVALID",
          400,
        );
      }
      const result = await ingestProject(project, runId);
      await repository.updateIngestionRun(runId, {
        status: "completed",
        chunksWritten: result.chunksWritten,
      });
      return { success: true, chunksIngested: result.chunksWritten, source: result.source };
    }

    if (request.type === "about") {
      const export_ = await adminClient.getContentExport();
      const result = await ingestAbout(export_, runId);
      await repository.updateIngestionRun(runId, {
        status: "completed",
        chunksWritten: result.chunksWritten,
      });
      return { success: true, chunksIngested: result.chunksWritten, source: result.source };
    }

    if (request.type === "blog") {
      if (!request.documentId) {
        throw new RagServiceError(
          "documentId is required for blog ingestion.",
          "INGEST_REQUEST_INVALID",
          400,
        );
      }
      const export_ = await adminClient.getContentExport();
      const blog = export_.blogs.find((b) => b.id === request.documentId);
      if (!blog) {
        throw new RagServiceError(
          `Blog link not found for id ${request.documentId}.`,
          "INGEST_REQUEST_INVALID",
          400,
        );
      }
      const result = await ingestBlog(blog, runId);
      await repository.updateIngestionRun(runId, {
        status: "completed",
        chunksWritten: result.chunksWritten,
      });
      return { success: true, chunksIngested: result.chunksWritten, source: result.source };
    }

    let totalChunks = 0;
    const export_ = await adminClient.getContentExport();
    const errors: string[] = [];

    try {
      const aboutResult = await ingestAbout(export_, runId);
      totalChunks += aboutResult.chunksWritten;
    } catch (err) {
      errors.push(`about:${err}`);
    }

    for (const project of export_.projects) {
      try {
        const projectResult = await ingestProject(project, runId);
        totalChunks += projectResult.chunksWritten;
      } catch (err) {
        errors.push(`project:${project.slug}:${err}`);
      }
    }

    for (const doc of export_.knowledgeDocs) {
      try {
        const knowledgeResult = await ingestKnowledgeDoc(doc, runId);
        totalChunks += knowledgeResult.chunksWritten;
      } catch (err) {
        errors.push(`knowledge:${doc.id}:${err}`);
      }
    }

    for (const blog of export_.blogs) {
      try {
        const blogResult = await ingestBlog(blog, runId);
        totalChunks += blogResult.chunksWritten;
      } catch (err) {
        errors.push(`blog:${blog.id}:${err}`);
      }
    }

    const status = errors.length > 0 ? "partial" : "completed";
    await repository.updateIngestionRun(runId, {
      status,
      chunksWritten: totalChunks,
      errorMessage: errors.length > 0 ? errors.join("; ") : null,
    });
    return { success: true, chunksIngested: totalChunks, source: "all" };
  } catch (err) {
    await repository.updateIngestionRun(runId, {
      status: "failed",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
