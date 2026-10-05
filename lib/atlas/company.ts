import { loadDataset } from "@/lib/companies";
import type { Company } from "@/lib/types";

// Dataset snapshots are replaced by resetDatasetCache(). Key by the array itself
// so a replacement cannot retain company objects from the previous snapshot.
const companyIndexes = new WeakMap<Company[], Map<string, Company>>();

/** Resolve a company from the discovery pool by canonical 6-digit symbol. */
export function findCompany(symbol: string): Company | null {
  const { companies } = loadDataset();
  let index = companyIndexes.get(companies);
  if (!index) {
    index = new Map();
    for (const company of companies) {
      // Preserve Array.find's first-entry behavior even for a malformed duplicate.
      if (!index.has(company.code)) index.set(company.code, company);
    }
    companyIndexes.set(companies, index);
  }
  return index.get(symbol) ?? null;
}

/** When the pool snapshot was generated (for honest "数据截至" captions). */
export function datasetGeneratedAt(): string | null {
  return loadDataset().generatedAt;
}

export function companyCount(): number {
  return loadDataset().companies.length;
}
