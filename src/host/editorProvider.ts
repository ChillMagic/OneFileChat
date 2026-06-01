import * as path from 'path';
import * as vscode from 'vscode';
import { getLocale, t } from '../shared/i18n';
import {
  AsyncMutex,
  VIEW_TYPE,
  activateMessagePath,
  appendMessageToChat,
  appendMessageVersion,
  collectDescendantMessageIds,
  composeUserMessageBody,
  createClipboardMarkdownAttachmentImport,
  createClipboardMarkdownForMessage,
  createClipboardMarkdownForVersion,
  createInheritableTextFieldForSave,
  createMessage,
  createMessageBodyFromAssistantContent,
  createTreeChatFromLinearMessages,
  createWebviewChatFile,
  createWebviewCommonConfigState,
  createWebviewConfigFieldState,
  createWebviewProviderItems,
  decodeUtf8,
  findLastAssistantSelection,
  findVersionById,
  getActiveConversationMessages,
  getChatDirectoryUri,
  getConversationPathToMessage,
  getDeletionPreview,
  getMessageCurrentAttachments,
  getMessageCurrentBody,
  getMessageCurrentContent,
  getMessagesForModel,
  getNextBranchFileUri,
  getNonce,
  getSiblingIds,
  getWorkspaceFolderUriForDocument,
  hasMeaningfulMessageContent,
  isCurrentMessageContent,
  isCurrentMessageVersion,
  isRequestCanceledError,
  loadCommonConfigs,
  loadKeyConfig,
  maybeAutoUpdateChatTitle,
  normalizeChatModelSelection,
  normalizeCurrentVersionId,
  normalizeOptionalStringOrNull,
  openExternalMarkdownLink,
  parseChatDocument,
  persistWebviewAttachments,
  removeMessageById,
  renderMarkdownToHtml,
  replaceDocumentContent,
  requestCompletionStreaming,
  resolveAssistantMessageMetadata,
  resolveAssistantName,
  resolveModelConfig,
  safeParseChatDocument,
  serializeChatFile,
  setActiveSiblingSelection,
  setMessageCurrentContent,
  setMessageCurrentStructuredContent,
  setMessageCurrentVersion,
  toErrorMessage,
  trimChatFileSuffix,
  updateMessageById,
  validateConversationAttachmentReferences
} from './chat';
import type {
  ChatFile,
  ChatMessage,
  ChatModelSelection,
  CommonConfigsFile,
  EditorStreamData,
  HostToWebviewMessage,
  KeyFileConfig,
  ResolvedModelConfig,
  StreamSnapshot,
  WebviewIncomingAttachment,
  WebviewProviderItem,
  WebviewToHostMessage
} from './chat';
import {
  createNewChatFile,
  manageCommonConfigCommand,
  manageProviderConfigCommand
} from './sessionTree';

export class OneFileChatEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly busyDocuments = new Set<string>();
  private readonly requestMutexByDocument = new Map<string, AsyncMutex>();
  private readonly activeAbortControllers = new Map<string, AbortController>();
  private readonly closingAbortControllers = new WeakSet<AbortController>();
  private readonly modelSelectionByDocument = new Map<string, ChatModelSelection>();
  private readonly streamDataByDocument = new Map<string, EditorStreamData>();
  private readonly pendingInitialPromptsByDocument = new Map<
    string,
    { prompt: string; attachments: WebviewIncomingAttachment[] }
  >();

  constructor(private readonly context: vscode.ExtensionContext) {}

  private getDocumentRequestMutex(document: vscode.TextDocument): AsyncMutex {
    const documentKey = document.uri.toString();
    let mutex = this.requestMutexByDocument.get(documentKey);

    if (!mutex) {
      mutex = new AsyncMutex();
      this.requestMutexByDocument.set(documentKey, mutex);
    }

    return mutex;
  }

  private async handoffPendingInitialPrompt(
    document: vscode.TextDocument,
    prompt: string,
    attachments: WebviewIncomingAttachment[]
  ): Promise<void> {
    const targetUri = document.uri.with({ scheme: 'file' });
    const targetKey = targetUri.toString();

    this.pendingInitialPromptsByDocument.set(targetKey, {
      prompt,
      attachments: attachments.map((attachment) => ({ ...attachment }))
    });

    try {
      const saved = await document.save();
      if (!saved) {
        throw new Error(t('host.firstSendCreateChatFailed'));
      }

      await vscode.commands.executeCommand('vscode.openWith', targetUri, VIEW_TYPE);
    } catch (error) {
      this.pendingInitialPromptsByDocument.delete(targetKey);
      throw error;
    }
  }

  private takePendingInitialPrompt(
    document: vscode.TextDocument
  ): { prompt: string; attachments: WebviewIncomingAttachment[] } | undefined {
    const documentKey = document.uri.toString();
    const pending = this.pendingInitialPromptsByDocument.get(documentKey);
    if (!pending) {
      return undefined;
    }

    this.pendingInitialPromptsByDocument.delete(documentKey);
    return pending;
  }

  private async persistLatestStreamSnapshotOnDispose(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== 'file') {
      return;
    }

    const documentKey = document.uri.toString();
    const latestSnapshot = this.streamDataByDocument.get(documentKey)?.latestSnapshot;
    if (!latestSnapshot) {
      return;
    }

    const partialContent = latestSnapshot.content;
    const partialReasoning = latestSnapshot.reasoningContent;
    const hasVisibleOutput = partialContent.trim().length > 0 || partialReasoning.trim().length > 0;
    if (!hasVisibleOutput) {
      return;
    }

    let sourceText: string;
    try {
      sourceText = document.isClosed ? decodeUtf8(await vscode.workspace.fs.readFile(document.uri)) : document.getText();
    } catch (error) {
      console.error(`[onefilechat] Failed to read chat document while persisting streamed snapshot for ${documentKey}:`, error);
      return;
    }

    let nextContent: string;
    try {
      const chat = parseChatDocument(sourceText, trimChatFileSuffix(path.basename(document.uri.fsPath)));
      if (!chat.messages.some((message) => message.id === latestSnapshot.messageId)) {
        return;
      }

      const nextReasoningContent = partialReasoning || undefined;
      const nextChat = updateMessageById(chat, latestSnapshot.messageId, (message) => {
        const updatedMessage = setMessageCurrentContent(message, partialContent, undefined, {
          ...(nextReasoningContent !== undefined ? { reasoningContent: nextReasoningContent } : {})
        });

        return {
          ...updatedMessage,
          reasoningContent: nextReasoningContent,
          status: 'completed'
        };
      });

      nextContent = serializeChatFile(nextChat);
    } catch (error) {
      console.error(`[onefilechat] Failed to persist streamed snapshot for message ${latestSnapshot.messageId} in ${documentKey}:`, error);
      return;
    }

    try {
      await vscode.workspace.fs.writeFile(document.uri, Buffer.from(nextContent, 'utf8'));
    } catch (error) {
      console.error(`[onefilechat] Failed to write streamed snapshot for ${documentKey}:`, error);
    }
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const documentWorkspaceFolder = getWorkspaceFolderUriForDocument(document);
    let webviewReloadTimer: ReturnType<typeof setTimeout> | undefined;

    const reloadWebview = (): void => {
      if (webviewReloadTimer !== undefined) {
        clearTimeout(webviewReloadTimer);
      }

      webviewReloadTimer = setTimeout(() => {
        webviewReloadTimer = undefined;
        webviewPanel.webview.html = this.getHtml(webviewPanel.webview);
      }, 40);
    };

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        vscode.Uri.joinPath(this.context.extensionUri, 'out'),
        getChatDirectoryUri(document),
        ...(documentWorkspaceFolder ? [documentWorkspaceFolder] : [])
      ]
    };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    const mediaWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(path.join(this.context.extensionUri.fsPath, 'media'), '{dist/webview.js,chat.css}')
    );
    mediaWatcher.onDidChange(() => reloadWebview());
    mediaWatcher.onDidCreate(() => reloadWebview());
    mediaWatcher.onDidDelete(() => reloadWebview());

    let currentError: string | undefined;
    let postChunkQueue = Promise.resolve();

    const postState = async (): Promise<void> => {
      const fallbackTitle = trimChatFileSuffix(path.basename(document.uri.fsPath));
      const parsed = safeParseChatDocument(document.getText(), fallbackTitle);
      webviewPanel.title = parsed.chat.title || fallbackTitle;
      let configError: string | undefined;
      let commonConfigError: string | undefined;
      let availableProviders: WebviewProviderItem[] = [];
      let currentSelection: ChatModelSelection | undefined;
      let keyConfig: KeyFileConfig | undefined;
      let commonConfigs: CommonConfigsFile = {};

      const [keyConfigResult, commonConfigsResult] = await Promise.allSettled([
        loadKeyConfig(document),
        loadCommonConfigs(document)
      ]);

      try {
        if (keyConfigResult.status === 'rejected') {
          throw keyConfigResult.reason;
        }

        keyConfig = keyConfigResult.value;
        availableProviders = createWebviewProviderItems(keyConfig);
        currentSelection = this.resolveDocumentSelection(document, parsed.chat, keyConfig);
      } catch (error) {
        configError = toErrorMessage(error);
        this.clearDocumentSelection(document);
      }

      try {
        if (commonConfigsResult.status === 'rejected') {
          throw commonConfigsResult.reason;
        }

        commonConfigs = commonConfigsResult.value;
      } catch (error) {
        commonConfigError = toErrorMessage(error);
      }

      const isBusy = this.busyDocuments.has(document.uri.toString());

      const payload: HostToWebviewMessage = {
        type: 'document',
        value: await createWebviewChatFile(webviewPanel.webview, document, parsed.chat, keyConfig),
        state: {
          error: currentError ?? parsed.error ?? configError ?? commonConfigError,
          fileName: fallbackTitle,
          isBusy,
          availableProviders,
          currentSelection,
          canSend: currentSelection !== undefined && !isBusy,
          commonConfig: createWebviewCommonConfigState(parsed.chat, commonConfigs),
          systemPrompt: createWebviewConfigFieldState(parsed.chat, commonConfigs, 'system_prompt'),
          messageTemplate: createWebviewConfigFieldState(parsed.chat, commonConfigs, 'message_template')
        }
      };

      await webviewPanel.webview.postMessage(payload);
    };

    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingChunk: StreamSnapshot | undefined;
    let latestSnapshot: StreamSnapshot | undefined;
    let streamAccumulationWarned = false;
    const STREAM_ACCUMULATION_SOFT_LIMIT_CHARS = 200 * 1024 * 1024;

    const flushChunkToWebview = (): void => {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }

      if (!pendingChunk) {
        return;
      }

      const snapshot = pendingChunk;
      pendingChunk = undefined;

      postChunkQueue = postChunkQueue
        .then(async () => {
          const [contentHtml, reasoningContentHtml] = await Promise.all([
            renderMarkdownToHtml(snapshot.content),
            renderMarkdownToHtml(snapshot.reasoningContent)
          ]);

          const chunkPayload: HostToWebviewMessage = {
            type: 'streamChunk',
            messageId: snapshot.messageId,
            contentDelta: '',
            reasoningDelta: '',
            content: snapshot.content,
            reasoningContent: snapshot.reasoningContent,
            contentHtml,
            reasoningContentHtml
          };

          await webviewPanel.webview.postMessage(chunkPayload);
        })
        .catch((error) => {
          currentError = toErrorMessage(error);
        });
    };

    const postChunk = (
      messageId: string,
      _contentDelta: string,
      _reasoningDelta: string,
      content: string,
      reasoningContent: string
    ): void => {
      const snapshot = { messageId, content, reasoningContent };
      latestSnapshot = snapshot;
      pendingChunk = snapshot;

      if (!streamAccumulationWarned && content.length + reasoningContent.length >= STREAM_ACCUMULATION_SOFT_LIMIT_CHARS) {
        streamAccumulationWarned = true;
        console.warn(`[onefilechat] Streaming response for message ${messageId} exceeded the soft size limit (${STREAM_ACCUMULATION_SOFT_LIMIT_CHARS} chars); memory usage may be high.`);
        void vscode.window.showWarningMessage(t('host.streamResponseTooLarge'));
      }

      if (flushTimer === undefined) {
        flushTimer = setTimeout(flushChunkToWebview, 80);
      }
    };

    const streamData: EditorStreamData = {
      flush: () => {
        flushChunkToWebview();
      },
      get queue(): Promise<void> {
        return postChunkQueue.then(() => undefined);
      },
      get latestSnapshot(): StreamSnapshot | undefined {
        return latestSnapshot;
      }
    };
    this.streamDataByDocument.set(document.uri.toString(), streamData);

    const changeSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() === document.uri.toString()) {
        // Drain any in-flight stream chunk renders first so the full-document
        // refresh can never race ahead of a pending streamChunk message and
        // momentarily render a stale view.
        void postChunkQueue.then(() => postState());
      }
    });

    const messageSubscription = webviewPanel.webview.onDidReceiveMessage(async (message: WebviewToHostMessage) => {
      if (message.type === 'ready') {
        await postState();

        const pendingInitialPrompt = this.takePendingInitialPrompt(document);
        if (pendingInitialPrompt) {
          currentError = undefined;

          try {
            await this.handlePrompt(document, pendingInitialPrompt.prompt, pendingInitialPrompt.attachments, postState, postChunk);
          } catch (error) {
            currentError = toErrorMessage(error);
            void vscode.window.showErrorMessage(currentError);
          } finally {
            await postState();
          }
        }

        return;
      }

      if (message.type === 'updateModelSelection') {
        currentError = undefined;

        try {
          this.assertDocumentNotBusy(document);

          const keyConfig = await loadKeyConfig(document);
          const nextSelection = normalizeChatModelSelection(
            {
              providerId: message.providerId,
              modelId: message.modelId,
              optionId: message.optionId
            },
            keyConfig
          );

          if (!nextSelection) {
            throw new Error(t('host.invalidModelSelection'));
          }

          this.setDocumentSelection(document, nextSelection);

          const currentChat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
          currentChat.modelSelection = nextSelection;
          await replaceDocumentContent(document, serializeChatFile(currentChat));
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'copyMessage') {
        const chat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
        const targetMessage = chat.messages.find((item) => item.id === message.messageId);
        if (!targetMessage) {
          return;
        }

        await vscode.env.clipboard.writeText(createClipboardMarkdownForMessage(targetMessage));
        return;
      }

      if (message.type === 'copyMessageVersion') {
        const chat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
        const targetMessage = chat.messages.find((item) => item.id === message.messageId);
        const version = targetMessage?.versions?.find((item) => item.id === message.versionId);
        if (!version) {
          return;
        }

        await vscode.env.clipboard.writeText(createClipboardMarkdownForVersion(version));
        return;
      }

      if (message.type === 'copyCodeBlock') {
        await vscode.env.clipboard.writeText(message.content);
        return;
      }

      if (message.type === 'importClipboardMarkdownAttachments') {
        const requestId = typeof message.requestId === 'string' ? message.requestId : '';
        const text = typeof message.text === 'string' ? message.text : '';

        try {
          const result = await createClipboardMarkdownAttachmentImport(document, text);
          await webviewPanel.webview.postMessage({
            type: 'clipboardMarkdownAttachments',
            requestId,
            ok: true,
            text: result.text,
            attachments: result.attachments
          });
        } catch (error) {
          await webviewPanel.webview.postMessage({
            type: 'clipboardMarkdownAttachments',
            requestId,
            ok: false,
            text,
            attachments: [],
            error: toErrorMessage(error)
          });
        }

        return;
      }

      if (message.type === 'persistEditorAttachments') {
        const requestId = typeof message.requestId === 'string' ? message.requestId : '';
        const incoming = Array.isArray(message.attachments) ? message.attachments : [];
        try {
          const persisted = await persistWebviewAttachments(document, incoming);
          await webviewPanel.webview.postMessage({
            type: 'editorAttachmentsPersisted',
            requestId,
            ok: true,
            attachments: persisted
          });
        } catch (error) {
          await webviewPanel.webview.postMessage({
            type: 'editorAttachmentsPersisted',
            requestId,
            ok: false,
            attachments: [],
            error: toErrorMessage(error)
          });
        }
        return;
      }

      if (message.type === 'stopGeneration') {
        this.stopGeneration(document);
        await postState();
        return;
      }

      if (message.type === 'editMessage') {
        currentError = undefined;

        try {
          await this.editMessage(document, message.messageId, message.content);
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'restoreMessageVersion') {
        currentError = undefined;

        try {
          await this.restoreMessageVersion(document, message.messageId, message.versionId);
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'deleteMessageVersion') {
        currentError = undefined;

        try {
          await this.deleteMessageVersion(document, message.messageId, message.versionId);
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'deleteMessageBranch') {
        currentError = undefined;

        try {
          await this.deleteMessageBranch(document, message.messageId);
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'rewriteMessageBranch') {
        currentError = undefined;

        try {
          await this.rewriteMessageBranch(
            document,
            message.messageId,
            message.content,
            message.continueGeneration === true,
            postState,
            postChunk
          );
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'createNewChat') {
        currentError = undefined;

        try {
          await createNewChatFile(document.uri);
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'viewRawChatJson') {
        try {
          await vscode.commands.executeCommand('onefilechat.viewRawChatJson', document.uri);
        } catch (error) {
          void vscode.window.showErrorMessage(toErrorMessage(error));
        }
        return;
      }

      if (message.type === 'updateCommonConfigId') {
        currentError = undefined;

        try {
          this.assertDocumentNotBusy(document);

          const currentChat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
          const nextCommonConfigId = normalizeOptionalStringOrNull(message.commonConfigId) ?? null;
          if ((currentChat.commonConfigId ?? null) !== nextCommonConfigId) {
            currentChat.commonConfigId = nextCommonConfigId;
            currentChat.updatedAt = new Date().toISOString();
            await replaceDocumentContent(document, serializeChatFile(currentChat));
          }
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'saveConfigField') {
        currentError = undefined;

        try {
          this.assertDocumentNotBusy(document);

          const currentChat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
          const nextField = createInheritableTextFieldForSave(message.inherit, message.content);
          const currentField = message.field === 'systemPrompt' ? currentChat.systemPrompt : currentChat.messageTemplate;
          const currentContent = currentField?.content ?? null;

          if (currentField?.inherit !== nextField.inherit || currentContent !== nextField.content) {
            currentChat[message.field] = nextField;
            currentChat.updatedAt = new Date().toISOString();
            await replaceDocumentContent(document, serializeChatFile(currentChat));
          }
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'manageProviderConfig') {
        currentError = undefined;

        try {
          await manageProviderConfigCommand(document.uri);
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'manageCommonConfig') {
        currentError = undefined;

        try {
          await manageCommonConfigCommand(document.uri);
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'openExternalLink') {
        await openExternalMarkdownLink(message.href);
        return;
      }

      if (message.type === 'resendMessage') {
        currentError = undefined;

        try {
          await this.resendMessage(document, message.messageId, postState, postChunk);
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'selectSibling') {
        currentError = undefined;

        try {
          await this.selectSibling(document, message.messageId, message.direction);
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'branchMessage') {
        currentError = undefined;

        try {
          await this.branchMessage(document, message.messageId);
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'sendPrompt') {
        const requestId = typeof message.requestId === 'string' ? message.requestId.trim() : '';
        const prompt = typeof message.prompt === 'string' ? message.prompt.trim() : '';
        const attachments = Array.isArray(message.attachments) ? message.attachments : [];
        if (!prompt && attachments.length === 0) {
          return;
        }

        currentError = undefined;
        let accepted = false;
        let handedOff = false;

        try {
          if (document.isUntitled) {
            await this.handoffPendingInitialPrompt(document, prompt, attachments);
            handedOff = true;
            accepted = true;

            if (requestId) {
              try {
                await webviewPanel.webview.postMessage({
                  type: 'sendPromptResult',
                  requestId,
                  ok: true
                } satisfies HostToWebviewMessage);
              } catch {
                // The old untitled editor may already be disposed while the saved editor takes over.
              }
            }

            return;
          }

          await this.handlePrompt(document, prompt, attachments, postState, postChunk, async () => {
            accepted = true;

            if (!requestId) {
              return;
            }

            await webviewPanel.webview.postMessage({
              type: 'sendPromptResult',
              requestId,
              ok: true
            } satisfies HostToWebviewMessage);
          });
        } catch (error) {
          if (!accepted && requestId) {
            await webviewPanel.webview.postMessage({
              type: 'sendPromptResult',
              requestId,
              ok: false
            } satisfies HostToWebviewMessage);
          }

          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          if (!handedOff) {
            await postState();
          }
        }
      }
    });

    webviewPanel.onDidDispose(() => {
      const documentKey = document.uri.toString();
      const activeAbortController = this.activeAbortControllers.get(documentKey);
      if (activeAbortController) {
        this.closingAbortControllers.add(activeAbortController);
      }

      if (webviewReloadTimer !== undefined) {
        clearTimeout(webviewReloadTimer);
      }

      changeSubscription.dispose();
      messageSubscription.dispose();
      mediaWatcher.dispose();

      void (async () => {
        try {
          this.stopGeneration(document);
          await this.persistLatestStreamSnapshotOnDispose(document);
        } finally {
          this.clearDocumentSelection(document);
          this.requestMutexByDocument.delete(documentKey);
          this.streamDataByDocument.delete(documentKey);
        }
      })();
    });
  }

  private stopGeneration(document: vscode.TextDocument): void {
    const documentKey = document.uri.toString();
    const controller = this.activeAbortControllers.get(documentKey);
    if (!controller) {
      return;
    }

    controller.abort();
    this.activeAbortControllers.delete(documentKey);
  }

  private assertDocumentNotBusy(document: vscode.TextDocument): void {
    if (this.busyDocuments.has(document.uri.toString())) {
      throw new Error(t('host.pendingReplyInProgress'));
    }
  }

  private setDocumentSelection(document: vscode.TextDocument, selection: ChatModelSelection): void {
    this.modelSelectionByDocument.set(document.uri.toString(), selection);
  }

  private clearDocumentSelection(document: vscode.TextDocument): void {
    this.modelSelectionByDocument.delete(document.uri.toString());
  }

  private resolveDocumentSelection(
    document: vscode.TextDocument,
    chat: ChatFile,
    keyConfig: KeyFileConfig
  ): ChatModelSelection | undefined {
    const documentKey = document.uri.toString();
    const sessionSelection = normalizeChatModelSelection(this.modelSelectionByDocument.get(documentKey), keyConfig);
    if (sessionSelection) {
      this.modelSelectionByDocument.set(documentKey, sessionSelection);
      return sessionSelection;
    }

    const fileSelection = normalizeChatModelSelection(chat.modelSelection, keyConfig);
    if (fileSelection) {
      this.modelSelectionByDocument.set(documentKey, fileSelection);
      return fileSelection;
    }

    const restoredSelection = normalizeChatModelSelection(findLastAssistantSelection(chat), keyConfig);
    if (restoredSelection) {
      this.modelSelectionByDocument.set(documentKey, restoredSelection);
      return restoredSelection;
    }

    this.modelSelectionByDocument.delete(documentKey);
    return undefined;
  }

  private resolveRequestConfig(
    document: vscode.TextDocument,
    chat: ChatFile,
    keyConfig: KeyFileConfig
  ): ResolvedModelConfig {
    const selection = this.resolveDocumentSelection(document, chat, keyConfig);
    if (!selection) {
      throw new Error(t('host.selectModelFirst'));
    }

    return resolveModelConfig(keyConfig, selection);
  }

  private async handlePrompt(
    document: vscode.TextDocument,
    prompt: string,
    attachments: WebviewIncomingAttachment[],
    postState: () => Promise<void>,
    postChunk: (
      messageId: string,
      contentDelta: string,
      reasoningDelta: string,
      content: string,
      reasoningContent: string
    ) => void,
    onAccepted?: () => Promise<void>
  ): Promise<void> {
    this.assertDocumentNotBusy(document);

    const documentKey = document.uri.toString();
    this.busyDocuments.add(documentKey);

    try {
      await postState();

      const chat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
      const keyConfig = await loadKeyConfig(document);
      const config = this.resolveRequestConfig(document, chat, keyConfig);
      const assistantLabel = resolveAssistantName(config);
      const assistantMetadata = resolveAssistantMessageMetadata(config);
      const activeMessages = getActiveConversationMessages(chat);
      const parentMessage = activeMessages[activeMessages.length - 1];

      await validateConversationAttachmentReferences(document, activeMessages);

      const storedAttachments = await persistWebviewAttachments(document, attachments);
      const userBody = await composeUserMessageBody(document, prompt, storedAttachments);
      const userMessage = createMessage('user', userBody.content, {
        body: userBody.body,
        attachments: userBody.attachments,
        status: 'completed'
      });

      await validateConversationAttachmentReferences(document, [...activeMessages, userMessage]);

      const assistantMessage = createMessage('assistant', '', {
        assistantLabel,
        model: assistantMetadata.model,
        providerId: assistantMetadata.providerId,
        optionId: assistantMetadata.optionId,
        status: 'pending'
      });

      let nextChat = appendMessageToChat(chat, parentMessage?.id, userMessage);
      nextChat = appendMessageToChat(nextChat, userMessage.id, assistantMessage);
      nextChat.modelSelection = {
        providerId: config.providerId,
        modelId: config.model,
        optionId: config.optionId
      };

      await replaceDocumentContent(document, serializeChatFile(nextChat));
      await postState();
      await onAccepted?.();
      await maybeAutoUpdateChatTitle(document, keyConfig, config, userBody.content, chat.messages.length === 0);

      const messagesForModel = getMessagesForModel(getActiveConversationMessages(nextChat));
      const boundPostChunk = (c: string, r: string, content: string, reasoningContent: string) =>
        postChunk(assistantMessage.id, c, r, content, reasoningContent);

      await this.runAssistantRequest(document, assistantMessage.id, messagesForModel, config, boundPostChunk);
    } finally {
      this.busyDocuments.delete(documentKey);
    }
  }

  private async retryAssistantMessage(
    document: vscode.TextDocument,
    assistantMessageId: string,
    postState: () => Promise<void>,
    postChunk: (
      messageId: string,
      contentDelta: string,
      reasoningDelta: string,
      content: string,
      reasoningContent: string
    ) => void
  ): Promise<void> {
    this.assertDocumentNotBusy(document);

    const documentKey = document.uri.toString();
    this.busyDocuments.add(documentKey);

    try {
      await postState();

      const chat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
      const keyConfig = await loadKeyConfig(document);
      const config = this.resolveRequestConfig(document, chat, keyConfig);
      const assistantLabel = resolveAssistantName(config);
      const assistantMetadata = resolveAssistantMessageMetadata(config);
      const targetMessage = chat.messages.find((message) => message.id === assistantMessageId);

      if (!targetMessage || targetMessage.role !== 'assistant') {
        throw new Error(t('host.noRetryableAssistantMessage'));
      }

      if (!targetMessage.parentId) {
        throw new Error(t('host.noUserMessageForReply'));
      }

      const futureConversation = getConversationPathToMessage(chat, targetMessage.parentId);
      await validateConversationAttachmentReferences(document, futureConversation);

      const assistantMessage = createMessage('assistant', '', {
        assistantLabel,
        model: assistantMetadata.model,
        providerId: assistantMetadata.providerId,
        optionId: assistantMetadata.optionId,
        status: 'pending'
      });

      let nextChat = activateMessagePath(chat, targetMessage.parentId);
      nextChat = appendMessageToChat(nextChat, targetMessage.parentId, assistantMessage);
      nextChat.modelSelection = {
        providerId: config.providerId,
        modelId: config.model,
        optionId: config.optionId
      };

      await replaceDocumentContent(document, serializeChatFile(nextChat));
      await postState();

      const messagesForModel = getMessagesForModel(getActiveConversationMessages(nextChat));
      const boundPostChunk = (c: string, r: string, content: string, reasoningContent: string) =>
        postChunk(assistantMessage.id, c, r, content, reasoningContent);

      await this.runAssistantRequest(document, assistantMessage.id, messagesForModel, config, boundPostChunk);
    } finally {
      this.busyDocuments.delete(documentKey);
    }
  }

  private async resendMessage(
    document: vscode.TextDocument,
    messageId: string,
    postState: () => Promise<void>,
    postChunk: (
      messageId: string,
      contentDelta: string,
      reasoningDelta: string,
      content: string,
      reasoningContent: string
    ) => void
  ): Promise<void> {
    const currentChat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
    const currentMessage = currentChat.messages.find((message) => message.id === messageId);

    if (currentMessage?.role === 'assistant') {
      await this.retryAssistantMessage(document, messageId, postState, postChunk);
      return;
    }

    this.assertDocumentNotBusy(document);

    const documentKey = document.uri.toString();
    this.busyDocuments.add(documentKey);

    try {
      await postState();

      const chat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
      const keyConfig = await loadKeyConfig(document);
      const config = this.resolveRequestConfig(document, chat, keyConfig);
      const assistantLabel = resolveAssistantName(config);
      const assistantMetadata = resolveAssistantMessageMetadata(config);
      const targetMessage = chat.messages.find((message) => message.id === messageId);

      if (!targetMessage) {
        throw new Error(t('host.noResendableMessage'));
      }

      if (targetMessage.status === 'pending') {
        throw new Error(t('host.pendingCannotResend'));
      }

      if (targetMessage.role !== 'user') {
        throw new Error(t('host.resendUserOrAssistantOnly'));
      }

      if ((targetMessage.childIds?.length ?? 0) === 0) {
        await this.generateAssistantReplyForUserMessage(document, chat, targetMessage.id, postState, postChunk);
        return;
      }

      const targetBody = getMessageCurrentBody(targetMessage);
      const targetAttachments = getMessageCurrentAttachments(targetMessage);
      const userMessage = createMessage('user', getMessageCurrentContent(targetMessage), {
        body: targetBody,
        attachments: targetAttachments,
        status: 'completed'
      });

      const futureConversation = targetMessage.parentId
        ? [...getConversationPathToMessage(chat, targetMessage.parentId), userMessage]
        : [userMessage];

      await validateConversationAttachmentReferences(document, futureConversation);

      const assistantMessage = createMessage('assistant', '', {
        assistantLabel,
        model: assistantMetadata.model,
        providerId: assistantMetadata.providerId,
        optionId: assistantMetadata.optionId,
        status: 'pending'
      });

      let nextChat = targetMessage.parentId ? activateMessagePath(chat, targetMessage.parentId) : chat;
      nextChat = appendMessageToChat(nextChat, targetMessage.parentId, userMessage);
      nextChat = appendMessageToChat(nextChat, userMessage.id, assistantMessage);
      nextChat.modelSelection = {
        providerId: config.providerId,
        modelId: config.model,
        optionId: config.optionId
      };

      await replaceDocumentContent(document, serializeChatFile(nextChat));
      await postState();

      const messagesForModel = getMessagesForModel(getActiveConversationMessages(nextChat));
      const boundPostChunk = (c: string, r: string, content: string, reasoningContent: string) =>
        postChunk(assistantMessage.id, c, r, content, reasoningContent);

      await this.runAssistantRequest(document, assistantMessage.id, messagesForModel, config, boundPostChunk);
    } finally {
      this.busyDocuments.delete(documentKey);
    }
  }

  private async selectSibling(
    document: vscode.TextDocument,
    messageId: string,
    direction: 'previous' | 'next'
  ): Promise<void> {
    this.assertDocumentNotBusy(document);

    const chat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
    const targetMessage = chat.messages.find((message) => message.id === messageId);

    if (!targetMessage) {
      throw new Error(t('host.branchSwitchMessageMissing'));
    }

    const siblingIds = getSiblingIds(chat, targetMessage.parentId);
    if (siblingIds.length <= 1) {
      return;
    }

    const currentIndex = siblingIds.indexOf(targetMessage.id);
    if (currentIndex < 0) {
      throw new Error(t('host.branchStateInvalid'));
    }

    const nextIndex = direction === 'previous' ? currentIndex - 1 : currentIndex + 1;
    if (nextIndex < 0 || nextIndex >= siblingIds.length) {
      return;
    }

    const nextChat = setActiveSiblingSelection(chat, targetMessage.parentId, siblingIds[nextIndex]);
    await replaceDocumentContent(document, serializeChatFile(nextChat));
  }

  private async branchMessage(document: vscode.TextDocument, messageId: string): Promise<void> {
    const chat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
    const activeMessages = getActiveConversationMessages(chat);
    const messageIndex = activeMessages.findIndex((message) => message.id === messageId);

    if (messageIndex < 0) {
      throw new Error(t('host.branchExportMessageMissing'));
    }

    const targetMessage = activeMessages[messageIndex];
    if (targetMessage.status === 'pending') {
      throw new Error(t('host.pendingCannotExportBranch'));
    }

    const branchUri = await getNextBranchFileUri(document.uri);
    const branchChat = createTreeChatFromLinearMessages(
      trimChatFileSuffix(path.basename(branchUri.fsPath)),
      activeMessages.slice(0, messageIndex + 1)
    );
    branchChat.commonConfigId = chat.commonConfigId;
    branchChat.systemPrompt = chat.systemPrompt;
    branchChat.messageTemplate = chat.messageTemplate;
    branchChat.modelSelection = chat.modelSelection;

    await vscode.workspace.fs.writeFile(branchUri, Buffer.from(serializeChatFile(branchChat), 'utf8'));
    await vscode.commands.executeCommand('vscode.openWith', branchUri, VIEW_TYPE);
  }

  private async editMessage(document: vscode.TextDocument, messageId: string, content: string): Promise<void> {
    this.assertDocumentNotBusy(document);

    if (!hasMeaningfulMessageContent(content)) {
      throw new Error(t('host.messageContentRequired'));
    }

    const chat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));

    const targetMessage = chat.messages.find((message) => message.id === messageId);

    if (!targetMessage) {
      throw new Error(t('host.correctMessageMissing'));
    }

    if (targetMessage.status === 'pending') {
      throw new Error(t('host.pendingCannotCorrect'));
    }

    if (isCurrentMessageContent(targetMessage, content)) {
      return;
    }

    const { body, attachments, content: normalizedContent } = await composeUserMessageBody(
      document,
      content,
      []
    );

    if (
      normalizedContent !== content &&
      isCurrentMessageContent(targetMessage, normalizedContent)
    ) {
      return;
    }

    const nextChat = updateMessageById(chat, messageId, (message) => ({
      ...appendMessageVersion(message, normalizedContent, undefined, body, attachments),
      status: 'completed'
    }));
    await replaceDocumentContent(document, serializeChatFile(nextChat));
  }

  private async restoreMessageVersion(document: vscode.TextDocument, messageId: string, versionId: string): Promise<void> {
    this.assertDocumentNotBusy(document);
    const chat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
    const targetMessage = chat.messages.find((message) => message.id === messageId);

    if (!targetMessage) {
      throw new Error(t('host.restoreVersionMessageMissing'));
    }

    if (targetMessage.status === 'pending') {
      throw new Error(t('host.pendingCannotRestoreVersion'));
    }

    const version = findVersionById(targetMessage.versions, versionId);
    if (!version) {
      throw new Error(t('host.restoreVersionNotFound'));
    }

    if (isCurrentMessageVersion(targetMessage, version.id)) {
      return;
    }

    const nextChat = updateMessageById(chat, messageId, (message) => ({
      ...setMessageCurrentVersion(message, version.id),
      status: 'completed'
    }));
    await replaceDocumentContent(document, serializeChatFile(nextChat));
  }

  private async deleteMessageVersion(document: vscode.TextDocument, messageId: string, versionId: string): Promise<void> {
    this.assertDocumentNotBusy(document);
    const chat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
    const targetMessage = chat.messages.find((message) => message.id === messageId);

    if (!targetMessage) {
      throw new Error(t('host.deleteVersionMessageMissing'));
    }

    if (targetMessage.status === 'pending') {
      throw new Error(t('host.pendingCannotDeleteVersion'));
    }

    const versions = targetMessage.versions ?? [];
    if (versions.length <= 1) {
      throw new Error(t('host.deleteVersionKeepOne'));
    }

    if (isCurrentMessageVersion(targetMessage, versionId)) {
      throw new Error(t('host.deleteVersionCurrentBlocked'));
    }

    if (!findVersionById(versions, versionId)) {
      return;
    }

    const version = findVersionById(versions, versionId);
    if (!version) {
      return;
    }

    const versionPreview = getDeletionPreview(version.content);
    const confirmed = await vscode.window.showWarningMessage(
      t('host.deleteVersionPromptTitle'),
      {
        modal: true,
        detail: versionPreview
          ? t('host.deleteVersionDetailWithPreview', { preview: versionPreview })
          : t('host.deleteVersionDetail')
      },
      t('host.deleteVersionButton')
    );

    if (confirmed !== t('host.deleteVersionButton')) {
      return;
    }

    const nextChat = updateMessageById(chat, messageId, (message) => {
      const nextVersions = (message.versions ?? []).filter((version) => version.id !== versionId);
      const nextCurrentVersionId = normalizeCurrentVersionId(message.currentVersionId, nextVersions);
      const nextContent = getMessageCurrentContent({
        ...message,
        versions: nextVersions,
        currentVersionId: nextCurrentVersionId
      });

      return {
        ...message,
        content: nextContent,
        currentVersionId: nextCurrentVersionId,
        versions: nextVersions
      };
    });

    await replaceDocumentContent(document, serializeChatFile(nextChat));
  }

  private async deleteMessageBranch(document: vscode.TextDocument, messageId: string): Promise<void> {
    this.assertDocumentNotBusy(document);

    const chat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
    const targetMessage = chat.messages.find((message) => message.id === messageId);

    if (!targetMessage) {
      throw new Error(t('host.deleteBranchMessageMissing'));
    }

    if (targetMessage.status === 'pending') {
      throw new Error(t('host.pendingCannotDeleteBranch'));
    }

    const branchSize = collectDescendantMessageIds(chat, messageId).size;
    const preview = getDeletionPreview(getMessageCurrentContent(targetMessage));
    const targetLabel = targetMessage.role === 'assistant' ? t('host.deleteBranchTargetLabelAssistant') : t('host.deleteBranchTargetLabelUser');
    const confirmed = await vscode.window.showWarningMessage(
      t('host.deleteBranchPromptTitle'),
      {
        modal: true,
        detail: [
          t('host.deleteBranchDetailFollowups', { target: targetLabel, count: branchSize - 1 }),
          preview ? t('host.deleteBranchDetailPreview', { preview }) : undefined,
          t('host.deleteBranchDetailUndoHint')
        ]
          .filter(Boolean)
          .join('\n')
      },
      t('host.deleteBranchButton')
    );

    if (confirmed !== t('host.deleteBranchButton')) {
      return;
    }

    const nextChat = removeMessageById(chat, messageId);
    await replaceDocumentContent(document, serializeChatFile(nextChat));
  }

  private async rewriteMessageBranch(
    document: vscode.TextDocument,
    messageId: string,
    content: string,
    continueGeneration: boolean,
    postState: () => Promise<void>,
    postChunk: (
      messageId: string,
      contentDelta: string,
      reasoningDelta: string,
      content: string,
      reasoningContent: string
    ) => void
  ): Promise<void> {
    this.assertDocumentNotBusy(document);

    if (!hasMeaningfulMessageContent(content)) {
      throw new Error(t('host.messageContentRequired'));
    }

    const chat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));

    const targetMessage = chat.messages.find((message) => message.id === messageId);

    if (!targetMessage) {
      throw new Error(t('host.rewriteBranchMessageMissing'));
    }

    if (targetMessage.role !== 'user') {
      throw new Error(t('host.rewriteBranchUserOnly'));
    }

    if (targetMessage.status === 'pending') {
      throw new Error(t('host.pendingCannotRewriteBranch'));
    }

    if (isCurrentMessageContent(targetMessage, content)) {
      throw new Error(t('host.rewriteBranchSameContent'));
    }

    const {
      body: rewrittenBody,
      attachments: rewrittenAttachments,
      content: rewrittenContent
    } = await composeUserMessageBody(document, content, []);

    if (
      rewrittenContent !== content &&
      isCurrentMessageContent(targetMessage, rewrittenContent)
    ) {
      throw new Error(t('host.rewriteBranchSameContent'));
    }

    const rewrittenMessage = createMessage('user', rewrittenContent, {
      status: 'completed',
      body: rewrittenBody,
      attachments: rewrittenAttachments
    });

    const futureConversation = targetMessage.parentId
      ? [...getConversationPathToMessage(chat, targetMessage.parentId), rewrittenMessage]
      : [rewrittenMessage];

    await validateConversationAttachmentReferences(document, futureConversation);

    const baseChat = targetMessage.parentId ? activateMessagePath(chat, targetMessage.parentId) : chat;
    const nextChat = appendMessageToChat(baseChat, targetMessage.parentId, rewrittenMessage);

    await replaceDocumentContent(document, serializeChatFile(nextChat));

    if (!continueGeneration) {
      return;
    }

    const documentKey = document.uri.toString();
    this.busyDocuments.add(documentKey);

    try {
      await postState();
      const latest = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
      await this.generateAssistantReplyForUserMessage(document, latest, rewrittenMessage.id, postState, postChunk);
    } finally {
      this.busyDocuments.delete(documentKey);
    }
  }

  private async generateAssistantReplyForUserMessage(
    document: vscode.TextDocument,
    chat: ChatFile,
    userMessageId: string,
    postState: () => Promise<void>,
    postChunk: (
      messageId: string,
      contentDelta: string,
      reasoningDelta: string,
      content: string,
      reasoningContent: string
    ) => void
  ): Promise<void> {
    const keyConfig = await loadKeyConfig(document);
    const config = this.resolveRequestConfig(document, chat, keyConfig);
    const assistantLabel = resolveAssistantName(config);
    const assistantMetadata = resolveAssistantMessageMetadata(config);

    const futureConversation = getConversationPathToMessage(chat, userMessageId);
    await validateConversationAttachmentReferences(document, futureConversation);

    const assistantMessage = createMessage('assistant', '', {
      assistantLabel,
      model: assistantMetadata.model,
      providerId: assistantMetadata.providerId,
      optionId: assistantMetadata.optionId,
      status: 'pending'
    });

    let nextChat = activateMessagePath(chat, userMessageId);
    nextChat = appendMessageToChat(nextChat, userMessageId, assistantMessage);
    nextChat.modelSelection = {
      providerId: config.providerId,
      modelId: config.model,
      optionId: config.optionId
    };

    await replaceDocumentContent(document, serializeChatFile(nextChat));
    await postState();

    const messagesForModel = getMessagesForModel(getActiveConversationMessages(nextChat));
    const boundPostChunk = (c: string, r: string, content: string, reasoningContent: string) =>
      postChunk(assistantMessage.id, c, r, content, reasoningContent);

    await this.runAssistantRequest(document, assistantMessage.id, messagesForModel, config, boundPostChunk);
  }

  private async runAssistantRequest(
    document: vscode.TextDocument,
    assistantMessageId: string,
    messagesForModel: ChatMessage[],
    config: ResolvedModelConfig,
    postChunk: (contentDelta: string, reasoningDelta: string, content: string, reasoningContent: string) => void
  ): Promise<void> {
    const documentKey = document.uri.toString();
    const abortController = new AbortController();
    const wasClosedDuringGeneration = (): boolean => this.closingAbortControllers.has(abortController);
    const requestMutex = this.getDocumentRequestMutex(document);
    this.activeAbortControllers.set(documentKey, abortController);
    const getLatestSnapshot = (): StreamSnapshot | undefined => {
      const latestSnapshot = this.streamDataByDocument.get(documentKey)?.latestSnapshot;
      if (!latestSnapshot || latestSnapshot.messageId !== assistantMessageId) {
        return undefined;
      }

      return latestSnapshot;
    };

    try {
      const latest = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
      const commonConfigs = await loadCommonConfigs(document);

      const assistantResponse = await requestMutex.runExclusive(async () =>
        requestCompletionStreaming(document, config, messagesForModel, postChunk, abortController.signal, latest, commonConfigs)
      );

      if (wasClosedDuringGeneration()) {
        return;
      }

      // Flush any pending throttled stream chunks and wait for the queue to drain
      const streamData = this.streamDataByDocument.get(documentKey);
      streamData?.flush();
      await streamData?.queue;

      const latestAfter = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
      const assistantMetadata = resolveAssistantMessageMetadata(config);
      const assistantBody = await createMessageBodyFromAssistantContent(document, assistantResponse.content);

      const nextChat = updateMessageById(latestAfter, assistantMessageId, (message) => ({
        ...setMessageCurrentStructuredContent(message, assistantBody.body, assistantBody.attachments, assistantBody.content, undefined, {
          reasoningContent: assistantResponse.reasoningContent,
          thinkingDurationMs: assistantResponse.thinkingDurationMs,
          totalDurationMs: assistantResponse.totalDurationMs,
          tokenStats: assistantResponse.tokenStats,
          model: assistantMetadata.model,
          providerId: assistantMetadata.providerId,
          optionId: assistantMetadata.optionId
        }),
        model: assistantMetadata.model,
        providerId: assistantMetadata.providerId,
        optionId: assistantMetadata.optionId,
        reasoningContent: assistantResponse.reasoningContent,
        thinkingDurationMs: assistantResponse.thinkingDurationMs,
        totalDurationMs: assistantResponse.totalDurationMs,
        tokenStats: assistantResponse.tokenStats,
        status: 'completed'
      }));
      await replaceDocumentContent(document, serializeChatFile(nextChat));
    } catch (error) {
      if (wasClosedDuringGeneration()) {
        return;
      }

      const streamData = this.streamDataByDocument.get(documentKey);
      streamData?.flush();
      await streamData?.queue;

      const latest = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
      const latestSnapshot = getLatestSnapshot();

      if (isRequestCanceledError(error)) {
        if (latest.messages.some((message) => message.id === assistantMessageId)) {
          const partialContent = error.partialContent || latestSnapshot?.content || '';
          const partialReasoning = error.partialReasoning || latestSnapshot?.reasoningContent || '';
          const hasVisibleOutput = partialContent.trim().length > 0 || partialReasoning.trim().length > 0;

          const nextChat = updateMessageById(latest, assistantMessageId, (message) => {
            if (!hasVisibleOutput) {
              return {
                ...message,
                reasoningContent: undefined,
                status: 'canceled'
              };
            }

            const nextReasoningContent = partialReasoning || undefined;
            const updatedMessage = setMessageCurrentContent(message, partialContent, undefined, {
              ...(nextReasoningContent !== undefined ? { reasoningContent: nextReasoningContent } : {})
            });

            return {
              ...updatedMessage,
              reasoningContent: nextReasoningContent,
              status: 'completed'
            };
          });
          await replaceDocumentContent(document, serializeChatFile(nextChat));
        }

        return;
      }

      if (latest.messages.some((message) => message.id === assistantMessageId)) {
        const nextChat = updateMessageById(latest, assistantMessageId, (message) => {
          const partialContent = latestSnapshot?.content || '';
          const partialReasoning = latestSnapshot?.reasoningContent || '';
          const hasVisibleOutput = partialContent.trim().length > 0 || partialReasoning.trim().length > 0;

          if (!hasVisibleOutput) {
            return {
              ...message,
              reasoningContent: undefined,
              status: 'error',
              errorDetail: toErrorMessage(error)
            };
          }

          const nextReasoningContent = partialReasoning || undefined;
          const updatedMessage = setMessageCurrentContent(message, partialContent, undefined, {
            ...(nextReasoningContent !== undefined ? { reasoningContent: nextReasoningContent } : {})
          });

          return {
            ...updatedMessage,
            reasoningContent: nextReasoningContent,
            status: 'completed'
          };
        });
        await replaceDocumentContent(document, serializeChatFile(nextChat));
        // The error is surfaced inside the assistant message bubble (and persisted to
        // the chat file), so we deliberately do not rethrow to avoid a duplicate popup.
        return;
      }

      throw error;
    } finally {
      this.closingAbortControllers.delete(abortController);
      const current = this.activeAbortControllers.get(documentKey);
      if (current === abortController) {
        this.activeAbortControllers.delete(documentKey);
      }
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const assetVersion = encodeURIComponent(`${Date.now()}`);
    const codiconStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'vendor', 'codicons', 'codicon.css').with({
        query: `v=${assetVersion}`
      })
    );
    const katexStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'vendor', 'katex', 'katex.min.css').with({
        query: `v=${assetVersion}`
      })
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'dist', 'webview.js').with({ query: `v=${assetVersion}` })
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.css').with({ query: `v=${assetVersion}` })
    );

    return `<!DOCTYPE html>
<html lang="${getLocale()}">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} https: http: data:; style-src ${webview.cspSource}; style-src-elem ${webview.cspSource}; style-src-attr 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${codiconStyleUri}" />
    <link rel="stylesheet" href="${katexStyleUri}" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>One File Chat</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

