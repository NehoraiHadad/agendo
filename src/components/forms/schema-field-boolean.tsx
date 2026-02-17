'use client';

import { Label } from '@/components/ui/label';
import type { UseFormRegister, FieldValues, Path } from 'react-hook-form';

interface SchemaFieldBooleanProps<T extends FieldValues> {
  name: Path<T>;
  label: string;
  description?: string;
  register: UseFormRegister<T>;
}

export function SchemaFieldBoolean<T extends FieldValues>({
  name,
  label,
  description,
  register,
}: SchemaFieldBooleanProps<T>) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={name}
        type="checkbox"
        className="mt-0.5 h-4 w-4 rounded border-input"
        {...register(name)}
      />
      <div>
        <Label htmlFor={name}>{label}</Label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
    </div>
  );
}
