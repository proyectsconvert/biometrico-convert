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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      attendance_adjustments: {
        Row: {
          attendance_id: string
          comment: string | null
          created_at: string
          created_by: string | null
          field: string
          id: string
          new_value: string | null
          old_value: string | null
          reason: string
          tenant_id: string
        }
        Insert: {
          attendance_id: string
          comment?: string | null
          created_at?: string
          created_by?: string | null
          field: string
          id?: string
          new_value?: string | null
          old_value?: string | null
          reason: string
          tenant_id: string
        }
        Update: {
          attendance_id?: string
          comment?: string | null
          created_at?: string
          created_by?: string | null
          field?: string
          id?: string
          new_value?: string | null
          old_value?: string | null
          reason?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_adjustments_attendance_id_fkey"
            columns: ["attendance_id"]
            isOneToOne: false
            referencedRelation: "attendance_daily"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_adjustments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_adjustments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance_daily: {
        Row: {
          employee_id: string
          expected_minutes: number
          first_in: string | null
          id: string
          is_manual: boolean
          is_rest_day: boolean
          last_out: string | null
          late_minutes: number
          night_minutes: number
          notes: string | null
          oculto: boolean
          ordinary_minutes: number
          overtime_minutes: number
          shift_id: string | null
          status: Database["public"]["Enums"]["attendance_status"]
          sunday_holiday_minutes: number
          tenant_id: string
          updated_at: string
          work_date: string
          worked_minutes: number
        }
        Insert: {
          employee_id: string
          expected_minutes?: number
          first_in?: string | null
          id?: string
          is_manual?: boolean
          is_rest_day?: boolean
          last_out?: string | null
          late_minutes?: number
          night_minutes?: number
          notes?: string | null
          oculto?: boolean
          ordinary_minutes?: number
          overtime_minutes?: number
          shift_id?: string | null
          status?: Database["public"]["Enums"]["attendance_status"]
          sunday_holiday_minutes?: number
          tenant_id: string
          updated_at?: string
          work_date: string
          worked_minutes?: number
        }
        Update: {
          employee_id?: string
          expected_minutes?: number
          first_in?: string | null
          id?: string
          is_manual?: boolean
          is_rest_day?: boolean
          last_out?: string | null
          late_minutes?: number
          night_minutes?: number
          notes?: string | null
          oculto?: boolean
          ordinary_minutes?: number
          overtime_minutes?: number
          shift_id?: string | null
          status?: Database["public"]["Enums"]["attendance_status"]
          sunday_holiday_minutes?: number
          tenant_id?: string
          updated_at?: string
          work_date?: string
          worked_minutes?: number
        }
        Relationships: [
          {
            foreignKeyName: "attendance_daily_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_daily_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_daily_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          created_at: string
          id: number
          module: string
          new_value: Json | null
          old_value: Json | null
          reason: string | null
          record_id: string | null
          tenant_id: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          id?: number
          module: string
          new_value?: Json | null
          old_value?: Json | null
          reason?: string | null
          record_id?: string | null
          tenant_id?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          id?: number
          module?: string
          new_value?: Json | null
          old_value?: Json | null
          reason?: string | null
          record_id?: string | null
          tenant_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      biometric_events: {
        Row: {
          biometric_name: string | null
          created_at: string
          device_code: string
          device_id: string | null
          device_name: string | null
          document: string | null
          door: string | null
          employee_id: string | null
          event_at: string
          event_type: string
          id: number
          import_id: string | null
          is_attendance: boolean
          is_duplicate: boolean
          oculto: boolean
          raw_user: string | null
          tenant_id: string
          user_group: string | null
        }
        Insert: {
          biometric_name?: string | null
          created_at?: string
          device_code: string
          device_id?: string | null
          device_name?: string | null
          document?: string | null
          door?: string | null
          employee_id?: string | null
          event_at: string
          event_type: string
          id?: number
          import_id?: string | null
          is_attendance?: boolean
          is_duplicate?: boolean
          oculto?: boolean
          raw_user?: string | null
          tenant_id: string
          user_group?: string | null
        }
        Update: {
          biometric_name?: string | null
          created_at?: string
          device_code?: string
          device_id?: string | null
          device_name?: string | null
          document?: string | null
          door?: string | null
          employee_id?: string | null
          event_at?: string
          event_type?: string
          id?: number
          import_id?: string | null
          is_attendance?: boolean
          is_duplicate?: boolean
          oculto?: boolean
          raw_user?: string | null
          tenant_id?: string
          user_group?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "biometric_events_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "biometric_events_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "biometric_events_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "biometric_imports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "biometric_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      biometric_imports: {
        Row: {
          created_by: string | null
          error_detail: Json
          error_message: string | null
          file_hash: string | null
          filename: string
          finished_at: string | null
          id: string
          rows_duplicated: number
          rows_error: number
          rows_found: number
          rows_ignored: number
          rows_processed: number
          rows_valid: number
          started_at: string
          status: Database["public"]["Enums"]["import_status"]
          storage_path: string | null
          tenant_id: string
        }
        Insert: {
          created_by?: string | null
          error_detail?: Json
          error_message?: string | null
          file_hash?: string | null
          filename: string
          finished_at?: string | null
          id?: string
          rows_duplicated?: number
          rows_error?: number
          rows_found?: number
          rows_ignored?: number
          rows_processed?: number
          rows_valid?: number
          started_at?: string
          status?: Database["public"]["Enums"]["import_status"]
          storage_path?: string | null
          tenant_id: string
        }
        Update: {
          created_by?: string | null
          error_detail?: Json
          error_message?: string | null
          file_hash?: string | null
          filename?: string
          finished_at?: string | null
          id?: string
          rows_duplicated?: number
          rows_error?: number
          rows_found?: number
          rows_ignored?: number
          rows_processed?: number
          rows_valid?: number
          started_at?: string
          status?: Database["public"]["Enums"]["import_status"]
          storage_path?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "biometric_imports_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "biometric_imports_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_responsibles: {
        Row: {
          campaign_id: string
          id: string
          responsibility: string
          tenant_id: string
          user_id: string
        }
        Insert: {
          campaign_id: string
          id?: string
          responsibility?: string
          tenant_id: string
          user_id: string
        }
        Update: {
          campaign_id?: string
          id?: string
          responsibility?: string
          tenant_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_responsibles_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_responsibles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      campaigns: {
        Row: {
          code: string
          cost_center_id: string | null
          created_at: string
          id: string
          name: string
          shift_id: string | null
          status: Database["public"]["Enums"]["generic_status"]
          tenant_id: string
        }
        Insert: {
          code: string
          cost_center_id?: string | null
          created_at?: string
          id?: string
          name: string
          shift_id?: string | null
          status?: Database["public"]["Enums"]["generic_status"]
          tenant_id: string
        }
        Update: {
          code?: string
          cost_center_id?: string | null
          created_at?: string
          id?: string
          name?: string
          shift_id?: string | null
          status?: Database["public"]["Enums"]["generic_status"]
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_cost_center_id_fkey"
            columns: ["cost_center_id"]
            isOneToOne: false
            referencedRelation: "cost_centers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaigns_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaigns_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      cost_centers: {
        Row: {
          code: string
          created_at: string
          id: string
          name: string
          status: Database["public"]["Enums"]["generic_status"]
          tenant_id: string
        }
        Insert: {
          code: string
          created_at?: string
          id?: string
          name: string
          status?: Database["public"]["Enums"]["generic_status"]
          tenant_id: string
        }
        Update: {
          code?: string
          created_at?: string
          id?: string
          name?: string
          status?: Database["public"]["Enums"]["generic_status"]
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cost_centers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      data_cleanups: {
        Row: {
          alcance: string[]
          created_at: string
          created_by: string | null
          desde: string
          filas: number
          hasta: string
          id: string
          modo: string
          motivo: string | null
          revertido: boolean
          tenant_id: string
        }
        Insert: {
          alcance?: string[]
          created_at?: string
          created_by?: string | null
          desde: string
          filas?: number
          hasta: string
          id?: string
          modo: string
          motivo?: string | null
          revertido?: boolean
          tenant_id: string
        }
        Update: {
          alcance?: string[]
          created_at?: string
          created_by?: string | null
          desde?: string
          filas?: number
          hasta?: string
          id?: string
          modo?: string
          motivo?: string | null
          revertido?: boolean
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "data_cleanups_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      devices: {
        Row: {
          building: string | null
          classification: Database["public"]["Enums"]["device_class"]
          confirmed: boolean
          created_at: string
          device_code: string
          door_name: string | null
          floor: string | null
          id: string
          is_active: boolean
          name: string
          site: string | null
          tenant_id: string
        }
        Insert: {
          building?: string | null
          classification?: Database["public"]["Enums"]["device_class"]
          confirmed?: boolean
          created_at?: string
          device_code: string
          door_name?: string | null
          floor?: string | null
          id?: string
          is_active?: boolean
          name: string
          site?: string | null
          tenant_id: string
        }
        Update: {
          building?: string | null
          classification?: Database["public"]["Enums"]["device_class"]
          confirmed?: boolean
          created_at?: string
          device_code?: string
          door_name?: string | null
          floor?: string | null
          id?: string
          is_active?: boolean
          name?: string
          site?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "devices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      employers: {
        Row: {
          biometric_groups: string[]
          created_at: string
          id: string
          include_in_reports: boolean
          name: string
          nit: string | null
          status: Database["public"]["Enums"]["generic_status"]
          tenant_id: string
        }
        Insert: {
          biometric_groups?: string[]
          created_at?: string
          id?: string
          include_in_reports?: boolean
          name: string
          nit?: string | null
          status?: Database["public"]["Enums"]["generic_status"]
          tenant_id: string
        }
        Update: {
          biometric_groups?: string[]
          created_at?: string
          id?: string
          include_in_reports?: boolean
          name?: string
          nit?: string | null
          status?: Database["public"]["Enums"]["generic_status"]
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "employers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      employees: {
        Row: {
          biometric_group: string | null
          campaign_id: string | null
          cost_center_id: string | null
          created_at: string
          document: string
          email: string | null
          employer_id: string | null
          full_name: string
          hire_date: string | null
          id: string
          position: string | null
          shift_id: string | null
          status: Database["public"]["Enums"]["generic_status"]
          supervisor_id: string | null
          tenant_id: string
          termination_date: string | null
          user_id: string | null
        }
        Insert: {
          biometric_group?: string | null
          campaign_id?: string | null
          cost_center_id?: string | null
          created_at?: string
          document: string
          email?: string | null
          employer_id?: string | null
          full_name: string
          hire_date?: string | null
          id?: string
          position?: string | null
          shift_id?: string | null
          status?: Database["public"]["Enums"]["generic_status"]
          supervisor_id?: string | null
          tenant_id: string
          termination_date?: string | null
          user_id?: string | null
        }
        Update: {
          biometric_group?: string | null
          campaign_id?: string | null
          cost_center_id?: string | null
          created_at?: string
          document?: string
          email?: string | null
          employer_id?: string | null
          full_name?: string
          hire_date?: string | null
          id?: string
          position?: string | null
          shift_id?: string | null
          status?: Database["public"]["Enums"]["generic_status"]
          supervisor_id?: string | null
          tenant_id?: string
          termination_date?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "employees_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_cost_center_id_fkey"
            columns: ["cost_center_id"]
            isOneToOne: false
            referencedRelation: "cost_centers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_supervisor_id_fkey"
            columns: ["supervisor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      holidays: {
        Row: {
          country: string
          description: string
          holiday_date: string
          id: string
          is_active: boolean
          tenant_id: string
        }
        Insert: {
          country?: string
          description: string
          holiday_date: string
          id?: string
          is_active?: boolean
          tenant_id: string
        }
        Update: {
          country?: string
          description?: string
          holiday_date?: string
          id?: string
          is_active?: boolean
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "holidays_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      novelty_entries: {
        Row: {
          campaign_label: string | null
          created_at: string
          created_by: string | null
          document: string
          employee_id: string | null
          full_name: string | null
          id: string
          notes: string | null
          novelty_type: string
          oculto: boolean
          position: string | null
          report_id: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          source: string
          status: string
          tenant_id: string
          work_date: string
        }
        Insert: {
          campaign_label?: string | null
          created_at?: string
          created_by?: string | null
          document: string
          employee_id?: string | null
          full_name?: string | null
          id?: string
          notes?: string | null
          novelty_type: string
          oculto?: boolean
          position?: string | null
          report_id?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          source?: string
          status?: string
          tenant_id: string
          work_date: string
        }
        Update: {
          campaign_label?: string | null
          created_at?: string
          created_by?: string | null
          document?: string
          employee_id?: string | null
          full_name?: string | null
          id?: string
          notes?: string | null
          novelty_type?: string
          oculto?: boolean
          position?: string | null
          report_id?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          source?: string
          status?: string
          tenant_id?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "novelty_entries_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "novelty_entries_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "novelty_reports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "novelty_entries_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      novelty_reports: {
        Row: {
          campaign_label: string | null
          company_name: string | null
          created_at: string
          days_count: number
          employees_count: number
          error_message: string | null
          filename: string
          id: string
          period_end: string | null
          period_start: string | null
          sheet_name: string | null
          status: string
          tenant_id: string
          uploaded_by: string | null
        }
        Insert: {
          campaign_label?: string | null
          company_name?: string | null
          created_at?: string
          days_count?: number
          employees_count?: number
          error_message?: string | null
          filename: string
          id?: string
          period_end?: string | null
          period_start?: string | null
          sheet_name?: string | null
          status?: string
          tenant_id: string
          uploaded_by?: string | null
        }
        Update: {
          campaign_label?: string | null
          company_name?: string | null
          created_at?: string
          days_count?: number
          employees_count?: number
          error_message?: string | null
          filename?: string
          id?: string
          period_end?: string | null
          period_start?: string | null
          sheet_name?: string | null
          status?: string
          tenant_id?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "novelty_reports_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      novelty_totals: {
        Row: {
          ajuste_dom_fest_090: number
          ajuste_dom_fest_190: number
          ajuste_extra_diurnas: number
          ajuste_extra_nocturnas: number
          ajuste_horas_nocturnas: number
          bonificacion: number
          campaign_label: string | null
          comisiones: number
          created_at: string
          document: string
          employee_id: string | null
          full_name: string | null
          horas_dom_fest_090: number
          horas_dom_fest_190: number
          horas_extra_diurnas: number
          horas_extra_nocturnas: number
          horas_nocturnas: number
          id: string
          observaciones: string | null
          period_end: string
          period_start: string
          position: string | null
          report_id: string | null
          source: string
          tenant_id: string
        }
        Insert: {
          ajuste_dom_fest_090?: number
          ajuste_dom_fest_190?: number
          ajuste_extra_diurnas?: number
          ajuste_extra_nocturnas?: number
          ajuste_horas_nocturnas?: number
          bonificacion?: number
          campaign_label?: string | null
          comisiones?: number
          created_at?: string
          document: string
          employee_id?: string | null
          full_name?: string | null
          horas_dom_fest_090?: number
          horas_dom_fest_190?: number
          horas_extra_diurnas?: number
          horas_extra_nocturnas?: number
          horas_nocturnas?: number
          id?: string
          observaciones?: string | null
          period_end: string
          period_start: string
          position?: string | null
          report_id?: string | null
          source?: string
          tenant_id: string
        }
        Update: {
          ajuste_dom_fest_090?: number
          ajuste_dom_fest_190?: number
          ajuste_extra_diurnas?: number
          ajuste_extra_nocturnas?: number
          ajuste_horas_nocturnas?: number
          bonificacion?: number
          campaign_label?: string | null
          comisiones?: number
          created_at?: string
          document?: string
          employee_id?: string | null
          full_name?: string | null
          horas_dom_fest_090?: number
          horas_dom_fest_190?: number
          horas_extra_diurnas?: number
          horas_extra_nocturnas?: number
          horas_nocturnas?: number
          id?: string
          observaciones?: string | null
          period_end?: string
          period_start?: string
          position?: string | null
          report_id?: string | null
          source?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "novelty_totals_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "novelty_totals_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "novelty_reports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "novelty_totals_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      permissions: {
        Row: {
          action: string
          id: string
          label: string
          module: string
        }
        Insert: {
          action: string
          id?: string
          label: string
          module: string
        }
        Update: {
          action?: string
          id?: string
          label?: string
          module?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          is_active: boolean
          tenant_id: string | null
        }
        Insert: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id: string
          is_active?: boolean
          tenant_id?: string | null
        }
        Update: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          is_active?: boolean
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      role_permissions: {
        Row: {
          permission_id: string
          role_id: string
        }
        Insert: {
          permission_id: string
          role_id: string
        }
        Update: {
          permission_id?: string
          role_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_permissions_permission_id_fkey"
            columns: ["permission_id"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_permissions_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
        ]
      }
      roles: {
        Row: {
          code: string
          created_at: string
          description: string | null
          id: string
          is_system: boolean
          name: string
          tenant_id: string | null
        }
        Insert: {
          code: string
          created_at?: string
          description?: string | null
          id?: string
          is_system?: boolean
          name: string
          tenant_id?: string | null
        }
        Update: {
          code?: string
          created_at?: string
          description?: string | null
          id?: string
          is_system?: boolean
          name?: string
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "roles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      rules: {
        Row: {
          description: string | null
          id: string
          key: string
          tenant_id: string
          updated_at: string
          value: Json
        }
        Insert: {
          description?: string | null
          id?: string
          key: string
          tenant_id: string
          updated_at?: string
          value: Json
        }
        Update: {
          description?: string | null
          id?: string
          key?: string
          tenant_id?: string
          updated_at?: string
          value?: Json
        }
        Relationships: [
          {
            foreignKeyName: "rules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      shifts: {
        Row: {
          break_minutes: number
          code: string
          created_at: string
          crosses_midnight: boolean
          end_time: string
          id: string
          name: string
          start_time: string
          status: Database["public"]["Enums"]["generic_status"]
          tenant_id: string
          tolerance_in_minutes: number
          tolerance_out_minutes: number
          workdays: number[]
        }
        Insert: {
          break_minutes?: number
          code: string
          created_at?: string
          crosses_midnight?: boolean
          end_time: string
          id?: string
          name: string
          start_time: string
          status?: Database["public"]["Enums"]["generic_status"]
          tenant_id: string
          tolerance_in_minutes?: number
          tolerance_out_minutes?: number
          workdays?: number[]
        }
        Update: {
          break_minutes?: number
          code?: string
          created_at?: string
          crosses_midnight?: boolean
          end_time?: string
          id?: string
          name?: string
          start_time?: string
          status?: Database["public"]["Enums"]["generic_status"]
          tenant_id?: string
          tolerance_in_minutes?: number
          tolerance_out_minutes?: number
          workdays?: number[]
        }
        Relationships: [
          {
            foreignKeyName: "shifts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      staging_personal: {
        Row: {
          car: string | null
          ccname: string | null
          code: string | null
          doc: string | null
          nom: string | null
        }
        Insert: {
          car?: string | null
          ccname?: string | null
          code?: string | null
          doc?: string | null
          nom?: string | null
        }
        Update: {
          car?: string | null
          ccname?: string | null
          code?: string | null
          doc?: string | null
          nom?: string | null
        }
        Relationships: []
      }
      tenants: {
        Row: {
          country: string
          created_at: string
          id: string
          is_active: boolean
          name: string
          nit: string | null
        }
        Insert: {
          country?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          nit?: string | null
        }
        Update: {
          country?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          nit?: string | null
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          campaign_ids: string[]
          created_at: string
          id: string
          role_id: string
          scope: Database["public"]["Enums"]["app_scope"]
          tenant_id: string | null
          user_id: string
        }
        Insert: {
          campaign_ids?: string[]
          created_at?: string
          id?: string
          role_id: string
          scope?: Database["public"]["Enums"]["app_scope"]
          tenant_id?: string | null
          user_id: string
        }
        Update: {
          campaign_ids?: string[]
          created_at?: string
          id?: string
          role_id?: string
          scope?: Database["public"]["Enums"]["app_scope"]
          tenant_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_roles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      biometric_daily: {
        Row: {
          document: string | null
          eventos_totales: number | null
          fecha: string | null
          marcaciones_validas: number | null
          nombre: string | null
          primera_entrada: string | null
          primera_marcacion: string | null
          tenant_id: string | null
          ultima_marcacion: string | null
          ultima_salida: string | null
        }
        Relationships: [
          {
            foreignKeyName: "biometric_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      calidad_datos: { Args: { _desde: string; _hasta: string }; Returns: Json }
      current_tenant_id: { Args: never; Returns: string }
      depurar_datos: {
        Args: {
          _alcance: string[]
          _desde: string
          _hasta: string
          _modo: string
          _motivo: string
          _tenant: string
          _user: string
        }
        Returns: number
      }
      generar_novedades_desde_asistencia: {
        Args: { _desde: string; _hasta: string }
        Returns: number
      }
      has_permission: {
        Args: { _action: string; _module: string }
        Returns: boolean
      }
      is_super_admin: { Args: { _user_id?: string }; Returns: boolean }
      minutos_en_ventana: {
        Args: { _fin: string; _ini: string; _vf: string; _vi: string }
        Returns: number
      }
      my_campaign_ids: { Args: never; Returns: string[] }
      my_documents: { Args: never; Returns: string[] }
      my_employee_ids: { Args: never; Returns: string[] }
      my_scope: {
        Args: never
        Returns: Database["public"]["Enums"]["app_scope"]
      }
      panel_bi: {
        Args: { _campaign?: string; _desde: string; _hasta: string }
        Returns: Json
      }
      procesar_importacion: { Args: { _import_id: string }; Returns: Json }
      recalcular_asistencia: {
        Args: { _desde: string; _hasta: string; _tenant: string }
        Returns: number
      }
      sugerir_clasificacion: {
        Args: { _name: string }
        Returns: Database["public"]["Enums"]["device_class"]
      }
      tenant_visible: { Args: { _tenant_id: string }; Returns: boolean }
      ve_toda_empresa: { Args: never; Returns: boolean }
    }
    Enums: {
      app_scope:
        | "solo_yo"
        | "mi_campana"
        | "campanas_asignadas"
        | "mi_empresa"
        | "plataforma"
      attendance_status: "completa" | "incompleta" | "sin_marcacion"
      device_class:
        | "entrada"
        | "salida"
        | "entrada_salida"
        | "interno"
        | "ignorar"
      generic_status: "activo" | "inactivo"
      import_status:
        | "pendiente"
        | "procesando"
        | "completado"
        | "completado_advertencias"
        | "error"
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_scope: [
        "solo_yo",
        "mi_campana",
        "campanas_asignadas",
        "mi_empresa",
        "plataforma",
      ],
      attendance_status: ["completa", "incompleta", "sin_marcacion"],
      device_class: [
        "entrada",
        "salida",
        "entrada_salida",
        "interno",
        "ignorar",
      ],
      generic_status: ["activo", "inactivo"],
      import_status: [
        "pendiente",
        "procesando",
        "completado",
        "completado_advertencias",
        "error",
      ],
    },
  },
} as const
