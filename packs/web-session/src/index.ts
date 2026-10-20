export { CookieJar } from "./cookieJar.js";
export type { Cookie } from "./cookieJar.js";
export { OAuth2Client } from "./oauth2.js";
export type { OAuth2Config } from "./oauth2.js";
export { DeviceFlowClient } from "./deviceFlow.js";
export type { DeviceFlowConfig, DeviceAuthResponse, DeviceTokenResponse } from "./deviceFlow.js";
export { generatePkce } from "./oauth2.js";
export type { PkcePair } from "./oauth2.js";
export { CookieChatDriver } from "./cookieChat.js";
export type { ChatMessage, CookieChatConfig } from "./cookieChat.js";
export { saveSession, loadSession, listSessions, deleteSession, sessionsDir } from "./sessionStore.js";
export type { SavedSession } from "./sessionStore.js";
export { WebSessionProvider } from "./base.js";
export { PACKS, AntigravityWeb, ClaudeWeb, ChatGptWeb, CopilotWeb, GrokWeb } from "./packs/index.js";
export type { WebSessionPack } from "./packs/index.js";
export {
  ANTIGRAVITY_PUBLIC_CLIENT_ID,
  ANTIGRAVITY_PUBLIC_CLIENT_SECRET,
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  ANTIGRAVITY_SCOPES,
  ANTIGRAVITY_RUNTIME_BASE_URLS,
  ANTIGRAVITY_BOOTSTRAP_BASE_URL,
  buildAuthUrl,
  exchangeCode,
  refreshAccessToken,
  loadCodeAssist,
  onboardUser,
  ensureProjectId,
  buildIdeMetadata,
  buildFingerprintHeaders,
  buildOnboardPayload,
  extractProjectId,
  resolveAntigravityPlatformEnum,
  ANTIGRAVITY_SESSION_NAME,
  saveAntigravitySession,
  loadAntigravitySession,
  getValidAccessToken,
  loginWithRefreshToken,
  loginWithLoopback,
  completeLoginWithCode,
  fetchAccountEmail,
} from "./providers/antigravity.js";
export type { AntigravityTokens, LoadCodeAssistResult, AntigravitySession } from "./providers/antigravity.js";
export {
  CLAUDE_PUBLIC_CLIENT_ID,
  CLAUDE_AUTH_URL,
  CLAUDE_TOKEN_URL,
  CLAUDE_SCOPES,
  CLAUDE_SESSION_NAME,
  buildAuthUrl as buildClaudeAuthUrl,
  exchangeCode as exchangeClaudeCode,
  refreshAccessToken as refreshClaudeAccessToken,
  saveClaudeSession,
  loadClaudeSession,
  getValidAccessToken as getValidClaudeAccessToken,
  loginWithRefreshToken as loginClaudeWithRefreshToken,
  loginWithLoopback as loginClaudeWithLoopback,
  completeLoginWithCode as completeClaudeLoginWithCode,
} from "./providers/claude.js";
export {
  CODEX_PUBLIC_CLIENT_ID,
  CODEX_AUTH_URL,
  CODEX_TOKEN_URL,
  CODEX_SCOPES,
  CODEX_SESSION_NAME,
  buildAuthUrl as buildCodexAuthUrl,
  exchangeCode as exchangeCodexCode,
  refreshAccessToken as refreshCodexAccessToken,
  extractAccountIdFromIdToken as extractCodexAccountId,
  saveCodexSession,
  loadCodexSession,
  getValidAccessToken as getValidCodexAccessToken,
  loginWithRefreshToken as loginCodexWithRefreshToken,
  loginWithLoopback as loginCodexWithLoopback,
  completeLoginWithCode as completeCodexLoginWithCode,
} from "./providers/codex.js";
export {
  CURSOR_SESSION_NAME,
  generateCursorAuthParams,
  pollCursorAuthOnce,
  refreshCursorToken,
  importCursorTokens,
  saveCursorSession,
  loadCursorSession,
  getValidCursorAccessToken,
  loginCursorWithBrowser,
  cursorJwtIdentity,
  cursorSessionMeta,
  CURSOR_POLL_URL,
  CURSOR_REFRESH_URL,
} from "./providers/cursor.js";
export {
  KIRO_SESSION_NAME,
  startKiroDeviceFlow,
  pollKiroDeviceTokenOnce,
  refreshKiroSsoToken,
  startKiroSocialDeviceFlow,
  pollKiroSocialDeviceOnce,
  refreshKiroSocialToken,
  importKiroToken,
  loginKiroBuilderId,
  loginKiroSocial,
  loadKiroSession,
  getValidKiroAccessToken,
  kiroSessionMeta,
  kiroSocialClientId,
} from "./providers/kiro.js";
export {
  TRAE_SESSION_NAME,
  TRAE_AUTH_SCHEME,
  importTraeToken,
  loadTraeSession,
  getTraeToken,
  traeJwtExpiryMs,
} from "./providers/trae.js";
export {
  ZED_HOSTED_SESSION_NAME,
  createZedNativeAuthData,
  decryptZedAccessToken,
  parseZedCallbackPayload,
  fetchZedUser,
  fetchZedLlmToken,
  saveZedHostedSession,
  loadZedHostedSession,
  zedSessionMeta,
  completeZedLogin,
  startZedLogin,
  loginZedWithPastedCallback,
} from "./providers/zedHosted.js";
export {
  CLINEPASS_SESSION_NAME,
  CLINEPASS_EXTRA_HEADERS,
  buildClinePassAuthUrl,
  decodeClinePassCode,
  exchangeClinePassCode,
  refreshClinePassToken,
  saveClinePassSession,
  loadClinePassSession,
  isClinePassByok,
  importClinePassKey,
  getValidClinePassAccessToken,
  loginClinePassWithBrowser,
} from "./providers/clinepass.js";
export {
  GITHUB_COPILOT_PUBLIC_CLIENT_ID,
  GITHUB_COPILOT_SCOPE,
  GITHUB_DEVICE_CODE_URL,
  GITHUB_TOKEN_URL,
  GITHUB_USER_INFO_URL,
  GITHUB_COPILOT_TOKEN_URL,
  GITHUB_COPILOT_CHAT_BASE_URL,
  GITHUB_COPILOT_SESSION_NAME,
  GHE_COPILOT_SESSION_NAME,
  COPILOT_API_VERSION,
  COPILOT_INTEGRATION_ID,
  githubCopilotClientId,
  copilotEndpoints,
  copilotCliVersion,
  copilotMachineId,
  buildCopilotChatHeaders,
  buildCopilotRefreshHeaders,
  exchangeCopilotToken,
  refreshGitHubAccessToken,
  CopilotLoginRequiredError,
  copilotTokenFresh,
  sessionNameFor,
  refreshCopilotToken,
  fetchCopilotAccount,
  saveCopilotSession,
  loginWithDeviceFlow,
} from "./providers/githubCopilot.js";
export type { CopilotKind, CopilotEndpoints, CopilotToken } from "./providers/githubCopilot.js";
export {
  CODEBUDDY_CN_CONFIG,
  loginCodeBuddyCn,
  loadCodeBuddyCnSession,
  refreshCodeBuddyCnToken,
} from "./providers/codebuddy-cn.js";
export {
  CODEBUDDY_INTL_CONFIG,
  loginCodeBuddyIntl,
  loadCodeBuddyIntlSession,
  refreshCodeBuddyIntlToken,
} from "./providers/codebuddy-intl.js";
export {
  WORKBUDDY_CONFIG,
  loginWorkBuddy,
  loadWorkBuddySession,
  refreshWorkBuddyToken,
} from "./providers/workbuddy.js";
export {
  requestTencentDeviceCode,
  pollTencentTokenOnce,
  pollTencentToken,
  loginWithTencentDevice,
  refreshTencentToken,
} from "./providers/tencentPluginAuth.js";
export type { TencentPluginAuthConfig, TencentTokens, TencentDeviceCode } from "./providers/tencentPluginAuth.js";
export {
  GROK_PUBLIC_CLIENT_ID,
  GROK_OAUTH_ISSUER,
  GROK_DEVICE_CODE_URL as GROK_CLI_DEVICE_CODE_URL,
  GROK_TOKEN_URL as GROK_CLI_TOKEN_URL,
  GROK_OAUTH_SCOPES,
  grokClientId,
  grokOAuthHeaders,
  requestGrokDeviceCode,
  pollGrokTokenOnce,
  loginWithGrokDevice,
  refreshGrokToken,
  parseGrokAuthJson,
  importGrokAuthJson,
  saveGrokSession,
  loadGrokSession,
} from "./providers/grok-cli.js";
export type { GrokDeviceCode, GrokTokens } from "./providers/grok-cli.js";
export {
  OPENFERENCE_PUBLIC_CLIENT_ID,
  openferenceClientId,
  buildOpenferenceAuthUrl,
  exchangeOpenferenceCode,
  refreshOpenferenceToken,
  decodeOpenferenceIdTokenIdentity,
  saveOpenferenceSession,
  loadOpenferenceSession,
  loginOpenferenceWithLoopback,
} from "./providers/openference.js";
export type { OpenferenceTokens } from "./providers/openference.js";
export {
  GITLAB_DUO_SCOPE,
  gitlabBase,
  gitlabClientId,
  gitlabClientSecret,
  gitlabEndpoints,
  buildGitLabAuthUrl,
  exchangeGitLabCode,
  refreshGitLabToken,
  postExchangeGitLab,
  saveGitLabSession,
  loadGitLabSession,
  loginGitLabWithLoopback,
} from "./providers/gitlab-duo.js";
export type { GitLabTokens, GitLabDirectAccess } from "./providers/gitlab-duo.js";
export {
  AGY_SESSION_NAME,
  buildAgyAuthUrl,
  saveAgySession,
  loadAgySession,
  loginAgyWithRefreshToken,
  loginAgyWithLoopback,
  completeAgyLoginWithCode,
  getValidAgyAccessToken,
} from "./providers/agy.js";
export {
  DEVIN_DESKTOP_BASE_URL,
  validateImportToken as validateDevinDesktopToken,
  saveDevinDesktopToken,
  loadDevinDesktopSession,
} from "./providers/devin-desktop.js";
export {
  WEBCHAT_DRIVERS,
  WEBCHAT_DRIVER_IDS,
  isWebChatProvider,
  createWebChatDriver,
  webchatCookieInfo,
} from "./providers/webchat/index.js";
export { WebChatError } from "./providers/webchat/types.js";
export type { WebChatDriver, WebChatDriverCtor } from "./providers/webchat/types.js";
