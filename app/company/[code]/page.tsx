import { redirect } from "next/navigation";
import { stockIdentity } from "@/lib/atlas/stockIdentity";
import { notFound } from "next/navigation";
export default async function CompanyRedirect({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { code } = await params; const identity = stockIdentity(code); if (!identity) notFound();
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) if (["q", "s", "c", "m"].includes(key) && typeof value === "string") query.set(key, value);
  redirect(`/stock/${identity.symbol}${query.size ? `?${query}` : ""}`);
}
