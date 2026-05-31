import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function CustodyPage() {
  redirect("/evidences/chain-of-custody");
}
