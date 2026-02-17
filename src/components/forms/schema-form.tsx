'use client';

import { useForm, type FieldValues, type SubmitHandler } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { SchemaField } from './schema-field';
import type { JsonSchemaObject } from '@/lib/types';

interface SchemaFormProps {
  schema: JsonSchemaObject;
  onSubmit: SubmitHandler<FieldValues>;
  submitLabel?: string;
  isSubmitting?: boolean;
}

export function SchemaForm({
  schema,
  onSubmit,
  submitLabel = 'Submit',
  isSubmitting = false,
}: SchemaFormProps) {
  const { register, handleSubmit } = useForm<FieldValues>();
  const properties = schema.properties ?? {};
  const requiredFields = new Set(schema.required ?? []);

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      {Object.entries(properties).map(([key, propSchema]) => (
        <SchemaField
          key={key}
          name={key}
          label={key}
          schema={propSchema as { type?: string; description?: string }}
          required={requiredFields.has(key)}
          register={register}
        />
      ))}
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Submitting...' : submitLabel}
      </Button>
    </form>
  );
}
