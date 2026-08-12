export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      admin_audit_log: {
        Row: {
          action: string
          admin_id: string
          after_state: Json | null
          before_state: Json | null
          created_at: string
          id: number
          reason: string
          request_ip: unknown
          target_id: string | null
          target_table: string
        }
        Insert: {
          action: string
          admin_id: string
          after_state?: Json | null
          before_state?: Json | null
          created_at?: string
          id?: never
          reason: string
          request_ip?: unknown
          target_id?: string | null
          target_table: string
        }
        Update: {
          action?: string
          admin_id?: string
          after_state?: Json | null
          before_state?: Json | null
          created_at?: string
          id?: never
          reason?: string
          request_ip?: unknown
          target_id?: string | null
          target_table?: string
        }
        Relationships: [
          {
            foreignKeyName: "admin_audit_log_admin_id_fkey"
            columns: ["admin_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_roles: {
        Row: {
          code: string
          created_at: string
          description: string | null
          id: string
          is_super: boolean
          name: string
          permissions: Database["public"]["Enums"]["admin_permission"][]
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          description?: string | null
          id?: string
          is_super?: boolean
          name: string
          permissions?: Database["public"]["Enums"]["admin_permission"][]
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          description?: string | null
          id?: string
          is_super?: boolean
          name?: string
          permissions?: Database["public"]["Enums"]["admin_permission"][]
          updated_at?: string
        }
        Relationships: []
      }
      admin_users: {
        Row: {
          granted_at: string
          granted_by: string | null
          is_active: boolean
          note: string | null
          profile_id: string
          revoked_at: string | null
          revoked_by: string | null
          role_id: string
        }
        Insert: {
          granted_at?: string
          granted_by?: string | null
          is_active?: boolean
          note?: string | null
          profile_id: string
          revoked_at?: string | null
          revoked_by?: string | null
          role_id: string
        }
        Update: {
          granted_at?: string
          granted_by?: string | null
          is_active?: boolean
          note?: string | null
          profile_id?: string
          revoked_at?: string | null
          revoked_by?: string | null
          role_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "admin_users_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "admin_users_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "admin_users_revoked_by_fkey"
            columns: ["revoked_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "admin_users_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "admin_roles"
            referencedColumns: ["id"]
          },
        ]
      }
      background_jobs: {
        Row: {
          attempts: number
          completed_at: string | null
          created_at: string
          dedupe_key: string | null
          id: string
          kind: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          payload: Json
          run_at: string
          status: Database["public"]["Enums"]["background_job_status"]
          updated_at: string
        }
        Insert: {
          attempts?: number
          completed_at?: string | null
          created_at?: string
          dedupe_key?: string | null
          id?: string
          kind: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          payload?: Json
          run_at?: string
          status?: Database["public"]["Enums"]["background_job_status"]
          updated_at?: string
        }
        Update: {
          attempts?: number
          completed_at?: string | null
          created_at?: string
          dedupe_key?: string | null
          id?: string
          kind?: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          payload?: Json
          run_at?: string
          status?: Database["public"]["Enums"]["background_job_status"]
          updated_at?: string
        }
        Relationships: []
      }
      cancellations: {
        Row: {
          actor_role: Database["public"]["Enums"]["party_role"]
          admin_assessed: boolean
          assessed_by: string | null
          cancelled_by: string | null
          client_refund_paise: number
          created_at: string
          elapsed_bps: number | null
          fee_paise: number
          id: string
          job_id: string
          reason: string
          tier: Database["public"]["Enums"]["cancellation_tier"]
          worker_compensation_paise: number
        }
        Insert: {
          actor_role: Database["public"]["Enums"]["party_role"]
          admin_assessed?: boolean
          assessed_by?: string | null
          cancelled_by?: string | null
          client_refund_paise?: number
          created_at?: string
          elapsed_bps?: number | null
          fee_paise?: number
          id?: string
          job_id: string
          reason: string
          tier: Database["public"]["Enums"]["cancellation_tier"]
          worker_compensation_paise?: number
        }
        Update: {
          actor_role?: Database["public"]["Enums"]["party_role"]
          admin_assessed?: boolean
          assessed_by?: string | null
          cancelled_by?: string | null
          client_refund_paise?: number
          created_at?: string
          elapsed_bps?: number | null
          fee_paise?: number
          id?: string
          job_id?: string
          reason?: string
          tier?: Database["public"]["Enums"]["cancellation_tier"]
          worker_compensation_paise?: number
        }
        Relationships: [
          {
            foreignKeyName: "cancellations_assessed_by_fkey"
            columns: ["assessed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cancellations_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cancellations_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      categories: {
        Row: {
          created_at: string
          description: string | null
          icon: string | null
          id: string
          max_upload_bytes: number | null
          min_budget_paise: number | null
          name: string
          position: number
          requires_watermark: boolean
          retired_at: string | null
          sample_format_note: string | null
          sample_max: number
          sample_min: number
          slug: string
          status: Database["public"]["Enums"]["category_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          icon?: string | null
          id?: string
          max_upload_bytes?: number | null
          min_budget_paise?: number | null
          name: string
          position?: number
          requires_watermark?: boolean
          retired_at?: string | null
          sample_format_note?: string | null
          sample_max?: number
          sample_min?: number
          slug: string
          status?: Database["public"]["Enums"]["category_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          icon?: string | null
          id?: string
          max_upload_bytes?: number | null
          min_budget_paise?: number | null
          name?: string
          position?: number
          requires_watermark?: boolean
          retired_at?: string | null
          sample_format_note?: string | null
          sample_max?: number
          sample_min?: number
          slug?: string
          status?: Database["public"]["Enums"]["category_status"]
          updated_at?: string
        }
        Relationships: []
      }
      category_brief_fields: {
        Row: {
          category_id: string
          created_at: string
          help_text: string | null
          id: string
          is_active: boolean
          is_required: boolean
          key: string
          label: string
          max_value: number | null
          min_value: number | null
          options: string[]
          position: number
          type: Database["public"]["Enums"]["brief_field_type"]
          unit: string | null
          updated_at: string
        }
        Insert: {
          category_id: string
          created_at?: string
          help_text?: string | null
          id?: string
          is_active?: boolean
          is_required?: boolean
          key: string
          label: string
          max_value?: number | null
          min_value?: number | null
          options?: string[]
          position?: number
          type: Database["public"]["Enums"]["brief_field_type"]
          unit?: string | null
          updated_at?: string
        }
        Update: {
          category_id?: string
          created_at?: string
          help_text?: string | null
          id?: string
          is_active?: boolean
          is_required?: boolean
          key?: string
          label?: string
          max_value?: number | null
          min_value?: number | null
          options?: string[]
          position?: number
          type?: Database["public"]["Enums"]["brief_field_type"]
          unit?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "category_brief_fields_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
      chargebacks: {
        Row: {
          amount_paise: number
          created_at: string
          evidence_due_at: string | null
          evidence_submitted_at: string | null
          id: string
          internal_note: string | null
          job_id: string
          loss_paise: number
          opened_at: string
          payment_id: string
          razorpay_dispute_id: string | null
          reason_code: string | null
          resolved_at: string | null
          status: Database["public"]["Enums"]["chargeback_status"]
          updated_at: string
        }
        Insert: {
          amount_paise: number
          created_at?: string
          evidence_due_at?: string | null
          evidence_submitted_at?: string | null
          id?: string
          internal_note?: string | null
          job_id: string
          loss_paise?: number
          opened_at?: string
          payment_id: string
          razorpay_dispute_id?: string | null
          reason_code?: string | null
          resolved_at?: string | null
          status?: Database["public"]["Enums"]["chargeback_status"]
          updated_at?: string
        }
        Update: {
          amount_paise?: number
          created_at?: string
          evidence_due_at?: string | null
          evidence_submitted_at?: string | null
          id?: string
          internal_note?: string | null
          job_id?: string
          loss_paise?: number
          opened_at?: string
          payment_id?: string
          razorpay_dispute_id?: string | null
          reason_code?: string | null
          resolved_at?: string | null
          status?: Database["public"]["Enums"]["chargeback_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "chargebacks_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chargebacks_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
        ]
      }
      client_profiles: {
        Row: {
          cancellation_rate_bps: number
          created_at: string
          first_job_at: string | null
          jobs_cancelled: number
          jobs_completed: number
          jobs_posted: number
          last_job_at: string | null
          profile_id: string
          rating: number | null
          rating_job_count: number
          total_spend_paise: number
          updated_at: string
        }
        Insert: {
          cancellation_rate_bps?: number
          created_at?: string
          first_job_at?: string | null
          jobs_cancelled?: number
          jobs_completed?: number
          jobs_posted?: number
          last_job_at?: string | null
          profile_id: string
          rating?: number | null
          rating_job_count?: number
          total_spend_paise?: number
          updated_at?: string
        }
        Update: {
          cancellation_rate_bps?: number
          created_at?: string
          first_job_at?: string | null
          jobs_cancelled?: number
          jobs_completed?: number
          jobs_posted?: number
          last_job_at?: string | null
          profile_id?: string
          rating?: number | null
          rating_job_count?: number
          total_spend_paise?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_profiles_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      commission_slabs: {
        Row: {
          client_bps: number
          created_at: string
          effective_from: string
          effective_to: string | null
          id: string
          label: string
          max_commission_paise: number | null
          max_paise: number | null
          min_commission_paise: number
          min_paise: number
          total_bps: number
          worker_bps: number
        }
        Insert: {
          client_bps: number
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          id?: string
          label: string
          max_commission_paise?: number | null
          max_paise?: number | null
          min_commission_paise?: number
          min_paise: number
          total_bps: number
          worker_bps: number
        }
        Update: {
          client_bps?: number
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          id?: string
          label?: string
          max_commission_paise?: number | null
          max_paise?: number | null
          min_commission_paise?: number
          min_paise?: number
          total_bps?: number
          worker_bps?: number
        }
        Relationships: []
      }
      conversations: {
        Row: {
          client_id: string
          client_read_at: string | null
          created_at: string
          id: string
          is_locked: boolean
          job_id: string
          last_message_at: string | null
          locked_reason: string | null
          message_count: number
          updated_at: string
          worker_id: string
          worker_read_at: string | null
        }
        Insert: {
          client_id: string
          client_read_at?: string | null
          created_at?: string
          id?: string
          is_locked?: boolean
          job_id: string
          last_message_at?: string | null
          locked_reason?: string | null
          message_count?: number
          updated_at?: string
          worker_id: string
          worker_read_at?: string | null
        }
        Update: {
          client_id?: string
          client_read_at?: string | null
          created_at?: string
          id?: string
          is_locked?: boolean
          job_id?: string
          last_message_at?: string | null
          locked_reason?: string | null
          message_count?: number
          updated_at?: string
          worker_id?: string
          worker_read_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conversations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      delivery_files: {
        Row: {
          created_at: string
          delivery_id: string
          file_id: string
          position: number
          unlocked_at: string | null
        }
        Insert: {
          created_at?: string
          delivery_id: string
          file_id: string
          position?: number
          unlocked_at?: string | null
        }
        Update: {
          created_at?: string
          delivery_id?: string
          file_id?: string
          position?: number
          unlocked_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "delivery_files_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "job_deliveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_files_file_id_fkey"
            columns: ["file_id"]
            isOneToOne: false
            referencedRelation: "files"
            referencedColumns: ["id"]
          },
        ]
      }
      dispute_ai_summaries: {
        Row: {
          completion_tokens: number | null
          confidence: number | null
          cost_paise: number | null
          created_at: string
          dispute_id: string
          followed_by_admin: boolean | null
          id: string
          model: string
          prompt_tokens: number | null
          recommended_outcome:
            | Database["public"]["Enums"]["dispute_outcome"]
            | null
          recommended_split_bps: number | null
          summary: string
        }
        Insert: {
          completion_tokens?: number | null
          confidence?: number | null
          cost_paise?: number | null
          created_at?: string
          dispute_id: string
          followed_by_admin?: boolean | null
          id?: string
          model: string
          prompt_tokens?: number | null
          recommended_outcome?:
            | Database["public"]["Enums"]["dispute_outcome"]
            | null
          recommended_split_bps?: number | null
          summary: string
        }
        Update: {
          completion_tokens?: number | null
          confidence?: number | null
          cost_paise?: number | null
          created_at?: string
          dispute_id?: string
          followed_by_admin?: boolean | null
          id?: string
          model?: string
          prompt_tokens?: number | null
          recommended_outcome?:
            | Database["public"]["Enums"]["dispute_outcome"]
            | null
          recommended_split_bps?: number | null
          summary?: string
        }
        Relationships: [
          {
            foreignKeyName: "dispute_ai_summaries_dispute_id_fkey"
            columns: ["dispute_id"]
            isOneToOne: false
            referencedRelation: "disputes"
            referencedColumns: ["id"]
          },
        ]
      }
      dispute_appeals: {
        Row: {
          created_at: string
          decided_at: string | null
          decided_by: string | null
          decision_note: string | null
          dispute_id: string
          filed_by: string
          filer_role: Database["public"]["Enums"]["party_role"]
          id: string
          new_evidence: string
          outcome: Database["public"]["Enums"]["dispute_outcome"] | null
          status: Database["public"]["Enums"]["dispute_status"]
          window_ends_at: string
        }
        Insert: {
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_note?: string | null
          dispute_id: string
          filed_by: string
          filer_role: Database["public"]["Enums"]["party_role"]
          id?: string
          new_evidence: string
          outcome?: Database["public"]["Enums"]["dispute_outcome"] | null
          status?: Database["public"]["Enums"]["dispute_status"]
          window_ends_at: string
        }
        Update: {
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_note?: string | null
          dispute_id?: string
          filed_by?: string
          filer_role?: Database["public"]["Enums"]["party_role"]
          id?: string
          new_evidence?: string
          outcome?: Database["public"]["Enums"]["dispute_outcome"] | null
          status?: Database["public"]["Enums"]["dispute_status"]
          window_ends_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "dispute_appeals_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispute_appeals_dispute_id_fkey"
            columns: ["dispute_id"]
            isOneToOne: true
            referencedRelation: "disputes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispute_appeals_filed_by_fkey"
            columns: ["filed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      dispute_evidence: {
        Row: {
          created_at: string
          dispute_id: string
          file_id: string
          uploaded_by: string
        }
        Insert: {
          created_at?: string
          dispute_id: string
          file_id: string
          uploaded_by: string
        }
        Update: {
          created_at?: string
          dispute_id?: string
          file_id?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "dispute_evidence_dispute_id_fkey"
            columns: ["dispute_id"]
            isOneToOne: false
            referencedRelation: "disputes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispute_evidence_file_id_fkey"
            columns: ["file_id"]
            isOneToOne: false
            referencedRelation: "files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispute_evidence_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      dispute_offers: {
        Row: {
          created_at: string
          dispute_id: string
          expires_at: string
          id: string
          message: string | null
          outcome: Database["public"]["Enums"]["dispute_outcome"]
          proposed_by: string
          proposer_role: Database["public"]["Enums"]["party_role"]
          responded_at: string | null
          responded_by: string | null
          split_client_bps: number | null
          status: Database["public"]["Enums"]["dispute_offer_status"]
        }
        Insert: {
          created_at?: string
          dispute_id: string
          expires_at: string
          id?: string
          message?: string | null
          outcome: Database["public"]["Enums"]["dispute_outcome"]
          proposed_by: string
          proposer_role: Database["public"]["Enums"]["party_role"]
          responded_at?: string | null
          responded_by?: string | null
          split_client_bps?: number | null
          status?: Database["public"]["Enums"]["dispute_offer_status"]
        }
        Update: {
          created_at?: string
          dispute_id?: string
          expires_at?: string
          id?: string
          message?: string | null
          outcome?: Database["public"]["Enums"]["dispute_outcome"]
          proposed_by?: string
          proposer_role?: Database["public"]["Enums"]["party_role"]
          responded_at?: string | null
          responded_by?: string | null
          split_client_bps?: number | null
          status?: Database["public"]["Enums"]["dispute_offer_status"]
        }
        Relationships: [
          {
            foreignKeyName: "dispute_offers_dispute_id_fkey"
            columns: ["dispute_id"]
            isOneToOne: false
            referencedRelation: "disputes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispute_offers_proposed_by_fkey"
            columns: ["proposed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispute_offers_responded_by_fkey"
            columns: ["responded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      dispute_statements: {
        Row: {
          author_id: string
          author_role: Database["public"]["Enums"]["party_role"]
          body: string
          created_at: string
          dispute_id: string
          id: string
          is_appeal: boolean
        }
        Insert: {
          author_id: string
          author_role: Database["public"]["Enums"]["party_role"]
          body: string
          created_at?: string
          dispute_id: string
          id?: string
          is_appeal?: boolean
        }
        Update: {
          author_id?: string
          author_role?: Database["public"]["Enums"]["party_role"]
          body?: string
          created_at?: string
          dispute_id?: string
          id?: string
          is_appeal?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "dispute_statements_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispute_statements_dispute_id_fkey"
            columns: ["dispute_id"]
            isOneToOne: false
            referencedRelation: "disputes"
            referencedColumns: ["id"]
          },
        ]
      }
      disputes: {
        Row: {
          amount_paise: number
          auto_resolved: boolean
          closed_at: string | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          decision_due_at: string
          decision_note: string | null
          fee_charged_to: Database["public"]["Enums"]["party_role"] | null
          fee_paise: number
          first_responded_at: string | null
          first_response_due_at: string
          id: string
          job_id: string
          layer: Database["public"]["Enums"]["dispute_layer"]
          opened_at: string
          outcome: Database["public"]["Enums"]["dispute_outcome"] | null
          raised_by: string
          raised_by_role: Database["public"]["Enums"]["party_role"]
          reason_summary: string
          response_due_at: string
          split_client_bps: number | null
          status: Database["public"]["Enums"]["dispute_status"]
          updated_at: string
        }
        Insert: {
          amount_paise: number
          auto_resolved?: boolean
          closed_at?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_due_at: string
          decision_note?: string | null
          fee_charged_to?: Database["public"]["Enums"]["party_role"] | null
          fee_paise?: number
          first_responded_at?: string | null
          first_response_due_at: string
          id?: string
          job_id: string
          layer?: Database["public"]["Enums"]["dispute_layer"]
          opened_at?: string
          outcome?: Database["public"]["Enums"]["dispute_outcome"] | null
          raised_by: string
          raised_by_role: Database["public"]["Enums"]["party_role"]
          reason_summary: string
          response_due_at: string
          split_client_bps?: number | null
          status?: Database["public"]["Enums"]["dispute_status"]
          updated_at?: string
        }
        Update: {
          amount_paise?: number
          auto_resolved?: boolean
          closed_at?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_due_at?: string
          decision_note?: string | null
          fee_charged_to?: Database["public"]["Enums"]["party_role"] | null
          fee_paise?: number
          first_responded_at?: string | null
          first_response_due_at?: string
          id?: string
          job_id?: string
          layer?: Database["public"]["Enums"]["dispute_layer"]
          opened_at?: string
          outcome?: Database["public"]["Enums"]["dispute_outcome"] | null
          raised_by?: string
          raised_by_role?: Database["public"]["Enums"]["party_role"]
          reason_summary?: string
          response_due_at?: string
          split_client_bps?: number | null
          status?: Database["public"]["Enums"]["dispute_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "disputes_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disputes_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disputes_raised_by_fkey"
            columns: ["raised_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      document_lines: {
        Row: {
          amount_paise: number
          document_id: string
          id: string
          kind: Database["public"]["Enums"]["document_line_kind"]
          label: string
          position: number
          tax_rate_bps: number | null
        }
        Insert: {
          amount_paise: number
          document_id: string
          id?: string
          kind: Database["public"]["Enums"]["document_line_kind"]
          label: string
          position: number
          tax_rate_bps?: number | null
        }
        Update: {
          amount_paise?: number
          document_id?: string
          id?: string
          kind?: Database["public"]["Enums"]["document_line_kind"]
          label?: string
          position?: number
          tax_rate_bps?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "document_lines_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          created_at: string
          file_id: string | null
          id: string
          issued_at: string
          job_id: string | null
          metadata: Json
          number: string
          profile_id: string
          series: string
          tax_paise: number
          total_paise: number
          type: Database["public"]["Enums"]["document_type"]
        }
        Insert: {
          created_at?: string
          file_id?: string | null
          id?: string
          issued_at?: string
          job_id?: string | null
          metadata?: Json
          number: string
          profile_id: string
          series: string
          tax_paise?: number
          total_paise: number
          type: Database["public"]["Enums"]["document_type"]
        }
        Update: {
          created_at?: string
          file_id?: string | null
          id?: string
          issued_at?: string
          job_id?: string | null
          metadata?: Json
          number?: string
          profile_id?: string
          series?: string
          tax_paise?: number
          total_paise?: number
          type?: Database["public"]["Enums"]["document_type"]
        }
        Relationships: [
          {
            foreignKeyName: "documents_file_id_fkey"
            columns: ["file_id"]
            isOneToOne: false
            referencedRelation: "files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      email_outbox: {
        Row: {
          attempts: number
          created_at: string
          dedupe_key: string | null
          error: string | null
          id: string
          job_id: string | null
          payload: Json
          profile_id: string | null
          provider_message_id: string | null
          scheduled_for: string
          sent_at: string | null
          status: Database["public"]["Enums"]["email_status"]
          subject: string
          template: string
          to_email: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          dedupe_key?: string | null
          error?: string | null
          id?: string
          job_id?: string | null
          payload?: Json
          profile_id?: string | null
          provider_message_id?: string | null
          scheduled_for?: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["email_status"]
          subject: string
          template: string
          to_email: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          dedupe_key?: string | null
          error?: string | null
          id?: string
          job_id?: string | null
          payload?: Json
          profile_id?: string | null
          provider_message_id?: string | null
          scheduled_for?: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["email_status"]
          subject?: string
          template?: string
          to_email?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_outbox_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_outbox_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      escrow_holds: {
        Row: {
          amount_paise: number
          created_at: string
          frozen_at: string | null
          frozen_reason: string | null
          id: string
          job_id: string
          payment_id: string
          refunded_paise: number
          released_at: string | null
          released_paise: number
          status: Database["public"]["Enums"]["escrow_status"]
          updated_at: string
        }
        Insert: {
          amount_paise: number
          created_at?: string
          frozen_at?: string | null
          frozen_reason?: string | null
          id?: string
          job_id: string
          payment_id: string
          refunded_paise?: number
          released_at?: string | null
          released_paise?: number
          status?: Database["public"]["Enums"]["escrow_status"]
          updated_at?: string
        }
        Update: {
          amount_paise?: number
          created_at?: string
          frozen_at?: string | null
          frozen_reason?: string | null
          id?: string
          job_id?: string
          payment_id?: string
          refunded_paise?: number
          released_at?: string | null
          released_paise?: number
          status?: Database["public"]["Enums"]["escrow_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "escrow_holds_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "escrow_holds_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
        ]
      }
      fee_schedule: {
        Row: {
          amount_paise: number
          code: string
          created_at: string
          effective_from: string
          effective_to: string | null
          id: string
          name: string
          note: string | null
          waived_below_paise: number | null
        }
        Insert: {
          amount_paise: number
          code: string
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          id?: string
          name: string
          note?: string | null
          waived_below_paise?: number | null
        }
        Update: {
          amount_paise?: number
          code?: string
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          id?: string
          name?: string
          note?: string | null
          waived_below_paise?: number | null
        }
        Relationships: []
      }
      files: {
        Row: {
          bucket: string
          created_at: string
          delete_after: string | null
          duration_seconds: number | null
          height: number | null
          id: string
          mime_type: string
          original_name: string
          owner_id: string
          page_count: number | null
          preview_generated_at: string | null
          preview_key: string | null
          purged_at: string | null
          purpose: Database["public"]["Enums"]["file_purpose"]
          retention_reason: string | null
          scan_status: Database["public"]["Enums"]["file_scan_status"]
          scanned_at: string | null
          sha256: string
          size_bytes: number
          storage_key: string
          uploaded_at: string
          width: number | null
        }
        Insert: {
          bucket?: string
          created_at?: string
          delete_after?: string | null
          duration_seconds?: number | null
          height?: number | null
          id?: string
          mime_type: string
          original_name: string
          owner_id: string
          page_count?: number | null
          preview_generated_at?: string | null
          preview_key?: string | null
          purged_at?: string | null
          purpose: Database["public"]["Enums"]["file_purpose"]
          retention_reason?: string | null
          scan_status?: Database["public"]["Enums"]["file_scan_status"]
          scanned_at?: string | null
          sha256: string
          size_bytes: number
          storage_key: string
          uploaded_at?: string
          width?: number | null
        }
        Update: {
          bucket?: string
          created_at?: string
          delete_after?: string | null
          duration_seconds?: number | null
          height?: number | null
          id?: string
          mime_type?: string
          original_name?: string
          owner_id?: string
          page_count?: number | null
          preview_generated_at?: string | null
          preview_key?: string | null
          purged_at?: string | null
          purpose?: Database["public"]["Enums"]["file_purpose"]
          retention_reason?: string | null
          scan_status?: Database["public"]["Enums"]["file_scan_status"]
          scanned_at?: string | null
          sha256?: string
          size_bytes?: number
          storage_key?: string
          uploaded_at?: string
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "files_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      job_assignments: {
        Row: {
          assigned_at: string
          created_at: string
          ended_at: string | null
          ended_reason: string | null
          id: string
          job_id: string
          opt_in_id: string | null
          payment_id: string | null
          source: Database["public"]["Enums"]["assignment_source"]
          status: Database["public"]["Enums"]["assignment_status"]
          worker_id: string
        }
        Insert: {
          assigned_at?: string
          created_at?: string
          ended_at?: string | null
          ended_reason?: string | null
          id?: string
          job_id: string
          opt_in_id?: string | null
          payment_id?: string | null
          source?: Database["public"]["Enums"]["assignment_source"]
          status?: Database["public"]["Enums"]["assignment_status"]
          worker_id: string
        }
        Update: {
          assigned_at?: string
          created_at?: string
          ended_at?: string | null
          ended_reason?: string | null
          id?: string
          job_id?: string
          opt_in_id?: string | null
          payment_id?: string | null
          source?: Database["public"]["Enums"]["assignment_source"]
          status?: Database["public"]["Enums"]["assignment_status"]
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_assignments_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_assignments_opt_in_id_fkey"
            columns: ["opt_in_id"]
            isOneToOne: false
            referencedRelation: "job_opt_ins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_assignments_payment_fk"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_assignments_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "worker_profiles"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      job_attachments: {
        Row: {
          created_at: string
          file_id: string
          job_id: string
          position: number
        }
        Insert: {
          created_at?: string
          file_id: string
          job_id: string
          position?: number
        }
        Update: {
          created_at?: string
          file_id?: string
          job_id?: string
          position?: number
        }
        Relationships: [
          {
            foreignKeyName: "job_attachments_file_id_fkey"
            columns: ["file_id"]
            isOneToOne: false
            referencedRelation: "files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_attachments_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      job_brief_answers: {
        Row: {
          field_id: string
          job_id: string
          value_bool: boolean | null
          value_number: number | null
          value_options: string[] | null
          value_text: string | null
        }
        Insert: {
          field_id: string
          job_id: string
          value_bool?: boolean | null
          value_number?: number | null
          value_options?: string[] | null
          value_text?: string | null
        }
        Update: {
          field_id?: string
          job_id?: string
          value_bool?: boolean | null
          value_number?: number | null
          value_options?: string[] | null
          value_text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_brief_answers_field_id_fkey"
            columns: ["field_id"]
            isOneToOne: false
            referencedRelation: "category_brief_fields"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_brief_answers_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      job_classifications: {
        Row: {
          completion_tokens: number | null
          confidence: number | null
          cost_paise: number | null
          created_at: string
          error: string | null
          id: string
          job_id: string
          model: string | null
          prompt_tokens: number | null
          resolved_at: string | null
          resolved_by: string | null
          resolved_category_id: string | null
          status: Database["public"]["Enums"]["classification_status"]
          suggested_category_id: string | null
        }
        Insert: {
          completion_tokens?: number | null
          confidence?: number | null
          cost_paise?: number | null
          created_at?: string
          error?: string | null
          id?: string
          job_id: string
          model?: string | null
          prompt_tokens?: number | null
          resolved_at?: string | null
          resolved_by?: string | null
          resolved_category_id?: string | null
          status?: Database["public"]["Enums"]["classification_status"]
          suggested_category_id?: string | null
        }
        Update: {
          completion_tokens?: number | null
          confidence?: number | null
          cost_paise?: number | null
          created_at?: string
          error?: string | null
          id?: string
          job_id?: string
          model?: string | null
          prompt_tokens?: number | null
          resolved_at?: string | null
          resolved_by?: string | null
          resolved_category_id?: string | null
          status?: Database["public"]["Enums"]["classification_status"]
          suggested_category_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_classifications_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_classifications_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_classifications_resolved_category_id_fkey"
            columns: ["resolved_category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_classifications_suggested_category_id_fkey"
            columns: ["suggested_category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
      job_deliveries: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          assignment_id: string
          attempt: number
          auto_accept_at: string
          auto_accepted: boolean
          created_at: string
          delivered_at: string
          id: string
          job_id: string
          note: string | null
          reminder_1_sent_at: string | null
          reminder_2_sent_at: string | null
          revision_requested_at: string | null
          status: Database["public"]["Enums"]["delivery_status"]
          updated_at: string
          worker_id: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          assignment_id: string
          attempt?: number
          auto_accept_at: string
          auto_accepted?: boolean
          created_at?: string
          delivered_at?: string
          id?: string
          job_id: string
          note?: string | null
          reminder_1_sent_at?: string | null
          reminder_2_sent_at?: string | null
          revision_requested_at?: string | null
          status?: Database["public"]["Enums"]["delivery_status"]
          updated_at?: string
          worker_id: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          assignment_id?: string
          attempt?: number
          auto_accept_at?: string
          auto_accepted?: boolean
          created_at?: string
          delivered_at?: string
          id?: string
          job_id?: string
          note?: string | null
          reminder_1_sent_at?: string | null
          reminder_2_sent_at?: string | null
          revision_requested_at?: string | null
          status?: Database["public"]["Enums"]["delivery_status"]
          updated_at?: string
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_deliveries_accepted_by_fkey"
            columns: ["accepted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_deliveries_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "job_assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_deliveries_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_deliveries_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "worker_profiles"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      job_events: {
        Row: {
          actor_id: string | null
          actor_role: Database["public"]["Enums"]["party_role"]
          created_at: string
          event_type: string
          from_status: Database["public"]["Enums"]["job_status"] | null
          id: number
          job_id: string
          metadata: Json
          to_status: Database["public"]["Enums"]["job_status"] | null
        }
        Insert: {
          actor_id?: string | null
          actor_role?: Database["public"]["Enums"]["party_role"]
          created_at?: string
          event_type: string
          from_status?: Database["public"]["Enums"]["job_status"] | null
          id?: never
          job_id: string
          metadata?: Json
          to_status?: Database["public"]["Enums"]["job_status"] | null
        }
        Update: {
          actor_id?: string | null
          actor_role?: Database["public"]["Enums"]["party_role"]
          created_at?: string
          event_type?: string
          from_status?: Database["public"]["Enums"]["job_status"] | null
          id?: never
          job_id?: string
          metadata?: Json
          to_status?: Database["public"]["Enums"]["job_status"] | null
        }
        Relationships: [
          {
            foreignKeyName: "job_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_events_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      job_financials: {
        Row: {
          budget_paise: number
          cap_applied: boolean
          client_commission_bps: number
          client_commission_paise: number
          client_tax_paise: number
          client_total_paise: number
          computed_at: string
          created_at: string
          discount_bps: number
          discount_source: string | null
          floor_applied: boolean
          job_id: string
          platform_gross_paise: number
          slab_id: string
          tax_rate_bps: number
          tax_rate_id: string | null
          worker_commission_bps: number
          worker_commission_paise: number
          worker_net_paise: number
          worker_tax_paise: number
        }
        Insert: {
          budget_paise: number
          cap_applied?: boolean
          client_commission_bps: number
          client_commission_paise: number
          client_tax_paise?: number
          client_total_paise: number
          computed_at?: string
          created_at?: string
          discount_bps?: number
          discount_source?: string | null
          floor_applied?: boolean
          job_id: string
          platform_gross_paise: number
          slab_id: string
          tax_rate_bps?: number
          tax_rate_id?: string | null
          worker_commission_bps: number
          worker_commission_paise: number
          worker_net_paise: number
          worker_tax_paise?: number
        }
        Update: {
          budget_paise?: number
          cap_applied?: boolean
          client_commission_bps?: number
          client_commission_paise?: number
          client_tax_paise?: number
          client_total_paise?: number
          computed_at?: string
          created_at?: string
          discount_bps?: number
          discount_source?: string | null
          floor_applied?: boolean
          job_id?: string
          platform_gross_paise?: number
          slab_id?: string
          tax_rate_bps?: number
          tax_rate_id?: string | null
          worker_commission_bps?: number
          worker_commission_paise?: number
          worker_net_paise?: number
          worker_tax_paise?: number
        }
        Relationships: [
          {
            foreignKeyName: "job_financials_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_financials_slab_id_fkey"
            columns: ["slab_id"]
            isOneToOne: false
            referencedRelation: "commission_slabs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_financials_tax_rate_id_fkey"
            columns: ["tax_rate_id"]
            isOneToOne: false
            referencedRelation: "tax_rates"
            referencedColumns: ["id"]
          },
        ]
      }
      job_moderation: {
        Row: {
          auto_score: number | null
          created_at: string
          id: string
          job_id: string
          matched_terms: string[] | null
          note: string | null
          reason: Database["public"]["Enums"]["moderation_reason"] | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["moderation_status"]
          trigger: Database["public"]["Enums"]["moderation_trigger"]
          updated_at: string
        }
        Insert: {
          auto_score?: number | null
          created_at?: string
          id?: string
          job_id: string
          matched_terms?: string[] | null
          note?: string | null
          reason?: Database["public"]["Enums"]["moderation_reason"] | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["moderation_status"]
          trigger: Database["public"]["Enums"]["moderation_trigger"]
          updated_at?: string
        }
        Update: {
          auto_score?: number | null
          created_at?: string
          id?: string
          job_id?: string
          matched_terms?: string[] | null
          note?: string | null
          reason?: Database["public"]["Enums"]["moderation_reason"] | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["moderation_status"]
          trigger?: Database["public"]["Enums"]["moderation_trigger"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_moderation_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_moderation_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      job_opt_ins: {
        Row: {
          brief_opened_at: string
          created_at: string
          history_score: number | null
          id: string
          job_id: string
          note_score: number | null
          noticed_detail: string
          rank_score: number | null
          software: string
          status: Database["public"]["Enums"]["opt_in_status"]
          turnaround: string
          updated_at: string
          withdrawn_at: string | null
          worker_id: string
        }
        Insert: {
          brief_opened_at: string
          created_at?: string
          history_score?: number | null
          id?: string
          job_id: string
          note_score?: number | null
          noticed_detail: string
          rank_score?: number | null
          software: string
          status?: Database["public"]["Enums"]["opt_in_status"]
          turnaround: string
          updated_at?: string
          withdrawn_at?: string | null
          worker_id: string
        }
        Update: {
          brief_opened_at?: string
          created_at?: string
          history_score?: number | null
          id?: string
          job_id?: string
          note_score?: number | null
          noticed_detail?: string
          rank_score?: number | null
          software?: string
          status?: Database["public"]["Enums"]["opt_in_status"]
          turnaround?: string
          updated_at?: string
          withdrawn_at?: string | null
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_opt_ins_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_opt_ins_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "worker_profiles"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      job_revisions: {
        Row: {
          created_at: string
          delivery_id: string
          due_at: string | null
          id: string
          is_free: boolean
          job_id: string
          reason: string
          requested_by: string
          responded_at: string | null
          sequence: number
          status: Database["public"]["Enums"]["revision_status"]
          updated_at: string
          worker_response: string | null
        }
        Insert: {
          created_at?: string
          delivery_id: string
          due_at?: string | null
          id?: string
          is_free: boolean
          job_id: string
          reason: string
          requested_by: string
          responded_at?: string | null
          sequence: number
          status?: Database["public"]["Enums"]["revision_status"]
          updated_at?: string
          worker_response?: string | null
        }
        Update: {
          created_at?: string
          delivery_id?: string
          due_at?: string | null
          id?: string
          is_free?: boolean
          job_id?: string
          reason?: string
          requested_by?: string
          responded_at?: string | null
          sequence?: number
          status?: Database["public"]["Enums"]["revision_status"]
          updated_at?: string
          worker_response?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_revisions_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "job_deliveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_revisions_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_revisions_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      job_shortlist_entries: {
        Row: {
          created_at: string
          history_score: number | null
          id: string
          note_score: number | null
          opt_in_id: string
          position: number
          score: number | null
          shortlist_id: string
          slot: Database["public"]["Enums"]["shortlist_slot"]
          worker_id: string
        }
        Insert: {
          created_at?: string
          history_score?: number | null
          id?: string
          note_score?: number | null
          opt_in_id: string
          position: number
          score?: number | null
          shortlist_id: string
          slot: Database["public"]["Enums"]["shortlist_slot"]
          worker_id: string
        }
        Update: {
          created_at?: string
          history_score?: number | null
          id?: string
          note_score?: number | null
          opt_in_id?: string
          position?: number
          score?: number | null
          shortlist_id?: string
          slot?: Database["public"]["Enums"]["shortlist_slot"]
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_shortlist_entries_opt_in_id_fkey"
            columns: ["opt_in_id"]
            isOneToOne: false
            referencedRelation: "job_opt_ins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_shortlist_entries_shortlist_id_fkey"
            columns: ["shortlist_id"]
            isOneToOne: false
            referencedRelation: "job_shortlists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_shortlist_entries_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "worker_profiles"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      job_shortlists: {
        Row: {
          algorithm_version: string
          generated_at: string
          id: string
          is_current: boolean
          job_id: string
        }
        Insert: {
          algorithm_version?: string
          generated_at?: string
          id?: string
          is_current?: boolean
          job_id: string
        }
        Update: {
          algorithm_version?: string
          generated_at?: string
          id?: string
          is_current?: boolean
          job_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_shortlists_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          addressed_to_worker_id: string | null
          assigned_at: string | null
          assigned_worker_id: string | null
          auto_accepted: boolean
          budget_paise: number
          cancelled_at: string | null
          category_id: string | null
          client_id: string
          completed_at: string | null
          created_at: string
          currency: string
          deadline_at: string | null
          delivered_at: string | null
          description: string
          expires_at: string | null
          id: string
          opt_in_count: number
          post_device_hash: string | null
          post_ip: unknown
          posted_as_other: boolean
          published_at: string | null
          requires_manual_review: boolean
          revision_count: number
          shortlist_generated_at: string | null
          status: Database["public"]["Enums"]["job_status"]
          title: string
          updated_at: string
        }
        Insert: {
          addressed_to_worker_id?: string | null
          assigned_at?: string | null
          assigned_worker_id?: string | null
          auto_accepted?: boolean
          budget_paise: number
          cancelled_at?: string | null
          category_id?: string | null
          client_id: string
          completed_at?: string | null
          created_at?: string
          currency?: string
          deadline_at?: string | null
          delivered_at?: string | null
          description: string
          expires_at?: string | null
          id?: string
          opt_in_count?: number
          post_device_hash?: string | null
          post_ip?: unknown
          posted_as_other?: boolean
          published_at?: string | null
          requires_manual_review?: boolean
          revision_count?: number
          shortlist_generated_at?: string | null
          status?: Database["public"]["Enums"]["job_status"]
          title: string
          updated_at?: string
        }
        Update: {
          addressed_to_worker_id?: string | null
          assigned_at?: string | null
          assigned_worker_id?: string | null
          auto_accepted?: boolean
          budget_paise?: number
          cancelled_at?: string | null
          category_id?: string | null
          client_id?: string
          completed_at?: string | null
          created_at?: string
          currency?: string
          deadline_at?: string | null
          delivered_at?: string | null
          description?: string
          expires_at?: string | null
          id?: string
          opt_in_count?: number
          post_device_hash?: string | null
          post_ip?: unknown
          posted_as_other?: boolean
          published_at?: string | null
          requires_manual_review?: boolean
          revision_count?: number
          shortlist_generated_at?: string | null
          status?: Database["public"]["Enums"]["job_status"]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "jobs_addressed_to_worker_id_fkey"
            columns: ["addressed_to_worker_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_assigned_worker_id_fkey"
            columns: ["assigned_worker_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      ledger_accounts: {
        Row: {
          code: string
          created_at: string
          currency: string
          id: string
          is_active: boolean
          name: string
          owner_id: string | null
          type: Database["public"]["Enums"]["ledger_account_type"]
        }
        Insert: {
          code: string
          created_at?: string
          currency?: string
          id?: string
          is_active?: boolean
          name: string
          owner_id?: string | null
          type: Database["public"]["Enums"]["ledger_account_type"]
        }
        Update: {
          code?: string
          created_at?: string
          currency?: string
          id?: string
          is_active?: boolean
          name?: string
          owner_id?: string | null
          type?: Database["public"]["Enums"]["ledger_account_type"]
        }
        Relationships: [
          {
            foreignKeyName: "ledger_accounts_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      ledger_entries: {
        Row: {
          account_id: string
          amount_paise: number
          created_at: string
          direction: Database["public"]["Enums"]["ledger_direction"]
          id: number
          job_id: string | null
          transaction_id: string
        }
        Insert: {
          account_id: string
          amount_paise: number
          created_at?: string
          direction: Database["public"]["Enums"]["ledger_direction"]
          id?: never
          job_id?: string | null
          transaction_id: string
        }
        Update: {
          account_id?: string
          amount_paise?: number
          created_at?: string
          direction?: Database["public"]["Enums"]["ledger_direction"]
          id?: never
          job_id?: string | null
          transaction_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ledger_entries_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "ledger_account_balances"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "ledger_entries_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "ledger_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_entries_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_entries_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "ledger_transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      ledger_transactions: {
        Row: {
          created_at: string
          created_by: string | null
          description: string
          id: string
          idempotency_key: string | null
          job_id: string | null
          kind: Database["public"]["Enums"]["ledger_txn_kind"]
          occurred_at: string
          reference_id: string | null
          reference_type: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description: string
          id?: string
          idempotency_key?: string | null
          job_id?: string | null
          kind: Database["public"]["Enums"]["ledger_txn_kind"]
          occurred_at?: string
          reference_id?: string | null
          reference_type?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string
          id?: string
          idempotency_key?: string | null
          job_id?: string | null
          kind?: Database["public"]["Enums"]["ledger_txn_kind"]
          occurred_at?: string
          reference_id?: string | null
          reference_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ledger_transactions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_transactions_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      message_attachments: {
        Row: {
          created_at: string
          file_id: string
          message_id: string
        }
        Insert: {
          created_at?: string
          file_id: string
          message_id: string
        }
        Update: {
          created_at?: string
          file_id?: string
          message_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_attachments_file_id_fkey"
            columns: ["file_id"]
            isOneToOne: false
            referencedRelation: "files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_attachments_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      message_raw: {
        Row: {
          body: string
          created_at: string
          message_id: string
        }
        Insert: {
          body: string
          created_at?: string
          message_id: string
        }
        Update: {
          body?: string
          created_at?: string
          message_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_raw_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: true
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      message_redactions: {
        Row: {
          created_at: string
          id: string
          kind: string
          matched: string
          message_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind: string
          matched: string
          message_id: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          matched?: string
          message_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_redactions_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          body: string
          conversation_id: string
          created_at: string
          has_attachments: boolean
          id: string
          redaction_count: number
          sender_id: string | null
          sender_role: Database["public"]["Enums"]["party_role"]
        }
        Insert: {
          body: string
          conversation_id: string
          created_at?: string
          has_attachments?: boolean
          id?: string
          redaction_count?: number
          sender_id?: string | null
          sender_role: Database["public"]["Enums"]["party_role"]
        }
        Update: {
          body?: string
          conversation_id?: string
          created_at?: string
          has_attachments?: boolean
          id?: string
          redaction_count?: number
          sender_id?: string | null
          sender_role?: Database["public"]["Enums"]["party_role"]
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          action_url: string | null
          body: string | null
          created_at: string
          id: string
          job_id: string | null
          profile_id: string
          read_at: string | null
          title: string
          type: Database["public"]["Enums"]["notification_type"]
        }
        Insert: {
          action_url?: string | null
          body?: string | null
          created_at?: string
          id?: string
          job_id?: string | null
          profile_id: string
          read_at?: string | null
          title: string
          type: Database["public"]["Enums"]["notification_type"]
        }
        Update: {
          action_url?: string | null
          body?: string | null
          created_at?: string
          id?: string
          job_id?: string | null
          profile_id?: string
          read_at?: string | null
          title?: string
          type?: Database["public"]["Enums"]["notification_type"]
        }
        Relationships: [
          {
            foreignKeyName: "notifications_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount_paise: number
          captured_at: string | null
          client_commission_paise: number
          client_id: string
          client_tax_paise: number
          created_at: string
          failed_at: string | null
          failure_reason: string | null
          gateway_fee_paise: number
          gateway_tax_paise: number
          id: string
          job_budget_paise: number
          job_id: string
          method: string | null
          payer_ip: unknown
          razorpay_order_id: string | null
          razorpay_payment_id: string | null
          refunded_paise: number
          status: Database["public"]["Enums"]["payment_status"]
          updated_at: string
        }
        Insert: {
          amount_paise: number
          captured_at?: string | null
          client_commission_paise?: number
          client_id: string
          client_tax_paise?: number
          created_at?: string
          failed_at?: string | null
          failure_reason?: string | null
          gateway_fee_paise?: number
          gateway_tax_paise?: number
          id?: string
          job_budget_paise: number
          job_id: string
          method?: string | null
          payer_ip?: unknown
          razorpay_order_id?: string | null
          razorpay_payment_id?: string | null
          refunded_paise?: number
          status?: Database["public"]["Enums"]["payment_status"]
          updated_at?: string
        }
        Update: {
          amount_paise?: number
          captured_at?: string | null
          client_commission_paise?: number
          client_id?: string
          client_tax_paise?: number
          created_at?: string
          failed_at?: string | null
          failure_reason?: string | null
          gateway_fee_paise?: number
          gateway_tax_paise?: number
          id?: string
          job_budget_paise?: number
          job_id?: string
          method?: string | null
          payer_ip?: unknown
          razorpay_order_id?: string | null
          razorpay_payment_id?: string | null
          refunded_paise?: number
          status?: Database["public"]["Enums"]["payment_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      payout_batches: {
        Row: {
          created_at: string
          cutoff_at: string
          cycle_start_at: string
          failure_note: string | null
          id: string
          item_count: number
          processed_at: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          scheduled_pay_at: string
          status: Database["public"]["Enums"]["payout_batch_status"]
          total_paise: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          cutoff_at: string
          cycle_start_at: string
          failure_note?: string | null
          id?: string
          item_count?: number
          processed_at?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          scheduled_pay_at: string
          status?: Database["public"]["Enums"]["payout_batch_status"]
          total_paise?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          cutoff_at?: string
          cycle_start_at?: string
          failure_note?: string | null
          id?: string
          item_count?: number
          processed_at?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          scheduled_pay_at?: string
          status?: Database["public"]["Enums"]["payout_batch_status"]
          total_paise?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payout_batches_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      payout_items: {
        Row: {
          adjustment_id: string | null
          amount_paise: number
          created_at: string
          earning_id: string | null
          id: string
          job_id: string | null
          kind: Database["public"]["Enums"]["payout_item_kind"]
          label: string
          payout_id: string
        }
        Insert: {
          adjustment_id?: string | null
          amount_paise: number
          created_at?: string
          earning_id?: string | null
          id?: string
          job_id?: string | null
          kind: Database["public"]["Enums"]["payout_item_kind"]
          label: string
          payout_id: string
        }
        Update: {
          adjustment_id?: string | null
          amount_paise?: number
          created_at?: string
          earning_id?: string | null
          id?: string
          job_id?: string | null
          kind?: Database["public"]["Enums"]["payout_item_kind"]
          label?: string
          payout_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payout_items_adjustment_fk"
            columns: ["adjustment_id"]
            isOneToOne: false
            referencedRelation: "worker_adjustments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_items_earning_id_fkey"
            columns: ["earning_id"]
            isOneToOne: false
            referencedRelation: "worker_earnings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_items_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_items_payout_id_fkey"
            columns: ["payout_id"]
            isOneToOne: false
            referencedRelation: "payouts"
            referencedColumns: ["id"]
          },
        ]
      }
      payout_methods: {
        Row: {
          account_last4: string | null
          bank_name: string | null
          consecutive_failures: number
          created_at: string
          destination_hash: string
          disabled_at: string | null
          id: string
          ifsc: string | null
          is_default: boolean
          label: string | null
          last_failure_reason: string | null
          razorpay_contact_id: string | null
          razorpay_fund_account_id: string | null
          status: Database["public"]["Enums"]["payout_method_status"]
          type: Database["public"]["Enums"]["payout_method_type"]
          updated_at: string
          upi_handle_masked: string | null
          verified_at: string | null
          worker_id: string
        }
        Insert: {
          account_last4?: string | null
          bank_name?: string | null
          consecutive_failures?: number
          created_at?: string
          destination_hash: string
          disabled_at?: string | null
          id?: string
          ifsc?: string | null
          is_default?: boolean
          label?: string | null
          last_failure_reason?: string | null
          razorpay_contact_id?: string | null
          razorpay_fund_account_id?: string | null
          status?: Database["public"]["Enums"]["payout_method_status"]
          type: Database["public"]["Enums"]["payout_method_type"]
          updated_at?: string
          upi_handle_masked?: string | null
          verified_at?: string | null
          worker_id: string
        }
        Update: {
          account_last4?: string | null
          bank_name?: string | null
          consecutive_failures?: number
          created_at?: string
          destination_hash?: string
          disabled_at?: string | null
          id?: string
          ifsc?: string | null
          is_default?: boolean
          label?: string | null
          last_failure_reason?: string | null
          razorpay_contact_id?: string | null
          razorpay_fund_account_id?: string | null
          status?: Database["public"]["Enums"]["payout_method_status"]
          type?: Database["public"]["Enums"]["payout_method_type"]
          updated_at?: string
          upi_handle_masked?: string | null
          verified_at?: string | null
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payout_methods_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "worker_profiles"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      payouts: {
        Row: {
          amount_paise: number
          attempt: number
          batch_id: string | null
          created_at: string
          failed_at: string | null
          failure_code: string | null
          failure_reason: string | null
          id: string
          instant_fee_paise: number
          is_instant: boolean
          paid_at: string | null
          payout_method_id: string
          razorpay_payout_id: string | null
          status: Database["public"]["Enums"]["payout_status"]
          updated_at: string
          utr: string | null
          worker_id: string
        }
        Insert: {
          amount_paise: number
          attempt?: number
          batch_id?: string | null
          created_at?: string
          failed_at?: string | null
          failure_code?: string | null
          failure_reason?: string | null
          id?: string
          instant_fee_paise?: number
          is_instant?: boolean
          paid_at?: string | null
          payout_method_id: string
          razorpay_payout_id?: string | null
          status?: Database["public"]["Enums"]["payout_status"]
          updated_at?: string
          utr?: string | null
          worker_id: string
        }
        Update: {
          amount_paise?: number
          attempt?: number
          batch_id?: string | null
          created_at?: string
          failed_at?: string | null
          failure_code?: string | null
          failure_reason?: string | null
          id?: string
          instant_fee_paise?: number
          is_instant?: boolean
          paid_at?: string | null
          payout_method_id?: string
          razorpay_payout_id?: string | null
          status?: Database["public"]["Enums"]["payout_status"]
          updated_at?: string
          utr?: string | null
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payouts_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "payout_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payouts_payout_method_id_fkey"
            columns: ["payout_method_id"]
            isOneToOne: false
            referencedRelation: "payout_methods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payouts_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "worker_profiles"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      penalties: {
        Row: {
          applied_by: string | null
          created_at: string
          debit_paise: number
          id: string
          internal_note: string | null
          job_id: string | null
          next_job_cap_paise: number
          pending_earnings_bps: number
          profile_id: string
          rating_delta: number | null
          reason: string
          reversal_reason: string | null
          reversed_at: string | null
          role: Database["public"]["Enums"]["party_role"]
          settled_at: string | null
          status: Database["public"]["Enums"]["penalty_status"]
          type: Database["public"]["Enums"]["penalty_type"]
          updated_at: string
        }
        Insert: {
          applied_by?: string | null
          created_at?: string
          debit_paise?: number
          id?: string
          internal_note?: string | null
          job_id?: string | null
          next_job_cap_paise?: number
          pending_earnings_bps?: number
          profile_id: string
          rating_delta?: number | null
          reason: string
          reversal_reason?: string | null
          reversed_at?: string | null
          role: Database["public"]["Enums"]["party_role"]
          settled_at?: string | null
          status?: Database["public"]["Enums"]["penalty_status"]
          type: Database["public"]["Enums"]["penalty_type"]
          updated_at?: string
        }
        Update: {
          applied_by?: string | null
          created_at?: string
          debit_paise?: number
          id?: string
          internal_note?: string | null
          job_id?: string | null
          next_job_cap_paise?: number
          pending_earnings_bps?: number
          profile_id?: string
          rating_delta?: number | null
          reason?: string
          reversal_reason?: string | null
          reversed_at?: string | null
          role?: Database["public"]["Enums"]["party_role"]
          settled_at?: string | null
          status?: Database["public"]["Enums"]["penalty_status"]
          type?: Database["public"]["Enums"]["penalty_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "penalties_applied_by_fkey"
            columns: ["applied_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "penalties_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "penalties_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      phone_verifications: {
        Row: {
          attempts: number
          consumed_at: string | null
          created_at: string
          expires_at: string
          id: string
          mobile: string
          otp_hash: string
          profile_id: string
          request_ip: unknown
        }
        Insert: {
          attempts?: number
          consumed_at?: string | null
          created_at?: string
          expires_at: string
          id?: string
          mobile: string
          otp_hash: string
          profile_id: string
          request_ip?: unknown
        }
        Update: {
          attempts?: number
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          mobile?: string
          otp_hash?: string
          profile_id?: string
          request_ip?: unknown
        }
        Relationships: [
          {
            foreignKeyName: "phone_verifications_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_settings: {
        Row: {
          description: string
          is_public: boolean
          key: string
          updated_at: string
          updated_by: string | null
          value: Json
          value_type: string
        }
        Insert: {
          description: string
          is_public?: boolean
          key: string
          updated_at?: string
          updated_by?: string | null
          value: Json
          value_type: string
        }
        Update: {
          description?: string
          is_public?: boolean
          key?: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
          value_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          anonymised_at: string | null
          avatar_file_id: string | null
          created_at: string
          display_name: string | null
          email: string
          email_verified_at: string | null
          full_name: string
          id: string
          is_client: boolean
          is_worker: boolean
          last_seen_at: string | null
          locale: string
          mobile: string | null
          mobile_verified_at: string | null
          signup_ip: unknown
          status: Database["public"]["Enums"]["account_status"]
          status_reason: string | null
          suspended_until: string | null
          timezone: string
          updated_at: string
        }
        Insert: {
          anonymised_at?: string | null
          avatar_file_id?: string | null
          created_at?: string
          display_name?: string | null
          email: string
          email_verified_at?: string | null
          full_name: string
          id: string
          is_client?: boolean
          is_worker?: boolean
          last_seen_at?: string | null
          locale?: string
          mobile?: string | null
          mobile_verified_at?: string | null
          signup_ip?: unknown
          status?: Database["public"]["Enums"]["account_status"]
          status_reason?: string | null
          suspended_until?: string | null
          timezone?: string
          updated_at?: string
        }
        Update: {
          anonymised_at?: string | null
          avatar_file_id?: string | null
          created_at?: string
          display_name?: string | null
          email?: string
          email_verified_at?: string | null
          full_name?: string
          id?: string
          is_client?: boolean
          is_worker?: boolean
          last_seen_at?: string | null
          locale?: string
          mobile?: string | null
          mobile_verified_at?: string | null
          signup_ip?: unknown
          status?: Database["public"]["Enums"]["account_status"]
          status_reason?: string | null
          suspended_until?: string | null
          timezone?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_avatar_file_fk"
            columns: ["avatar_file_id"]
            isOneToOne: false
            referencedRelation: "files"
            referencedColumns: ["id"]
          },
        ]
      }
      public_profiles: {
        Row: {
          avatar_file_id: string | null
          display_name: string
          is_client: boolean
          is_worker: boolean
          member_since: string
          profile_id: string
          updated_at: string
        }
        Insert: {
          avatar_file_id?: string | null
          display_name: string
          is_client?: boolean
          is_worker?: boolean
          member_since: string
          profile_id: string
          updated_at?: string
        }
        Update: {
          avatar_file_id?: string | null
          display_name?: string
          is_client?: boolean
          is_worker?: boolean
          member_since?: string
          profile_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "public_profiles_avatar_file_fk"
            columns: ["avatar_file_id"]
            isOneToOne: false
            referencedRelation: "files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "public_profiles_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      rating_tag_selections: {
        Row: {
          rating_id: string
          tag_id: string
        }
        Insert: {
          rating_id: string
          tag_id: string
        }
        Update: {
          rating_id?: string
          tag_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rating_tag_selections_rating_id_fkey"
            columns: ["rating_id"]
            isOneToOne: false
            referencedRelation: "ratings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rating_tag_selections_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "rating_tags"
            referencedColumns: ["id"]
          },
        ]
      }
      rating_tags: {
        Row: {
          code: string
          created_at: string
          direction: Database["public"]["Enums"]["rating_direction"]
          id: string
          is_active: boolean
          label: string
          position: number
          sentiment: Database["public"]["Enums"]["rating_sentiment"]
        }
        Insert: {
          code: string
          created_at?: string
          direction: Database["public"]["Enums"]["rating_direction"]
          id?: string
          is_active?: boolean
          label: string
          position?: number
          sentiment: Database["public"]["Enums"]["rating_sentiment"]
        }
        Update: {
          code?: string
          created_at?: string
          direction?: Database["public"]["Enums"]["rating_direction"]
          id?: string
          is_active?: boolean
          label?: string
          position?: number
          sentiment?: Database["public"]["Enums"]["rating_sentiment"]
        }
        Relationships: []
      }
      ratings: {
        Row: {
          category_id: string | null
          comment: string | null
          counts_publicly: boolean
          created_at: string
          direction: Database["public"]["Enums"]["rating_direction"]
          id: string
          job_id: string
          ratee_id: string
          rater_id: string
          revealed_at: string | null
          stars: number
        }
        Insert: {
          category_id?: string | null
          comment?: string | null
          counts_publicly?: boolean
          created_at?: string
          direction: Database["public"]["Enums"]["rating_direction"]
          id?: string
          job_id: string
          ratee_id: string
          rater_id: string
          revealed_at?: string | null
          stars: number
        }
        Update: {
          category_id?: string | null
          comment?: string | null
          counts_publicly?: boolean
          created_at?: string
          direction?: Database["public"]["Enums"]["rating_direction"]
          id?: string
          job_id?: string
          ratee_id?: string
          rater_id?: string
          revealed_at?: string | null
          stars?: number
        }
        Relationships: [
          {
            foreignKeyName: "ratings_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ratings_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ratings_ratee_id_fkey"
            columns: ["ratee_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ratings_rater_id_fkey"
            columns: ["rater_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      refunds: {
        Row: {
          amount_paise: number
          cancellation_id: string | null
          completed_at: string | null
          created_at: string
          dispute_id: string | null
          document_id: string | null
          failure_reason: string | null
          gateway_fee_absorbed_paise: number
          id: string
          initiated_by: string | null
          job_id: string
          note: string | null
          payment_id: string
          razorpay_refund_id: string | null
          reason: Database["public"]["Enums"]["refund_reason"]
          status: Database["public"]["Enums"]["refund_status"]
          updated_at: string
        }
        Insert: {
          amount_paise: number
          cancellation_id?: string | null
          completed_at?: string | null
          created_at?: string
          dispute_id?: string | null
          document_id?: string | null
          failure_reason?: string | null
          gateway_fee_absorbed_paise?: number
          id?: string
          initiated_by?: string | null
          job_id: string
          note?: string | null
          payment_id: string
          razorpay_refund_id?: string | null
          reason: Database["public"]["Enums"]["refund_reason"]
          status?: Database["public"]["Enums"]["refund_status"]
          updated_at?: string
        }
        Update: {
          amount_paise?: number
          cancellation_id?: string | null
          completed_at?: string | null
          created_at?: string
          dispute_id?: string | null
          document_id?: string | null
          failure_reason?: string | null
          gateway_fee_absorbed_paise?: number
          id?: string
          initiated_by?: string | null
          job_id?: string
          note?: string | null
          payment_id?: string
          razorpay_refund_id?: string | null
          reason?: Database["public"]["Enums"]["refund_reason"]
          status?: Database["public"]["Enums"]["refund_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "refunds_cancellation_id_fkey"
            columns: ["cancellation_id"]
            isOneToOne: false
            referencedRelation: "cancellations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refunds_dispute_fk"
            columns: ["dispute_id"]
            isOneToOne: false
            referencedRelation: "disputes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refunds_document_fk"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refunds_initiated_by_fkey"
            columns: ["initiated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refunds_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refunds_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
        ]
      }
      rehire_invitations: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          job_id: string
          message: string | null
          responded_at: string | null
          status: Database["public"]["Enums"]["rehire_status"]
          worker_id: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          id?: string
          job_id: string
          message?: string | null
          responded_at?: string | null
          status?: Database["public"]["Enums"]["rehire_status"]
          worker_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          job_id?: string
          message?: string | null
          responded_at?: string | null
          status?: Database["public"]["Enums"]["rehire_status"]
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rehire_invitations_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rehire_invitations_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "worker_profiles"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      reports: {
        Row: {
          assigned_admin_id: string | null
          created_at: string
          delivery_id: string | null
          description: string
          id: string
          job_id: string | null
          message_id: string | null
          priority: number
          reason: Database["public"]["Enums"]["report_reason"]
          reported_profile_id: string | null
          reporter_id: string
          resolution_note: string | null
          resolved_at: string | null
          sample_id: string | null
          status: Database["public"]["Enums"]["report_status"]
          updated_at: string
        }
        Insert: {
          assigned_admin_id?: string | null
          created_at?: string
          delivery_id?: string | null
          description: string
          id?: string
          job_id?: string | null
          message_id?: string | null
          priority?: number
          reason: Database["public"]["Enums"]["report_reason"]
          reported_profile_id?: string | null
          reporter_id: string
          resolution_note?: string | null
          resolved_at?: string | null
          sample_id?: string | null
          status?: Database["public"]["Enums"]["report_status"]
          updated_at?: string
        }
        Update: {
          assigned_admin_id?: string | null
          created_at?: string
          delivery_id?: string | null
          description?: string
          id?: string
          job_id?: string | null
          message_id?: string | null
          priority?: number
          reason?: Database["public"]["Enums"]["report_reason"]
          reported_profile_id?: string | null
          reporter_id?: string
          resolution_note?: string | null
          resolved_at?: string | null
          sample_id?: string | null
          status?: Database["public"]["Enums"]["report_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reports_assigned_admin_id_fkey"
            columns: ["assigned_admin_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reports_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "job_deliveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reports_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reports_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reports_reported_profile_id_fkey"
            columns: ["reported_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reports_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reports_sample_id_fkey"
            columns: ["sample_id"]
            isOneToOne: false
            referencedRelation: "worker_samples"
            referencedColumns: ["id"]
          },
        ]
      }
      risk_flags: {
        Row: {
          counterparty_id: string | null
          created_at: string
          detail: Json
          id: string
          job_id: string | null
          kind: Database["public"]["Enums"]["risk_flag_kind"]
          profile_id: string
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          severity: number
          status: Database["public"]["Enums"]["risk_flag_status"]
        }
        Insert: {
          counterparty_id?: string | null
          created_at?: string
          detail?: Json
          id?: string
          job_id?: string | null
          kind: Database["public"]["Enums"]["risk_flag_kind"]
          profile_id: string
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          severity?: number
          status?: Database["public"]["Enums"]["risk_flag_status"]
        }
        Update: {
          counterparty_id?: string | null
          created_at?: string
          detail?: Json
          id?: string
          job_id?: string | null
          kind?: Database["public"]["Enums"]["risk_flag_kind"]
          profile_id?: string
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          severity?: number
          status?: Database["public"]["Enums"]["risk_flag_status"]
        }
        Relationships: [
          {
            foreignKeyName: "risk_flags_counterparty_id_fkey"
            columns: ["counterparty_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "risk_flags_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "risk_flags_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "risk_flags_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      subscription_plans: {
        Row: {
          audience: Database["public"]["Enums"]["plan_audience"]
          brief_templates: boolean
          code: string
          commission_discount_bps: number
          created_at: string
          featured_placement: boolean
          free_instant_payouts: number
          gst_invoicing: boolean
          guaranteed_shortlist: boolean
          id: string
          is_active: boolean
          name: string
          opt_in_limit: number | null
          price_paise: number
          priority_disputes: boolean
          unlimited_opt_ins: boolean
          unlimited_rehire: boolean
          updated_at: string
        }
        Insert: {
          audience: Database["public"]["Enums"]["plan_audience"]
          brief_templates?: boolean
          code: string
          commission_discount_bps?: number
          created_at?: string
          featured_placement?: boolean
          free_instant_payouts?: number
          gst_invoicing?: boolean
          guaranteed_shortlist?: boolean
          id?: string
          is_active?: boolean
          name: string
          opt_in_limit?: number | null
          price_paise: number
          priority_disputes?: boolean
          unlimited_opt_ins?: boolean
          unlimited_rehire?: boolean
          updated_at?: string
        }
        Update: {
          audience?: Database["public"]["Enums"]["plan_audience"]
          brief_templates?: boolean
          code?: string
          commission_discount_bps?: number
          created_at?: string
          featured_placement?: boolean
          free_instant_payouts?: number
          gst_invoicing?: boolean
          guaranteed_shortlist?: boolean
          id?: string
          is_active?: boolean
          name?: string
          opt_in_limit?: number | null
          price_paise?: number
          priority_disputes?: boolean
          unlimited_opt_ins?: boolean
          unlimited_rehire?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      subscriptions: {
        Row: {
          cancel_at_period_end: boolean
          cancelled_at: string | null
          created_at: string
          current_period_end: string
          current_period_start: string
          id: string
          plan_id: string
          profile_id: string
          razorpay_subscription_id: string | null
          started_at: string
          status: Database["public"]["Enums"]["subscription_status"]
          updated_at: string
        }
        Insert: {
          cancel_at_period_end?: boolean
          cancelled_at?: string | null
          created_at?: string
          current_period_end: string
          current_period_start: string
          id?: string
          plan_id: string
          profile_id: string
          razorpay_subscription_id?: string | null
          started_at?: string
          status?: Database["public"]["Enums"]["subscription_status"]
          updated_at?: string
        }
        Update: {
          cancel_at_period_end?: boolean
          cancelled_at?: string | null
          created_at?: string
          current_period_end?: string
          current_period_start?: string
          id?: string
          plan_id?: string
          profile_id?: string
          razorpay_subscription_id?: string | null
          started_at?: string
          status?: Database["public"]["Enums"]["subscription_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "subscription_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      support_messages: {
        Row: {
          author_id: string
          body: string
          created_at: string
          id: string
          is_staff: boolean
          ticket_id: string
        }
        Insert: {
          author_id: string
          body: string
          created_at?: string
          id?: string
          is_staff?: boolean
          ticket_id: string
        }
        Update: {
          author_id?: string
          body?: string
          created_at?: string
          id?: string
          is_staff?: boolean
          ticket_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_messages_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_messages_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "support_tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      support_tickets: {
        Row: {
          assigned_admin_id: string | null
          created_at: string
          first_reply_at: string | null
          id: string
          job_id: string | null
          priority: number
          profile_id: string
          resolved_at: string | null
          sla_due_at: string
          status: Database["public"]["Enums"]["ticket_status"]
          subject: string
          updated_at: string
        }
        Insert: {
          assigned_admin_id?: string | null
          created_at?: string
          first_reply_at?: string | null
          id?: string
          job_id?: string | null
          priority?: number
          profile_id: string
          resolved_at?: string | null
          sla_due_at: string
          status?: Database["public"]["Enums"]["ticket_status"]
          subject: string
          updated_at?: string
        }
        Update: {
          assigned_admin_id?: string | null
          created_at?: string
          first_reply_at?: string | null
          id?: string
          job_id?: string | null
          priority?: number
          profile_id?: string
          resolved_at?: string | null
          sla_due_at?: string
          status?: Database["public"]["Enums"]["ticket_status"]
          subject?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_tickets_assigned_admin_id_fkey"
            columns: ["assigned_admin_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_tickets_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_tickets_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      tax_rates: {
        Row: {
          applies_to: string
          code: string
          created_at: string
          effective_from: string
          effective_to: string | null
          id: string
          jurisdiction: string
          name: string
          note: string | null
          rate_bps: number
        }
        Insert: {
          applies_to: string
          code: string
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          id?: string
          jurisdiction?: string
          name: string
          note?: string | null
          rate_bps: number
        }
        Update: {
          applies_to?: string
          code?: string
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          id?: string
          jurisdiction?: string
          name?: string
          note?: string | null
          rate_bps?: number
        }
        Relationships: []
      }
      user_devices: {
        Row: {
          device_hash: string
          first_seen_at: string
          id: string
          last_seen_at: string
          profile_id: string
          seen_count: number
          user_agent: string | null
        }
        Insert: {
          device_hash: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          profile_id: string
          seen_count?: number
          user_agent?: string | null
        }
        Update: {
          device_hash?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          profile_id?: string
          seen_count?: number
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_devices_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_ip_events: {
        Row: {
          context: string
          created_at: string
          id: number
          ip: unknown
          profile_id: string
        }
        Insert: {
          context: string
          created_at?: string
          id?: never
          ip: unknown
          profile_id: string
        }
        Update: {
          context?: string
          created_at?: string
          id?: never
          ip?: unknown
          profile_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_ip_events_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_pair_signals: {
        Row: {
          avg_completion_seconds: number | null
          avg_rating: number | null
          client_id: string
          first_job_at: string | null
          five_star_count: number
          jobs_together: number
          last_job_at: string | null
          shared_device: boolean
          shared_ip: boolean
          shared_payout_destination: boolean
          total_messages: number
          total_value_paise: number
          updated_at: string
          worker_id: string
        }
        Insert: {
          avg_completion_seconds?: number | null
          avg_rating?: number | null
          client_id: string
          first_job_at?: string | null
          five_star_count?: number
          jobs_together?: number
          last_job_at?: string | null
          shared_device?: boolean
          shared_ip?: boolean
          shared_payout_destination?: boolean
          total_messages?: number
          total_value_paise?: number
          updated_at?: string
          worker_id: string
        }
        Update: {
          avg_completion_seconds?: number | null
          avg_rating?: number | null
          client_id?: string
          first_job_at?: string | null
          five_star_count?: number
          jobs_together?: number
          last_job_at?: string | null
          shared_device?: boolean
          shared_ip?: boolean
          shared_payout_destination?: boolean
          total_messages?: number
          total_value_paise?: number
          updated_at?: string
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_pair_signals_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_pair_signals_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_private_stats: {
        Row: {
          chargebacks: number
          dispute_rate_bps: number
          disputes_against: number
          disputes_lost: number
          disputes_raised: number
          profile_id: string
          reports_against: number
          risk_components: Json
          risk_computed_at: string | null
          risk_score: number
          updated_at: string
        }
        Insert: {
          chargebacks?: number
          dispute_rate_bps?: number
          disputes_against?: number
          disputes_lost?: number
          disputes_raised?: number
          profile_id: string
          reports_against?: number
          risk_components?: Json
          risk_computed_at?: string | null
          risk_score?: number
          updated_at?: string
        }
        Update: {
          chargebacks?: number
          dispute_rate_bps?: number
          disputes_against?: number
          disputes_lost?: number
          disputes_raised?: number
          profile_id?: string
          reports_against?: number
          risk_components?: Json
          risk_computed_at?: string | null
          risk_score?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_private_stats_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_sanctions: {
        Row: {
          created_at: string
          ends_at: string | null
          id: string
          internal_note: string | null
          issued_by: string | null
          lifted_at: string | null
          lifted_by: string | null
          penalty_id: string | null
          profile_id: string
          reason: string
          report_id: string | null
          starts_at: string
          type: Database["public"]["Enums"]["sanction_type"]
        }
        Insert: {
          created_at?: string
          ends_at?: string | null
          id?: string
          internal_note?: string | null
          issued_by?: string | null
          lifted_at?: string | null
          lifted_by?: string | null
          penalty_id?: string | null
          profile_id: string
          reason: string
          report_id?: string | null
          starts_at?: string
          type: Database["public"]["Enums"]["sanction_type"]
        }
        Update: {
          created_at?: string
          ends_at?: string | null
          id?: string
          internal_note?: string | null
          issued_by?: string | null
          lifted_at?: string | null
          lifted_by?: string | null
          penalty_id?: string | null
          profile_id?: string
          reason?: string
          report_id?: string | null
          starts_at?: string
          type?: Database["public"]["Enums"]["sanction_type"]
        }
        Relationships: [
          {
            foreignKeyName: "user_sanctions_issued_by_fkey"
            columns: ["issued_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_sanctions_lifted_by_fkey"
            columns: ["lifted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_sanctions_penalty_fk"
            columns: ["penalty_id"]
            isOneToOne: false
            referencedRelation: "penalties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_sanctions_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_sanctions_report_fk"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "reports"
            referencedColumns: ["id"]
          },
        ]
      }
      worker_adjustments: {
        Row: {
          amount_paise: number
          blocks_new_jobs: boolean
          created_at: string
          created_by: string | null
          id: string
          kind: Database["public"]["Enums"]["payout_item_kind"]
          penalty_id: string | null
          reason: string
          recovered_paise: number
          settled_at: string | null
          updated_at: string
          worker_id: string
        }
        Insert: {
          amount_paise: number
          blocks_new_jobs?: boolean
          created_at?: string
          created_by?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["payout_item_kind"]
          penalty_id?: string | null
          reason: string
          recovered_paise?: number
          settled_at?: string | null
          updated_at?: string
          worker_id: string
        }
        Update: {
          amount_paise?: number
          blocks_new_jobs?: boolean
          created_at?: string
          created_by?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["payout_item_kind"]
          penalty_id?: string | null
          reason?: string
          recovered_paise?: number
          settled_at?: string | null
          updated_at?: string
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_adjustments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_adjustments_penalty_fk"
            columns: ["penalty_id"]
            isOneToOne: false
            referencedRelation: "penalties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_adjustments_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "worker_profiles"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      worker_applications: {
        Row: {
          attempt: number
          created_at: string
          decision_reason: string | null
          flagged_for_first_job: boolean
          id: string
          internal_note: string | null
          resubmit_after: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          sla_due_at: string | null
          status: Database["public"]["Enums"]["worker_application_status"]
          submitted_at: string | null
          updated_at: string
          worker_id: string
        }
        Insert: {
          attempt?: number
          created_at?: string
          decision_reason?: string | null
          flagged_for_first_job?: boolean
          id?: string
          internal_note?: string | null
          resubmit_after?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sla_due_at?: string | null
          status?: Database["public"]["Enums"]["worker_application_status"]
          submitted_at?: string | null
          updated_at?: string
          worker_id: string
        }
        Update: {
          attempt?: number
          created_at?: string
          decision_reason?: string | null
          flagged_for_first_job?: boolean
          id?: string
          internal_note?: string | null
          resubmit_after?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sla_due_at?: string | null
          status?: Database["public"]["Enums"]["worker_application_status"]
          submitted_at?: string | null
          updated_at?: string
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_applications_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_applications_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "worker_profiles"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      worker_categories: {
        Row: {
          category_id: string
          created_at: string
          is_primary: boolean
          worker_id: string
        }
        Insert: {
          category_id: string
          created_at?: string
          is_primary?: boolean
          worker_id: string
        }
        Update: {
          category_id?: string
          created_at?: string
          is_primary?: boolean
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_categories_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_categories_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "worker_profiles"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      worker_category_stats: {
        Row: {
          category_id: string
          jobs_abandoned: number
          jobs_completed: number
          last_job_at: string | null
          late_deliveries: number
          on_time_deliveries: number
          rating: number | null
          rating_count: number
          rating_raw_sum: number
          updated_at: string
          worker_id: string
        }
        Insert: {
          category_id: string
          jobs_abandoned?: number
          jobs_completed?: number
          last_job_at?: string | null
          late_deliveries?: number
          on_time_deliveries?: number
          rating?: number | null
          rating_count?: number
          rating_raw_sum?: number
          updated_at?: string
          worker_id: string
        }
        Update: {
          category_id?: string
          jobs_abandoned?: number
          jobs_completed?: number
          last_job_at?: string | null
          late_deliveries?: number
          on_time_deliveries?: number
          rating?: number | null
          rating_count?: number
          rating_raw_sum?: number
          updated_at?: string
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_category_stats_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_category_stats_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "worker_profiles"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      worker_earnings: {
        Row: {
          accepted_at: string | null
          commission_paise: number
          created_at: string
          eligible_at: string | null
          frozen_reason: string | null
          gross_paise: number
          hold_reason: string | null
          hold_until: string | null
          id: string
          job_id: string
          net_paise: number
          paid_at: string | null
          payout_id: string | null
          penalty_paise: number
          status: Database["public"]["Enums"]["earning_status"]
          tax_paise: number
          updated_at: string
          worker_id: string
        }
        Insert: {
          accepted_at?: string | null
          commission_paise?: number
          created_at?: string
          eligible_at?: string | null
          frozen_reason?: string | null
          gross_paise: number
          hold_reason?: string | null
          hold_until?: string | null
          id?: string
          job_id: string
          net_paise: number
          paid_at?: string | null
          payout_id?: string | null
          penalty_paise?: number
          status?: Database["public"]["Enums"]["earning_status"]
          tax_paise?: number
          updated_at?: string
          worker_id: string
        }
        Update: {
          accepted_at?: string | null
          commission_paise?: number
          created_at?: string
          eligible_at?: string | null
          frozen_reason?: string | null
          gross_paise?: number
          hold_reason?: string | null
          hold_until?: string | null
          id?: string
          job_id?: string
          net_paise?: number
          paid_at?: string | null
          payout_id?: string | null
          penalty_paise?: number
          status?: Database["public"]["Enums"]["earning_status"]
          tax_paise?: number
          updated_at?: string
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_earnings_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_earnings_payout_fk"
            columns: ["payout_id"]
            isOneToOne: false
            referencedRelation: "payouts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_earnings_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "worker_profiles"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      worker_kyc: {
        Row: {
          attempts: number
          blocked_reason: string | null
          created_at: string
          date_of_birth: string | null
          duplicate_pan_flagged: boolean
          legal_name: string | null
          name_match_passed: boolean | null
          name_match_score: number | null
          pan_hash: string | null
          pan_last4: string | null
          pan_registered_name: string | null
          penny_drop_name: string | null
          provider_reference: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["kyc_status"]
          updated_at: string
          verified_at: string | null
          worker_id: string
        }
        Insert: {
          attempts?: number
          blocked_reason?: string | null
          created_at?: string
          date_of_birth?: string | null
          duplicate_pan_flagged?: boolean
          legal_name?: string | null
          name_match_passed?: boolean | null
          name_match_score?: number | null
          pan_hash?: string | null
          pan_last4?: string | null
          pan_registered_name?: string | null
          penny_drop_name?: string | null
          provider_reference?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["kyc_status"]
          updated_at?: string
          verified_at?: string | null
          worker_id: string
        }
        Update: {
          attempts?: number
          blocked_reason?: string | null
          created_at?: string
          date_of_birth?: string | null
          duplicate_pan_flagged?: boolean
          legal_name?: string | null
          name_match_passed?: boolean | null
          name_match_score?: number | null
          pan_hash?: string | null
          pan_last4?: string | null
          pan_registered_name?: string | null
          penny_drop_name?: string | null
          provider_reference?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["kyc_status"]
          updated_at?: string
          verified_at?: string | null
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_kyc_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_kyc_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: true
            referencedRelation: "worker_profiles"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      worker_profiles: {
        Row: {
          active_opt_ins: number
          approved_at: string | null
          bio: string | null
          created_at: string
          headline: string | null
          jobs_completed: number
          last_delivered_at: string | null
          profile_id: string
          rating: number | null
          rating_job_count: number
          status: Database["public"]["Enums"]["worker_status"]
          tier: Database["public"]["Enums"]["worker_tier"]
          tier_computed_at: string | null
          updated_at: string
        }
        Insert: {
          active_opt_ins?: number
          approved_at?: string | null
          bio?: string | null
          created_at?: string
          headline?: string | null
          jobs_completed?: number
          last_delivered_at?: string | null
          profile_id: string
          rating?: number | null
          rating_job_count?: number
          status?: Database["public"]["Enums"]["worker_status"]
          tier?: Database["public"]["Enums"]["worker_tier"]
          tier_computed_at?: string | null
          updated_at?: string
        }
        Update: {
          active_opt_ins?: number
          approved_at?: string | null
          bio?: string | null
          created_at?: string
          headline?: string | null
          jobs_completed?: number
          last_delivered_at?: string | null
          profile_id?: string
          rating?: number | null
          rating_job_count?: number
          status?: Database["public"]["Enums"]["worker_status"]
          tier?: Database["public"]["Enums"]["worker_tier"]
          tier_computed_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_profiles_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      worker_samples: {
        Row: {
          application_id: string | null
          caption: string
          category_id: string
          created_at: string
          file_id: string
          id: string
          position: number
          rejection_reason: string | null
          reverse_search_at: string | null
          reverse_search_url: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          sole_author_confirmed: boolean
          status: Database["public"]["Enums"]["sample_status"]
          updated_at: string
          worker_id: string
        }
        Insert: {
          application_id?: string | null
          caption: string
          category_id: string
          created_at?: string
          file_id: string
          id?: string
          position?: number
          rejection_reason?: string | null
          reverse_search_at?: string | null
          reverse_search_url?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sole_author_confirmed: boolean
          status?: Database["public"]["Enums"]["sample_status"]
          updated_at?: string
          worker_id: string
        }
        Update: {
          application_id?: string | null
          caption?: string
          category_id?: string
          created_at?: string
          file_id?: string
          id?: string
          position?: number
          rejection_reason?: string | null
          reverse_search_at?: string | null
          reverse_search_url?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sole_author_confirmed?: boolean
          status?: Database["public"]["Enums"]["sample_status"]
          updated_at?: string
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_samples_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "worker_applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_samples_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_samples_file_id_fkey"
            columns: ["file_id"]
            isOneToOne: false
            referencedRelation: "files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_samples_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_samples_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "worker_profiles"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      worker_state: {
        Row: {
          earnings_frozen: boolean
          earnings_frozen_reason: string | null
          first_payout_at: string | null
          jobs_abandoned: number
          kyc_status: Database["public"]["Enums"]["kyc_status"]
          lifetime_earnings_paise: number
          low_ratings_in_grace: number
          loyalty_discount_bps: number
          newest_slot_retired_at: string | null
          newest_slot_shortlists: number
          newest_slot_started_at: string | null
          opt_in_limit_override: number | null
          outstanding_debit_paise: number
          profile_id: string
          true_rating: number | null
          updated_at: string
        }
        Insert: {
          earnings_frozen?: boolean
          earnings_frozen_reason?: string | null
          first_payout_at?: string | null
          jobs_abandoned?: number
          kyc_status?: Database["public"]["Enums"]["kyc_status"]
          lifetime_earnings_paise?: number
          low_ratings_in_grace?: number
          loyalty_discount_bps?: number
          newest_slot_retired_at?: string | null
          newest_slot_shortlists?: number
          newest_slot_started_at?: string | null
          opt_in_limit_override?: number | null
          outstanding_debit_paise?: number
          profile_id: string
          true_rating?: number | null
          updated_at?: string
        }
        Update: {
          earnings_frozen?: boolean
          earnings_frozen_reason?: string | null
          first_payout_at?: string | null
          jobs_abandoned?: number
          kyc_status?: Database["public"]["Enums"]["kyc_status"]
          lifetime_earnings_paise?: number
          low_ratings_in_grace?: number
          loyalty_discount_bps?: number
          newest_slot_retired_at?: string | null
          newest_slot_shortlists?: number
          newest_slot_started_at?: string | null
          opt_in_limit_override?: number | null
          outstanding_debit_paise?: number
          profile_id?: string
          true_rating?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_state_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: true
            referencedRelation: "worker_profiles"
            referencedColumns: ["profile_id"]
          },
        ]
      }
    }
    Views: {
      ledger_account_balances: {
        Row: {
          account_id: string | null
          balance_paise: number | null
          code: string | null
          entry_count: number | null
          last_entry_at: string | null
          owner_id: string | null
          type: Database["public"]["Enums"]["ledger_account_type"] | null
        }
        Relationships: [
          {
            foreignKeyName: "ledger_accounts_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      admin_can: {
        Args: { perm: Database["public"]["Enums"]["admin_permission"] }
        Returns: boolean
      }
      auto_accept_deadline: {
        Args: { budget_paise: number; delivered_at: string }
        Returns: string
      }
      claim_job_assignment: {
        Args: {
          p_job_id: string
          p_opt_in_id?: string
          p_payment_id?: string
          p_source?: Database["public"]["Enums"]["assignment_source"]
          p_worker_id: string
        }
        Returns: {
          assigned_at: string
          created_at: string
          ended_at: string | null
          ended_reason: string | null
          id: string
          job_id: string
          opt_in_id: string | null
          payment_id: string | null
          source: Database["public"]["Enums"]["assignment_source"]
          status: Database["public"]["Enums"]["assignment_status"]
          worker_id: string
        }
        SetofOptions: {
          from: "*"
          to: "job_assignments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      ensure_worker_ledger_account: {
        Args: { p_worker_id: string }
        Returns: string
      }
      is_active_worker: { Args: { uid?: string }; Returns: boolean }
      is_admin: { Args: never; Returns: boolean }
      is_conversation_participant: {
        Args: { conversation: string }
        Returns: boolean
      }
      is_dispute_party: { Args: { dispute: string }; Returns: boolean }
      is_job_client: { Args: { job: string }; Returns: boolean }
      is_job_participant: { Args: { job: string }; Returns: boolean }
      max_deadline_days: { Args: { budget_paise: number }; Returns: number }
      setting_bigint: {
        Args: { fallback: number; setting_key: string }
        Returns: number
      }
      setting_bool: {
        Args: { fallback: boolean; setting_key: string }
        Returns: boolean
      }
      setting_int: {
        Args: { fallback: number; setting_key: string }
        Returns: number
      }
      slab_for: {
        Args: { at_time?: string; budget_paise: number }
        Returns: {
          client_bps: number
          created_at: string
          effective_from: string
          effective_to: string | null
          id: string
          label: string
          max_commission_paise: number | null
          max_paise: number | null
          min_commission_paise: number
          min_paise: number
          total_bps: number
          worker_bps: number
        }
        SetofOptions: {
          from: "*"
          to: "commission_slabs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      worker_works_in_category: { Args: { cat: string }; Returns: boolean }
    }
    Enums: {
      account_status:
        | "active"
        | "restricted"
        | "suspended"
        | "banned"
        | "deactivated"
      admin_permission:
        | "manage_admins"
        | "manage_users"
        | "review_workers"
        | "view_disputes"
        | "resolve_disputes"
        | "manage_payouts"
        | "view_finance"
        | "manage_categories"
        | "manage_settings"
        | "resolve_reports"
        | "handle_support"
        | "view_audit_log"
      assignment_source: "shortlist" | "rehire" | "admin"
      assignment_status:
        | "active"
        | "completed"
        | "cancelled"
        | "abandoned"
        | "replaced"
      background_job_status:
        | "queued"
        | "running"
        | "succeeded"
        | "failed"
        | "dead"
      brief_field_type:
        | "text"
        | "long_text"
        | "number"
        | "select"
        | "multi_select"
        | "boolean"
        | "file_format"
      cancellation_tier:
        | "pre_assignment"
        | "early"
        | "mid"
        | "late"
        | "post_delivery"
      category_status: "active" | "hidden" | "retired"
      chargeback_status:
        | "open"
        | "evidence_submitted"
        | "won"
        | "lost"
        | "cancelled"
      classification_status:
        | "pending"
        | "classified"
        | "low_confidence"
        | "admin_review"
        | "resolved"
        | "failed"
      delivery_status:
        | "pending_review"
        | "accepted"
        | "revision_requested"
        | "disputed"
        | "superseded"
      dispute_layer:
        | "auto_resolved"
        | "self_settlement"
        | "admin_review"
        | "instant_split"
      dispute_offer_status:
        | "pending"
        | "accepted"
        | "countered"
        | "rejected"
        | "expired"
      dispute_outcome: "release" | "refund" | "split"
      dispute_status:
        | "open"
        | "awaiting_response"
        | "self_settlement"
        | "admin_review"
        | "resolved"
        | "appealed"
        | "closed"
      document_line_kind:
        | "job_budget"
        | "commission"
        | "tax"
        | "fee"
        | "discount"
        | "refund"
        | "penalty"
        | "net_payable"
      document_type:
        | "client_receipt"
        | "commission_invoice"
        | "credit_note"
        | "payout_advice"
        | "refund_note"
      earning_status:
        | "pending"
        | "confirmed"
        | "on_hold"
        | "frozen"
        | "in_payout"
        | "paid"
        | "reversed"
        | "forfeited"
      email_status:
        | "queued"
        | "sending"
        | "sent"
        | "failed"
        | "bounced"
        | "complained"
        | "cancelled"
      escrow_status: "held" | "frozen" | "released" | "refunded" | "split"
      file_purpose:
        | "job_attachment"
        | "delivery"
        | "sample"
        | "chat_attachment"
        | "dispute_evidence"
        | "kyc_document"
        | "avatar"
        | "document"
      file_scan_status: "pending" | "clean" | "infected" | "skipped" | "failed"
      job_status:
        | "draft"
        | "pending_moderation"
        | "open"
        | "assigned"
        | "delivered"
        | "revision_requested"
        | "disputed"
        | "completed"
        | "cancelled"
        | "expired"
        | "rejected"
      kyc_status:
        | "not_started"
        | "submitted"
        | "verifying"
        | "verified"
        | "rejected"
        | "blocked"
      ledger_account_type:
        | "escrow"
        | "worker_payable"
        | "platform_revenue"
        | "tax_payable"
        | "gateway_fees"
        | "chargeback_reserve"
        | "penalty_receivable"
        | "external"
      ledger_direction: "debit" | "credit"
      ledger_txn_kind:
        | "payment_captured"
        | "commission_charged"
        | "tax_charged"
        | "escrow_released"
        | "refund_issued"
        | "payout_created"
        | "payout_paid"
        | "payout_failed"
        | "penalty_applied"
        | "penalty_recovered"
        | "chargeback_opened"
        | "chargeback_lost"
        | "chargeback_won"
        | "reserve_transfer"
        | "subscription_charged"
        | "adjustment"
      moderation_reason:
        | "academic_submission"
        | "credential_sharing"
        | "adult_content"
        | "impersonation"
        | "illegal_or_harmful"
        | "copyright_infringement"
        | "deceptive_material"
        | "other"
      moderation_status: "pending" | "approved" | "rejected" | "escalated"
      moderation_trigger:
        | "other_category"
        | "first_high_value_job"
        | "user_report"
        | "keyword_flag"
        | "random_audit"
        | "risk_score"
      notification_type:
        | "email_verification"
        | "mobile_verification"
        | "payment_received"
        | "shortlist_ready"
        | "worker_assigned"
        | "work_delivered"
        | "auto_accept_reminder"
        | "job_completed"
        | "refund_issued"
        | "dispute_update"
        | "application_approved"
        | "application_rejected"
        | "worker_selected"
        | "revision_requested"
        | "payout_sent"
        | "payout_failed"
        | "penalty_notice"
        | "kyc_required"
        | "new_job_in_category"
        | "message_received"
        | "job_expiring"
        | "support_reply"
      opt_in_status:
        | "active"
        | "shortlisted"
        | "selected"
        | "not_selected"
        | "withdrawn"
        | "expired"
      party_role: "client" | "worker" | "admin" | "system"
      payment_status:
        | "created"
        | "authorized"
        | "captured"
        | "failed"
        | "refunded"
        | "partially_refunded"
        | "charged_back"
      payout_batch_status:
        | "open"
        | "closed"
        | "under_review"
        | "processing"
        | "completed"
        | "failed"
      payout_item_kind: "earning" | "penalty" | "adjustment" | "reversal"
      payout_method_status:
        | "unverified"
        | "verifying"
        | "verified"
        | "failed"
        | "disabled"
      payout_method_type: "bank_account" | "upi"
      payout_status: "pending" | "processing" | "paid" | "failed" | "cancelled"
      penalty_status: "active" | "settled" | "waived" | "reversed"
      penalty_type:
        | "abandonment"
        | "off_platform_contact"
        | "plagiarism"
        | "low_rating"
        | "prohibited_work"
        | "late_delivery"
        | "chargeback_fraud"
        | "sample_theft"
        | "collusion"
      plan_audience: "worker" | "client"
      rating_direction: "client_to_worker" | "worker_to_client"
      rating_sentiment: "positive" | "neutral" | "negative"
      refund_reason:
        | "client_cancellation"
        | "worker_abandonment"
        | "dispute_refund"
        | "dispute_split"
        | "prohibited_work"
        | "job_expired"
        | "admin_adjustment"
        | "chargeback"
      refund_status: "pending" | "processing" | "completed" | "failed"
      rehire_status:
        | "pending"
        | "accepted"
        | "declined"
        | "expired"
        | "withdrawn"
      report_reason:
        | "abuse"
        | "plagiarism"
        | "off_platform_contact"
        | "impersonation"
        | "prohibited_work"
        | "spam"
        | "other"
      report_status: "open" | "reviewing" | "actioned" | "dismissed"
      revision_status:
        | "requested"
        | "accepted_by_worker"
        | "declined_by_worker"
        | "delivered"
        | "cancelled"
      risk_flag_kind:
        | "shared_device"
        | "shared_ip"
        | "shared_payout_destination"
        | "duplicate_pan"
        | "fast_completion"
        | "always_five_star"
        | "no_chat_activity"
        | "closed_pair"
        | "velocity"
        | "name_mismatch"
      risk_flag_status: "open" | "cleared" | "confirmed"
      sample_status: "pending" | "approved" | "rejected" | "flagged"
      sanction_type:
        | "warning"
        | "rating_penalty"
        | "shortlist_removal"
        | "sample_resubmission"
        | "suspension"
        | "ban"
      shortlist_slot: "top" | "middle" | "newest"
      subscription_status:
        | "active"
        | "past_due"
        | "cancelled"
        | "expired"
        | "paused"
      ticket_status:
        | "open"
        | "waiting_on_user"
        | "waiting_on_admin"
        | "resolved"
        | "closed"
      worker_application_status:
        | "draft"
        | "submitted"
        | "approved"
        | "approved_with_flag"
        | "rejected"
        | "withdrawn"
      worker_status:
        | "draft"
        | "pending_approval"
        | "approved"
        | "approved_with_flag"
        | "rejected"
        | "suspended"
        | "removed"
      worker_tier: "new" | "established" | "top"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      account_status: [
        "active",
        "restricted",
        "suspended",
        "banned",
        "deactivated",
      ],
      admin_permission: [
        "manage_admins",
        "manage_users",
        "review_workers",
        "view_disputes",
        "resolve_disputes",
        "manage_payouts",
        "view_finance",
        "manage_categories",
        "manage_settings",
        "resolve_reports",
        "handle_support",
        "view_audit_log",
      ],
      assignment_source: ["shortlist", "rehire", "admin"],
      assignment_status: [
        "active",
        "completed",
        "cancelled",
        "abandoned",
        "replaced",
      ],
      background_job_status: [
        "queued",
        "running",
        "succeeded",
        "failed",
        "dead",
      ],
      brief_field_type: [
        "text",
        "long_text",
        "number",
        "select",
        "multi_select",
        "boolean",
        "file_format",
      ],
      cancellation_tier: [
        "pre_assignment",
        "early",
        "mid",
        "late",
        "post_delivery",
      ],
      category_status: ["active", "hidden", "retired"],
      chargeback_status: [
        "open",
        "evidence_submitted",
        "won",
        "lost",
        "cancelled",
      ],
      classification_status: [
        "pending",
        "classified",
        "low_confidence",
        "admin_review",
        "resolved",
        "failed",
      ],
      delivery_status: [
        "pending_review",
        "accepted",
        "revision_requested",
        "disputed",
        "superseded",
      ],
      dispute_layer: [
        "auto_resolved",
        "self_settlement",
        "admin_review",
        "instant_split",
      ],
      dispute_offer_status: [
        "pending",
        "accepted",
        "countered",
        "rejected",
        "expired",
      ],
      dispute_outcome: ["release", "refund", "split"],
      dispute_status: [
        "open",
        "awaiting_response",
        "self_settlement",
        "admin_review",
        "resolved",
        "appealed",
        "closed",
      ],
      document_line_kind: [
        "job_budget",
        "commission",
        "tax",
        "fee",
        "discount",
        "refund",
        "penalty",
        "net_payable",
      ],
      document_type: [
        "client_receipt",
        "commission_invoice",
        "credit_note",
        "payout_advice",
        "refund_note",
      ],
      earning_status: [
        "pending",
        "confirmed",
        "on_hold",
        "frozen",
        "in_payout",
        "paid",
        "reversed",
        "forfeited",
      ],
      email_status: [
        "queued",
        "sending",
        "sent",
        "failed",
        "bounced",
        "complained",
        "cancelled",
      ],
      escrow_status: ["held", "frozen", "released", "refunded", "split"],
      file_purpose: [
        "job_attachment",
        "delivery",
        "sample",
        "chat_attachment",
        "dispute_evidence",
        "kyc_document",
        "avatar",
        "document",
      ],
      file_scan_status: ["pending", "clean", "infected", "skipped", "failed"],
      job_status: [
        "draft",
        "pending_moderation",
        "open",
        "assigned",
        "delivered",
        "revision_requested",
        "disputed",
        "completed",
        "cancelled",
        "expired",
        "rejected",
      ],
      kyc_status: [
        "not_started",
        "submitted",
        "verifying",
        "verified",
        "rejected",
        "blocked",
      ],
      ledger_account_type: [
        "escrow",
        "worker_payable",
        "platform_revenue",
        "tax_payable",
        "gateway_fees",
        "chargeback_reserve",
        "penalty_receivable",
        "external",
      ],
      ledger_direction: ["debit", "credit"],
      ledger_txn_kind: [
        "payment_captured",
        "commission_charged",
        "tax_charged",
        "escrow_released",
        "refund_issued",
        "payout_created",
        "payout_paid",
        "payout_failed",
        "penalty_applied",
        "penalty_recovered",
        "chargeback_opened",
        "chargeback_lost",
        "chargeback_won",
        "reserve_transfer",
        "subscription_charged",
        "adjustment",
      ],
      moderation_reason: [
        "academic_submission",
        "credential_sharing",
        "adult_content",
        "impersonation",
        "illegal_or_harmful",
        "copyright_infringement",
        "deceptive_material",
        "other",
      ],
      moderation_status: ["pending", "approved", "rejected", "escalated"],
      moderation_trigger: [
        "other_category",
        "first_high_value_job",
        "user_report",
        "keyword_flag",
        "random_audit",
        "risk_score",
      ],
      notification_type: [
        "email_verification",
        "mobile_verification",
        "payment_received",
        "shortlist_ready",
        "worker_assigned",
        "work_delivered",
        "auto_accept_reminder",
        "job_completed",
        "refund_issued",
        "dispute_update",
        "application_approved",
        "application_rejected",
        "worker_selected",
        "revision_requested",
        "payout_sent",
        "payout_failed",
        "penalty_notice",
        "kyc_required",
        "new_job_in_category",
        "message_received",
        "job_expiring",
        "support_reply",
      ],
      opt_in_status: [
        "active",
        "shortlisted",
        "selected",
        "not_selected",
        "withdrawn",
        "expired",
      ],
      party_role: ["client", "worker", "admin", "system"],
      payment_status: [
        "created",
        "authorized",
        "captured",
        "failed",
        "refunded",
        "partially_refunded",
        "charged_back",
      ],
      payout_batch_status: [
        "open",
        "closed",
        "under_review",
        "processing",
        "completed",
        "failed",
      ],
      payout_item_kind: ["earning", "penalty", "adjustment", "reversal"],
      payout_method_status: [
        "unverified",
        "verifying",
        "verified",
        "failed",
        "disabled",
      ],
      payout_method_type: ["bank_account", "upi"],
      payout_status: ["pending", "processing", "paid", "failed", "cancelled"],
      penalty_status: ["active", "settled", "waived", "reversed"],
      penalty_type: [
        "abandonment",
        "off_platform_contact",
        "plagiarism",
        "low_rating",
        "prohibited_work",
        "late_delivery",
        "chargeback_fraud",
        "sample_theft",
        "collusion",
      ],
      plan_audience: ["worker", "client"],
      rating_direction: ["client_to_worker", "worker_to_client"],
      rating_sentiment: ["positive", "neutral", "negative"],
      refund_reason: [
        "client_cancellation",
        "worker_abandonment",
        "dispute_refund",
        "dispute_split",
        "prohibited_work",
        "job_expired",
        "admin_adjustment",
        "chargeback",
      ],
      refund_status: ["pending", "processing", "completed", "failed"],
      rehire_status: [
        "pending",
        "accepted",
        "declined",
        "expired",
        "withdrawn",
      ],
      report_reason: [
        "abuse",
        "plagiarism",
        "off_platform_contact",
        "impersonation",
        "prohibited_work",
        "spam",
        "other",
      ],
      report_status: ["open", "reviewing", "actioned", "dismissed"],
      revision_status: [
        "requested",
        "accepted_by_worker",
        "declined_by_worker",
        "delivered",
        "cancelled",
      ],
      risk_flag_kind: [
        "shared_device",
        "shared_ip",
        "shared_payout_destination",
        "duplicate_pan",
        "fast_completion",
        "always_five_star",
        "no_chat_activity",
        "closed_pair",
        "velocity",
        "name_mismatch",
      ],
      risk_flag_status: ["open", "cleared", "confirmed"],
      sample_status: ["pending", "approved", "rejected", "flagged"],
      sanction_type: [
        "warning",
        "rating_penalty",
        "shortlist_removal",
        "sample_resubmission",
        "suspension",
        "ban",
      ],
      shortlist_slot: ["top", "middle", "newest"],
      subscription_status: [
        "active",
        "past_due",
        "cancelled",
        "expired",
        "paused",
      ],
      ticket_status: [
        "open",
        "waiting_on_user",
        "waiting_on_admin",
        "resolved",
        "closed",
      ],
      worker_application_status: [
        "draft",
        "submitted",
        "approved",
        "approved_with_flag",
        "rejected",
        "withdrawn",
      ],
      worker_status: [
        "draft",
        "pending_approval",
        "approved",
        "approved_with_flag",
        "rejected",
        "suspended",
        "removed",
      ],
      worker_tier: ["new", "established", "top"],
    },
  },
} as const
