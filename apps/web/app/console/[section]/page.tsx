import { ConsoleApp } from "../../../components/console-app";

export default async function ConsoleSection({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  return <ConsoleApp section={section} />;
}
