import { CookieJar } from "./cookieJar.js";

/**
 * Base class for web-session packs. A pack drives an unofficial web endpoint
 * using the user's own browser session (cookies) or OAuth tokens.
 */
export abstract class WebSessionProvider {
  protected jar = new CookieJar();

  abstract readonly id: string;
  abstract readonly name: string;

  /** Load a session from env (cookie export or token). Implemented per pack. */
  abstract loadSession(env: NodeJS.ProcessEnv): void;

  protected authedFetch(url: string, init: RequestInit = {}, fetchFn: typeof fetch = fetch): Promise<Response> {
    const cookie = this.jar.headerFor(url);
    const headers = new Headers(init.headers);
    if (cookie) headers.set("cookie", cookie);
    return fetchFn(url, { ...init, headers });
  }
}
