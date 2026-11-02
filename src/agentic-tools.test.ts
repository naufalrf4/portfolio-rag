import { describe, it, expect } from "bun:test";
import {
  stageSubmitGuestbook,
  stageSendMessage,
  stageCreateBooking,
} from "./agentic-tools";

describe("Agentic Tools — Stage", () => {
  it("stageSubmitGuestbook returns pendingAction with all data", () => {
    const result = stageSubmitGuestbook("Hello world!", "token123");
    expect(result.pendingAction.tool).toBe("submit_guestbook");
    expect(result.pendingAction.missingFields).toEqual([]);
    expect(result.pendingAction.payload.message).toBe("Hello world!");
    expect(result.pendingAction.payload.guestbookToken).toBe("token123");
  });

  it("stageSubmitGuestbook reports missing guestbook token", () => {
    const result = stageSubmitGuestbook("Hello world!");
    expect(result.pendingAction.missingFields).toContain("guestbook token (sign in to guestbook first)");
    expect(result.message).toContain("still need");
  });

  it("stageSubmitGuestbook reports missing message", () => {
    const result = stageSubmitGuestbook("", "token");
    expect(result.pendingAction.missingFields).toContain("message");
  });

  it("stageSendMessage returns pendingAction", () => {
    const result = stageSendMessage("Hi there!");
    expect(result.pendingAction.tool).toBe("send_message");
    expect(result.pendingAction.missingFields).toEqual([]);
    expect(result.pendingAction.payload.content).toBe("Hi there!");
  });

  it("stageSendMessage reports missing content", () => {
    const result = stageSendMessage("");
    expect(result.pendingAction.missingFields).toContain("content");
  });

  it("stageCreateBooking returns pendingAction", () => {
    const result = stageCreateBooking("slot1", "Naufal", "naufal@test.com", "Notes", "+123");
    expect(result.pendingAction.tool).toBe("create_booking");
    expect(result.pendingAction.missingFields).toEqual([]);
    expect(result.pendingAction.payload.slotId).toBe("slot1");
    expect(result.pendingAction.payload.name).toBe("Naufal");
    expect(result.pendingAction.payload.email).toBe("naufal@test.com");
  });

  it("stageCreateBooking reports missing name and email", () => {
    const result = stageCreateBooking("slot1", "", "bad");
    expect(result.pendingAction.missingFields).toContain("name");
    expect(result.pendingAction.missingFields).toContain("valid email");
  });
});
