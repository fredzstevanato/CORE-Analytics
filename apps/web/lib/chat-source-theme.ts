export type ChatPlatform = "whatsapp" | "instagram" | "facebook" | "generic";

export function detectChatPlatform(sourceApp?: string | null): ChatPlatform {
  const value = (sourceApp ?? "").toLowerCase();
  if (value.includes("whatsapp") || value.includes("wa")) return "whatsapp";
  if (value.includes("instagram") || value.includes("ig")) return "instagram";
  if (value.includes("facebook") || value.includes("messenger") || value.includes("fb")) return "facebook";
  return "generic";
}

export function getPlatformLabel(platform: ChatPlatform) {
  if (platform === "whatsapp") return "WhatsApp";
  if (platform === "instagram") return "Instagram";
  if (platform === "facebook") return "Facebook";
  return "Outro";
}

export function getPlatformContainerClass(platform: ChatPlatform) {
  if (platform === "whatsapp") return "border-emerald-300 bg-emerald-50";
  if (platform === "instagram") return "border-fuchsia-300 bg-fuchsia-50";
  if (platform === "facebook") return "border-blue-300 bg-blue-50";
  return "border-zinc-300 bg-zinc-50";
}

export function getPlatformBadgeClass(platform: ChatPlatform) {
  if (platform === "whatsapp") return "border-emerald-300 bg-emerald-100 text-emerald-800";
  if (platform === "instagram") return "border-fuchsia-300 bg-fuchsia-100 text-fuchsia-800";
  if (platform === "facebook") return "border-blue-300 bg-blue-100 text-blue-800";
  return "border-zinc-300 bg-zinc-100 text-zinc-700";
}

export function getPlatformHeaderClass(platform: ChatPlatform) {
  if (platform === "whatsapp") return "border-emerald-400 bg-emerald-700 text-white";
  if (platform === "instagram") return "border-fuchsia-500 bg-gradient-to-r from-fuchsia-600 to-rose-500 text-white";
  if (platform === "facebook") return "border-blue-500 bg-blue-700 text-white";
  return "border-zinc-300 bg-zinc-200 text-zinc-900";
}

export function getPlatformConversationClass(platform: ChatPlatform) {
  if (platform === "whatsapp") {
    return "bg-[radial-gradient(circle_at_1px_1px,_#d9f99d_1px,_transparent_0)] [background-size:22px_22px]";
  }
  if (platform === "instagram") {
    return "bg-[linear-gradient(135deg,_rgba(244,114,182,0.18),_rgba(217,70,239,0.12)_40%,_rgba(255,255,255,0.8)_70%)]";
  }
  if (platform === "facebook") {
    return "bg-[linear-gradient(180deg,_rgba(191,219,254,0.4),_rgba(255,255,255,0.95))]";
  }
  return "bg-white";
}

export function getOutgoingBubbleClass(platform: ChatPlatform) {
  if (platform === "whatsapp") return "bg-emerald-200 text-zinc-900";
  if (platform === "instagram") return "bg-gradient-to-r from-fuchsia-600 to-rose-500 text-white";
  if (platform === "facebook") return "bg-blue-600 text-white";
  return "bg-zinc-900 text-white";
}

export function getIncomingBubbleClass(platform: ChatPlatform) {
  if (platform === "whatsapp") return "border border-emerald-300 bg-white text-zinc-900";
  if (platform === "instagram") return "border border-fuchsia-200 bg-white text-zinc-900";
  if (platform === "facebook") return "border border-blue-200 bg-white text-zinc-900";
  return "border border-zinc-200 bg-white text-zinc-900";
}

