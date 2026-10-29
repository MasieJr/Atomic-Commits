/* an error that is safe to show the client: fixed status + fixed message */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
