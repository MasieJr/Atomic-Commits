/* an error that is safe to show the client: fixed status + fixed message (+ optional stable code) */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}
