'use client';

import { MessageSquare, ArrowLeftRight, Trash2, PlusCircle } from 'lucide-react';
import type { AnnotationType } from '@/lib/types/annotations';

/**
 * Renders the icon associated with an annotation type.
 * Extracted from plan-annotator.tsx so any component that needs to display
 * annotation type icons can import from a single place.
 */
export function AnnotationTypeIcon({
  type,
  className,
}: {
  type: AnnotationType;
  className?: string;
}) {
  switch (type) {
    case 'comment':
      return <MessageSquare className={className} />;
    case 'replacement':
      return <ArrowLeftRight className={className} />;
    case 'deletion':
      return <Trash2 className={className} />;
    case 'insertion':
      return <PlusCircle className={className} />;
  }
}
