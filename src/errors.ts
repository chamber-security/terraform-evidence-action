export class SafeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SafeError";
    this.code = code;
  }
}

export class AmbiguousTransportError extends SafeError {
  constructor() {
    super(
      "transport_outcome_ambiguous",
      "The connection ended after evidence streaming began. Chamber may have received the submission; run a new Action execution to recapture it.",
    );
    this.name = "AmbiguousTransportError";
  }
}

export function safeError(error: unknown): SafeError {
  if (error instanceof SafeError) return error;
  return new SafeError(
    "unexpected_action_error",
    "The Terraform evidence Action failed unexpectedly without exposing command output.",
  );
}
