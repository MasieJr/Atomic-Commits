/**
 * Payment engine domain contract barrel (L3).
 *
 * Transport-independent payment-engine types, errors, and ports.
 * Adapters (Express, DB, Open Payments SDK, FCM, Flutter) must consume
 * THIS surface and never let service-layer types leak into it.
 */

export * from "./money";
export * from "./errors";
export * from "./payments";
export * from "./grants";
export * from "./offline";
export * from "./events";
export * from "./idempotency";
export * from "./serialization";
export * from "./ports";
export * from "./signed-offline-instruction";
export * from "./offline-spending-policy";
export * from "./offline-redemption";
