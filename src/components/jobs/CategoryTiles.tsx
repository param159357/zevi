"use client";

import type { PostableCategory } from "@/lib/jobs/types";
import { cn } from "@/lib/utils/cn";

/**
 * Spec §5: category tiles, or "Other".
 *
 * "Other" is not one of the tiles the admin console manages — it is the absence
 * of a category, and picking it sends the job to a human instead of the feed.
 * It sits apart from the rest for that reason.
 */
export function CategoryTiles({
  categories,
  selectedId,
  postedAsOther,
  error,
  onSelect,
  onSelectOther,
}: {
  categories: PostableCategory[];
  selectedId: string | null;
  postedAsOther: boolean;
  error?: string;
  onSelect: (categoryId: string) => void;
  onSelectOther: () => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1.5 block text-sm font-medium">What do you need?</legend>

      <div className="grid gap-2 sm:grid-cols-2">
        {categories.map((category) => {
          const checked = !postedAsOther && selectedId === category.id;

          return (
            <label
              key={category.id}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
                checked
                  ? "border-accent bg-surface-muted"
                  : "border-border hover:bg-surface-muted",
              )}
            >
              <input
                type="radio"
                name="category"
                value={category.id}
                checked={checked}
                onChange={() => onSelect(category.id)}
                className="accent-accent mt-0.5 size-4 shrink-0"
              />
              <span className="space-y-0.5">
                <span className="block text-sm font-medium">{category.name}</span>
                {category.description ? (
                  <span className="text-muted block text-xs">{category.description}</span>
                ) : null}
              </span>
            </label>
          );
        })}

        <label
          className={cn(
            "flex cursor-pointer items-start gap-3 rounded-lg border border-dashed p-3 transition-colors",
            postedAsOther
              ? "border-accent bg-surface-muted"
              : "border-border hover:bg-surface-muted",
          )}
        >
          <input
            type="radio"
            name="category"
            value="other"
            checked={postedAsOther}
            onChange={onSelectOther}
            className="accent-accent mt-0.5 size-4 shrink-0"
          />
          <span className="space-y-0.5">
            <span className="block text-sm font-medium">Something else</span>
            <span className="text-muted block text-xs">
              We&apos;ll file it under the right category before it goes out to workers.
            </span>
          </span>
        </label>
      </div>

      {error ? (
        <p className="text-danger text-xs" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
