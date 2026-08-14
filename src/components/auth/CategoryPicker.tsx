"use client";

import { useActionState, useState } from "react";

import { SubmitButton } from "@/components/auth/SubmitButton";
import { Alert } from "@/components/ui/Alert";
import { saveWorkerCategories } from "@/lib/auth/actions";
import { IDLE_FORM_STATE } from "@/lib/auth/types";
import { MAX_WORKER_CATEGORIES } from "@/lib/constants/auth";
import { cn } from "@/lib/utils/cn";

export type PickableCategory = {
  id: string;
  name: string;
  description: string | null;
};

export function CategoryPicker({
  categories,
  selectedIds = [],
}: {
  categories: PickableCategory[];
  selectedIds?: string[];
}) {
  const [state, formAction] = useActionState(saveWorkerCategories, IDLE_FORM_STATE);
  const [selected, setSelected] = useState<string[]>(selectedIds);

  const atLimit = selected.length >= MAX_WORKER_CATEGORIES;

  function toggle(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      <fieldset className="space-y-2">
        <legend className="sr-only">Categories you work in</legend>

        {categories.map((category) => {
          const checked = selected.includes(category.id);

          return (
            <label
              key={category.id}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
                checked ? "border-accent bg-surface-muted" : "border-border hover:bg-surface-muted",
                !checked && atLimit && "cursor-not-allowed opacity-50",
              )}
            >
              <input
                type="checkbox"
                name="categoryId"
                value={category.id}
                checked={checked}
                disabled={!checked && atLimit}
                onChange={() => toggle(category.id)}
                className="accent-accent mt-0.5 size-4"
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
      </fieldset>

      <p className="text-muted text-xs">
        {selected.length} of {MAX_WORKER_CATEGORIES} chosen. You can change these later, but
        every category needs its own samples before you can take work in it.
      </p>

      <SubmitButton disabled={selected.length === 0} pendingLabel="Saving…">
        Continue
      </SubmitButton>
    </form>
  );
}
