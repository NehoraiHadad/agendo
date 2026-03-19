import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getErrorMessage } from '@/lib/utils/error-utils';

export type ActionResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string };

function applyRevalidation(revalidate: string | string[] | undefined): void {
  if (!revalidate) return;
  const paths = Array.isArray(revalidate) ? revalidate : [revalidate];
  paths.forEach((p) => revalidatePath(p));
}

/** Wraps a server action with standardized error handling */
export function withAction<TInput, TOutput>(
  fn: (input: TInput) => Promise<TOutput>,
  options?: { revalidate?: string | string[] },
): (input: TInput) => Promise<ActionResult<TOutput>> {
  return async (input: TInput) => {
    let data: TOutput;
    try {
      data = await fn(input);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return { success: false, error: error.issues[0].message };
      }
      return { success: false, error: getErrorMessage(error) };
    }
    applyRevalidation(options?.revalidate);
    return { success: true, data };
  };
}

/** Wraps a server action that validates input with a Zod schema */
export function withValidatedAction<TSchema extends z.ZodType, TOutput>(
  schema: TSchema,
  fn: (validated: z.infer<TSchema>) => Promise<TOutput>,
  options?: { revalidate?: string | string[] },
): (input: unknown) => Promise<ActionResult<TOutput>> {
  return withAction((input: unknown) => {
    const validated = schema.parse(input);
    return fn(validated);
  }, options);
}
