// Small HTTP helpers shared by all route handlers.

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

export function error(status: number, message: string): Response {
  return json({ error: message }, { status });
}

/** Thrown by handlers to short-circuit with a specific HTTP status. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Parse and validate a JSON body, throwing HttpError(400) on malformed input. */
export async function readJson<T = Record<string, unknown>>(
  req: Request,
): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

export function requireString(
  value: unknown,
  field: string,
  { max = 10_000, min = 1 }: { max?: number; min?: number } = {},
): string {
  if (typeof value !== "string") {
    throw new HttpError(400, `${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min) {
    throw new HttpError(400, `${field} must not be empty`);
  }
  if (trimmed.length > max) {
    throw new HttpError(400, `${field} is too long (max ${max})`);
  }
  return trimmed;
}
