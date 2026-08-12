/**
 * Supabase schema types.
 *
 * PLACEHOLDER — there is no database schema yet. Once the first migration
 * lands, replace this whole file with generated output:
 *
 *   npx supabase gen types typescript --project-id <ref> > src/types/database.types.ts
 *
 * Never hand-edit the generated version; regenerate it instead.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: Record<never, never>;
    Views: Record<never, never>;
    Functions: Record<never, never>;
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};
