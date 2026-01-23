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
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      options_cache: {
        Row: {
          cache_type: string
          cached_at: string
          created_at: string
          data: Json
          expiration: string | null
          expires_at: string
          id: string
          underlying: string
        }
        Insert: {
          cache_type: string
          cached_at?: string
          created_at?: string
          data?: Json
          expiration?: string | null
          expires_at: string
          id?: string
          underlying: string
        }
        Update: {
          cache_type?: string
          cached_at?: string
          created_at?: string
          data?: Json
          expiration?: string | null
          expires_at?: string
          id?: string
          underlying?: string
        }
        Relationships: []
      }
      position_group_map: {
        Row: {
          created_at: string
          entry_credit: number | null
          expiration: string | null
          id: string
          leg_qty: number
          leg_side: string | null
          open_order_id: string
          strategy_name: string | null
          strategy_type: string | null
          symbol: string
          trade_group_id: string
          underlying: string
        }
        Insert: {
          created_at?: string
          entry_credit?: number | null
          expiration?: string | null
          id?: string
          leg_qty?: number
          leg_side?: string | null
          open_order_id: string
          strategy_name?: string | null
          strategy_type?: string | null
          symbol: string
          trade_group_id: string
          underlying: string
        }
        Update: {
          created_at?: string
          entry_credit?: number | null
          expiration?: string | null
          id?: string
          leg_qty?: number
          leg_side?: string | null
          open_order_id?: string
          strategy_name?: string | null
          strategy_type?: string | null
          symbol?: string
          trade_group_id?: string
          underlying?: string
        }
        Relationships: []
      }
      settings: {
        Row: {
          created_at: string
          fill_price_buffer_percent: number
          id: string
          max_bid_ask_spread_percent: number
          max_condors_per_expiry: number
          max_daily_loss: number
          max_positions: number
          updated_at: string
          zero_dte_close_buffer_minutes: number
        }
        Insert: {
          created_at?: string
          fill_price_buffer_percent?: number
          id?: string
          max_bid_ask_spread_percent?: number
          max_condors_per_expiry?: number
          max_daily_loss?: number
          max_positions?: number
          updated_at?: string
          zero_dte_close_buffer_minutes?: number
        }
        Update: {
          created_at?: string
          fill_price_buffer_percent?: number
          id?: string
          max_bid_ask_spread_percent?: number
          max_condors_per_expiry?: number
          max_daily_loss?: number
          max_positions?: number
          updated_at?: string
          zero_dte_close_buffer_minutes?: number
        }
        Relationships: []
      }
      strategies: {
        Row: {
          created_at: string
          enabled: boolean
          entry_conditions: Json
          exit_conditions: Json
          id: string
          max_positions: number
          name: string
          position_size: number
          type: string
          underlying: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          entry_conditions?: Json
          exit_conditions?: Json
          id?: string
          max_positions?: number
          name: string
          position_size?: number
          type: string
          underlying: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          entry_conditions?: Json
          exit_conditions?: Json
          id?: string
          max_positions?: number
          name?: string
          position_size?: number
          type?: string
          underlying?: string
          updated_at?: string
        }
        Relationships: []
      }
      strategy_evaluations: {
        Row: {
          client_request_id: string | null
          config_json: Json
          created_at: string
          decision: string
          event_type: string
          gates_json: Json
          id: string
          inputs_json: Json
          proposed_order_json: Json | null
          reason: string | null
          strategy_id: string
          trade_group_id: string | null
          underlying: string
        }
        Insert: {
          client_request_id?: string | null
          config_json?: Json
          created_at?: string
          decision: string
          event_type: string
          gates_json?: Json
          id?: string
          inputs_json?: Json
          proposed_order_json?: Json | null
          reason?: string | null
          strategy_id: string
          trade_group_id?: string | null
          underlying: string
        }
        Update: {
          client_request_id?: string | null
          config_json?: Json
          created_at?: string
          decision?: string
          event_type?: string
          gates_json?: Json
          id?: string
          inputs_json?: Json
          proposed_order_json?: Json | null
          reason?: string | null
          strategy_id?: string
          trade_group_id?: string | null
          underlying?: string
        }
        Relationships: [
          {
            foreignKeyName: "strategy_evaluations_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      trades: {
        Row: {
          close_avg_fill_price: number | null
          close_filled_at: string | null
          close_filled_qty: number | null
          close_order_id: string | null
          close_reject_reason: string | null
          close_side: string | null
          close_status: string | null
          close_submitted_at: string | null
          contracts: number | null
          created_at: string
          entry_credit: number | null
          entry_credit_dollars: number | null
          entry_price: number
          entry_time: string
          exit_debit: number | null
          exit_debit_dollars: number | null
          exit_price: number | null
          exit_price_source: string | null
          exit_reason: string | null
          exit_time: string
          exit_trigger_reason: string | null
          fees: number | null
          id: string
          leg_count: number | null
          multiplier: number | null
          needs_reconcile: boolean | null
          notes: string | null
          open_order_id: string | null
          open_side: string | null
          pnl: number | null
          pnl_computed_at: string | null
          pnl_formula: string | null
          pnl_percent: number | null
          pnl_status: string | null
          quantity: number
          strategy_name: string | null
          strategy_type: string | null
          symbol: string
          trade_group_id: string | null
          underlying: string
        }
        Insert: {
          close_avg_fill_price?: number | null
          close_filled_at?: string | null
          close_filled_qty?: number | null
          close_order_id?: string | null
          close_reject_reason?: string | null
          close_side?: string | null
          close_status?: string | null
          close_submitted_at?: string | null
          contracts?: number | null
          created_at?: string
          entry_credit?: number | null
          entry_credit_dollars?: number | null
          entry_price: number
          entry_time: string
          exit_debit?: number | null
          exit_debit_dollars?: number | null
          exit_price?: number | null
          exit_price_source?: string | null
          exit_reason?: string | null
          exit_time?: string
          exit_trigger_reason?: string | null
          fees?: number | null
          id?: string
          leg_count?: number | null
          multiplier?: number | null
          needs_reconcile?: boolean | null
          notes?: string | null
          open_order_id?: string | null
          open_side?: string | null
          pnl?: number | null
          pnl_computed_at?: string | null
          pnl_formula?: string | null
          pnl_percent?: number | null
          pnl_status?: string | null
          quantity: number
          strategy_name?: string | null
          strategy_type?: string | null
          symbol: string
          trade_group_id?: string | null
          underlying: string
        }
        Update: {
          close_avg_fill_price?: number | null
          close_filled_at?: string | null
          close_filled_qty?: number | null
          close_order_id?: string | null
          close_reject_reason?: string | null
          close_side?: string | null
          close_status?: string | null
          close_submitted_at?: string | null
          contracts?: number | null
          created_at?: string
          entry_credit?: number | null
          entry_credit_dollars?: number | null
          entry_price?: number
          entry_time?: string
          exit_debit?: number | null
          exit_debit_dollars?: number | null
          exit_price?: number | null
          exit_price_source?: string | null
          exit_reason?: string | null
          exit_time?: string
          exit_trigger_reason?: string | null
          fees?: number | null
          id?: string
          leg_count?: number | null
          multiplier?: number | null
          needs_reconcile?: boolean | null
          notes?: string | null
          open_order_id?: string | null
          open_side?: string | null
          pnl?: number | null
          pnl_computed_at?: string | null
          pnl_formula?: string | null
          pnl_percent?: number | null
          pnl_status?: string | null
          quantity?: number
          strategy_name?: string | null
          strategy_type?: string | null
          symbol?: string
          trade_group_id?: string | null
          underlying?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
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
  public: {
    Enums: {},
  },
} as const
