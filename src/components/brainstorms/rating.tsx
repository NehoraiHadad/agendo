'use client';

import { useState } from 'react';
import { Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

interface RatingProps {
  roomId: string;
  onRated: (rating: number) => void;
}

export function Rating({ roomId, onRated }: RatingProps) {
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (rating === 0) {
      toast.error('Please select a rating');
      return;
    }
    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/brainstorms/${roomId}/rate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating }),
      });
      if (!res.ok) {
        throw new Error('Failed to submit rating');
      }
      toast.success('Thank you for your feedback!');
      onRated(rating);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to submit rating');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="mx-4 my-3 flex flex-col items-center gap-3 rounded-xl border border-yellow-500/20 bg-yellow-950/25 px-4 py-3">
      <p className="text-xs font-semibold text-yellow-300/90">
        How focused and relevant was this discussion to your problem?
      </p>
      <div className="flex items-center gap-1">
        {[...Array(5)].map((_, index) => {
          index += 1;
          return (
            <button
              key={index}
              className={`text-yellow-400 transition-colors ${
                index <= (hover || rating) ? 'text-yellow-400' : 'text-yellow-400/30'
              }`}
              onClick={() => setRating(index)}
              onMouseEnter={() => setHover(index)}
              onMouseLeave={() => setHover(rating)}
            >
              <Star className="size-5" />
            </button>
          );
        })}
      </div>
      <Button
        onClick={handleSubmit}
        disabled={isSubmitting || rating === 0}
        size="sm"
        className="mt-2"
      >
        {isSubmitting ? 'Submitting...' : 'Submit Rating'}
      </Button>
    </div>
  );
}
