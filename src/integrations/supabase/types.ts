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
      fadebot_asks: {
        Row: {
          action: string | null
          at_sec: number | null
          created_at: string | null
          did: string | null
          down_cost: number | null
          down_sell: number | null
          id: number
          ms: number | null
          p_up: number | null
          pos_side: string | null
          probs: Json | null
          unrealized: number | null
          up_cost: number | null
          up_sell: number | null
          window_start: number
        }
        Insert: {
          action?: string | null
          at_sec?: number | null
          created_at?: string | null
          did?: string | null
          down_cost?: number | null
          down_sell?: number | null
          id?: number
          ms?: number | null
          p_up?: number | null
          pos_side?: string | null
          probs?: Json | null
          unrealized?: number | null
          up_cost?: number | null
          up_sell?: number | null
          window_start: number
        }
        Update: {
          action?: string | null
          at_sec?: number | null
          created_at?: string | null
          did?: string | null
          down_cost?: number | null
          down_sell?: number | null
          id?: number
          ms?: number | null
          p_up?: number | null
          pos_side?: string | null
          probs?: Json | null
          unrealized?: number | null
          up_cost?: number | null
          up_sell?: number | null
          window_start?: number
        }
        Relationships: []
      }
      fadebot_bets5: {
        Row: {
          created_at: string | null
          exit_at: string | null
          exit_order_id: string | null
          exit_price: number | null
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
          target_price: number | null
          tv15: string | null
          window_start: number
        }
        Insert: {
          created_at?: string | null
          exit_at?: string | null
          exit_order_id?: string | null
          exit_price?: number | null
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
          target_price?: number | null
          tv15?: string | null
          window_start: number
        }
        Update: {
          created_at?: string | null
          exit_at?: string | null
          exit_order_id?: string | null
          exit_price?: number | null
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
          target_price?: number | null
          tv15?: string | null
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
      fadebot_kv: {
        Row: {
          at: string | null
          k: string
          v: Json | null
        }
        Insert: {
          at?: string | null
          k: string
          v?: Json | null
        }
        Update: {
          at?: string | null
          k?: string
          v?: Json | null
        }
        Relationships: []
      }
      fadebot_longshot: {
        Row: {
          at_sec: number | null
          bought: boolean | null
          cost: number | null
          created_at: string | null
          note: string | null
          p: number | null
          side: string | null
          start_ref: number | null
          window_start: number
        }
        Insert: {
          at_sec?: number | null
          bought?: boolean | null
          cost?: number | null
          created_at?: string | null
          note?: string | null
          p?: number | null
          side?: string | null
          start_ref?: number | null
          window_start: number
        }
        Update: {
          at_sec?: number | null
          bought?: boolean | null
          cost?: number | null
          created_at?: string | null
          note?: string | null
          p?: number | null
          side?: string | null
          start_ref?: number | null
          window_start?: number
        }
        Relationships: []
      }
      fadebot_path: {
        Row: {
          minute: number
          pts: Json
          window_start: number
        }
        Insert: {
          minute: number
          pts: Json
          window_start: number
        }
        Update: {
          minute?: number
          pts?: Json
          window_start?: number
        }
        Relationships: []
      }
      fadebot_pmhist: {
        Row: {
          down_low: number | null
          down_read: number | null
          error: string | null
          fetched_at: string | null
          long_is: string | null
          n_points: number | null
          pts: Json | null
          sample: string | null
          slug: string | null
          up_low: number | null
          up_read: number | null
          window_start: number
        }
        Insert: {
          down_low?: number | null
          down_read?: number | null
          error?: string | null
          fetched_at?: string | null
          long_is?: string | null
          n_points?: number | null
          pts?: Json | null
          sample?: string | null
          slug?: string | null
          up_low?: number | null
          up_read?: number | null
          window_start: number
        }
        Update: {
          down_low?: number | null
          down_read?: number | null
          error?: string | null
          fetched_at?: string | null
          long_is?: string | null
          n_points?: number | null
          pts?: Json | null
          sample?: string | null
          slug?: string | null
          up_low?: number | null
          up_read?: number | null
          window_start?: number
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
      fadebot_strength: {
        Row: {
          at_sec: number
          move: number | null
          score: number
          used: string | null
          window_start: number
        }
        Insert: {
          at_sec: number
          move?: number | null
          score: number
          used?: string | null
          window_start: number
        }
        Update: {
          at_sec?: number
          move?: number | null
          score?: number
          used?: string | null
          window_start?: number
        }
        Relationships: []
      }
      fadebot_trades: {
        Row: {
          closed_at: string | null
          dip: string | null
          exit_order_id: string | null
          exit_price: number | null
          exit_sec: number | null
          fees: number | null
          id: number
          limit_price: number | null
          limit_shares: number | null
          long_is: string | null
          market_slug: string | null
          mode: string
          open_ref: number | null
          opened_at: string | null
          opened_sec: number | null
          order_id: string | null
          order_type: string | null
          p_side: number | null
          pnl: number | null
          price: number | null
          reason: string | null
          result: string | null
          shares: number | null
          side: string
          stake: number | null
          status: string
          strategy: string | null
          window_start: number
        }
        Insert: {
          closed_at?: string | null
          dip?: string | null
          exit_order_id?: string | null
          exit_price?: number | null
          exit_sec?: number | null
          fees?: number | null
          id?: number
          limit_price?: number | null
          limit_shares?: number | null
          long_is?: string | null
          market_slug?: string | null
          mode: string
          open_ref?: number | null
          opened_at?: string | null
          opened_sec?: number | null
          order_id?: string | null
          order_type?: string | null
          p_side?: number | null
          pnl?: number | null
          price?: number | null
          reason?: string | null
          result?: string | null
          shares?: number | null
          side: string
          stake?: number | null
          status?: string
          strategy?: string | null
          window_start: number
        }
        Update: {
          closed_at?: string | null
          dip?: string | null
          exit_order_id?: string | null
          exit_price?: number | null
          exit_sec?: number | null
          fees?: number | null
          id?: number
          limit_price?: number | null
          limit_shares?: number | null
          long_is?: string | null
          market_slug?: string | null
          mode?: string
          open_ref?: number | null
          opened_at?: string | null
          opened_sec?: number | null
          order_id?: string | null
          order_type?: string | null
          p_side?: number | null
          pnl?: number | null
          price?: number | null
          reason?: string | null
          result?: string | null
          shares?: number | null
          side?: string
          stake?: number | null
          status?: string
          strategy?: string | null
          window_start?: number
        }
        Relationships: []
      }
      jev_shared: {
        Row: {
          body: Json | null
          created_at: string | null
          key: string
        }
        Insert: {
          body?: Json | null
          created_at?: string | null
          key: string
        }
        Update: {
          body?: Json | null
          created_at?: string | null
          key?: string
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
