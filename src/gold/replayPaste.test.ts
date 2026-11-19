import { describe, expect, it } from "vitest";
import { parsePaste, PASTE_SPEC, pasteReference, toPaste } from "./replayPaste";

const base: Record<string, string> = Object.fromEntries(PASTE_SPEC.map((f) => [f.key, f.example]));

describe("replay paste", () => {
  it("reads secret lines in any order, keeping unmentioned settings", () => {
    const r = parsePaste(
      [
        "FADEBOT_TRADER_STATS_SKIP_RANGES=0-9,30-39",
        "# a comment",
        "FADEBOT_TRADER_EDGE=25",
        "FADEBOT_TRADER_STATS_INVERT=1",
        "FADEBOT_TRADER_CONFIRM_AT=(delete)",
        "FADEBOT_TRADER_ORDER=market",
      ].join("\n"),
      { ...base, minSec: "45" },
    );
    expect(r.form.edge).toBe("25");
    expect(r.form.statsSkipRanges).toBe("0-9,30-39");
    expect(r.form.statsInvert).toBe("on");
    expect(r.form.confirmAt).toBe("");
    expect(r.form.minSec).toBe("45");
    expect(r.ignored).toEqual([]);
  });
  it("reads short names, form keys, colons and age rules with colons inside", () => {
    const r = parsePaste("STATS_MIN_EDGE: 25\nconfirmSec=90\nAGE_RULES=0-2:none;3-5:50-99;21+:all\nageRules: 0-2:none", base);
    expect(r.form.statsMinEdge).toBe("25");
    expect(r.form.confirmSec).toBe("90");
    expect(r.form.ageRules).toBe("0-2:none");
  });
  it("reads JSON, controls, ban on/min/max and swap off", () => {
    const j = parsePaste('{"edge": 30, "stats": true, "days": 3, "gap": 15, "start": 500}', base);
    expect(j.form.edge).toBe("30");
    expect(j.form.stats).toBe("on");
    expect(j.controls).toEqual({ days: 3, gap: 15, start: 500 });
    const b = parsePaste("FADEBOT_TRADER_BAN=on\nFADEBOT_TRADER_BAN_MIN=51\nFADEBOT_TRADER_BAN_MAX=99\nFADEBOT_TRADER_SWAP=off", base);
    expect(b.form.ban).toBe("51-99");
    expect(b.form.swapRanges).toBe("");
    expect(parsePaste("BAN=off", { ...base, ban: "40-99" }).form.ban).toBe("");
  });
  it("cleans units and quotes, and reports unknown names", () => {
    const r = parsePaste('CONFIRM_AT = "160-189 s",\nSTATS_SWAP_RANGES=60¢-80¢\nCONFIRM_AT_MODE=ask again\nFOO=1', base);
    expect(r.form.confirmAt).toBe("160-189");
    expect(r.form.statsSwapRanges).toBe("60-80");
    expect(r.form.confirmAtMode).toBe("reask");
    expect(r.ignored).toEqual(["FOO=1"]);
  });
  it("round-trips its own export", () => {
    const f = { ...base, edge: "22", statsSkipRanges: "0-9,30-39", ageRules: "0-2:none;21+:all", confirm2Sec: "30", tpPct: "50" };
    const r = parsePaste(toPaste(f, { days: 5, gap: 12 }), base);
    for (const k of Object.keys(f)) expect(r.form[k]).toBe(f[k]);
    expect(r.controls).toEqual({ days: 5, gap: 12 });
    expect(pasteReference()).toContain("FADEBOT_TRADER_STATS_SKIP_RANGES");
  });
});
