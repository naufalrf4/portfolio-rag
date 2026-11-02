import { config } from "./config";
import type { BookingSlotOption } from "./types";

export type AgenticToolName = "submit_guestbook" | "send_message" | "create_booking";

export interface PendingAction {
  tool: AgenticToolName;
  payload: Record<string, unknown>;
  description: string;
  missingFields: string[];
}

export interface ToolStageResult {
  pendingAction: PendingAction;
  message: string;
}

export function stageSubmitGuestbook(
  message: string,
  guestbookToken?: string,
): ToolStageResult {
  const missing: string[] = [];
  if (!message || message.trim().length === 0) missing.push("message");
  if (!guestbookToken) missing.push("guestbook token (sign in to guestbook first)");

  const description = `Post to guestbook: "${message.slice(0, 80)}${message.length > 80 ? '…' : ''}"`;

  if (missing.length > 0) {
    return {
      pendingAction: {
        tool: "submit_guestbook",
        payload: { message: message.trim() },
        description,
        missingFields: missing,
      },
      message: `I can post that to the guestbook, but I still need: ${missing.join(', ')}. ${
        missing.includes('guestbook token (sign in to guestbook first)')
          ? 'Please sign in using the guestbook button on the homepage first.'
          : ''
      }`,
    };
  }

  return {
    pendingAction: {
      tool: "submit_guestbook",
      payload: { message: message.trim(), guestbookToken },
      description,
      missingFields: [],
    },
    message: `Ready to post to the guestbook: "${message.trim()}". Confirm to continue.`,
  };
}

export function stageSendMessage(
  content: string,
): ToolStageResult {
  const missing: string[] = [];
  if (!content || content.trim().length === 0) missing.push("content");

  const description = `Send anonymous message: "${content.slice(0, 80)}${content.length > 80 ? '…' : ''}"`;

  if (missing.length > 0) {
    return {
      pendingAction: {
        tool: "send_message",
        payload: { content: content.trim() },
        description,
        missingFields: missing,
      },
      message: `I can send that message, but I still need: ${missing.join(', ')}. Please provide the message content.`,
    };
  }

  return {
    pendingAction: {
      tool: "send_message",
      payload: { content: content.trim() },
      description,
      missingFields: [],
    },
    message: `Ready to send your message. Confirm to continue.`,
  };
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PLACEHOLDER_VALUES = new Set(["", "tbd", "you", "unknown", "n/a", "none", "unknown@unknown.com"]);

export function isPlaceholderValue(value: string): boolean {
  return PLACEHOLDER_VALUES.has(value.trim().toLowerCase());
}

export function stageCreateBooking(
  slotId: string,
  name: string,
  email: string,
  notes?: string,
  phone?: string,
): ToolStageResult {
  const missing: string[] = [];
  if (!slotId || isPlaceholderValue(slotId)) missing.push("slotId");
  if (!name || name.trim().length === 0 || isPlaceholderValue(name)) missing.push("name");
  if (!email || !EMAIL_REGEX.test(email) || isPlaceholderValue(email)) missing.push("valid email");

  const description = `Create booking for ${name || 'you'} at slot ${slotId}`;

  if (missing.length > 0) {
    return {
      pendingAction: {
        tool: "create_booking",
        payload: { slotId, name: name.trim(), email: email.trim(), notes, phone },
        description,
        missingFields: missing,
      },
      message: `I can create that booking, but I still need: ${missing.join(', ')}.`,
    };
  }

  return {
    pendingAction: {
      tool: "create_booking",
      payload: { slotId, name: name.trim(), email: email.trim(), notes, phone },
      description,
      missingFields: [],
    },
    message: `Ready to book slot ${slotId} for ${name} (${email}). Confirm to continue.`,
  };
}

const FIELD_LIMITS = {
  guestbookMessage: 500,
  messageContent: 500,
  name: 100,
  email: 255,
  phone: 32,
  notes: 1000,
  slotId: 64,
} as const;

function tooLong(value: string, max: number): boolean {
  return value.length > max;
}

export async function executeSubmitGuestbook(
  payload: Record<string, unknown>,
  adminApiUrl: string,
  clientIp?: string,
): Promise<{ success: boolean; message: string }> {
  const message = String(payload.message ?? '').trim();
  const guestbookToken = String(payload.guestbookToken ?? '');

  if (!message) {
    return { success: false, message: "Guestbook rejected: message is required." };
  }
  if (tooLong(message, FIELD_LIMITS.guestbookMessage)) {
    return {
      success: false,
      message: `Guestbook rejected: message must be ${FIELD_LIMITS.guestbookMessage} characters or less.`,
    };
  }

  const res = await fetch(`${adminApiUrl.replace(/\/$/, "")}/api/v1/public/guestbook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(clientIp ? { "X-Forwarded-For": clientIp } : {}),
    },
    body: JSON.stringify({
      message,
      guestbookToken,
      turnstileToken: "",
    }),
  });

  const data = (await res.json()) as Record<string, unknown>;

  if (!res.ok) {
    const err = data.error as { message?: string } | undefined;
    return {
      success: false,
      message: err?.message ?? `Guestbook submission failed (${res.status})`,
    };
  }

  return { success: true, message: "Guestbook entry posted successfully!" };
}

export async function executeSendMessage(
  payload: Record<string, unknown>,
  adminApiUrl: string,
  clientIp?: string,
): Promise<{ success: boolean; message: string }> {
  const content = String(payload.content ?? '').trim();

  if (!content) {
    return { success: false, message: "Message rejected: content is required." };
  }
  if (tooLong(content, FIELD_LIMITS.messageContent)) {
    return {
      success: false,
      message: `Message rejected: content must be ${FIELD_LIMITS.messageContent} characters or less.`,
    };
  }

  const res = await fetch(`${adminApiUrl.replace(/\/$/, "")}/api/v1/public/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Service-Token": config.ragServiceToken,
      ...(clientIp ? { "X-Forwarded-For": clientIp } : {}),
    },
    body: JSON.stringify({ content }),
  });

  const data = (await res.json()) as Record<string, unknown>;

  if (!res.ok) {
    const err = data.error as { message?: string } | undefined;
    return {
      success: false,
      message: err?.message ?? `Message send failed (${res.status})`,
    };
  }

  return { success: true, message: "Message sent successfully!" };
}

export async function executeCreateBooking(
  payload: Record<string, unknown>,
  adminApiUrl: string,
  clientIp?: string,
): Promise<{ success: boolean; message: string }> {
  const slotId = String(payload.slotId ?? '').trim();
  const name = String(payload.name ?? '').trim();
  const email = String(payload.email ?? '').trim();
  const notes = payload.notes != null ? String(payload.notes) : undefined;
  const phone = payload.phone != null ? String(payload.phone) : undefined;

  if (isPlaceholderValue(slotId)) {
    return { success: false, message: "Booking rejected: slotId is missing or a placeholder value." };
  }
  if (isPlaceholderValue(email) || !EMAIL_REGEX.test(email)) {
    return { success: false, message: "Booking rejected: a valid email is required." };
  }
  if (isPlaceholderValue(name)) {
    return { success: false, message: "Booking rejected: name is missing or a placeholder value." };
  }
  if (
    tooLong(slotId, FIELD_LIMITS.slotId) ||
    tooLong(name, FIELD_LIMITS.name) ||
    tooLong(email, FIELD_LIMITS.email) ||
    (phone != null && tooLong(phone, FIELD_LIMITS.phone)) ||
    (notes != null && tooLong(notes, FIELD_LIMITS.notes))
  ) {
    return { success: false, message: "Booking rejected: one or more fields exceed the allowed length." };
  }

  const res = await fetch(`${adminApiUrl.replace(/\/$/, "")}/api/v1/public/bookings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Service-Token": config.ragServiceToken,
      ...(clientIp ? { "X-Forwarded-For": clientIp } : {}),
    },
    body: JSON.stringify({
      slotId,
      name,
      email,
      phone,
      notes,
    }),
  });

  const data = (await res.json()) as Record<string, unknown>;

  if (!res.ok) {
    const err = data.error as { message?: string } | undefined;
    return {
      success: false,
      message: err?.message ?? `Booking failed (${res.status})`,
    };
  }

  return { success: true, message: `Booking created for ${name} at slot ${slotId}!` };
}

function jakartaSlotDateTimeIso(date: string, startTime: string): string {
  return `${date}T${startTime}:00+07:00`;
}

function jakartaSlotLabel(date: string, startTime: string, endTime: string): string {
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jakarta",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(jakartaSlotDateTimeIso(date, startTime)));
  return `${dateLabel}, ${startTime}-${endTime} WIB`;
}

export async function fetchAvailableBookingSlots(
  adminApiUrl: string,
  days: number,
): Promise<BookingSlotOption[]> {
  try {
    const res = await fetch(
      `${adminApiUrl.replace(/\/$/, "")}/api/v1/public/bookings/available?days=${days}`,
    );
    if (!res.ok) return [];
    const payload = (await res.json()) as Record<string, unknown>;
    const grouped = (payload.data ?? payload) as Record<string, unknown>;
    if (!grouped || typeof grouped !== "object") return [];

    const options: BookingSlotOption[] = [];
    for (const slots of Object.values(grouped)) {
      if (!Array.isArray(slots)) continue;
      for (const slot of slots) {
        if (!slot || typeof slot !== "object") continue;
        const typed = slot as Record<string, unknown>;
        const id = String(typed.id ?? "").trim();
        const date = String(typed.date ?? "").trim();
        const startTime = String(typed.startTime ?? "").trim();
        const endTime = String(typed.endTime ?? "").trim();
        if (!id || !date || !startTime || !endTime) continue;
        options.push({
          slotId: id,
          label: jakartaSlotLabel(date, startTime, endTime),
          dateTimeIso: jakartaSlotDateTimeIso(date, startTime),
        });
      }
    }
    return options;
  } catch {
    return [];
  }
}
