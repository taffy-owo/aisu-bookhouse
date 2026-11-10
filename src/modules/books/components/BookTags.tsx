import { useMemo, useState } from 'react';
import { Badge } from '../../../shared/components/Badge';

interface BookTagsProps {
  maxVisible?: number;
  tags: string[];
}

export function BookTags({ maxVisible = 6, tags }: BookTagsProps) {
  const [expandedTagKey, setExpandedTagKey] = useState<string | null>(null);
  const normalizedTags = useMemo(() => Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean))), [tags]);
  const tagKey = normalizedTags.join('\u0000');
  const isExpanded = expandedTagKey === tagKey;
  const hasOverflow = normalizedTags.length > maxVisible;
  const visibleTags = isExpanded ? normalizedTags : normalizedTags.slice(0, maxVisible);

  return (
    <div className="flex flex-wrap gap-2">
      {visibleTags.map((tag) => (
        <Badge key={tag}>{tag}</Badge>
      ))}
      {hasOverflow && (
        <button
          aria-label={isExpanded ? '收起标签' : `展开其余 ${normalizedTags.length - maxVisible} 个标签`}
          className="inline-flex min-h-6 items-center rounded-full border border-stone-200 bg-white/55 px-2.5 text-xs font-medium text-stone-500 transition hover:border-accent/40 hover:text-accent dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-400 dark:hover:text-peach"
          onClick={() => setExpandedTagKey((current) => current === tagKey ? null : tagKey)}
          type="button"
        >
          {isExpanded ? '收起' : `+${normalizedTags.length - maxVisible}`}
        </button>
      )}
    </div>
  );
}
