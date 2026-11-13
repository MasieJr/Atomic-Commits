import { ApiError } from "../errors/api-error";

export interface EmailVerification {
  sendCode(email: string): Promise<void>;
  verifyCode(email: string, code: string): Promise<void>;
}

export function createSupabaseEmailVerification(url: string, key: string): EmailVerification {
  const base = new URL(url);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/" || !key.trim()) {
    throw new Error("SUPABASE_URL must be an HTTPS origin.");
  }
  const origin = base.origin;

  async function request(path: string, body: object): Promise<Response> {
    try {
      return await fetch(`${origin}/auth/v1/${path}`, {
        method: "POST",
        redirect: "error",
        headers: { apikey: key, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ApiError(503, "Email verification is temporarily unavailable.", "EMAIL_SERVICE_UNAVAILABLE");
    }
  }

  async function sendCode(email: string): Promise<void> {
    const response = await request("otp", { email, create_user: true });
    if (response.status === 429) throw new ApiError(429, "Please wait before requesting another code.", "EMAIL_RATE_LIMITED");
    if (!response.ok) throw new ApiError(503, "Unable to send a verification code. Please try again later.", "EMAIL_SERVICE_UNAVAILABLE");
  }

  async function verifyCode(email: string, code: string): Promise<void> {
    const response = await request("verify", { email, token: code, type: "email" });
    if (response.status === 429) throw new ApiError(429, "Too many attempts. Please try again later.", "EMAIL_RATE_LIMITED");
    if ([400, 401, 403, 422].includes(response.status)) {
      throw new ApiError(400, "The email verification code is invalid or expired.", "EMAIL_CODE_INVALID");
    }
    if (!response.ok) throw new ApiError(503, "Email verification is temporarily unavailable.", "EMAIL_SERVICE_UNAVAILABLE");
    const result: unknown = await response.json().catch(() => null);
    if (typeof result !== "object" || result === null || !("user" in result) ||
        !("access_token" in result) || typeof result.access_token !== "string" || !result.access_token ||
         typeof result.user !== "object" || result.user === null ||
         !("id" in result.user) || typeof result.user.id !== "string" || !result.user.id ||
         !("email_confirmed_at" in result.user) || typeof result.user.email_confirmed_at !== "string" || !result.user.email_confirmed_at ||
        !("email" in result.user) || typeof result.user.email !== "string" ||
        result.user.email.trim().toLowerCase() !== email) {
      throw new ApiError(400, "The email verification code is invalid or expired.", "EMAIL_CODE_INVALID");
    }
  }

  return { sendCode, verifyCode };
}
