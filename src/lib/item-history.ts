import { Buffer } from "node:buffer";
import type { ChangeHistoryEntry, RegisterEntry, RegisterState } from "./snapshots";

/** Opaque tokens avoid slash/percent decoding and filesystem path collisions. */
export function itemRouteToken(key: string): string {
  return `k-${Buffer.from(key, "utf8").toString("base64url")}`;
}

export function itemPath(slug: string, key: string): string {
  return `/registers/${encodeURIComponent(slug)}/items/${itemRouteToken(key)}/`;
}

/** Never infer event ownership from the patch's printed identifier/position. */
export function itemHistory(state: RegisterState, key: string): ChangeHistoryEntry[] | null {
  return state.key_history && Object.hasOwn(state.key_history, key)
    ? state.key_history[key] ?? null
    : null;
}

export interface RegisterItem {
  key: string;
  status: "active" | "lapsed" | "deleted" | "historical";
  entry?: RegisterEntry;
}

/** Match replay Strategies::Base.entry_key, including canonical language order. */
function entryKey(entry: RegisterEntry, keyField: string | string[]): string | null {
  const parts = (Array.isArray(keyField) ? keyField : [keyField]).map((field) => {
    const value = entry[field];
    if (value === null || value === undefined) return "";
    if (typeof value === "object" && !Array.isArray(value)) {
      const translations = value as Record<string, unknown>;
      const language = ["fr", "en", "es", "zh", "ru", "ar"].find(
        (lang) => typeof translations[lang] === "string" && translations[lang] !== "",
      );
      return language ? String(translations[language]) : "";
    }
    return String(value);
  });
  return parts.every((part) => part === "") ? null : parts.join(" | ");
}

/** Include withdrawn and historical keys so their pages remain discoverable. */
export function listRegisterItems(state: RegisterState, keyField: string | string[]): RegisterItem[] {
  const items = new Map<string, RegisterItem>();
  for (const key of Object.keys(state.key_history ?? {})) items.set(key, { key, status: "historical" });
  for (const key of state.deleted_keys) items.set(key, { key, status: "deleted" });
  for (const key of state.lapsed_keys) items.set(key, { key, status: "lapsed" });
  for (const entry of state.active_entries) {
    const key = entryKey(entry, keyField);
    if (key !== null) items.set(key, { key, status: "active", entry });
  }
  return [...items.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
