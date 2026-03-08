import { DashboardApp } from "@/components/dashboard/dashboard-app";
import { getDashboardInitialData } from "@/lib/dashboard-server";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const initialData = await getDashboardInitialData();

  return <DashboardApp initialData={initialData} page="overview" />;
}