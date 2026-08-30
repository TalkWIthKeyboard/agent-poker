export type DomainErrorCode =
  | "ALREADY_EXISTS"
  | "DEADLINE_EXCEEDED"
  | "FAILED_PRECONDITION"
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "RESOURCE_EXHAUSTED"
  | "UNAUTHENTICATED"
  | "UNAVAILABLE";

export class DomainError extends Error {
  constructor(readonly code: DomainErrorCode, message: string) {
    super(message);
  }
}
