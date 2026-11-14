import { ApiError } from "../errors/api-error";

export function publicCallbackOrigin(value: string | undefined): string {
  let url: URL;
  try { url = new URL(value?.trim() ?? ""); } catch {
    throw new ApiError(503, "Provider approval requires PUBLIC_BASE_URL.", "NOT_CONFIGURED");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new ApiError(503, "PUBLIC_BASE_URL must be an HTTPS origin.", "NOT_CONFIGURED");
  }
  return url.origin;
}
