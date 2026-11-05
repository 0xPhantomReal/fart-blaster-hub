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
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      fadebot_bets5: {
        Row: {
          created_at: string | null
          fees: number | null
          jev_sure: number | null
          kind: string | null
          limit_filled: number | null
          limit_order_id: string | null
          limit_price: number | null
          limit_shares: number | null
          long_is: string | null
          market_slug: string | null
          mode: string | null
          open_ref: number | null
          order_id: string | null
          pnl: number | null
          price: number | null
          reason: string | null
          regime: string | null
          result: string | null
          settled_at: string | null
          shares: number | null
          side: string | null
          stake: number | null
          status: string | null
          step: number | null
          window_start: number
        }
        Insert: {
          created_at?: string | null
          fees?: number | null
          jev_sure?: number | null
          kind?: string | null
          limit_filled?: number | null
          limit_order_id?: string | null
          limit_price?: number | null
          limit_shares?: number | null
          long_is?: string | null
          market_slug?: string | null
          mode?: string | null
          open_ref?: number | null
          order_id?: string | null
          pnl?: number | null
          price?: number | null
          reason?: string | null
          regime?: string | null
          result?: string | null
          settled_at?: string | null
          shares?: number | null
          side?: string | null
          stake?: number | null
          status?: string | null
          step?: number | null
          window_start: number
        }
        Update: {
          created_at?: string | null
          fees?: number | null
          jev_sure?: number | null
          kind?: string | null
          limit_filled?: number | null
          limit_order_id?: string | null
          limit_price?: number | null
          limit_shares?: number | null
          long_is?: string | null
          market_slug?: string | null
          mode?: string | null
          open_ref?: number | null
          order_id?: string | null
          pnl?: number | null
          price?: number | null
          reason?: string | null
          regime?: string | null
          result?: string | null
          settled_at?: string | null
          shares?: number | null
          side?: string | null
          stake?: number | null
          status?: string | null
          step?: number | null
          window_start?: number
        }
        Relationships: []
      }
      fadebot_flow: {
        Row: {
          fp: Json
          time: number
        }
        Insert: {
          fp: Json
          time: number
        }
        Update: {
          fp?: Json
          time?: number
        }
        Relationships: []
      }
      fadebot_prices: {
        Row: {
          avg: number | null
          created_at: string | null
          high: number | null
          last: number | null
          low: number | null
          n: number | null
          period_start: number
          source: string | null
        }
        Insert: {
          avg?: number | null
          created_at?: string | null
          high?: number | null
          last?: number | null
          low?: number | null
          n?: number | null
          period_start: number
          source?: string | null
        }
        Update: {
          avg?: number | null
          created_at?: string | null
          high?: number | null
          last?: number | null
          low?: number | null
          n?: number | null
          period_start?: number
          source?: string | null
        }
        Relationships: []
      }
      fadebot_reads5: {
        Row: {
          created_at: string | null
          move: number | null
          open_ref: number | null
          outcome: string | null
          p_green: number | null
          window_start: number
        }
        Insert: {
          created_at?: string | null
          move?: number | null
          open_ref?: number | null
          outcome?: string | null
          p_green?: number | null
          window_start: number
        }
        Update: {
          created_at?: string | null
          move?: number | null
          open_ref?: number | null
          outcome?: string | null
          p_green?: number | null
          window_start?: number
        }
        Relationships: []
      }
      fadebot_state5: {
        Row: {
          flow_from: number | null
          flow_step: number | null
          flow_until: number | null
          id: number
          peak: number
          step: number
          total_pnl: number
          trades: number
          wins: number
          worst_drawdown: number
        }
        Insert: {
          flow_from?: number | null
          flow_step?: number | null
          flow_until?: number | null
          id: number
          peak?: number
          step?: number
          total_pnl?: number
          trades?: number
          wins?: number
          worst_drawdown?: number
        }
        Update: {
          flow_from?: number | null
          flow_step?: number | null
          flow_until?: number | null
          id?: number
          peak?: number
          step?: number
          total_pnl?: number
          trades?: number
          wins?: number
          worst_drawdown?: number
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
    Enums: {},
  },
} as const
