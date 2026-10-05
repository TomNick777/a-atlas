import { TrawlerExperience } from "@/components/TrawlerExperience";
import { identities, physicalPlates } from "@/lib/companies";

export default function Home() {
  const plates = physicalPlates();
  const universeCount = identities().length;
  if (!universeCount) {
    return (
      <main className="grid min-h-full place-items-center px-6 text-center text-[#d9d4c8]">
        <p>
          还没有公司数据。先运行 <code>npm run data</code>。
        </p>
      </main>
    );
  }
  return <TrawlerExperience plates={plates} universeCount={universeCount} />;
}
