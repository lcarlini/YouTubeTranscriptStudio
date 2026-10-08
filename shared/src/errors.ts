export type ErrorCode =
  | "invalid-url"
  | "no-captions"
  | "unsupported-language"
  | "network"
  | "cors-blocked"
  | "model-download"
  | "model-runtime"
  | "cache"
  | "extension-permission"
  | "empty-transcript";

export class StudioError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "StudioError";
    this.code = code;
  }
}

export function isStudioError(error: unknown): error is StudioError {
  return error instanceof StudioError;
}
