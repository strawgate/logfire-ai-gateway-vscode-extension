import {
  type AuthenticationProvider,
  type AuthenticationProviderAuthenticationSessionsChangeEvent,
  type AuthenticationProviderSessionOptions,
  type AuthenticationSession,
  authentication,
  type Disposable,
  type Event,
  EventEmitter,
  type ExtensionContext,
  window,
} from "vscode";
import { ERROR_MESSAGES, EXTENSION_ID } from "./constants";
import { logger } from "./logger";

export const LOGFIRE_AUTH_PROVIDER_ID = EXTENSION_ID;

const SESSIONS_SECRET_KEY = `${LOGFIRE_AUTH_PROVIDER_ID}.sessions`;
const ACTIVE_SESSION_KEY = `${LOGFIRE_AUTH_PROVIDER_ID}.activeSession`;

interface SessionData {
  id: string;
  accessToken: string;
  account: { id: string; label: string };
  scopes: readonly string[];
}

export class LogfireAuthenticationProvider
  implements AuthenticationProvider, Disposable
{
  private _sessionChangeEmitter =
    new EventEmitter<AuthenticationProviderAuthenticationSessionsChangeEvent>();
  private _disposable: Disposable;

  constructor(private readonly context: ExtensionContext) {
    this._disposable = authentication.registerAuthenticationProvider(
      EXTENSION_ID,
      "Logfire AI Gateway",
      this,
      { supportsMultipleAccounts: false },
    );
  }

  get onDidChangeSessions(): Event<AuthenticationProviderAuthenticationSessionsChangeEvent> {
    return this._sessionChangeEmitter.event;
  }

  dispose(): void {
    this._disposable.dispose();
    this._sessionChangeEmitter.dispose();
  }

  async getSessions(
    _scopes?: readonly string[],
    _options?: AuthenticationProviderSessionOptions,
  ): Promise<AuthenticationSession[]> {
    const sessions = await this.getSessionsData();
    logger.info(
      `getSessions called: found ${sessions.length} stored session(s)`,
    );

    // Sort sessions so the active session comes first
    const activeSessionId = await this.getActiveSessionId();
    const sortedSessions = [...sessions].sort((a, b) => {
      if (a.id === activeSessionId) return -1;
      if (b.id === activeSessionId) return 1;
      return 0;
    });

    return sortedSessions.map((session) => ({
      id: session.id,
      accessToken: session.accessToken,
      account: session.account,
      scopes: [...session.scopes],
    }));
  }

  async createSession(_scopes: readonly string[]): Promise<AuthenticationSession> {
    const sessionName = await this.promptForSessionName();
    if (!sessionName) {
      throw new Error("Session name required");
    }

    const apiKey = await this.promptForApiKey();
    if (!apiKey) {
      throw new Error("API key required");
    }

    const session: SessionData = {
      id: this.generateSessionId(),
      accessToken: apiKey,
      account: { id: "logfire-user", label: sessionName },
      scopes: [],
    };

    await this.storeSession(session);
    return session;
  }

  async removeSession(sessionId: string): Promise<void> {
    const sessions = await this.getSessionsData();
    const index = sessions.findIndex((s) => s.id === sessionId);

    if (index === -1) {
      return;
    }

    const [removed] = sessions.splice(index, 1);
    await this.context.secrets.store(
      SESSIONS_SECRET_KEY,
      JSON.stringify(sessions),
    );

    const activeSessionId = await this.getActiveSessionId();
    if (activeSessionId === sessionId) {
      const newActiveSession = sessions.length > 0 ? sessions[0].id : null;
      await this.setActiveSession(newActiveSession);
    }

    const removedAuthSession: AuthenticationSession = {
      id: removed.id,
      accessToken: removed.accessToken,
      account: removed.account,
      scopes: [...removed.scopes],
    };
    this._sessionChangeEmitter.fire({
      added: [],
      removed: [removedAuthSession],
      changed: [],
    });
    window.showInformationMessage("Session removed");
  }

  /**
   * Get the active session's API key directly from secrets storage.
   * Bypasses authentication.getSession's consent model which returns undefined
   * for silent lookups until the user explicitly grants access via the VS Code
   * accounts UI — even when the session already exists in our own provider.
   */
  async getActiveToken(): Promise<string | undefined> {
    const sessions = await this.getSessionsData();
    if (sessions.length === 0) return undefined;
    const activeId = await this.getActiveSessionId();
    const session = sessions.find((s) => s.id === activeId) ?? sessions[0];
    return session?.accessToken;
  }

  /**
   * Programmatically store a credential — used by E2E tests to inject
   * credentials without going through the interactive UI.
   */
  async storeTestCredential(apiKey: string, label = "Test"): Promise<void> {
    const session: SessionData = {
      id: this.generateSessionId(),
      accessToken: apiKey,
      account: { id: "test-user", label },
      scopes: [],
    };
    await this.storeSession(session);
  }

  async manageAuthentication(): Promise<void> {
    try {
      const sessions = await this.getSessionsData();
      if (sessions.length === 0) {
        await this.createSession([]);
        return;
      }

      const action = await this.promptForAction(sessions);
      await this.executeAction(action, sessions);
    } catch (error) {
      logger.error("Error in manage authentication:", error);
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred";
      window.showErrorMessage(
        `Authentication management failed: ${errorMessage}`,
      );
    }
  }

  private async storeSession(session: SessionData): Promise<void> {
    const existingSessions = await this.getSessionsData();
    const sessions = [...existingSessions, session];
    await this.context.secrets.store(
      SESSIONS_SECRET_KEY,
      JSON.stringify(sessions),
    );

    await this.setActiveSession(session.id);

    this._sessionChangeEmitter.fire({
      added: [session],
      removed: [],
      changed: [],
    });
    window.showInformationMessage("Authentication successful!");
  }

  private async getSessionsData(): Promise<SessionData[]> {
    const stored = await this.context.secrets.get(SESSIONS_SECRET_KEY);
    if (!stored) {
      return [];
    }

    try {
      return JSON.parse(stored) as SessionData[];
    } catch {
      await this.context.secrets.delete(SESSIONS_SECRET_KEY);
      return [];
    }
  }

  private async promptForSessionName(): Promise<string | undefined> {
    return window.showInputBox({
      prompt: "Enter a name for this session",
      placeHolder: "e.g., Personal, Work, Project Name",
      ignoreFocusOut: true,
      validateInput: (value) => (!value?.trim() ? "Session name required" : null),
    });
  }

  private async promptForApiKey(): Promise<string | undefined> {
    return window.showInputBox({
      prompt: "Enter your Logfire AI Gateway API key",
      password: true,
      placeHolder: "Your gateway API key...",
      ignoreFocusOut: true,
      validateInput: (value) =>
        !value?.trim() ? "API key required" : null,
    });
  }

  private generateSessionId(): string {
    return `${EXTENSION_ID}-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  private async getActiveSessionId(): Promise<string | null> {
    return this.context.globalState.get(ACTIVE_SESSION_KEY, null);
  }

  private async setActiveSession(sessionId: string | null): Promise<void> {
    await this.context.globalState.update(ACTIVE_SESSION_KEY, sessionId);
  }

  private async promptForAction(
    sessions: SessionData[],
  ): Promise<string | undefined> {
    const activeSession = sessions.find(
      (s) => s.id === (this.context.globalState.get(ACTIVE_SESSION_KEY) ?? sessions[0]?.id),
    );
    const activeSessionName = activeSession?.account.label ?? "None";

    const options = [{ label: "Add new authentication", value: "add" }];
    if (sessions.length > 1) {
      options.push({ label: "Switch active session", value: "switch" });
    }
    options.push(
      { label: "Remove session", value: "remove" },
      { label: "Cancel", value: "cancel" },
    );

    const result = await window.showQuickPick(options, {
      placeHolder: `Active session: ${activeSessionName} - Choose an action`,
    });
    return result?.value;
  }

  private async executeAction(
    action: string | undefined,
    sessions: SessionData[],
  ): Promise<void> {
    if (!action || action === "cancel") {
      return;
    }

    switch (action) {
      case "add":
        await this.createSession([]);
        break;
      case "switch":
        await this.switchActiveSession(sessions);
        break;
      case "remove":
        await this.handleRemoveSession(sessions);
        break;
    }
  }

  private async switchActiveSession(sessions: SessionData[]): Promise<void> {
    if (sessions.length <= 1) {
      window.showInformationMessage(
        "You need at least 2 sessions to switch between them.",
      );
      return;
    }

    const activeSessionId = await this.getActiveSessionId();
    const options = sessions.map((s) => ({
      label: s.account.label,
      description: s.id === activeSessionId ? "(currently active)" : "",
      value: s.id,
    }));

    const selected = await window.showQuickPick(options, {
      placeHolder: "Select session to activate",
    });

    if (!selected || selected.value === activeSessionId) {
      return;
    }

    await this.setActiveSession(selected.value);

    const selectedSession = sessions.find((s) => s.id === selected.value);
    if (selectedSession) {
      const authSession: AuthenticationSession = {
        id: selectedSession.id,
        accessToken: selectedSession.accessToken,
        account: selectedSession.account,
        scopes: [...selectedSession.scopes],
      };
      this._sessionChangeEmitter.fire({
        added: [],
        removed: [],
        changed: [authSession],
      });
    }
    window.showInformationMessage(
      `Switched to: ${selectedSession?.account.label}`,
    );
  }

  private async handleRemoveSession(sessions: SessionData[]): Promise<void> {
    if (sessions.length === 1) {
      await this.removeSession(sessions[0].id);
      return;
    }

    const selected = await window.showQuickPick(
      sessions.map((s) => ({
        label: s.account.label,
        value: s.id,
      })),
      { placeHolder: "Select session to remove" },
    );
    if (selected) {
      await this.removeSession(selected.value);
    }
  }
}
