/*
 * One-line JSON operational logs. Only ids, statuses and error codes go in:
 * never tokens, secrets, codes, emails or provider error text.
 */
export type LogFields = Record<string, string | number | boolean | null | undefined>;
export type LogEvent = (event: string, fields?: LogFields) => void;

export const logEvent: LogEvent = (event, fields = {}) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
};

export const silentLog: LogEvent = () => {};
