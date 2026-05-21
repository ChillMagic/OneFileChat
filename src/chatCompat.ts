const LEGACY_ASSISTANT_LABEL_CUTOFF_MS = Date.parse('2026-06-01T00:00:00.000Z');

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shouldApplyLegacyAssistantLabelCompat(updatedAt: unknown): boolean {
  if (typeof updatedAt !== 'string' || !updatedAt.trim()) {
    return false;
  }

  const timestamp = Date.parse(updatedAt);
  return Number.isFinite(timestamp) && timestamp < LEGACY_ASSISTANT_LABEL_CUTOFF_MS;
}

function migrateLegacyAssistantLabelVersion(version: unknown, assistantLabel: string): unknown {
  if (!isObject(version)) {
    return version;
  }

  if (typeof version.assistantLabel === 'string' && version.assistantLabel.trim()) {
    return version;
  }

  return {
    ...version,
    assistantLabel
  };
}

export function migrateLegacyAssistantLabelMessage(message: JsonObject): JsonObject {
  const legacyName = typeof message.name === 'string' && message.name.trim()
    ? message.name.trim()
    : undefined;

  if (!legacyName) {
    return message;
  }

  const { name: _legacyName, versions, ...rest } = message;
  const nextVersions = Array.isArray(versions)
    ? versions.map((version) => migrateLegacyAssistantLabelVersion(version, legacyName))
    : versions;

  return {
    ...rest,
    ...(nextVersions !== undefined ? { versions: nextVersions } : {})
  };
}

export function applyLegacyChatCompatibility(raw: JsonObject): JsonObject {
  if (!shouldApplyLegacyAssistantLabelCompat(raw.updatedAt) || !Array.isArray(raw.messages)) {
    return raw;
  }

  return {
    ...raw,
    messages: raw.messages.map((message) => (isObject(message) ? migrateLegacyAssistantLabelMessage(message) : message))
  };
}