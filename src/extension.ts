import * as vscode from 'vscode';
import { setLocale, normalizeLocale, t } from './shared/i18n';
import {
  CHAT_DATA_DIRECTORY_GLOB,
  CHAT_FILE_GLOB,
  SESSIONS_VIEW_VISIBILITY_CONTEXT,
  VIEW_TYPE,
  toErrorMessage
} from './host/chat';
import type {
  ChatSessionSummary,
  ChatSessionTreeNode
} from './host/chat';
import { OneFileChatEditorProvider } from './host/editorProvider';
import {
  ChatSessionsProvider,
  OPEN_CHAT_SESSION_FROM_TREE_COMMAND,
  closeChatEditors,
  confirmDeleteChatSessions,
  createNewChatFile,
  getActiveChatEditorDocumentUri,
  manageCommonConfigCommand,
  manageProviderConfigCommand,
  regenerateChatTitle,
  renameChatTitle,
  reopenActiveChatTextEditorIfNeeded,
  resolveDeleteChatSessionTargets,
  resolveRawJsonTargetUri,
  resolveSingleSessionCommandTargetUri
} from './host/sessionTree';

export function activate(context: vscode.ExtensionContext): void {
  setLocale(normalizeLocale(vscode.env.language));
  const provider = new OneFileChatEditorProvider(context);
  const sessionsProvider = new ChatSessionsProvider();
  void vscode.commands.executeCommand('setContext', SESSIONS_VIEW_VISIBILITY_CONTEXT, false);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  );

  queueMicrotask(() => {
    void reopenActiveChatTextEditorIfNeeded();
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('onefilechat.newChatFile', async () => {
      await createNewChatFile(getActiveChatEditorDocumentUri());
    })
  );

  const sessionsTreeView = vscode.window.createTreeView<ChatSessionTreeNode>('onefilechat.sessionsView', {
    treeDataProvider: sessionsProvider,
    canSelectMany: true,
    showCollapseAll: true
  });
  context.subscriptions.push(sessionsTreeView);

  let pendingSessionPreviewOpen: ReturnType<typeof setTimeout> | undefined;
  const scheduleSessionPreviewOpen = (targetSessionUri: vscode.Uri) => {
    if (pendingSessionPreviewOpen !== undefined) {
      clearTimeout(pendingSessionPreviewOpen);
      pendingSessionPreviewOpen = undefined;
    }

    pendingSessionPreviewOpen = setTimeout(() => {
      pendingSessionPreviewOpen = undefined;

      if (sessionsTreeView.selection.length !== 1) {
        return;
      }

      const currentSelection = sessionsTreeView.selection[0];
      if (currentSelection.kind !== 'session' || currentSelection.uri.toString() !== targetSessionUri.toString()) {
        return;
      }

      void vscode.commands.executeCommand('vscode.openWith', targetSessionUri, VIEW_TYPE, {
        preview: true,
        preserveFocus: true
      });
    }, 120);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_CHAT_SESSION_FROM_TREE_COMMAND, (targetSessionUri?: vscode.Uri) => {
      if (!targetSessionUri) {
        return;
      }

      scheduleSessionPreviewOpen(targetSessionUri);
    })
  );

  context.subscriptions.push(
    sessionsTreeView.onDidChangeSelection((event) => {
      if (pendingSessionPreviewOpen !== undefined) {
        clearTimeout(pendingSessionPreviewOpen);
        pendingSessionPreviewOpen = undefined;
      }

      if (event.selection.length !== 1) {
        return;
      }

      const selectedItem = event.selection[0];
      if (selectedItem.kind !== 'session') {
        return;
      }

      const targetSessionUri = selectedItem.uri;
      scheduleSessionPreviewOpen(targetSessionUri);
    })
  );
  context.subscriptions.push({
    dispose: () => {
      if (pendingSessionPreviewOpen !== undefined) {
        clearTimeout(pendingSessionPreviewOpen);
      }
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('onefilechat.refreshSessions', async () => {
      await sessionsProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('onefilechat.renameChatTitle', async (item?: ChatSessionSummary, selectedItems?: readonly ChatSessionTreeNode[]) => {
      const targetUri = resolveSingleSessionCommandTargetUri(item, selectedItems, t('host.noChatToRename'));
      if (!targetUri) {
        return;
      }

      try {
        await renameChatTitle(targetUri);
        await sessionsProvider.upsertSession(targetUri);
      } catch (error) {
        const message = toErrorMessage(error);
        void vscode.window.showErrorMessage(message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('onefilechat.regenerateChatTitle', async (item?: ChatSessionSummary, selectedItems?: readonly ChatSessionTreeNode[]) => {
      const targetUri = resolveSingleSessionCommandTargetUri(item, selectedItems, t('host.noChatToRegenerateTitle'));
      if (!targetUri) {
        return;
      }

      try {
        const didChange = await regenerateChatTitle(targetUri);
        if (!didChange) {
          void vscode.window.showInformationMessage(t('host.titleSameAsCurrentInfo'));
          return;
        }

        await sessionsProvider.upsertSession(targetUri);
      } catch (error) {
        const message = toErrorMessage(error);
        void vscode.window.showErrorMessage(message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('onefilechat.deleteChatSession', async (item?: ChatSessionSummary, selectedItems?: readonly ChatSessionTreeNode[]) => {
      try {
        const targets = await resolveDeleteChatSessionTargets(item, selectedItems, sessionsTreeView.selection, sessionsProvider);
        if (targets.length === 0) {
          void vscode.window.showInformationMessage(t('host.noChatToDelete'));
          return;
        }

        const confirmed = await confirmDeleteChatSessions(targets);
        if (!confirmed) {
          return;
        }

        await closeChatEditors(targets.map((target) => target.uri));
        for (const target of targets) {
          await vscode.workspace.fs.delete(target.uri, { useTrash: false });
        }

        await sessionsProvider.refresh();
      } catch (error) {
        const message = toErrorMessage(error);
        void vscode.window.showErrorMessage(message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('onefilechat.manageProviderConfig', async (resourceUri?: vscode.Uri) => {
      await manageProviderConfigCommand(resourceUri);
      await sessionsProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('onefilechat.manageCommonConfig', async (resourceUri?: vscode.Uri) => {
      await manageCommonConfigCommand(resourceUri);
      await sessionsProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('onefilechat.viewRawChatJson', async (item?: ChatSessionSummary | vscode.Uri) => {
      const target = resolveRawJsonTargetUri(item);
      if (!target) {
        void vscode.window.showWarningMessage(t('host.noChatFileToView'));
        return;
      }
      try {
        const document = await vscode.workspace.openTextDocument(target);
        await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
      } catch (error) {
        void vscode.window.showErrorMessage(toErrorMessage(error));
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void sessionsProvider.refresh();
    })
  );

  const watcher = vscode.workspace.createFileSystemWatcher(CHAT_FILE_GLOB);
  const chatDirectoryWatcher = vscode.workspace.createFileSystemWatcher(CHAT_DATA_DIRECTORY_GLOB);
  const refreshSessions = () => {
    void sessionsProvider.refresh();
  };
  const upsertSession = (uri: vscode.Uri) => {
    void sessionsProvider.upsertSession(uri);
  };
  const removeSession = (uri: vscode.Uri) => {
    void sessionsProvider.removeSession(uri);
  };
  context.subscriptions.push(watcher);
  context.subscriptions.push(chatDirectoryWatcher);
  context.subscriptions.push(watcher.onDidCreate(upsertSession));
  context.subscriptions.push(watcher.onDidChange(upsertSession));
  context.subscriptions.push(watcher.onDidDelete(removeSession));
  context.subscriptions.push(chatDirectoryWatcher.onDidCreate(refreshSessions));
  context.subscriptions.push(chatDirectoryWatcher.onDidDelete(refreshSessions));

  void sessionsProvider.refresh();
}

export function deactivate(): void {}

