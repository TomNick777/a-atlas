import { describe, expect, it } from "vitest";
import { findCompany, companyCount, datasetGeneratedAt } from "../lib/atlas/company";
import { boardFor, BOARD_LABEL, exchangeFor } from "../lib/atlas/stockIdentity";
import { loadDataset, resetDatasetCache } from "../lib/companies";

/**
 * Pool integrity for the A-Atlas company domain: the discovery pool stays the
 * single source of company facts, and the StockIdentity prefix rules must
 * agree with the pool's own exchange/board fields for EVERY company — a
 * mismatch would mean 串号 identity between Discover and /stock/:symbol.
 */

describe("atlas company data", () => {
  it("loads the full pool without shrinkage", () => {
    expect(companyCount()).toBe(5567);
    expect(loadDataset().companies.length).toBe(5567);
  });

  it("reports the snapshot generation time", () => {
    expect(datasetGeneratedAt()).toMatch(/^2026-/);
  });

  it("prefix rules agree with the pool for every company", () => {
    for (const company of loadDataset().companies) {
      expect(exchangeFor(company.code), `exchange ${company.code} ${company.name}`).toBe(company.exchange);
      const board = boardFor(company.code);
      expect(board, `board ${company.code} ${company.name}`).not.toBeNull();
      expect(BOARD_LABEL[board!], `board label ${company.code} ${company.name}`).toBe(company.board);
    }
  });

  it("resolves a known company with its profile facts", () => {
    const company = findCompany("688017");
    expect(company).not.toBeNull();
    expect(company!.name).toBe("绿的谐波");
    expect(company!.exchange).toBe("SH");
    expect(company!.swLevel1Industry).toBe("机械设备");
    expect(company!.businessDescription.length).toBeGreaterThan(0);
    expect(Array.isArray(company!.mainProducts)).toBe(true);
  });

  it("returns null for codes outside the pool", () => {
    expect(findCompany("999999")).toBeNull();
  });

  it("resolves the current snapshot after the dataset cache is reset", () => {
    const previous = findCompany("688017");
    resetDatasetCache();
    const current = loadDataset().companies.find((company) => company.code === "688017");
    expect(current).not.toBe(previous);
    expect(findCompany("688017")).toBe(current);
  });
});
