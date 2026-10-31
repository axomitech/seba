export type ErrorCode =
  | "invalid_input"
  | "not_found"
  | "unavailable"
  | "unauthorized"
  | "rate_limited"
  | "disabled"
  | "upstream_error"
  | "internal";

/** An error whose message is safe to show to MCP clients. Anything else is reported as `internal`. */
export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what: string) => new AppError("not_found", `${what} not found`, 404);
export const invalid = (msg: string) => new AppError("invalid_input", msg, 400);

export interface SafeError {
  code: ErrorCode;
  message: string;
}

/** Map any thrown value to a client-safe error. Details are logged server-side by the caller. */
export function toSafeError(e: unknown): SafeError {
  if (e instanceof AppError) return { code: e.code, message: e.message };
  return { code: "internal", message: "An internal error occurred. Please try again later." };
}
