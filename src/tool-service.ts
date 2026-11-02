import { normalizeLanguage } from "./prompt-builder";
import type { FreelanceProfile } from "./types";

interface ToolExecutionResult {
  toolName: string;
  text: string;
  context: string;
  metadata: Record<string, unknown>;
}

function asFloat(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace(/,/g, ""));
    return Number.isNaN(parsed) ? fallback : parsed;
  }
  return fallback;
}

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatCurrency(amount: number, currency: string): string {
  const rounded = Math.round(amount);
  if (currency.toUpperCase() === "IDR") {
    return `Rp${rounded.toLocaleString("id-ID")}`;
  }
  return `${currency.toUpperCase()} ${rounded.toLocaleString()}`;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
}

function asReferencePrices(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const prices: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = normalizeKey(k);
    if (!key) continue;
    const price = asFloat(v, -1);
    if (price >= 0) prices[key] = price;
  }
  return prices;
}

function asFreelanceProfile(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const typed = value as Record<string, unknown>;

  const featurePricing: Array<Record<string, unknown>> = [];
  const fpRaw = typed.featurePricing;
  if (Array.isArray(fpRaw)) {
    for (const item of fpRaw) {
      if (!item || typeof item !== "object") continue;
      const ti = item as Record<string, unknown>;
      const feature = asString(ti.feature);
      if (!feature) continue;
      featurePricing.push({
        feature,
        price: asFloat(ti.price, -1),
        notes: asString(ti.notes),
        relatedProjectSlugs: asStringList(ti.relatedProjectSlugs),
      });
    }
  }

  const projectReferences: Array<Record<string, string>> = [];
  const prRaw = typed.projectReferences;
  if (Array.isArray(prRaw)) {
    for (const item of prRaw) {
      if (!item || typeof item !== "object") continue;
      const ti = item as Record<string, unknown>;
      const slug = asString(ti.slug);
      const title = asString(ti.title);
      if (!slug || !title) continue;
      projectReferences.push({ slug, title, notes: asString(ti.notes) });
    }
  }

  return {
    hourlyRate: asFloat(typed.hourlyRate, -1),
    currency: asString(typed.currency) || "IDR",
    completedProjects: Math.round(asFloat(typed.completedProjects, -1)),
    pricingNotes: asString(typed.pricingNotes),
    featurePricing,
    projectReferences,
  };
}

function referenceCatalogFromProfile(
  profile: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const catalog: Record<string, Record<string, unknown>> = {};
  const fpRaw = profile.featurePricing;
  if (!Array.isArray(fpRaw)) return catalog;
  for (const item of fpRaw) {
    if (!item || typeof item !== "object") continue;
    const ti = item as Record<string, unknown>;
    const feature = normalizeKey(asString(ti.feature));
    const price = asFloat(ti.price, -1);
    if (!feature || price < 0) continue;
    catalog[feature] = {
      price,
      notes: asString(ti.notes),
      relatedProjectSlugs: asStringList(ti.relatedProjectSlugs),
    };
  }
  return catalog;
}

function projectReferenceLookup(
  profile: Record<string, unknown>,
): Record<string, Record<string, string>> {
  const lookup: Record<string, Record<string, string>> = {};
  const prRaw = profile.projectReferences;
  if (!Array.isArray(prRaw)) return lookup;
  for (const item of prRaw) {
    if (!item || typeof item !== "object") continue;
    const ti = item as Record<string, unknown>;
    const slug = asString(ti.slug);
    const title = asString(ti.title);
    if (!slug || !title) continue;
    lookup[slug] = { slug, title, notes: asString(ti.notes) };
  }
  return lookup;
}

export function executeFeaturePricingQuote(
  arguments_: Record<string, unknown>,
  question: string,
  answerLanguage: string,
): ToolExecutionResult {
  const isIndonesian = normalizeLanguage(answerLanguage) === "id";
  const profile = asFreelanceProfile(arguments_.freelanceProfile);
  const profileCatalog = referenceCatalogFromProfile(profile);
  const projectLookup = projectReferenceLookup(profile);
  const currency =
    asString(arguments_.currency) || asString(profile.currency) || "IDR";
  const projectName = asString(arguments_.projectName);
  const requirementsSummary = asString(arguments_.requirementsSummary);
  const modulesInput = arguments_.modules;

  const modules: Array<{ name: string; features: string[] }> = [];
  if (Array.isArray(modulesInput)) {
    for (const mod of modulesInput) {
      if (!mod || typeof mod !== "object") continue;
      const tm = mod as Record<string, unknown>;
      const moduleName = asString(tm.name) || "General";
      const features = asStringList(tm.features);
      if (moduleName || features.length > 0) {
        modules.push({ name: moduleName, features });
      }
    }
  }

  if (modules.length === 0) {
    const exampleFeatures = Object.keys(profileCatalog).slice(0, 2);
    const exampleLine = exampleFeatures.length > 0
      ? (isIndonesian
          ? ` Contoh referensi yang sudah dikenali: ${exampleFeatures.join(", ")}.`
          : ` Reference examples already recognized: ${exampleFeatures.join(", ")}.`)
      : "";
    const guidance = (isIndonesian
      ? "Saya bisa menyiapkan rincian penawaran freelance, tetapi saya masih butuh daftar modul dan fitur. Kirim requirement sebagai modul dengan item fitur, lalu saya akan cocokkan dengan harga referensi Anda."
      : "I can prepare a freelance quote breakdown, but I still need the module and feature list. Share the requirements as modules with feature items, then I can match them against your reference prices."
    ) + exampleLine;
    return {
      toolName: "feature_pricing_quote",
      text: guidance,
      context: guidance,
      metadata: {
        status: "needs_input",
        mode: "feature_breakdown",
        question,
        loadedFromIntentProfile: Object.keys(profileCatalog).length > 0,
      },
    };
  }

  const references: Record<string, number> = {};
  for (const [key, details] of Object.entries(profileCatalog)) {
    const price = asFloat(details.price, -1);
    if (price >= 0) references[key] = price;
  }
  Object.assign(references, asReferencePrices(arguments_.referencePrices));

  const lineItems: Array<Record<string, unknown>> = [];
  const missingFeatures: string[] = [];
  let matchedTotal = 0;
  const usedProjectReferences: Array<Record<string, string>> = [];

  for (const mod of modules) {
    for (const feature of mod.features) {
      const trimmed = feature.trim();
      if (!trimmed) continue;
      const nf = normalizeKey(trimmed);
      const price = references[nf];
      if (price === undefined) {
        missingFeatures.push(trimmed);
        continue;
      }

      const relatedSlugs = (profileCatalog[nf]?.relatedProjectSlugs as string[]) ?? [];
      const relatedProjects: Array<Record<string, string>> = [];
      for (const slug of relatedSlugs) {
        const ref = projectLookup[slug];
        if (ref) relatedProjects.push(ref);
        if (ref && !usedProjectReferences.some((u) => u.slug === slug)) {
          usedProjectReferences.push(ref);
        }
      }

      const priceValue = price;
      matchedTotal += priceValue;
      lineItems.push({
        module: mod.name,
        feature: trimmed,
        price: priceValue,
        notes: (profileCatalog[nf]?.notes as string) ?? "",
        relatedProjects,
      });
    }
  }

  const textLines: string[] = [
    isIndonesian
      ? `Rincian penawaran fitur freelance (${currency.toUpperCase()}):`
      : `Freelance feature quote breakdown (${currency.toUpperCase()}):`,
  ];

  if (projectName) textLines.push(`- ${isIndonesian ? "Proyek" : "Project"}: ${projectName}`);
  if (requirementsSummary) {
    const label = isIndonesian ? "Ringkasan kebutuhan" : "Requirement summary";
    textLines.push(`- ${label}: ${requirementsSummary}`);
  }
  const profileHourlyRate = asFloat(profile.hourlyRate, -1);
  if (profileHourlyRate >= 0) {
    textLines.push(`- ${isIndonesian ? "Rate per jam referensi" : "Reference hourly rate"}: ${formatCurrency(profileHourlyRate, currency)}`);
  }
  const profileCompleted = Math.round(asFloat(profile.completedProjects, -1));
  if (profileCompleted >= 0) {
    textLines.push(`- ${isIndonesian ? "Proyek freelance selesai di profil" : "Completed freelance projects in profile"}: ${profileCompleted}`);
  }

  if (lineItems.length > 0) {
    textLines.push(
      isIndonesian ? "- Item referensi yang cocok:" : "- Matched reference items:",
    );
    for (const item of lineItems) {
      const lineTotal = formatCurrency(asFloat(item.price, 0), currency);
      const relatedProjs = (item.relatedProjects as Array<Record<string, string>>) ?? [];
      let relatedSuffix = "";
      if (relatedProjs.length > 0) {
        const titles = relatedProjs.map((p) => p.title).filter(Boolean);
        if (titles.length > 0) {
          relatedSuffix = isIndonesian
            ? ` (proyek terkait: ${titles.join(", ")})`
            : ` (related projects: ${titles.join(", ")})`;
        }
      }
      textLines.push(`  - ${item.module}: ${item.feature} = ${lineTotal}${relatedSuffix}`);
    }
    textLines.push(
      `- ${isIndonesian ? "Subtotal penawaran saat ini" : "Current quoted subtotal"}: ${formatCurrency(matchedTotal, currency)}`,
    );
  } else {
    textLines.push(
      isIndonesian
        ? "- Belum ada fitur modul yang cocok dengan katalog referensi saat ini."
        : "- No module features matched the current reference catalog yet.",
    );
  }

  if (missingFeatures.length > 0) {
    textLines.push(
      isIndonesian
        ? "- Harga referensi yang masih belum ada untuk:"
        : "- Missing reference prices for:",
    );
    for (const f of missingFeatures) textLines.push(`  - ${f}`);
    textLines.push(
      isIndonesian
        ? "- Tambahkan harga referensi untuk fitur yang masih kosong, lalu jalankan ulang rincian ini untuk mendapatkan penawaran final."
        : "- Add reference prices for the missing features, then rerun the breakdown to get a final quote.",
    );
  }

  const pricingNotes = asString(profile.pricingNotes);
  if (pricingNotes) {
    textLines.push(`- ${isIndonesian ? "Catatan pricing" : "Pricing notes"}: ${pricingNotes}`);
  }

  textLines.push(
    isIndonesian
      ? "- Model pricing: penawaran berbasis modul/fitur menggunakan katalog referensi freelance Anda, bukan estimasi rate generik."
      : "- Pricing model: module/feature-based quoting using your freelance reference catalog instead of generic rate estimation.",
  );

  const context = `Tool result from feature_pricing_quote. Module-feature pricing mode. Matched subtotal: ${formatCurrency(matchedTotal, currency)}. Matched items: ${lineItems.length}. Missing references: ${missingFeatures.length}.`;

  return {
    toolName: "feature_pricing_quote",
    text: textLines.join("\n"),
    context,
    metadata: {
      status: lineItems.length > 0 && missingFeatures.length === 0 ? "completed" : "needs_reference",
      mode: "feature_breakdown",
      currency,
      projectName,
      requirementsSummary,
      modules,
      lineItems,
      matchedSubtotal: matchedTotal,
      missingFeatures,
      referenceCatalogSize: Object.keys(references).length,
      referencedProjects: usedProjectReferences.map((ref) => ({
        slug: ref.slug,
        title: ref.title,
      })),
      loadedFromIntentProfile: Object.keys(profileCatalog).length > 0,
    },
  };
}

export function executeFreelanceProfileLookup(
  arguments_: Record<string, unknown>,
  answerLanguage: string,
): ToolExecutionResult {
  const isIndonesian = normalizeLanguage(answerLanguage) === "id";
  const profile = asFreelanceProfile(arguments_.freelanceProfile);
  const featurePricing = (profile.featurePricing as Array<Record<string, unknown>>) ?? [];
  const projectReferences = (profile.projectReferences as Array<Record<string, string>>) ?? [];

  if (Object.keys(profile).length === 0) {
    const text = isIndonesian
      ? "Saya belum punya profil freelance terstruktur yang cukup untuk menjawab itu secara deterministik."
      : "I don't have enough structured freelance profile data to answer that deterministically yet.";
    return {
      toolName: "freelance_profile_lookup",
      text,
      context: text,
      metadata: { status: "unavailable", mode: "profile_lookup" },
    };
  }

  const currency = asString(profile.currency) || "IDR";
  const textLines: string[] = [
    isIndonesian ? "Ringkasan profil freelance:" : "Freelance profile summary:",
  ];

  const hourlyRate = asFloat(profile.hourlyRate, -1);
  if (hourlyRate >= 0) {
    textLines.push(`- ${isIndonesian ? "Rate per jam" : "Hourly rate"}: ${formatCurrency(hourlyRate, currency)}`);
  }

  const completedProjects = Math.round(asFloat(profile.completedProjects, -1));
  if (completedProjects >= 0) {
    textLines.push(`- ${isIndonesian ? "Proyek selesai" : "Completed projects"}: ${completedProjects}`);
  }

  const pricingNotes = asString(profile.pricingNotes);
  if (pricingNotes) {
    textLines.push(`- ${isIndonesian ? "Catatan pricing" : "Pricing notes"}: ${pricingNotes}`);
  }

  if (featurePricing.length > 0) {
    textLines.push(`- ${isIndonesian ? "Contoh fitur berharga referensi" : "Example referenced features"}:`);
    for (const item of featurePricing.slice(0, 5)) {
      const feature = asString(item.feature);
      const price = asFloat(item.price, -1);
      if (!feature || price < 0) continue;
      textLines.push(`  - ${feature}: ${formatCurrency(price, currency)}`);
    }
  }

  if (projectReferences.length > 0) {
    const labels = projectReferences
      .slice(0, 4)
      .map((p) => p.title)
      .filter(Boolean);
    if (labels.length > 0) {
      textLines.push(`- ${isIndonesian ? "Referensi proyek" : "Project references"}: ${labels.join(", ")}`);
    }
  }

  const context = `Tool result from freelance_profile_lookup. Hourly rate available: ${hourlyRate >= 0}. Completed projects: ${completedProjects >= 0 ? completedProjects : "unknown"}. Feature pricing entries: ${featurePricing.length}. Project references: ${projectReferences.length}.`;

  return {
    toolName: "freelance_profile_lookup",
    text: textLines.join("\n"),
    context,
    metadata: {
      status: "completed",
      mode: "profile_lookup",
      currency,
      hourlyRate: hourlyRate < 0 ? null : hourlyRate,
      completedProjects: completedProjects < 0 ? null : completedProjects,
      featurePricingCount: featurePricing.length,
      projectReferenceCount: projectReferences.length,
      referencedProjects: projectReferences.map((ref) => ({
        slug: ref.slug,
        title: ref.title,
      })),
    },
  };
}

export function executeTool(
  toolName: string,
  arguments_: Record<string, unknown>,
  question: string,
  answerLanguage: string,
): ToolExecutionResult {
  if (toolName === "feature_pricing_quote") {
    return executeFeaturePricingQuote(arguments_, question, answerLanguage);
  }
  if (toolName === "freelance_profile_lookup") {
    return executeFreelanceProfileLookup(arguments_, answerLanguage);
  }
  const isIndonesian = normalizeLanguage(answerLanguage) === "id";
  return {
    toolName,
    text: isIndonesian
      ? "Saya mengenali workflow tool, tetapi tool yang diminta belum tersedia."
      : "I recognized a tool workflow, but the requested tool is not available yet.",
    context: isIndonesian
      ? "Belum ada hasil tool deterministik yang tersedia."
      : "No deterministic tool result was available.",
    metadata: { status: "unavailable" },
  };
}
