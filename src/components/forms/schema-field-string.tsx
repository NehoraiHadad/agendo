'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { UseFormRegister, FieldValues, Path } from 'react-hook-form';

interface SchemaFieldStringProps<T extends FieldValues> {
  name: Path<T>;
  label: string;
  description?: string;
  required?: boolean;
  register: UseFormRegister<T>;
}

export function SchemaFieldString<T extends FieldValues>({
  name,
  label,
  description,
  required,
  register,
}: SchemaFieldStringProps<T>) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={name}>
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      <Input id={name} {...register(name, { required })} />
    </div>
  );
}
