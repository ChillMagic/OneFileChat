import * as vscode from 'vscode';
import { t } from '../../shared/i18n';
import {
  CHAT_COMMON_CONFIGS_FILE_NAME,
  KEY_FILE_ENV_VAR_REGEX
} from './types';
import type {
  ChatDataDirectoryResolution,
  ChatFile,
  ChatMessageVersion,
  ChatModelSelection,
  CommonConfigEntry,
  CommonConfigsFile,
  InheritableTextField,
  KeyFileConfig,
  KeyFileModelConfig,
  KeyFileOptionConfig,
  KeyFileProviderConfig,
  KeyFileTitleGenerationConfig,
  ResolveTitleGenerationRequestConfigOptions,
  ResolvedModelConfig,
  WebviewCommonConfigState,
  WebviewConfigFieldSource,
  WebviewConfigFieldState,
  WebviewProviderItem
} from './types';
import {
  decodeUtf8,
  findFirstExistingUri,
  getChatDataDirectoryUriForBaseDirectory,
  isObject,
  normalizeModelSelectionField,
  normalizeOptionalStringOrNull,
  parseJsoncDocument,
  resolveChatDataDirectoryResolution,
  toErrorMessage
} from './utils';
import {
  getActiveConversationMessages,
  getMessageCurrentAssistantLabel
} from './document';

export const UNSUPPORTED_KEY_FILE_FIELDS = new Set([
  'provider',
  'apiKey',
  'apiKeyEnvName',
  'baseUrl',
  'baseURL',
  'base_url',
  'assistant_name',
  'aiName',
  'reasoningEffort',
  'thinking',
  'request'
]);

export function createDefaultKeyFileContent(): string {
  return `${JSON.stringify(
    {
      providers: {
        'example-provider': {
          label: 'Example Provider',
          transport: 'openai-compatible',
          api_key: '<your-api-key>',
          api_base: 'https://your-host/v1',
          models: [
            {
              id: 'your-model-id',
              label: 'Your Model',
              options: [
                {
                  id: 'default',
                  label: 'Default',
                  config: {}
                }
              ]
            }
          ]
        }
      },
      titleGeneration: {
        selection: {
          providerId: 'example-provider',
          modelId: 'your-model-id',
          optionId: 'default'
        }
      }
    },
    null,
    2
  )}\n`;
}

export function createDefaultCommonConfigsFileContent(): string {
  return `${JSON.stringify(
    {
      default: {
        name: t('host.generalAssistantName'),
        system_prompt: t('host.generalAssistantSystemPrompt'),
        message_template: '{{ message }}'
      }
    },
    null,
    2
  )}\n`;
}

export function assertNoUnsupportedKeyFileFields(raw: Record<string, unknown>): void {
  const unsupportedFields = Object.keys(raw).filter((key) => UNSUPPORTED_KEY_FILE_FIELDS.has(key));
  if (unsupportedFields.length > 0) {
    throw new Error(t('host.keyJsonRemovedFields', { fields: unsupportedFields.join(', ') }));
  }

  const legacyTopLevelFields = [
    'transport',
    'providerId',
    'model',
    'assistantName',
    'api_key',
    'api_base',
    'temperature'
  ].filter((key) => key in raw);

  if (legacyTopLevelFields.length > 0) {
    throw new Error(t('host.keyJsonLegacyFlat', { fields: legacyTopLevelFields.join(', ') }));
  }
}

export async function loadKeyConfig(document: vscode.TextDocument): Promise<KeyFileConfig> {
  return loadKeyConfigForResource(document.uri);
}

export async function loadKeyConfigForResource(resourceUri?: vscode.Uri): Promise<KeyFileConfig> {
  const resolution = await resolveChatDataDirectoryResolution(resourceUri);
  const candidateKeyUris = getChatDataFileCandidateUris(resolution, 'key.json');
  const keyUri = await findFirstExistingUri(candidateKeyUris);
  let fileContent: Uint8Array;

  if (!keyUri) {
    throw new Error(t('host.keyFileNotFound', { paths: candidateKeyUris.map((uri) => uri.fsPath).join('; ') }));
  }

  fileContent = await vscode.workspace.fs.readFile(keyUri);

  const raw = parseJsoncDocument(decodeUtf8(fileContent), `key.json：${keyUri.fsPath}`);

  if (!isObject(raw)) {
    throw new Error(t('host.keyJsonRootMustBeObject'));
  }

  assertNoUnsupportedKeyFileFields(raw);

  if (!isObject(raw.providers)) {
    throw new Error(t('host.keyJsonMustHaveProviders'));
  }

  const providers = Object.fromEntries(
    Object.entries(raw.providers).map(([providerId, providerRaw]) => [providerId, normalizeKeyFileProviderConfig(providerId, providerRaw)])
  );

  if (Object.keys(providers).length === 0) {
    throw new Error(t('host.keyJsonProvidersEmpty'));
  }

  return {
    providers,
    titleGeneration: normalizeOptionalKeyFileTitleGenerationConfig(raw.titleGeneration)
  };
}

export async function loadCommonConfigs(document: vscode.TextDocument): Promise<CommonConfigsFile> {
  const resolution = await resolveChatDataDirectoryResolution(document.uri);
  const configUri = await findFirstExistingUri(getChatDataFileCandidateUris(resolution, CHAT_COMMON_CONFIGS_FILE_NAME));
  let fileContent: Uint8Array;

  if (!configUri) {
    return {};
  }

  fileContent = await vscode.workspace.fs.readFile(configUri);

  const raw = parseJsoncDocument(decodeUtf8(fileContent), `common_configs.json：${configUri.fsPath}`);

  if (!isObject(raw)) {
    throw new Error(t('host.commonConfigsRootMustBeObject'));
  }

  const configs: CommonConfigsFile = {};
  for (const [configId, entryRaw] of Object.entries(raw)) {
    if (!isObject(entryRaw)) {
      continue;
    }

    const name = typeof entryRaw.name === 'string' && entryRaw.name.trim() ? entryRaw.name.trim() : undefined;
    const systemPrompt = typeof entryRaw.system_prompt === 'string' && entryRaw.system_prompt.trim() ? entryRaw.system_prompt.trim() : '';
    const messageTemplate = typeof entryRaw.message_template === 'string' && entryRaw.message_template.trim() ? entryRaw.message_template.trim() : '';

    if (!name) {
      continue;
    }

    configs[configId] = {
      name,
      system_prompt: systemPrompt,
      message_template: messageTemplate
    };
  }

  return configs;
}

export function resolveEffectiveSystemPrompt(chat: ChatFile, commonConfigs: CommonConfigsFile): string | null {
  const field = chat.systemPrompt;
  if (!field) {
    return null;
  }

  if (field.inherit && chat.commonConfigId) {
    const entry = commonConfigs[chat.commonConfigId];
    if (entry && entry.system_prompt) {
      return entry.system_prompt;
    }

    return null;
  }

  return field.content || null;
}

export function resolveEffectiveMessageTemplate(chat: ChatFile, commonConfigs: CommonConfigsFile): string | null {
  const field = chat.messageTemplate;
  if (!field) {
    return null;
  }

  if (field.inherit && chat.commonConfigId) {
    const entry = commonConfigs[chat.commonConfigId];
    if (entry && entry.message_template) {
      return entry.message_template;
    }

    return null;
  }

  return field.content || null;
}

export function createWebviewCommonConfigState(chat: ChatFile, commonConfigs: CommonConfigsFile): WebviewCommonConfigState {
  const selectedId = chat.commonConfigId ?? undefined;
  const selectedEntry = selectedId ? commonConfigs[selectedId] : undefined;
  const options = Object.entries(commonConfigs)
    .sort(([, left], [, right]) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' }))
    .map(([id, entry]) => ({
      id,
      name: entry.name,
      systemPrompt: entry.system_prompt,
      messageTemplate: entry.message_template
    }));

  return {
    selectedId,
    selectedName: selectedEntry?.name,
    hasMissingSelection: Boolean(selectedId && !selectedEntry),
    options
  };
}

export function createWebviewConfigFieldState(
  chat: ChatFile,
  commonConfigs: CommonConfigsFile,
  fieldKey: keyof Pick<CommonConfigEntry, 'system_prompt' | 'message_template'>
): WebviewConfigFieldState {
  const field = fieldKey === 'system_prompt' ? chat.systemPrompt : chat.messageTemplate;
  const inheritedConfigId = chat.commonConfigId ?? undefined;
  const inheritedEntry = inheritedConfigId ? commonConfigs[inheritedConfigId] : undefined;
  const inheritedValue = inheritedEntry?.[fieldKey] ?? '';
  const inherit = field?.inherit === true;
  const content = field?.content ?? '';
  const effectiveContent = inherit ? inheritedValue : content;

  let source: WebviewConfigFieldSource = 'none';
  if (inherit && inheritedValue) {
    source = 'common-config';
  } else if (!inherit && content) {
    source = 'local';
  }

  return {
    inherit,
    content,
    effectiveContent,
    source,
    inheritedConfigId,
    inheritedConfigName: inheritedEntry?.name,
    missingInheritedConfig: Boolean(inherit && inheritedConfigId && !inheritedEntry),
    missingInheritedValue: Boolean(inherit && inheritedEntry && !inheritedValue),
    hasRetainedDraft: Boolean(inherit && content)
  };
}

export function createInheritableTextFieldForSave(inherit: boolean, content: unknown): InheritableTextField {
  return {
    inherit,
    content: normalizeOptionalStringOrNull(content) ?? null
  };
}

export function normalizeKeyFileProviderConfig(providerId: string, raw: unknown): KeyFileProviderConfig {
  const normalizedProviderId = normalizeRequiredKeyFileString(providerId, t('host.providersKeyLabel'));
  if (!isObject(raw)) {
    throw new Error(t('host.providerConfigMustBeObject', { id: normalizedProviderId }));
  }

  const label = normalizeRequiredKeyFileString(raw.label, `provider ${normalizedProviderId}.label`);
  const transport = normalizeRequiredKeyFileString(raw.transport, `provider ${normalizedProviderId}.transport`);
  if (transport !== 'openai-compatible') {
    throw new Error(t('host.providerTransportOnly', { id: normalizedProviderId }));
  }

  const apiKey = normalizeRequiredKeyFileEnvString(raw.api_key, `provider ${normalizedProviderId}.api_key`);
  const apiBase = normalizeOptionalKeyFileEnvString(raw.api_base, `provider ${normalizedProviderId}.api_base`);
  const models = normalizeKeyFileModels(normalizedProviderId, raw.models);

  if (models.length === 0) {
    throw new Error(t('host.providerModelsRequired', { id: normalizedProviderId }));
  }

  return {
    label,
    transport,
    api_key: apiKey,
    api_base: apiBase,
    models
  };
}

export function normalizeKeyFileModels(providerId: string, raw: unknown): KeyFileModelConfig[] {
  if (!Array.isArray(raw)) {
    throw new Error(t('host.providerModelsMustBeArray', { id: providerId }));
  }

  const models = raw.map((modelRaw, index) => normalizeKeyFileModelConfig(providerId, index, modelRaw));
  const seenModelIds = new Set<string>();
  for (const model of models) {
    if (seenModelIds.has(model.id)) {
      throw new Error(t('host.providerModelDuplicateId', { id: providerId, modelId: model.id }));
    }

    seenModelIds.add(model.id);
  }

  return models;
}

export function normalizeKeyFileModelConfig(providerId: string, index: number, raw: unknown): KeyFileModelConfig {
  if (!isObject(raw)) {
    throw new Error(t('host.providerModelMustBeObject', { id: providerId, index }));
  }

  const id = normalizeRequiredKeyFileString(raw.id, `provider ${providerId}.models[${index}].id`);
  const label = normalizeRequiredKeyFileString(raw.label, `provider ${providerId}.models[${index}].label`);
  const options = normalizeKeyFileOptions(providerId, id, raw.options);

  return {
    id,
    label,
    options: options.length > 0 ? options : undefined
  };
}

export function normalizeKeyFileOptions(providerId: string, modelId: string, raw: unknown): KeyFileOptionConfig[] {
  if (raw === undefined) {
    return [];
  }

  if (!Array.isArray(raw)) {
    throw new Error(t('host.providerOptionsMustBeArray', { id: providerId, modelId }));
  }

  const options = raw.map((optionRaw, index) => normalizeKeyFileOptionConfig(providerId, modelId, index, optionRaw));
  const seenOptionIds = new Set<string>();
  for (const option of options) {
    if (seenOptionIds.has(option.id)) {
      throw new Error(t('host.providerOptionDuplicateId', { id: providerId, modelId, optionId: option.id }));
    }

    seenOptionIds.add(option.id);
  }

  return options;
}

export function normalizeKeyFileOptionConfig(providerId: string, modelId: string, index: number, raw: unknown): KeyFileOptionConfig {
  if (!isObject(raw)) {
    throw new Error(t('host.providerOptionMustBeObject', { id: providerId, modelId, index }));
  }

  const id = normalizeRequiredKeyFileString(raw.id, `provider ${providerId}.models(${modelId}).options[${index}].id`);
  const label = normalizeRequiredKeyFileString(raw.label, `provider ${providerId}.models(${modelId}).options[${index}].label`);
  const config = normalizeOptionalKeyFileObject(raw.config, `provider ${providerId}.models(${modelId}).options[${index}].config`);

  return {
    id,
    label,
    config
  };
}

export function normalizeOptionalKeyFileTitleGenerationConfig(raw: unknown): KeyFileTitleGenerationConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (!isObject(raw)) {
    return {
      selectionError: t('host.titleGenerationMustBeObject')
    };
  }

  if (raw.selection === undefined) {
    return {};
  }

  try {
    return {
      selection: normalizeRequiredTitleGenerationSelection(raw.selection)
    };
  } catch (error) {
    return {
      selectionError: t('host.titleGenerationSelectionInvalid', { detail: toErrorMessage(error) })
    };
  }
}

export function normalizeRequiredTitleGenerationSelection(raw: unknown): ChatModelSelection {
  const selection = normalizeModelSelectionField(raw);
  if (!selection?.providerId || !selection.modelId) {
    throw new Error(t('host.providerIdAndModelIdRequired'));
  }

  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    optionId: selection.optionId
  };
}

export function normalizeRequiredKeyFileString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(t('host.fieldMustBeNonEmptyString', { field: fieldName }));
  }

  return value.trim();
}

export function normalizeOptionalKeyFileString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(t('host.fieldMustBeNonEmptyString', { field: fieldName }));
  }

  return value.trim();
}

export function normalizeRequiredKeyFileEnvString(value: unknown, fieldName: string): string {
  const normalized = normalizeRequiredKeyFileString(value, fieldName);
  return normalizeRequiredKeyFileString(resolveKeyFileEnvironmentVariables(normalized, fieldName), fieldName);
}

export function normalizeOptionalKeyFileEnvString(value: unknown, fieldName: string): string | undefined {
  const normalized = normalizeOptionalKeyFileString(value, fieldName);
  if (normalized === undefined) {
    return undefined;
  }

  return normalizeRequiredKeyFileString(resolveKeyFileEnvironmentVariables(normalized, fieldName), fieldName);
}

export function resolveKeyFileEnvironmentVariables(value: string, fieldName: string): string {
  return value.replace(KEY_FILE_ENV_VAR_REGEX, (_match, envName: string) => {
    const envValue = process.env[envName];
    if (typeof envValue !== 'string' || !envValue.trim()) {
      throw new Error(t('host.envVarNotSet', { field: fieldName, envName }));
    }

    return envValue;
  });
}

export function normalizeOptionalKeyFileObject(value: unknown, fieldName: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isObject(value)) {
    throw new Error(t('host.fieldMustBeObject', { field: fieldName }));
  }

  return { ...value };
}

export function getKeyFileUriForDirectory(directoryUri: vscode.Uri): vscode.Uri {
  return getChatDataFileUriForBaseDirectory(directoryUri, 'key.json');
}

export function getCommonConfigsFileUriForDirectory(directoryUri: vscode.Uri): vscode.Uri {
  return getChatDataFileUriForBaseDirectory(directoryUri, CHAT_COMMON_CONFIGS_FILE_NAME);
}

export function getChatDataFileUriForBaseDirectory(baseDirectoryUri: vscode.Uri, relativePath: string): vscode.Uri {
  return vscode.Uri.joinPath(getChatDataDirectoryUriForBaseDirectory(baseDirectoryUri), relativePath);
}

export function getChatDataFileCandidateUris(
  resolution: ChatDataDirectoryResolution,
  relativePath: string
): vscode.Uri[] {
  return resolution.candidateBaseDirectories.map((baseDirectoryUri) => getChatDataFileUriForBaseDirectory(baseDirectoryUri, relativePath));
}

export function createWebviewProviderItems(config: KeyFileConfig): WebviewProviderItem[] {
  return Object.entries(config.providers).map(([providerId, provider]) => ({
    id: providerId,
    label: provider.label,
    models: provider.models.map((model) => ({
      id: model.id,
      label: model.label,
      options: (model.options ?? []).map((option) => ({
        id: option.id,
        label: option.label
      }))
    }))
  }));
}

export function normalizeChatModelSelection(selection: ChatModelSelection | undefined, config: KeyFileConfig): ChatModelSelection | undefined {
  if (!selection?.providerId || !selection.modelId) {
    return undefined;
  }

  const provider = config.providers[selection.providerId];
  if (!provider) {
    return undefined;
  }

  const model = provider.models.find((item) => item.id === selection.modelId);
  if (!model) {
    return undefined;
  }

  const optionId = typeof selection.optionId === 'string' && selection.optionId.trim() ? selection.optionId.trim() : undefined;
  const options = model.options ?? [];

  if (options.length === 0) {
    return {
      providerId: selection.providerId,
      modelId: model.id,
      optionId: undefined
    };
  }

  if (!optionId) {
    return {
      providerId: selection.providerId,
      modelId: model.id,
      optionId: undefined
    };
  }

  if (optionId && options.some((item) => item.id === optionId)) {
    return {
      providerId: selection.providerId,
      modelId: model.id,
      optionId
    };
  }

  return undefined;
}

export function findLastAssistantSelection(chat: ChatFile): ChatModelSelection | undefined {
  const activeMessages = getActiveConversationMessages(chat);

  for (let index = activeMessages.length - 1; index >= 0; index -= 1) {
    const message = activeMessages[index];
    if (message.role !== 'assistant' || !message.providerId || !message.model) {
      continue;
    }

    return {
      providerId: message.providerId,
      modelId: message.model,
      optionId: message.optionId
    };
  }

  return undefined;
}

export function resolveStoredChatModelSelection(chat: ChatFile, keyConfig: KeyFileConfig): ChatModelSelection | undefined {
  const persistedSelection = normalizeChatModelSelection(chat.modelSelection, keyConfig);
  if (persistedSelection) {
    return persistedSelection;
  }

  return normalizeChatModelSelection(findLastAssistantSelection(chat), keyConfig);
}

export function resolveTitleGenerationRequestConfig(
  chat: ChatFile,
  keyConfig: KeyFileConfig,
  options: ResolveTitleGenerationRequestConfigOptions = {}
): ResolvedModelConfig {
  const titleGenerationConfig = keyConfig.titleGeneration;

  if (titleGenerationConfig?.selectionError) {
    if (!options.allowInvalidCustomSelectionFallback) {
      throw new Error(titleGenerationConfig.selectionError);
    }
  } else if (titleGenerationConfig?.selection) {
    try {
      return resolveModelConfig(keyConfig, titleGenerationConfig.selection);
    } catch (error) {
      if (!options.allowInvalidCustomSelectionFallback) {
        throw new Error(t('host.titleSelectionModelInvalid', { detail: toErrorMessage(error) }));
      }
    }
  }

  if (options.fallbackConfig) {
    return options.fallbackConfig;
  }

  const selection = resolveStoredChatModelSelection(chat, keyConfig);
  if (!selection) {
    throw new Error(t('host.noTitleModelAvailable'));
  }

  return resolveModelConfig(keyConfig, selection);
}

export function resolveModelConfig(config: KeyFileConfig, selection: ChatModelSelection): ResolvedModelConfig {
  const normalizedSelection = normalizeChatModelSelection(selection, config);
  if (!normalizedSelection?.providerId || !normalizedSelection.modelId) {
    throw new Error(t('host.selectModelFirst'));
  }

  const provider = config.providers[normalizedSelection.providerId];
  const model = provider.models.find((item) => item.id === normalizedSelection.modelId);
  if (!model) {
    throw new Error(t('host.selectedModelNotFound'));
  }

  const option = normalizedSelection.optionId
    ? (model.options ?? []).find((item) => item.id === normalizedSelection.optionId)
    : undefined;

  const extraRequestConfig = { ...(option?.config ?? {}) };
  assertNoReservedRequestConfigKeys(extraRequestConfig);

  return {
    providerId: normalizedSelection.providerId,
    providerLabel: provider.label,
    transport: provider.transport,
    api_key: provider.api_key,
    api_base: provider.api_base,
    model: model.id,
    modelLabel: model.label,
    optionId: option?.id,
    optionLabel: option?.label,
    assistantLabel: option ? `${model.label} · ${option.label}` : model.label,
    extraRequestConfig
  };
}

export function assertNoReservedRequestConfigKeys(config: Record<string, unknown>): void {
  const reservedKeys = ['model', 'messages', 'stream'];
  const conflicts = reservedKeys.filter((key) => key in config);
  if (conflicts.length === 0) {
    return;
  }

  throw new Error(t('host.optionConfigReservedFields', { fields: conflicts.join(', ') }));
}

export function resolveAssistantName(config: ResolvedModelConfig): string | undefined {
  return config.assistantLabel.trim() || undefined;
}

export function tryResolveAssistantNameFromSelection(
  selection: ChatModelSelection | undefined,
  keyConfig: KeyFileConfig
): string | undefined {
  if (!selection) {
    return undefined;
  }

  try {
    return resolveAssistantName(resolveModelConfig(keyConfig, selection));
  } catch {
    return undefined;
  }
}

export async function resolveSessionAssistantName(uri: vscode.Uri, chat: ChatFile): Promise<string | undefined> {
  const fallbackAssistantName = resolveLatestAssistantDisplayName(chat);

  try {
    const keyConfig = await loadKeyConfigForResource(uri);
    return tryResolveAssistantNameFromSelection(resolveStoredChatModelSelection(chat, keyConfig), keyConfig) ?? fallbackAssistantName;
  } catch {
    return fallbackAssistantName;
  }
}

export function resolveLatestAssistantDisplayName(chat: ChatFile): string | undefined {
  const activeMessages = getActiveConversationMessages(chat);

  for (let index = activeMessages.length - 1; index >= 0; index -= 1) {
    const message = activeMessages[index];
    if (message.role !== 'assistant') {
      continue;
    }

    const assistantLabel = getMessageCurrentAssistantLabel(message);
    if (typeof assistantLabel === 'string' && assistantLabel.trim()) {
      return assistantLabel.trim();
    }

    if (typeof message.model === 'string' && message.model.trim()) {
      return message.model.trim();
    }
  }

  return undefined;
}

export function resolveProjectedAssistantLabel(
  message: Pick<ChatMessageVersion, 'assistantLabel' | 'providerId' | 'model' | 'optionId'>,
  keyConfig: KeyFileConfig
): string | undefined {
  if (!message.providerId || !message.model) {
    return message.assistantLabel;
  }

  return tryResolveAssistantNameFromSelection(
    {
      providerId: message.providerId,
      modelId: message.model,
      optionId: message.optionId
    },
    keyConfig
  ) ?? message.assistantLabel;
}

export function resolveAssistantMessageMetadata(config: ResolvedModelConfig): { model: string; providerId: string; optionId?: string } {
  return {
    model: config.model.trim(),
    providerId: config.providerId,
    optionId: config.optionId
  };
}
