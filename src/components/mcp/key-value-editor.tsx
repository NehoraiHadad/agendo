'use client';

import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface KeyValuePair {
  key: string;
  value: string;
}

interface KeyValueEditorProps {
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  disabled?: boolean;
}

export function KeyValueEditor({
  value,
  onChange,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
  disabled = false,
}: KeyValueEditorProps) {
  function handleAdd() {
    const tempKey = `__new_${Date.now()}`;
    onChange({ ...value, [tempKey]: '' });
  }

  // Flatten internal representation to pairs including temp keys
  const allPairs: KeyValuePair[] = Object.entries(value).map(([key, val]) => ({
    key,
    value: val,
  }));

  function handleRawKeyChange(index: number, newKey: string) {
    const entries = Object.entries(value);
    const [, oldVal] = entries[index];
    // Remove old key, add new key
    const updated: Record<string, string> = {};
    for (let i = 0; i < entries.length; i++) {
      if (i === index) {
        if (newKey) updated[newKey] = oldVal;
      } else {
        updated[entries[i][0]] = entries[i][1];
      }
    }
    onChange(updated);
  }

  function handleRawValueChange(index: number, newValue: string) {
    const entries = Object.entries(value);
    const updated: Record<string, string> = {};
    for (let i = 0; i < entries.length; i++) {
      if (i === index) {
        updated[entries[i][0]] = newValue;
      } else {
        updated[entries[i][0]] = entries[i][1];
      }
    }
    onChange(updated);
  }

  function handleRawRemove(index: number) {
    const entries = Object.entries(value);
    const updated: Record<string, string> = {};
    for (let i = 0; i < entries.length; i++) {
      if (i !== index) {
        updated[entries[i][0]] = entries[i][1];
      }
    }
    onChange(updated);
  }

  return (
    <div className="space-y-1.5">
      {allPairs.map(({ key, value: val }, index) => (
        <div key={index} className="flex flex-wrap sm:flex-nowrap items-center gap-1.5">
          <Input
            value={key.startsWith('__new_') ? '' : key}
            onChange={(e) => handleRawKeyChange(index, e.target.value)}
            placeholder={keyPlaceholder}
            disabled={disabled}
            className="h-7 text-xs font-mono flex-1 min-w-[6rem]"
          />
          <Input
            value={val}
            onChange={(e) => handleRawValueChange(index, e.target.value)}
            placeholder={valuePlaceholder}
            disabled={disabled}
            className="h-7 text-xs font-mono flex-1 min-w-[6rem]"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground/50 hover:text-destructive"
            onClick={() => handleRawRemove(index)}
            disabled={disabled}
            aria-label="Remove row"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 text-xs text-muted-foreground/60 hover:text-foreground gap-1.5 px-2"
        onClick={handleAdd}
        disabled={disabled}
      >
        <Plus className="h-3 w-3" />
        Add row
      </Button>
    </div>
  );
}
