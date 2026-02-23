/** Successful single-item response */
export interface ApiResponse<T> {
  data: T;
}

/** Successful list response with pagination metadata */
export interface ApiListResponse<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    pageSize: number;
  };
}

/** Error response */
export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    context?: Record<string, unknown>;
  };
}

/**
 * Type-safe fetch wrapper for internal API calls from client components.
 * Throws on non-2xx responses with the error body.
 */
export async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  });

  // 204 No Content has no body — skip JSON parse
  if (response.status === 204) {
    return undefined as T;
  }

  const body = await response.json();

  if (!response.ok) {
    const errorBody = body as ApiErrorResponse;
    throw new Error(errorBody.error?.message ?? 'Request failed');
  }

  return body as T;
}
