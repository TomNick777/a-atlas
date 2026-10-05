import { describe, expect, it } from "vitest";
import { boardFor, exchangeFor, normalizeSymbol, stockIdentity } from "../lib/atlas/stockIdentity";

/**
 * Canonical StockIdentity mapping (A-Atlas target architecture §3). The
 * 6-digit code is the boundary between the discovery pool, /stock/:symbol
 * and the Vibe research backend; a wrong prefix rule would 串号 companies.
 */

describe("normalizeSymbol", () => {
  it("accepts bare and suffixed forms", () => {
    expect(normalizeSymbol("688017")).toBe("688017");
    expect(normalizeSymbol(" 000001 ")).toBe("000001");
    expect(normalizeSymbol("688017.SH")).toBe("688017");
    expect(normalizeSymbol("688017.sh")).toBe("688017");
    expect(normalizeSymbol("SH688017")).toBe("688017");
    expect(normalizeSymbol("sz000001")).toBe("000001");
    expect(normalizeSymbol("920002.BJ")).toBe("920002");
  });

  it("rejects names, partial codes and non-A-share shapes", () => {
    expect(normalizeSymbol("绿的谐波")).toBeNull();
    expect(normalizeSymbol("68801")).toBeNull();
    expect(normalizeSymbol("6880171")).toBeNull();
    expect(normalizeSymbol("AAPL")).toBeNull();
    expect(normalizeSymbol("")).toBeNull();
    expect(normalizeSymbol("68-017")).toBeNull();
  });
});

describe("exchangeFor", () => {
  it("maps the five prefixes present in the pool", () => {
    expect(exchangeFor("600519")).toBe("SH");
    expect(exchangeFor("688017")).toBe("SH");
    expect(exchangeFor("000001")).toBe("SZ");
    expect(exchangeFor("300750")).toBe("SZ");
    expect(exchangeFor("920002")).toBe("BJ");
  });

  it("also accepts legacy and B-share schemes for Vibe input normalization", () => {
    expect(exchangeFor("900948")).toBe("SH");
    expect(exchangeFor("200002")).toBe("SZ");
    expect(exchangeFor("830799")).toBe("BJ");
    expect(exchangeFor("430047")).toBe("BJ");
    expect(exchangeFor("871981")).toBe("BJ");
  });

  it("returns null outside the scheme", () => {
    expect(exchangeFor("123456")).toBeNull();
    expect(exchangeFor("999999")).toBeNull();
  });
});

describe("boardFor", () => {
  it("distinguishes main boards, star, chinext and bse", () => {
    expect(boardFor("600519")).toBe("main");
    expect(boardFor("605111")).toBe("main");
    expect(boardFor("688017")).toBe("star");
    expect(boardFor("689009")).toBe("star");
    expect(boardFor("000001")).toBe("main");
    expect(boardFor("002594")).toBe("main");
    expect(boardFor("003816")).toBe("main");
    expect(boardFor("300750")).toBe("chinext");
    expect(boardFor("301536")).toBe("chinext");
    expect(boardFor("920002")).toBe("bse");
    expect(boardFor("830799")).toBe("bse");
    expect(boardFor("900948")).toBe("b");
    expect(boardFor("200002")).toBe("b");
  });
});

describe("stockIdentity", () => {
  it("returns the full canonical identity", () => {
    expect(stockIdentity("688017.SH")).toEqual({ symbol: "688017", exchange: "SH", board: "star" });
    expect(stockIdentity("000001")).toEqual({ symbol: "000001", exchange: "SZ", board: "main" });
  });

  it("is null for anything that is not a valid A-share symbol", () => {
    expect(stockIdentity("AAPL")).toBeNull();
    expect(stockIdentity("绿的谐波")).toBeNull();
    expect(stockIdentity("999999")).toBeNull();
  });
});
