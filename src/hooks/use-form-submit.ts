'use client';

import { useState } from 'react';
import { getErrorMessage } from '@/lib/utils/error-utils';

export function useFormSubmit<T = void>(
  onSubmit: () => Promise<T>,
): {
  isSubmitting: boolean;
  error: string | null;
  setError: (error: string | null) => void;
  handleSubmit: () => Promise<T | undefined>;
} {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(): Promise<T | undefined> {
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await onSubmit();
      return result;
    } catch (err) {
      setError(getErrorMessage(err));
      return undefined;
    } finally {
      setIsSubmitting(false);
    }
  }

  return { isSubmitting, error, setError, handleSubmit };
}
