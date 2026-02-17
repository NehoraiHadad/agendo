import { SchemaFieldString } from './schema-field-string';
import { SchemaFieldBoolean } from './schema-field-boolean';
import type { UseFormRegister, FieldValues, Path } from 'react-hook-form';

interface PropertySchema {
  type?: string;
  description?: string;
  [key: string]: unknown;
}

interface SchemaFieldProps<T extends FieldValues> {
  name: Path<T>;
  label: string;
  schema: PropertySchema;
  required?: boolean;
  register: UseFormRegister<T>;
}

export function SchemaField<T extends FieldValues>({
  name,
  label,
  schema,
  required,
  register,
}: SchemaFieldProps<T>) {
  switch (schema.type) {
    case 'boolean':
      return (
        <SchemaFieldBoolean
          name={name}
          label={label}
          description={schema.description}
          register={register}
        />
      );
    case 'string':
    default:
      return (
        <SchemaFieldString
          name={name}
          label={label}
          description={schema.description}
          required={required}
          register={register}
        />
      );
  }
}
