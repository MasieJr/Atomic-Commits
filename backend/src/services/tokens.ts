import { createHmac, timingSafeEqual } from "node:crypto";

/* only this alg is allowed - verify() rejects anything else the header claims */
const jwtAlgorithm = "HS256";
/* two hours, same life the cookie session used to get */
const accessTokenTtlSeconds = 2 * 60 * 60;

function base64UrlEncode(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

function base64UrlDecode(value: string): Buffer | undefined {
  try {
    // node pads base64url automatically, but padding or standard alphabet fails
    const roundTrip = Buffer.from(value, "base64url").toString("base64url");
    if (roundTrip !== value) return undefined;
    return Buffer.from(value, "base64url");
  } catch {
    return undefined;
  }
}

export interface AccessTokenService {
  sign(userId: number): string;
  /* undefined means anything untrustworthy - callers just treat it as not logged in */
  verify(token: string): number | undefined;
}

/* signs and verifies our minimal HS256 bearer access token */
export function createAccessTokenService(secret: string): AccessTokenService {
  function sign(userId: number): string {
    const header = base64UrlEncode(JSON.stringify({ alg: jwtAlgorithm, typ: "JWT" }));
    const issuedAt = Math.floor(Date.now() / 1000);
    const payload = base64UrlEncode(
      JSON.stringify({
        sub: String(userId), /* jwt sub is a string per the spec */
        iat: issuedAt,
        exp: issuedAt + accessTokenTtlSeconds,
      }),
    );
    const signature = createHmac("sha256", secret)
      .update(`${header}.${payload}`)
      .digest("base64url");
    return `${header}.${payload}.${signature}`;
  }

  function verify(token: string): number | undefined {
    /* exactly header.payload.signature; anything else is not ours */
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const [headerPart, payloadPart, signaturePart] = parts;
    if (
      typeof headerPart !== "string" ||
      typeof payloadPart !== "string" ||
      typeof signaturePart !== "string"
    )
      return undefined;

    /* alg confusion defence - the header only ever says HS256 */
    let header: { alg?: unknown };
    try {
      header = JSON.parse(base64UrlDecode(headerPart)?.toString("utf8") ?? "");
    } catch {
      return undefined;
    }
    if (header?.alg !== jwtAlgorithm) return undefined;

    let payload: { sub?: unknown; iat?: unknown; exp?: unknown };
    try {
      payload = JSON.parse(base64UrlDecode(payloadPart)?.toString("utf8") ?? "");
    } catch {
      return undefined;
    }

    /* expiry gate - expired, missing or malformed exp are all rejected */
    if (!(typeof payload.exp === "number" && Number.isInteger(payload.exp)))
      return undefined;
    if (!(typeof payload.iat === "number" && Number.isInteger(payload.iat)))
      return undefined;
    if (
      payload.exp <= payload.iat ||
      payload.exp <= Math.floor(Date.now() / 1000)
    )
      return undefined;

    /* subject must be our positive user id */
    if (typeof payload.sub !== "string" || !/^\d{1,15}$/.test(payload.sub))
      return undefined;
    const userId = Number.parseInt(payload.sub, 10);
    if (!Number.isSafeInteger(userId) || userId < 1) return undefined;

    /* constant time signature check over the exact two encoded parts */
    const expected = createHmac("sha256", secret)
      .update(`${headerPart}.${payloadPart}`)
      .digest("base64url");
    const given = base64UrlDecode(signaturePart);
    if (!given) return undefined;
    const expectedBytes = Buffer.from(expected, "base64url");
    if (expectedBytes.length !== given.length) return undefined;
    if (!timingSafeEqual(expectedBytes, given)) return undefined;

    return userId;
  }

  return { sign, verify };
}
